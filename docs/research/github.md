# Background: GitHub

Notes on how GitHub hosts git, from the storage layer up to the pull request
workflow, collected from GitHub's engineering blog and documentation. This is
source material, not a spec: what OpenScion actually does is defined in
[`../specs/`](../specs/openscion-architecture.md). GitHub matters to OpenScion
twice over. It is the most widely used example of git run as a centralized
service, which is the model mismatch Scion was built to escape (see
[`scion.md`](scion.md)), and it is the platform most OpenScion adopters will
have to interoperate with.

Figures are as of the post or page cited. Where GitHub has not published how
something works, this document says so.

## Storage: Spokes

### From DRBD pairs to application-level replication

Until 2016 GitHub stored each repository on a pair of file servers replicated
at the block level with DRBD, plus a hot spare, with manual failover. In
[*Introducing DGit*](https://github.blog/engineering/infrastructure/introducing-dgit/)
(April 2016) GitHub described its replacement, later renamed **Spokes**:

- Replication moved from the disk layer to the git layer. Each repository has
  three replicas on three servers, kept as loosely coupled git repositories
  synchronized over git's own protocols.
- Replicas live on local SSDs rather than a SAN or distributed file system,
  because git is latency-sensitive.
- Writes stream synchronously to all replicas and commit when at least two
  confirm. Reads can go to any replica.
- A failed server is routed around without waiting for a human, and
  under-replicated repositories are re-copied N-to-N across the remaining
  servers.

[*Building resilience in Spokes*](https://github.blog/engineering/infrastructure/building-resilience-in-spokes/)
(September 2016) added detail. At that point Spokes held over 38 million
repositories and 36 million gists, with at least three copies of each in
different racks, treating racks as availability zones. Spokes has no primary:
"every write" is treated as an election. A write takes an exclusive lock on a
majority of replicas, is accepted only if a strict majority applies it with the
same result, and is reverted otherwise; losing replicas are marked unhealthy
until repaired with a mix of git and rsync. On a typical day a few dozen writes
out of many millions failed to get a unanimous vote. Failure detection uses
live traffic, tracked per application server.

### Ref updates: three-phase commit and checksums

[*Stretching Spokes*](https://github.blog/engineering/infrastructure/stretching-spokes/)
(2017) explains how ref updates stay consistent once replicas are far apart:

- Ref updates use a **three-phase commit** across replicas, which also acts as
  a distributed lock that orders the repository's database updates. It costs
  four round trips to the distant replicas.
- Each replica applies the update as a git ref transaction
  (`git update-ref --stdin`, which GitHub contributed upstream): take local
  locks, verify old values, check new values, then commit or roll back.
- Each replica keeps a **Spokes checksum** of its refs: the XOR of a hash of
  every (refname, value) pair. It updates incrementally,
  `new = old XOR h(ref, old) XOR h(ref, new)`, and matching checksums mean
  matching logical contents.
- Reads outnumber writes about 100 to 1. The target was a few ref updates per
  second per repository; one update cost about a third of a second, and a push
  to `master` in some repositories triggered over 100 bookkeeping ref updates,
  so GitHub coalesced bookkeeping updates and prioritized user-initiated ones.
- GitHub Enterprise geo-replicas are non-voting, so pushes keep working when
  they are unreachable.

The cost of this design showed up on monorepos.
[*Improving large monorepo performance on GitHub*](https://github.blog/engineering/architecture-optimization/improving-large-monorepo-performance-on-github/)
(2021) reports that GitHub.com writes **five replicas across three data
centers**, and that the cross-replica lock for a ref update was held for 20 to
30 seconds on large monorepos while checksums were computed. Precomputing the
checksums before taking the lock cut lock time to under a second and raised
single-repository update throughput by at least an order of magnitude.

### Fork networks and shared objects

[*Counting objects*](https://github.blog/2015-09-22-counting-objects/) (2015)
describes how forks share storage. Rails alone had nearly 11,000 forks at the
time. Every repository in a fork network borrows objects through git
**alternates** from a shared root repository, `network.git`, which holds the
network's objects in one packfile. This deduplicates storage but means an
object in one fork may be stored as a delta against an object that only another
fork can see, which then has to be re-deltified on the fly when someone clones.
GitHub's fix "painted" each object with the set of forks that reach it and only
allowed a delta base whose set was a superset of the child's. Git's later delta
islands feature (`pack.island`) serves the same purpose, and in 2026 GitHub
told Dropbox that its server-side optimizations depend on bitmaps and delta
islands ([Dropbox](https://dropbox.tech/infrastructure/reducing-our-monorepo-size-to-improve-developer-velocity)).

The network is also a policy unit: push rulesets apply to a repository's whole
fork network ([about rulesets](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/about-rulesets)),
and commit signature verification records are shared across it
([signature verification](https://docs.github.com/en/authentication/managing-commit-signature-verification/about-commit-signature-verification)).
GitHub's 18.6 PB of git data (2022) overstates real storage because of
deduplication within fork networks
([*Scaling Git's garbage collection*](https://github.blog/engineering/architecture-optimization/scaling-gits-garbage-collection/)).

### Repository maintenance

Packfiles need maintenance, and at GitHub's scale maintenance became a
scaling problem of its own.

| Problem | GitHub's answer | Source |
| --- | --- | --- |
| Counting reachable objects for a clone walked all history; a Linux clone took up to 8 minutes of CPU | Reachability **bitmaps** (EWAH-compressed, 5 to 10% of repo size), upstreamed in Git 2.0; counting dropped to milliseconds and average CPU for network operations fell over 90% | [Counting objects](https://github.blog/2015-09-22-counting-objects/) |
| Repacking everything into one pack hit timeouts on large repos | **Geometric repacking** (`git repack --geometric=2`), each pack at least twice the size of the next, so work scales with new objects; an all-into-one repack every eighth run. Average repack time fell from about 1 minute to 15 seconds | [Scaling monorepo maintenance](https://github.blog/engineering/architecture-optimization/scaling-monorepo-maintenance/) |
| Bitmaps required a single pack | **Multi-pack index bitmaps** with on-disk reverse indexes; median fetch CPU on `Homebrew/homebrew-core` fell about 80% | same |
| Unreachable objects (force pushes, deleted branches) were kept as loose files to avoid racing with pushes, exhausting inodes and slowing repacks | **Cruft packs** with a `.mtimes` table, in Git 2.37. `github/github` shrank from about 57 GB to 27 GB; one force-push-heavy repo from 186 GB to 2 GB | [Scaling Git's garbage collection](https://github.blog/engineering/architecture-optimization/scaling-gits-garbage-collection/) |
| Monorepo maintenance failed and retried only after seven days | Maintenance after every 50 pushes or 40 MB of unpacked objects, capped delta comparisons, retries every four hours | [Monorepo performance](https://github.blog/engineering/architecture-optimization/improving-large-monorepo-performance-on-github/) |

Pruning is hard because the server may advertise an object to a client, delete
it, and then receive a push that builds on it, corrupting the repository. Git's
mitigation is a grace period (`--prune=<date>`), which is why unreachable data
lingers. Maintenance is also replica-aware: the geometric repacking rollout
never put a majority of a repository's replicas in one data center on the new
code.

Pack layout remains sensitive to heuristics. Dropbox's 87 GB monorepo bloated
because git's delta heuristic pairs files by the last 16 characters of their
path; GitHub fixed it with an aggressive server-side repack that took about nine
hours on a mirror and was rolled out one replica per day
([Dropbox, 2026](https://dropbox.tech/infrastructure/reducing-our-monorepo-size-to-improve-developer-velocity)).

### libgit2, Rugged, and the move to git-native tooling

GitHub's Ruby application long used libgit2 (a C reimplementation of git) and
its Ruby binding Rugged, both maintained under the
[libgit2 organization](https://github.com/libgit2/rugged). Server-side merges
and rebases ran on libgit2 because it needed no working directory. In
[*Scaling merge-ort across GitHub*](https://github.blog/engineering/infrastructure/scaling-merge-ort-across-github/)
(2023), GitHub reports that libgit2's merge-base selection sometimes failed
merges that local git handled, causing a steady stream of support tickets. It
moved merges to git's `merge-ort` strategy and rebases to the new
`git replay` command, both of which run without a worktree, validated with
Scientist experiments against production traffic:

- merges on `github/github`: P50 71 ms to 8 ms, P99 1.6 s to 330 ms;
- rebases: 730,000 experimental runs took 2.56 hours on libgit2 and under
  10 minutes on `merge-ort`.

Across these posts GitHub fixes scaling problems upstream in git (ref
transactions, bitmaps, MIDX bitmaps, geometric repacking, cruft packs,
`git replay`). The RPC layer between the Rails application and the file servers
is not described in these sources, so this document does not characterize it.

## Serving clones and fetches

- **Bitmaps** answer "which objects does this client need" without walking
  history; see the maintenance table. GitHub considered caching full clone
  responses in 2015 and rejected it, because a cache costs about as much disk as
  the repository and active repositories change constantly
  ([Counting objects](https://github.blog/2015-09-22-counting-objects/)).
  Whether GitHub.com caches generated packs today is not publicly documented.
- **Read routing.** Spokes routes reads to the closest in-sync replica, so more
  replicas means more read capacity
  ([Stretching Spokes](https://github.blog/engineering/infrastructure/stretching-spokes/)).
- **Protocol v2** has been supported since November 2018
  ([changelog](https://github.blog/changelog/2018-11-08-git-protocol-v2-support)).
  Its main benefit for large repositories is server-side ref filtering, so a
  fetch no longer starts with an advertisement of every ref.
- **Partial clone** is supported on GitHub.com and GHES 2.22+: blobless
  (`--filter=blob:none`) and treeless (`--filter=tree:0`)
  ([Stolee, 2020](https://github.blog/engineering/architecture-optimization/get-up-to-speed-with-partial-clone-and-shallow-clone/)).
  GitHub recommends blobless for large developer repos, treeless or shallow
  only for throwaway CI clones, and warns that **shallow fetches are expensive
  for the server** because they cannot use bitmaps. Treeless clones make
  `git log -- <path>` and `git blame` slow because they fault in root trees per
  commit.
- **Git LFS** keeps a pointer file (spec version, SHA-256 `oid`, size) in the
  repository and the content elsewhere. Per-file maximums are 2 GB (Free/Pro),
  4 GB (Team), and 5 GB (Enterprise Cloud)
  ([about LFS](https://docs.github.com/en/repositories/working-with-files/managing-large-files/about-git-large-file-storage)).

### Published limits

[Repository limits](https://docs.github.com/en/repositories/creating-and-managing-repositories/repository-limits)
lists recommendations rather than hard caps, except where marked "enforced",
and warns that exceeding them "increases the risk of degraded repository
health".

| Resource | Recommended maximum |
| --- | --- |
| On-disk size of `.git` | 10 GB |
| Entries per directory / directory depth | 3,000 / 50 |
| Branches | 5,000 ("unnecessary data in fetch operations") |
| Push size | 2 GB (enforced) |
| Single object | 1 MB recommended, 100 MB enforced |
| Git reads per repository | 15 per second |
| Pushes per repository | 6 per minute |
| Pull request merges | 1 per minute |
| Open pull requests against one branch | 1,000 |
| "Rebase and merge" | 100 commits |

Separately, GitHub warns at 50 MiB per file, blocks over 100 MiB, recommends
repositories under 1 GB, and "strongly" recommends under 5 GB
([large files](https://docs.github.com/en/repositories/working-with-files/managing-large-files/about-large-files-on-github)).
Dropbox described its Enterprise Cloud limit as 100 GB; the public pages above
do not state such a figure, so the actual ceiling appears to vary by plan or
arrangement.

## Ref updates and push policy

A push lands in this order, as far as the documentation describes it: the
receiving server checks policy (push rulesets, protected branch rules, and on
GHES pre-receive hooks), then Spokes commits the ref transaction across
replicas.

- **Pre-receive hooks** exist only on GitHub Enterprise Server. Each runs in an
  isolated environment; a non-zero exit rejects the push. All hooks for a
  repository share a fixed **5-second budget**, and a timeout fails the push
  even when enforcement is off. GitHub steers customers toward push rules, a
  kind of ruleset, instead
  ([about pre-receive hooks](https://docs.github.com/en/enterprise-server@latest/admin/enforcing-policies/enforcing-policy-with-pre-receive-hooks/about-pre-receive-hooks)).
- **Protected branches** apply one rule per branch (fnmatch pattern) with
  settings for required reviews, stale-approval dismissal, code owner review,
  required status checks (strict mode, the default, requires the branch to be
  up to date with the base), conversation resolution, signed commits, linear
  history, required deployments, merge queue, branch lock, push restrictions,
  and force-push and deletion controls
  ([about protected branches](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches)).
- **Rulesets** layer: any number can apply to a ref, they have no priority, and
  the most restrictive version of each rule wins. They have bypass lists,
  enforcement status, organization-wide targeting on Enterprise, and can
  constrain commit metadata. Push rulesets block pushes by path, extension, and
  size across the fork network. Limit: 75 per repository and 75 per
  organization ([about rulesets](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/about-rulesets)).
- **Signed commits** may be GPG, SSH, or S/MIME. GitHub verifies a signature at
  push time and stores a permanent record with `verified_at`, which survives key
  rotation and revocation and is not re-checked. Web UI commits are signed with
  GitHub's `web-flow` key. "Rebase and merge" produces unsigned commits because
  GitHub cannot sign as the user
  ([signature verification](https://docs.github.com/en/authentication/managing-commit-signature-verification/about-commit-signature-verification)).

## The pull request model

### Refs

A pull request is backed by hidden refs in the base repository.
`refs/pull/<n>/head` holds the head commits, even when they came from a fork,
and the `refs/pull/` namespace is read-only to clients ("deny updating a hidden
ref") ([checking out PRs locally](https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/reviewing-changes-in-pull-requests/checking-out-pull-requests-locally)).
GitHub also maintains a **test merge commit** of the head into the base, which
CI systems commonly fetch as `refs/pull/<n>/merge`; that ref name is widely used
but the pages cited here do not document it.

### Mergeability

Mergeability is computed asynchronously. The pulls API returns
`mergeable: true | false | null`, where `null` means a background job has
started, and `merge_commit_sha` is the test merge commit
([pulls API](https://docs.github.com/en/rest/pulls/pulls)). The
[git database guide](https://docs.github.com/en/rest/guides/using-the-rest-api-to-interact-with-your-git-database)
warns that merge refs can be stale and tells integrators to poll the pull
request until `mergeable` resolves before reading them. In February 2026 GitHub
stopped regenerating test merges on page views; they are now built only when the
head changes, the merge base changes, or the current one is older than 12 hours
([changelog](https://github.blog/changelog/2026-02-19-changes-to-test-merge-commit-generation-for-pull-requests/)).
The point is that each open pull request costs a server-side merge whenever its
branch moves, and the base branch moving changes the merge base for many of
them at once.

### Merge methods

| Method | Result on the base branch | Notes |
| --- | --- | --- |
| Merge commit | `--no-ff` merge commit | Blocked by "require linear history" |
| Squash and merge | One new commit, fast-forwarded | Loses original SHAs and per-commit authorship |
| Rebase and merge | Each commit rewritten as new commits | Always new committer and SHAs; drops empty commits; unsigned; 100-commit limit |

Source: [about merge methods](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/configuring-pull-request-merges/about-merge-methods-on-github).
The merge endpoint takes an optional `sha` that must match the PR head (409
otherwise), an optimistic check on the head, not on the base. The docs now
recommend an asynchronous merge API and note the synchronous endpoint does not
support merge queues or stacked pull requests
([pulls API](https://docs.github.com/en/rest/pulls/pulls)).

### Review and checks

- **CODEOWNERS** lives in `.github/`, the root, or `docs/` (first found wins),
  is read from the pull request's base branch, uses gitignore-like patterns
  where the last match wins, and must be under 3 MB or it is ignored. Owners
  need explicit write access. Branch protection can require one approval from
  any matching owner
  ([about code owners](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/about-code-owners)).
- **Statuses and checks.** Commit statuses are a simple per-SHA state any
  token can set. **Check runs** are richer (annotations, 50 per request) and
  writable only by GitHub Apps; both attach to a commit SHA, not to a pull
  request. GitHub keeps at most 1,000 check runs of the same name per suite and
  lists only the 1,000 most recent suites for a ref
  ([check runs API](https://docs.github.com/en/rest/checks/runs)).

## Merge queue

GitHub's own monorepo used "deploy trains" from about 2016: a conductor bundled
up to 15 pull requests, and derailed trains could cost developers 8 hours or
more. GitHub began replacing them in 2020, tested merge queue on small repos in
2021, migrated the monorepo through 2022 to 2023, and made merge queue generally
available in July 2023 after 30,000+ pull requests and 4.5 million CI runs. By
2024 over 500 engineers merged about 2,500 pull requests a month into the
monorepo, average wait to ship fell 33%, and groups of 30 or more changes could
ship together
([*How GitHub uses merge queue*](https://github.blog/engineering/engineering-principles/how-github-uses-merge-queue-to-ship-hundreds-of-changes-every-day/)).

How it works ([managing a merge queue](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/configuring-pull-request-merges/managing-a-merge-queue)):

1. A pull request that passes branch protection is queued, first in first out.
2. For each entry GitHub creates a temporary branch under
   `gh-readonly-queue/<base>/` holding the latest base plus every queued pull
   request ahead of it, plus this one. These are speculative merges: entry N is
   tested as if entries 1 to N-1 had already landed.
3. CI runs on that branch, triggered by the `merge_group` webhook
   (`checks_requested`) or by a `merge_group` trigger in Actions.
4. When an entry's group passes, it and everything ahead of it merge into the
   base together. A failure, timeout, conflict, or removal ejects the pull
   request, and the branches behind it are rebuilt without it.

| Setting | Range / meaning |
| --- | --- |
| Merge method | merge, rebase, or squash; the queue chooses, not the author |
| Build concurrency | 1 to 100 `merge_group` builds dispatched at once |
| Minimum / maximum PRs per merge | 1 to 100 each, plus a wait time for the minimum |
| Only merge non-failing PRs | if off, a failing entry can still land when a later group containing it passes |
| Status check timeout | after which checks count as failed |

Jumping the queue puts a pull request at the head, which invalidates every
in-flight speculative branch and forces a full rebuild. The queue still
serializes landing on one ref: concurrency buys parallel testing, not parallel
ref updates, and every ejection costs a rebuild of everything behind it. How
GitHub schedules builds internally beyond these settings is not published.

## APIs

### Git database API

GitHub exposes raw git objects over REST, which lets a client create a commit
with no clone
([guide](https://docs.github.com/en/rest/guides/using-the-rest-api-to-interact-with-your-git-database)):
read the branch's commit and tree, `POST` new blobs, `POST` a tree with
`base_tree` set to the old tree and entries overriding paths (an entry with
`sha: null` deletes a file), `POST` a commit with that tree and the old commit
as parent, then `PATCH` the ref.

| Endpoint | Notable behavior and limits |
| --- | --- |
| [Blobs](https://docs.github.com/en/rest/git/blobs) | `utf-8` or `base64`; reads support blobs up to 100 MB |
| [Trees](https://docs.github.com/en/rest/git/trees) | Recursive reads cap at 100,000 entries or 7 MB and set `truncated`; then walk subtrees one at a time |
| [Commits](https://docs.github.com/en/rest/git/commits) | Arbitrary parents, author, committer, and an optional caller-supplied PGP signature; response carries a `verification` object |
| [Refs](https://docs.github.com/en/rest/git/refs) | Update is fast-forward-only unless `force: true`; there is no expected-old-value parameter, so it is not a compare-and-swap |

The tree endpoint works on full git trees, so the cost of a change grows with
the width of each directory along the changed paths, not with the repository,
but a client still has to fetch the directories it rewrites.

The GraphQL mutation
[`createCommitOnBranch`](https://docs.github.com/en/graphql/reference/commits)
is the higher-level form: it takes file additions and deletions, appends one
commit to a branch as the authenticated user, and requires `expectedHeadOid`,
"the git commit oid expected at the head of the branch prior to the commit".
That is a genuine compare-and-swap on the branch. Commits it creates are signed
by GitHub where supported, and the author cannot be set.

### Contents and compare

- **Contents API** reads files up to 1 MB with full features, 1 to 100 MB raw
  only, and nothing over 100 MB; directory listings stop at 1,000 entries. Its
  `PUT` writes one file per commit, requires the old blob `sha` to update, and
  must not run concurrently with deletes
  ([contents API](https://docs.github.com/en/rest/repos/contents)).
- **Compare** returns up to 250 commits unpaginated and at most 300 files for
  the whole comparison. Get-commit pages files beyond 300 up to 3,000, and large
  `.diff`/`.patch` responses "may time out"
  ([commits API](https://docs.github.com/en/rest/commits/commits)).

### Rate limits

| Limit | Value |
| --- | --- |
| REST, authenticated | 5,000 requests/hour (15,000 for Enterprise Cloud apps) |
| `GITHUB_TOKEN` in Actions | 1,000/hour per repository |
| GraphQL | 5,000 points/hour; 500,000 nodes per query; 10-second timeout |
| Secondary | 100 concurrent requests; 900 REST / 2,000 GraphQL points per minute; about 80 content-creating requests per minute and 500 per hour |
| Git LFS | separate bucket, 3,000 requests/minute authenticated |

Sources: [REST limits](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api),
[GraphQL limits](https://docs.github.com/en/graphql/overview/rate-limits-and-query-limits-for-the-graphql-api).
The content-creation limit (about 8 commits per minute if each needs blob, tree,
commit, and ref calls) is what keeps the git database API from serving as a
high-volume commit path.

### Webhooks

Payloads are capped at 25 MB and are dropped if larger. A `push` event lists at
most 2,048 commits; pushing more than 5,000 branches at once emits no `push`
event, and pushing more than three tags emits no tag events
([events and payloads](https://docs.github.com/en/webhooks/webhook-events-and-payloads)).
Receivers must answer within 10 seconds or the delivery counts as failed
([handling deliveries](https://docs.github.com/en/webhooks/using-webhooks/handling-webhook-deliveries));
failed deliveries can be redelivered by request. Webhooks are notifications
with gaps, so integrations reconcile against the API.

## Monorepo pain points

GitHub's own monorepo, `github/github`, recurs across these posts: about 57 GB
before cruft packs, migrated off deploy trains to merge queue, and the
benchmark for the `merge-ort` rollout. The documented pain is push failures
from maintenance timeouts, a per-server push throttle, and long replica locks
(Project Cyclops, 2021); maintenance cost that grew with total size until
repacking became incremental; clone and fetch cost, addressed with bitmaps,
protocol v2, and partial clone; pack bloat from delta heuristics (Dropbox); and
merge throughput, which merge queue raised but the published guidance still
puts at about one merge per minute per repository.

## Where cost scales

| Cost driver | Grows with | Where it shows up |
| --- | --- | --- |
| Full clone | Reachable objects; bitmap coverage | Pack generation CPU and egress |
| Shallow fetch | History, because bitmaps cannot be used | Server CPU |
| Ref advertisement (v0/v1) | Number of refs | Bytes before any objects move; mitigated by v2 |
| Repack | Total objects (all-into-one) or new objects (geometric) | Maintenance CPU and failures |
| Ref update | Replicas, inter-DC latency, checksum work | Lock hold time; pushes per second |
| Unreachable objects | Force pushes, deleted branches | Disk and repack time until pruned |
| Test merges | Open PRs times base-branch movement | Background merge jobs |
| Merge queue | Queue depth times ejection rate | CI rebuilds |
| Tree API writes | Directory width along changed paths | API calls and payload size |
| Fork network | Forks sharing one object store | Delta selection constraints; whole-network policy |

## What this means for OpenScion

- **Server-side commit creation has precedent.** The git database API and
  `createCommitOnBranch` already let clients commit without a clone. OpenScion
  makes this the primary path rather than a rate-limited side door, and its
  changeset (changed files relative to the first parent) is closer to
  `createCommitOnBranch`'s additions and deletions than to the tree-rewriting
  REST flow. `expectedHeadOid` is the same compare-and-swap OpenScion uses for
  refs; the REST ref update, which is fast-forward-only with no expected old
  value, is the shape to avoid.
- **Merge queue and Land solve different problems.** Merge queue proves each
  landing commit green before the ref moves, at the cost of serialized landing,
  speculative rebuilds, and ejections. OpenScion's lock-free Land rebases and
  lands without a queue and leaves correctness to post-merge and pre-deploy
  testing, per the architecture's non-goals. Repositories that need pre-merge
  guarantees can still put a queue in front of Land; the queue's settings
  (concurrency, batch size, ejection rules) are a reasonable template.
- **Spokes ref voting versus single-record CAS.** Spokes replicates whole git
  repositories, so every ref update runs a three-phase commit across five
  replicas in three data centers, and its throughput target was a few updates
  per second per repository. OpenScion keeps refs in the metadata store and
  moves each with a single-record compare-and-swap; durability and replication
  belong to that store, and objects need no replica agreement because they are
  immutable and content-addressed. The Spokes checksum is still a useful idea
  for verifying a ref mirror cheaply.
- **Fork networks versus global content addressing.** GitHub deduplicates only
  within a fork network and pays for it in delta constraints, alternates, and
  network-wide policy. Global content addressing deduplicates everywhere with
  no network concept, but makes access control a question of which refs and
  paths a caller may reach, not which objects exist.
- **No packfiles, no maintenance.** Most of GitHub's storage engineering
  (bitmaps, geometric repacks, MIDX, cruft packs, delta islands, the pruning
  race) exists because git stores packs. OpenScion avoids that class of work,
  but must still answer the questions it was solving: reachability for fetch,
  compact storage of similar blobs, and garbage collection without racing
  writers.
- **Interop with GitHub.** A plausible shape, none of it designed yet:
  - *Mirroring out.* Export main and release refs to a GitHub repository as
    ordinary git, so GitHub-hosted CI, code search, and forks keep working.
    Exports should be incremental and stay under GitHub's push guidance
    (6 pushes per minute, 2 GB per push).
  - *Ingesting in.* Import from GitHub over the git protocol, then follow
    `push` webhooks, reconciling against the API because webhooks drop large
    events.
  - *Pull request integration.* Present OpenScion changesets as GitHub pull
    requests for review, with status reported through check runs (a GitHub
    App) and landing done by OpenScion rather than GitHub's merge button. The
    one-merge-per-minute guidance and the rate limits rule out landing at
    Scion's volume through GitHub's APIs.
  - *Policy.* CODEOWNERS, rulesets, and required checks have no OpenScion
    equivalent yet; interop either leaves them on the GitHub side or needs a
    mapping to OpenScion's per-path permissions.
