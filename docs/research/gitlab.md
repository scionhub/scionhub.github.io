# Background: GitLab

Notes on how GitLab hosts git repositories, from the storage service up to the
merge request workflow. This is source material, not a spec: what OpenScion
actually does is defined in
[`../specs/openscion-architecture.md`](../specs/openscion-architecture.md).
GitLab is useful prior art because it already runs history, merges, rebases,
and commit creation on the server, exposed as RPCs, on top of stock git. Facts
were checked against GitLab and Gitaly documentation, design documents, and
source as of October 2026; where a source was unclear, the text says so.

## Components

| Component | Role |
| --- | --- |
| NGINX / load balancer | Passes HTTP through untransformed |
| GitLab Workhorse | Go reverse proxy in front of Rails (Puma); handles git over HTTP, uploads, archives |
| GitLab Rails | Application, REST and GraphQL APIs, authorization, merge request logic |
| Sidekiq | Background jobs (rebases, merges, housekeeping scheduling) |
| GitLab Shell | Handles git over SSH after the SSH server authenticates the key |
| Gitaly | gRPC service that owns every git repository on local disk |
| Praefect | Optional router and transaction manager for replicated Gitaly ("Gitaly Cluster") |
| PostgreSQL | Rails metadata; separately, Praefect's cluster metadata |
| Object storage | LFS objects, uploads, optionally external merge request diffs |

Every Gitaly client (Rails, Shell, Workhorse, the Elasticsearch and Zoekt
indexers, the Kubernetes agent) talks to Gitaly over gRPC, and nothing else
touches repository data. Only local disks are supported; NFS and cloud file
systems are not
([architecture](https://docs.gitlab.com/development/architecture/),
[Workhorse](https://docs.gitlab.com/development/workhorse/),
[Gitaly](https://docs.gitlab.com/administration/gitaly/)).

## Gitaly

### Why it exists

GitLab.com used to mount repositories over NFS on every application server and
background worker. The
[Gitaly design document](https://gitlab.com/gitlab-org/gitaly/-/blob/master/doc/DESIGN.md)
records P99 time to open a `Rugged::Repository` spiking to 30 seconds of wall
time against about 15 ms of CPU, and notes that one broken NFS server could take
down every application server. Its first design reason was "to avoid having the
Git binary operate on remote storage." Ceph was tried first and rejected on
cloud performance; the migration then went RPC by RPC, each behind a feature
flag, until NFS was unmounted from production without customer impact
([*The road to Gitaly v1.0*](https://about.gitlab.com/blog/the-road-to-gitaly-1-0/),
2018). Decisions from that document that still shape the API:

- **gRPC over HTTP+JSON**, "not so much for performance reasons" but because
  gRPC is a framework with conventions the team did not have to invent.
- **High-level operations, not object lookups.** A diff needs an unbounded
  number of object reads, so one RPC per object was judged infeasible. "Defining
  new gRPC calls is cheap"; moving Rails logic into Gitaly is fine when it saves
  round trips.
- **A daemon, not a library**, so caches are shared and no application host
  needs the storage mounted.
- **Go**: a Ruby sidecar used 20 GB RSS for 5 requests per second on one server
  while the Go process used under 3 GB for 90.

### How it runs git

Gitaly shells out to stock `git(1)`, preferring plumbing commands, through a
command factory that guards against injection and pins the git version and
environment; small stable pieces such as pkt-line parsing are reimplemented in
Go ([server-side git usage](https://gitlab.com/gitlab-org/gitaly/-/blob/master/doc/serverside_git_usage.md)).
On-server git config is ignored in favour of Gitaly's own.

- **Process reuse.** Object reads use long-lived `git cat-file --batch`
  processes kept in a per-repository
  [cat-file cache](https://docs.gitlab.com/administration/gitaly/configure_gitaly/#cat-file-cache)
  (default 100 entries).
- **No worktree for merges.** Merges use `git merge-tree --write-tree`; rebase
  replays a `rev-list` todo list with merge-tree based cherry-picks
  ([`merge.go`](https://gitlab.com/gitlab-org/gitaly/-/blob/master/internal/git/localrepo/merge.go),
  [`rebase.go`](https://gitlab.com/gitlab-org/gitaly/-/blob/master/internal/git/localrepo/rebase.go)).
- **Hooks.** `core.hooksPath` points at symlinks to a `gitaly-hooks` binary
  that calls back into Gitaly over gRPC. `pre-receive` posts ref updates to
  Rails' `/internal/allowed` for the authorization decision;
  `reference-transaction` drives Praefect voting
  ([hooks](https://gitlab.com/gitlab-org/gitaly/-/blob/master/doc/hooks.md)).
- **Quarantine.** Pushed objects sit in git's quarantine directory until
  `pre-receive` approves them, and Rails is told the quarantine path so its
  checks can read them
  ([object quarantine](https://gitlab.com/gitlab-org/gitaly/-/blob/master/doc/object_quarantine.md)).
- **Layout.** Repositories live under hashed paths (`@hashed/xx/yy/<sha256>.git`)
  so renames do not move data
  ([storage paths](https://docs.gitlab.com/administration/repository_storage_paths/)).

### gRPC surface

Services are defined in [`proto/`](https://gitlab.com/gitlab-org/gitaly/-/tree/master/proto);
counts are RPCs per service on `master` at the time of writing.

| Service | RPCs | Representative calls |
| --- | --- | --- |
| `RepositoryService` | 42 | `CreateRepository`, `CreateFork`, `OptimizeRepository`, `FindMergeBase`, `GetArchive`, `SearchFilesByContent`, `ReplicateRepository`, `BackupRepository` |
| `RefService` | 16 | `ListRefs`, `FindBranch`, `UpdateReferences`, `DeleteRefs`, `ListBranchNamesContainingCommit` |
| `CommitService` | 22 | `ListCommits`, `FindCommit`, `CommitIsAncestor`, `TreeEntry`, `GetTreeEntries`, `RawBlame`, `LastCommitForPath`, `ListLastCommitsForTree`, `CheckObjectsExist` |
| `OperationService` | 16 | `UserCommitFiles`, `UserMergeBranch`, `UserMergeToRef`, `UserFFBranch`, `UserRebaseConfirmable`, `UserRebaseToRef`, `UserSquash`, `UserCherryPick`, `UserRevert`, `UserApplyPatch` |
| `DiffService` | 10 | `CommitDiff`, `CommitDelta`, `RawDiff`, `DiffStats`, `FindChangedPaths`, `RangeDiff`, `DiffBlobs` |
| `BlobService` | 7 | `GetBlob`, `GetBlobs`, `ListBlobs`, LFS pointer listing |
| `ConflictsService` | 2 | `ListConflictFiles`, `ResolveConflicts` |
| `ObjectPoolService` | 6 | `CreateObjectPool`, `LinkRepositoryToObjectPool`, `FetchIntoObjectPool`, `DisconnectGitAlternates` |
| `SmartHTTPService` | 5 | `InfoRefsUploadPack`, `PostUploadPackWithSidechannel`, `PostReceivePack`, `AdvertiseBundleURI` |
| `SSHService` | 3 | `SSHUploadPackWithSidechannel`, `SSHReceivePack`, `SSHUploadArchive` |

`OperationService` is the server-side write path. Its RPCs take a `User`, run
the access-check hooks as that user, and update a ref
([`operations.proto`](https://gitlab.com/gitlab-org/gitaly/-/blob/master/proto/operations.proto)):

- **`UserCommitFiles`** is a client stream: a header (branch, message, author,
  optional `start_sha` or `start_branch_name`, optional `start_repository` for
  cross-fork commits) then actions with content. It builds a commit and moves
  the branch without a clone.
- **`expected_old_oid`** on `UserCommitFiles` and `UserMergeBranch` is a
  compare-and-swap guard: the branch must still point there or the RPC fails;
  the zero OID means "create"; unset means overwrite.
- **Two-phase confirmation.** `UserMergeBranch` and `UserRebaseConfirmable`
  return the computed commit first and update the ref only on a second message
  with `apply = true`.
- **`UserMergeToRef` and `UserRebaseToRef`** write a merge or rebase result to
  an arbitrary ref without touching the target branch, for internal refs such
  as `refs/merge-requests/*`.
- **`UserFFBranch`** fast-forwards a branch and returns an empty response if
  the ref update loses a race.

### Bulk transfer and caching

Clone and fetch run `git upload-pack`; push runs `git receive-pack`.

- **Sidechannels.** gRPC message framing limited how much fetch traffic a
  server could serve, so since GitLab 14.4 upload-pack bytes travel on a
  separate stream over the same TCP connection, with gRPC used only for control
  ([sidechannel](https://gitlab.com/gitlab-org/gitaly/-/blob/master/doc/sidechannel.md)).
- **Pack-objects cache.** `uploadpack.packObjectsHook` routes
  `git pack-objects` back into Gitaly, which streams one cached response to
  concurrent identical fetches. It targets CPU load from massively parallel CI
  fetches, streams unfinished entries with backpressure so misses are not
  slower, and stores data in local files to benefit from the page cache (object
  storage was rejected as a new failure point). It is off by default because it
  can sharply raise disk writes, and it does nothing for unique fetches
  ([design notes](https://gitlab.com/gitlab-org/gitaly/-/blob/master/doc/design_pack_objects_cache.md),
  [admin docs](https://docs.gitlab.com/administration/gitaly/configure_gitaly/#pack-objects-cache)).
- **Bundle URIs.** Gitaly can advertise a pre-built bundle, made manually or
  automatically when clones are frequent, so clients fetch most objects from a
  CDN ([bundle URI](https://gitlab.com/gitlab-org/gitaly/-/blob/master/doc/bundle-uri.md)).
- **Concurrency limits.** Per-RPC, per-repository and per-IP pack-objects
  limits queue or reject work, optionally adapted with AIMD
  ([concurrency limiting](https://docs.gitlab.com/administration/gitaly/concurrency_limiting/)).

### Housekeeping

Gitaly runs its own maintenance instead of `git gc --auto`, which gave too
little control and observability. Rails once called fine-grained RPCs
(`RepackFull`, `PackRefs`, `GarbageCollect`) every few pushes; it now calls a
black-box `OptimizeRepository` that inspects on-disk state and does only what is
needed ([*Scaling repository maintenance*](https://about.gitlab.com/blog/scaling-repository-maintenance/)):

- **Heuristics** on loose objects, packfile count (the allowed count grows with
  size, so big repositories are fully repacked less often), loose-to-packed ref
  ratio, and stale commit-graphs. This more than halved optimization CPU on
  GitLab.com.
- **Geometric repacking** (git 2.32, global in GitLab 16.0) merges only the
  small end of a geometric sequence of packs. **Cruft packs** (git 2.37) keep
  unreachable objects packed with per-object mtimes for the 14-day grace period.
  Repacking time on the largest internal repositories fell about 80%
  ([*Rearchitecting object database maintenance*](https://about.gitlab.com/blog/rearchitecting-git-object-database-mainentance-for-scale/)).
- **Triggers:** every N pushes, on request, and a daily window for idle
  repositories ([housekeeping](https://docs.gitlab.com/administration/housekeeping/)).
  The old all-into-one repack could take hours on a monorepo.

### Object pools for forks

Forks share objects through an **object pool**: a hidden repository, seeded by
a `--local` clone of the source, that members reference through
`objects/info/alternates`
([object pools](https://gitlab.com/gitlab-org/gitaly/-/blob/master/doc/object_pools.md)).
Linking deletes the member's bitmaps, since git uses only one.
`FetchIntoObjectPool` updates the pool from its primary member with a
non-pruning fetch and repacks it with delta islands on `refs/heads` and
`refs/tags`. **Pool objects can never be pruned**: no moment exists when every
member's refs can be read race-free, so each newly dangling object gets a
`refs/dangling/<oid>` ref, and on busy repositories these make pool upkeep
expensive. Leaving a pool hard-links all pool objects into the member, removes
the alternate, and runs `git fsck`.

## Gitaly Cluster (Praefect)

### Architecture

Praefect, "a router and transaction manager for Gitaly," fronts a set of Gitaly
nodes forming a **virtual storage**
([Praefect docs](https://docs.gitlab.com/administration/gitaly/praefect/)).
Several Praefects run behind a load balancer and share a PostgreSQL database of
repository metadata, replica assignments, and the replication queue. By default
every repository is replicated to every node.

- **Writes** to transactional RPCs go to all healthy, up-to-date replicas
  synchronously. Failed replicas, and non-transactional RPCs, get asynchronous
  **replication jobs** from the primary.
- **Reads** marked `ACCESSOR` go to any healthy replica with no pending
  replication jobs, else to the primary.
- **Metadata atomicity** comes from PostgreSQL, not the disks: creation reserves
  an ID and writes replicas under a path derived from it, deletion drops the
  row and cleans disks later, moves only rewrite the path.
- **Failover** promotes the secondary most Praefects consider healthy,
  preferring the fewest failed replication jobs. A repository whose primary is
  outdated goes read-only until reconciled.

### Voting on ref updates

Strong consistency is scoped to ref updates, since every user-visible mutation
ends in one ([HA design](https://gitlab.com/gitlab-org/gitaly/-/blob/master/doc/design_ha.md)).
Praefect proxies a mutating RPC to every replica; on each, git's
`reference-transaction` hook sends Praefect a **vote**, a hash of the old and
new values of the refs about to change. Praefect commits when quorum agrees
(`strong`: all; `primary-wins`; `majority-wins`: primary plus half the
secondaries) and aborts otherwise. Outvoted nodes are repaired by replication.
An RPC may cast several ordered votes; all must pass.

This deadlocked under concurrency: at the `prepared` phase git already holds
on-disk ref locks, so two transactions locking overlapping refs in different
orders on different nodes wait forever. The fix
([serialized writes](https://gitlab.com/gitlab-org/gitaly/-/blob/master/doc/serialized_writes.md))
needed a new upstream hook phase, `preparing` (git 2.54.0), and a
PostgreSQL-backed per-repository lock held from `preparing` to `committed`,
since an in-process mutex cannot span Praefects. Documented cost: an extra
database round trip per write, and single-repository write throughput
"upper-bounded by `1 / lock_hold_duration`".

### Known problems

From the [known issues](https://docs.gitlab.com/administration/gitaly/praefect/#known-issues)
and design notes:

- Some operations still use replication jobs, so unreplicated writes can be lost
  on failover; stated objectives are RPO under one minute and RTO under 10 s.
- `PostReceiveHook` can run before replication, so CI jobs hitting a lagging
  replica fail with `couldn't find remote ref refs/merge-requests/$iid/{head,merge}`.
- On a heavily written monorepo, writes outpace replication and the primary
  serves most reads, so read distribution fails where it matters most.
- Restoring one node from a snapshot breaks reconciliation; Kubernetes support
  is beta and ECS unsupported.

### The abandoned write-ahead log and Raft direction

The [transaction management blueprint](https://handbook.gitlab.com/handbook/engineering/architecture/design-documents/gitaly_transaction_management/)
(2023) listed ways Gitaly violated ACID: refs updated one by one and left
half-done on interruption, quarantine migration ignoring object dependencies,
backups capturing states that never existed, missing fsyncs. It proposed
per-partition write-ahead logs with snapshot isolation as the first stage of
Raft replication that would remove Praefect and PostgreSQL
([epic 8903](https://gitlab.com/groups/gitlab-org/-/epics/8903)). The
[implementation](https://gitlab.com/gitlab-org/gitaly/-/blob/master/doc/transactions.md)
worked around git's file layout:

- **Partitions**: one per repository, except a pool and its members share one.
- **Snapshots**: copy the directory tree and hard-link files, so cost "scales
  by the number of files and directories".
- **Log entries**: a manifest of hard-link and remove operations plus the new
  pack and ref files git wrote, applied by one goroutine per partition.
- **Conflict checks** at commit: file-level (two transactions touching
  `packed-refs` conflict even with different refs), ref-level, and object
  dependencies. Write skew is not prevented.

As of September 2026 the blueprint is **rejected**: "the
Gitaly-Cluster-without-Praefect direction has been dropped," transactions are
disabled in staging, and the WAL, transaction, and Raft code is being removed.
Praefect with serialized writes remains the replication design.

Separately, a [reftable rollout](https://handbook.gitlab.com/handbook/engineering/architecture/design-documents/gitaly_reftable_rollout/)
(git 2.45; staging done, production status unclear) targets ref-count pain:
`DeleteRefs` averaged about 20 times `WriteRef` latency.

## Request flows

From the [architecture overview](https://docs.gitlab.com/development/architecture/):

- **HTTP fetch.** Workhorse asks Rails to authorize
  `GET /info/refs?service=git-upload-pack`, then calls `InfoRefsUploadPack`
  (`git upload-pack --stateless-rpc --advertise-refs`). The `POST
  /git-upload-pack` is authorized again and streamed to
  `PostUploadPackWithSidechannel`. Push is the same with `git-receive-pack`.
- **SSH fetch.** `AuthorizedKeysCommand` asks Rails which key ID owns the key;
  GitLab Shell calls `/internal/api/allowed`, receives Gitaly details, and
  proxies the session to `SSHUploadPackWithSidechannel` or `SSHReceivePack`.
- **Push inside Gitaly.** Objects go to quarantine; `pre-receive` calls Rails
  `/internal/allowed`, which may call back into Gitaly (for example
  `CommitIsAncestor`) against the quarantine; refs update (voted on under
  Praefect); `post-receive` notifies Rails for post-push work such as pipelines.
- **UI or API write.** Rails calls an `OperationService` RPC; the same hooks
  run, so access checks are identical for pushes and server-side commits.

## Merge requests

### Refs

| Ref | Contents | Written by |
| --- | --- | --- |
| `refs/merge-requests/<iid>/head` | Source tip, copied into the target project even from forks | Pushes to the source; deleted 14 days after close or merge |
| `refs/merge-requests/<iid>/merge` | Source merged into target, as the target would look after merging | `UserMergeToRef` via mergeability checks and the [`merge_ref` API](https://docs.gitlab.com/api/merge_requests/#merge-to-default-merge-ref-path) |
| `refs/merge-requests/<iid>/train` | Merge with all earlier merge train cars | Merge trains ([`merge_request.rb`](https://gitlab.com/gitlab-org/gitlab/-/blob/master/app/models/merge_request.rb)) |

So each merge request costs the target repository up to three refs, and CI runs
against them ([checkout refspec](https://docs.gitlab.com/user/project/merge_requests/merge_request_troubleshooting/)).
The diffs the UI shows are size-limited copies in the `merge_request_diff_files`
table, optionally in object storage
([diff storage](https://docs.gitlab.com/administration/merge_request_diffs/)).

### Merge methods

| Method ([docs](https://docs.gitlab.com/user/project/merge_requests/methods/)) | History | Source must be current |
| --- | --- | --- |
| Merge commit | Always a merge commit | No |
| Merge commit with semi-linear history | Merge commit, only when a fast-forward is possible | Yes; rebase offered |
| Fast-forward | Linear | Yes; rebase offered |

- **Squash** builds one commit with `UserSquash`; with a merge-commit method
  two commits land, with fast-forward one.
- **Server-side rebase** (UI, `/rebase`, or `PUT /merge_requests/:iid/rebase`)
  is queued to Sidekiq and returns `202`; callers poll `rebase_in_progress`. It
  works only without conflicts and drops GPG signatures. Automatic rebase at
  merge time does not re-run CI on the result.
- **Merging** (`PUT /merge_requests/:iid/merge`) accepts `sha`, which must equal
  the source head or the call fails with `409`; groups can require it so only
  reviewed commits merge.

### Mergeability, approvals, and code owners

`detailed_merge_status` reports values such as `checking`, `conflict`,
`need_rebase`, `ci_must_pass`, `not_approved`, `discussions_not_resolved`,
`requested_changes`, `status_checks_must_pass`, `locked_paths`, and `mergeable`
([merge status](https://docs.gitlab.com/api/merge_requests/#merge-status)).
Each check is a class run by `RunChecksService`, optionally cached; checks run
so often that the target is 10 to 20 ms each, and the approval check is named
as the slow one
([mergeability framework](https://docs.gitlab.com/development/merge_request_concepts/mergeability_framework/)).

- **Approval rules** (Premium) name users or groups and a required count, as
  project defaults or per merge request; fork merge requests use the target's
  rules ([rules](https://docs.gitlab.com/user/project/merge_requests/approvals/rules/)).
- **Settings** can forbid approval by the author or committers, require
  re-authentication, and reset all approvals, or only affected code-owner
  approvals, on new commits
  ([settings](https://docs.gitlab.com/user/project/merge_requests/approvals/settings/)).
- **CODEOWNERS** maps path patterns to owners, read from the target branch.
  Owner approval is required only on protected branches with code-owner
  approval enabled; unmatched files need none
  ([Code Owners](https://docs.gitlab.com/user/project/codeowners/)).

Rules are path- and membership-based; nothing documented classifies a change by
its semantics, as Scion's Antique does.

### Merge trains

A merged results pipeline tests source plus current target, but two merge
requests can pass separately and break the target together. Merge trains
(Premium) address this ([merge trains](https://docs.gitlab.com/ci/pipelines/merge_trains/)):

1. Each car's train ref merges its source onto the previous car's train ref
   (the target for the first car), via `first_parent_ref`.
2. Car *n*'s pipeline tests the target plus cars 1 to *n*. Pipelines run in
   parallel, up to 20 per train by default (configurable; 1 means strictly
   sequential). Further cars queue without limit.
3. A car merges once its pipeline passes and every car ahead has merged.
4. A failed car is removed; every pipeline behind it is cancelled and
   recreated without it. "Merge immediately" also restarts the train.

Landing is a fast-forward
([`FromTrainRef`](https://gitlab.com/gitlab-org/gitlab/-/blob/master/ee/app/services/merge_requests/merge_strategies/from_train_ref.rb)):
Rails re-runs mergeability checks, verifies the train ref still points at the
SHA the pipeline tested, and fast-forwards the target to it, so the tested
commit is exactly what lands. The price is speculative CI: one failure at the
head of a 20-car train discards up to 19 running pipelines.

## Server-side changes over the API

| Endpoint | What it does |
| --- | --- |
| [`POST /projects/:id/repository/commits`](https://docs.gitlab.com/api/commits/#create-a-commit) | One commit from a batch of `actions` (`create`, `update`, `delete`, `move`, `chmod`), text or base64 content, no clone. `start_branch` or `start_sha` (optionally from `start_project`) picks the parent; `force` replaces history; per-action `last_commit_id` rejects edits to a file changed since. Over 300 MB is rejected; over 20 MB is limited to 3 requests per 30 s |
| GraphQL [`commitCreate`](https://docs.gitlab.com/api/graphql/reference/#mutationcommitcreate) | The same, with `CommitAction` inputs |
| [Repository files](https://docs.gitlab.com/api/repository_files/) | Read, raw read, blame with line ranges, and single-file create, update, delete |
| [Compare](https://docs.gitlab.com/api/repositories/#compare-branches-tags-or-commits) | Commits and diffs between two revisions; merge base (`...`) by default, `straight` for direct; diffs may be truncated (`compare_timeout`) |
| [Cherry-pick, revert](https://docs.gitlab.com/api/commits/) | Server-side, onto a named branch |

These reach Gitaly through `UserCommitFiles` and its siblings. The REST API
does not expose `expected_old_oid`; the nearest guards are `start_sha` and
per-file `last_commit_id`.

## Large repositories

GitLab's [monorepo guidance](https://docs.gitlab.com/user/project/repository/monorepos/)
mostly reduces what git asks of the server:

- **Server:** pack-objects cache, bundle URIs, longer negotiation timeouts,
  hardware sized to a reference architecture, pruning branches, hiding refs with
  `transfer.hideRefs` in Gitaly's config, scheduled housekeeping.
- **CI:** runners shallow-clone and use the `fetch` strategy by default; also
  `--filter=blob:limit=1m`, `--no-tags`, skipping `git clean`, staggered
  schedules.
- **Partial clone** (git 2.22+) with `blob:limit` or `blob:none` plus sparse
  checkout; the `sparse:oid` filter is experimental and may be slow and costly
  on the server ([reduce clone size](https://docs.gitlab.com/topics/git/clone/)).
- **LFS** keeps binaries in object storage ([Git LFS](https://docs.gitlab.com/topics/git/lfs/)).

## Where cost scales

| Cost driver | Scales with | GitLab mitigation |
| --- | --- | --- |
| Clone, full fetch | Reachable objects; `git pack-objects` is "the most resource intensive operation" | Bitmaps, pack-objects cache (identical concurrent fetches only), bundle URIs, shallow and partial clone |
| Ref advertisement and walk | Ref count, on every fetch | Pack refs, hidden refs, reftable |
| Ref deletion | Size of `packed-refs` | Reftable |
| Repacking | Total objects | Geometric repacking, cruft packs, heuristics |
| Object pool upkeep | Dangling refs that are never dropped | Delta islands only |
| Replication | Write rate per repository | Primary absorbs reads when replicas lag |
| Serialized writes | One lock per repository | None; throughput capped at `1 / lock_hold_duration` |
| WAL snapshots (abandoned) | Files and directories in the repository | Shared read snapshots |
| Merge request refs | Merge requests, up to three refs each | Deletion 14 days after close |
| Mergeability checks | Merge requests times checks | Per-check caching |
| Merge trains | Cars behind a failure | Parallelism cap |

The write itself is mostly proportional to the change, since merge-tree and
`UserCommitFiles` need no worktree. Everything around it (ref storage,
replication, housekeeping, transfer) grows with the repository.

## What this means for OpenScion

- **Server-side changeset creation has strong precedent.** `UserCommitFiles`
  and the Commits API `actions` array are OpenScion's changeset write in git
  form: the client names file-level changes against a parent and the server
  builds the commit. GitLab's action set (`create`, `update`, `delete`, `move`,
  `chmod`, base64 content, per-file `last_commit_id`) is a tested shape worth
  matching. Unlike GitLab, OpenScion separates creating a changeset from moving
  a ref.
- **Single-record CAS versus Praefect voting.** Praefect needed votes from
  every replica through a git hook, a new upstream hook phase, and a PostgreSQL
  lock per repository to avoid deadlock, ending with writes serialized per
  repository. Its remaining failures (lagging replicas, CI fetching refs not yet
  replicated, read-only repositories after failover) come from replicating
  mutable file-system state. With immutable, content-addressed objects and refs
  moved by single-record compare-and-swap, only the ref record needs
  consistency. `expected_old_oid` shows Gitaly exposes the same CAS primitive.
- **Do not retrofit transactions onto git's file layout.** GitLab's WAL and
  snapshot work was abandoned after three years; snapshot cost grew with file
  count, and conflicts arose at the file level (`packed-refs`) as well as the
  logical one. That supports a storage model built for atomic single-record
  updates over wrapping git.
- **Merge trains versus lock-free `Land`.** A train lands exactly the tested
  commit, at the price of discarded speculative CI and throughput bounded by
  pipeline length times parallelism. `Land` rebases onto the current tip,
  retries the swap, and leaves breakage to post-merge testing, as Scion does.
  A CI system wanting train semantics can build them on the API: compose
  changesets server-side (no refs needed), test them, then `Land` expecting the
  tested tip.
- **Merge request refs are a scaling trap.** Up to three refs per merge request
  feed straight into GitLab's ref-count problems. OpenScion's rule that work in
  progress is a changeset, not a ref, avoids this; review tools should address
  changesets by ID.
- **gRPC is a reasonable transport, with a caveat.** Gitaly picked gRPC for its
  conventions and runs it at GitLab.com scale, but per-message framing capped
  fetch throughput until sidechannels were added. If OpenScion chooses gRPC,
  bulk object streaming needs large messages, a side stream, or a plain HTTP
  path caches can serve. Gitaly's preference for high-level RPCs over chained
  low-level ones also fits history, blame, and diff.
- **Caching.** The pack-objects cache helps only identical concurrent fetches
  and is off by default for write amplification; content addressing makes every
  OpenScion object response cacheable instead. Gitaly's reliance on local files
  and the page cache over object storage is relevant to `openscion-daemon`'s
  node store.
- **Interop**, not evaluated in depth: (1) a GitLab-compatible subset of the
  Commits, Repository files, and Compare REST endpoints, so existing bots and CI
  scripts work unchanged; (2) a bridge implementing parts of Gitaly's
  `CommitService`, `BlobService`, `DiffService`, and `OperationService`, which
  is far larger because those RPCs assume git object IDs, branches, and hooks
  that call into Rails.
- **Housekeeping never goes away in GitLab.** Years of tuning cut repack time
  by 80% without removing it. Keeping packfiles out of the authoritative store,
  as Scion does, is the larger win, and git ingestion should not reintroduce
  them on the serving side.
