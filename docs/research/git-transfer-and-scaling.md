# Background: git transfer and scaling

Notes on how git moves objects between machines, how it has been stretched
for very large repositories, and what the big monorepo systems built instead.
This is source material, not a spec: what OpenScion does is defined in
[`../specs/openscion-architecture.md`](../specs/openscion-architecture.md) and
its companions; background on Scion is in [`scion.md`](scion.md). Facts come
from git's [documentation](https://git-scm.com/docs) and the teams' own
write-ups. Each section names where its cost grows with repository size.

Two git repositories synchronize by working out which objects one side lacks
and shipping them as a **packfile**: a stream of objects, many stored as deltas
against others in the pack (or, in a *thin pack*, against objects the receiver
already has). Everything below decides which objects to send, builds the pack
cheaply, or avoids sending a pack at all.

## Transports

| Transport | How it runs | Notes |
| --- | --- | --- |
| `file://` | Runs `git-upload-pack` / `git-receive-pack` locally over a pipe | Same protocol as ssh and git:// |
| `ssh://` | Runs the same programs on the remote host | Authentication and encryption come from SSH |
| `git://` | A daemon on port 9418 | Unauthenticated; receive-pack over it is writable by anyone who can reach the port |
| Smart HTTP | `GET info/refs?service=git-upload-pack`, then `POST` to `git-upload-pack` or `git-receive-pack` | Stateless from the server's side; the default for hosted git |
| Dumb HTTP | Plain `GET`s of static files (`info/refs`, loose objects by path, packs) | Needs no git-aware server; no negotiation at all |

Over file, ssh, and git:// the
[pack protocol](https://git-scm.com/docs/gitprotocol-pack) is a stateful conversation on one
connection. [Smart HTTP](https://git-scm.com/docs/gitprotocol-http) turns it into self-contained `POST`s: the server keeps
no state between requests (so round-robin load balancing works), and each
negotiation request repeats the wants and the haves already found common. A
client tells smart from dumb by the `application/x-git-upload-pack-advertisement`
content type, which a dumb server may not use.

## Framing: pkt-line and sideband

All smart protocols are framed as **pkt-lines**
([gitprotocol-common](https://git-scm.com/docs/gitprotocol-common)). Each line
starts with four lowercase hex digits giving the total length including the
prefix; the payload is binary-safe and at most 65516 bytes, so a line is at
most 65520 bytes. Special packets carry no payload: `0000` flush-pkt ends a
message; protocol v2 adds `0001` delim-pkt between sections and `0002`
response-end-pkt to end a response on stateless connections.

The pack itself is usually **multiplexed** onto pkt-lines with a one-byte
sideband code per packet: `1` pack data, `2` progress for stderr, `3` fatal
error ([gitprotocol-capabilities](https://git-scm.com/docs/gitprotocol-capabilities)).
`side-band` allows 999 data bytes per packet and `side-band-64k` allows 65519.
Protocol v2 always multiplexes the packfile section this way and adds
`sideband-all`, which multiplexes the entire response and lets the server send
`0005\2` as a keepalive.

## Protocol v0/v1 versus v2

**v0/v1.** The server speaks first. It advertises **every** ref it has, sorted
by name, with `HEAD` first and peeled values for annotated tags; the first line
carries the capability list after a NUL byte. Only then does the client say
what it wants. v1 is v0 with a leading `version 1` line.

**v2** ([gitprotocol-v2](https://git-scm.com/docs/gitprotocol-v2)) inverts
this. The server first sends only a capability advertisement (`version 2`
followed by `key[=value]` lines, which clients must ignore if unknown). The
client then issues one **command** per request: `command=<name>`, capability
lines, a delim-pkt, command arguments, and a flush-pkt. v2 is stateless by
design; clients must not require state on the server. The client requests v2
through the `GIT_PROTOCOL` environment variable over ssh and file, an extra
`version=2` parameter over git://, and a `Git-Protocol: version=2` header over
HTTP.

| Command | Purpose |
| --- | --- |
| `ls-refs` | List refs; arguments `ref-prefix <p>` (repeatable), `symrefs`, `peel`, `unborn`. Prefix filtering is an optimization the server may ignore, so clients still filter. |
| `fetch` | Negotiate and receive a pack (below) |
| `object-info` | Return `size` and/or `type` for named object ids without sending them |
| `bundle-uri` | Return a list of pre-built bundles to download before fetching |

The motivation was the ref advertisement. Google's
[announcement](https://opensource.googleblog.com/2018/05/introducing-git-protocol-version-2.html)
notes that Chromium had over 500,000 branches and tags, so a v0 fetch of one
branch received tens of megabytes of advertisement first; with server-side ref
filtering they measured a 3x improvement for no-op single-branch fetches and an
8x reduction in non-packfile overhead bytes. v2 became the default in git
2.26 ([release notes](https://github.com/git/git/blob/master/Documentation/RelNotes/2.26.0.adoc)).

**v2 `fetch`** takes `want`, `have`, `done`, pack options (`thin-pack`,
`ofs-delta`, `include-tag`), shallow controls (`shallow`, `deepen`,
`deepen-relative`, `deepen-since`, `deepen-not`), `filter`, `want-ref`,
`sideband-all`, `packfile-uris`, and `wait-for-done`. The response is optional
sections (`acknowledgments`, `shallow-info`, `wanted-refs`, `packfile-uris`)
then `packfile`. Wants "are not limited to advertised objects", but
upload-pack's `uploadpack.allow{Tip,Reachable,Any}SHA1InWant` settings decide
which unadvertised ids it accepts.

**Where cost scales.** In v0 every fetch first pays for an advertisement
proportional to the ref count; v2 removes that but not negotiation.

## Fetch negotiation

The client must tell the server what it already has so the server can avoid
resending it ([gitprotocol-pack](https://git-scm.com/docs/gitprotocol-pack)):

1. The client sends `want` lines, then walks its own history and sends
   `have` lines in blocks of 32, keeping a block in flight.
2. The server answers `ACK <oid> common` for haves it shares, `ACK <oid>
   ready` once it can build a good pack (`multi_ack_detailed`), or `NAK`.
3. The client stops walking a line once it is acknowledged, and sends `done`
   when satisfied; the canonical client gives up after 256 haves with no new
   ACK. `no-done` lets the server send the pack right after `ready`.
4. The server sends everything reachable from the wants minus everything
   reachable from the common haves.

**Negotiation algorithms.** `fetch.negotiationAlgorithm` selects how the client
picks haves ([fetch config](https://git-scm.com/docs/git-config#Documentation/git-config.txt-fetchnegotiationAlgorithm)):

| Value | Behaviour |
| --- | --- |
| `consecutive` (default) | Walk consecutive commits, checking each |
| `skipping` | Skip commits to converge in fewer round trips, at the risk of a larger-than-necessary pack. In [`negotiator/skipping.c`](https://github.com/git/git/blob/master/negotiator/skipping.c) the gap grows by about 1.5x at each step. Default under `feature.experimental`. Added in git 2.19. |
| `noop` | Send no haves; skip negotiation and accept a larger pack |

`git fetch --negotiation-tip` (also 2.19) limits which local refs send haves.

**Why negotiation cost grows.** The client walks its own commit graph and the
server must look up every have; the number of rounds depends on how far the
client's refs have diverged from the server's and on how many local refs it
has. Over smart HTTP each round resends the accumulated common haves because
the server keeps no state. The server's final set difference is a reachability
walk over history unless bitmaps (below) can answer it. None of this work is
cacheable across clients, because each client's have set is different.

## Push

`git push` runs `receive-pack`, which advertises refs and capabilities. The
client sends `old-id new-id refname` per ref (zero id to create or delete),
then a pack (thin by default) of what the server lacks. The server unpacks it,
checks each `old-id` still matches, runs hooks, updates refs, and reports `ok`
or `ng <ref> <reason>` per ref.

With `atomic`, all ref updates happen in one transaction, all or none. With
`push-cert`, the command list is wrapped in a GPG-signed certificate naming the
pusher, the target URL, and a server-supplied nonce that prevents replay.

The client builds the pack from the refs the server advertised, so push has
fetch's knowledge problem in reverse. A push to a moved branch fails
non-fast-forward and the client must fetch, rebase or merge, and retry.

## Server-side pack generation

`upload-pack` hands the want and common-have sets to `git pack-objects`, which
enumerates objects ("counting objects"), chooses deltas, and writes the pack.

**Reachability bitmaps.** For selected commits, a bitmap marks every object
reachable from that commit, by position in a pack (or multi-pack index). A
repository has at most one bitmap index
([bitmap format](https://github.com/git/git/blob/master/Documentation/technical/bitmap-format.adoc)).
GitHub's [*Counting Objects*](https://github.blog/engineering/architecture-optimization/counting-objects/)
(Vicent Martí, 2015) describes the motivation: a Linux kernel clone reported
4,350,078 objects to count and could take up to 8 minutes of server CPU. With
EWAH-compressed bitmaps on branch tips, recent commits, and a sample of older
history (one in every 3,000 commits near the end of the graph), the lookup
took under 3 ms, the index cost 5 to 10% of repository size, and average CPU
time on git network operations fell by more than 90%. The work shipped in
git 2.0. `repack.writeBitmaps` defaults to true on bare repositories.

**Pack reuse.** With bitmaps, `pack.allowPackReuse` sends parts of an on-disk
pack verbatim (`multi`: across a multi-pack index), avoiding re-encoding.

**Delta islands.** Reuse fails when an on-disk delta's base is something the
client will not receive; the server must "break" the delta and search for a new
one at high CPU cost. This bites when one object store holds several groups of
refs fetched separately, such as forks. `pack.island` groups refs into islands
and forbids deltas against a base not in all of an object's islands, trading
slightly larger packs for reusable ones
([git-pack-objects](https://git-scm.com/docs/git-pack-objects#_delta_islands)).

**Caching whole responses.** `uploadpack.packObjectsHook` runs a configured
command in place of `git pack-objects` with the same input. Gitaly's
[pack-objects cache](https://gitlab.com/gitlab-org/gitaly/-/blob/master/doc/design_pack_objects_cache.md)
uses it so identical concurrent fetches, typically CI jobs on one commit, share
one pack. It is off by default, keeps entries 5 minutes, and does little for
unique fetches ([docs](https://docs.gitlab.com/administration/gitaly/configure_gitaly/#pack-objects-cache)).

**Bundle URIs.** A bundle is a pack plus a header of refs and prerequisites.
With bundle URIs the server (via the v2 `bundle-uri` command) or the user (via
`git clone --bundle-uri`, git 2.38) points the client at pre-built bundles on
any static host or CDN. The client downloads them, then runs a normal fetch
advertising the bundle tips as haves, so the origin only builds the remainder.
Lists of bundles may say whether all or any are needed, and a `creationToken`
heuristic (git 2.40) lets incremental fetches download only newer bundles
([bundle-uri design](https://github.com/git/git/blob/master/Documentation/technical/bundle-uri.adoc)).
Clients must degrade gracefully when bundles are unavailable.

**Packfile URIs.** A v2-only extension: the server replaces part of the pack
with a `packfile-uris` section of URIs and pack hashes, which the client
downloads before its connectivity check. git's experimental server side
offloads blobs listed in `uploadpack.blobPackfileUri`; clients opt in through
`fetch.uriprotocols`, empty by default
([packfile-uri design](https://github.com/git/git/blob/master/Documentation/technical/packfile-uri.adoc)).

**Where cost scales.** Without bitmaps, counting walks all history reachable
from the wants; bitmaps need repacking, proportional to the whole repository.
Response caches help only identical requests, and bundles drift from the tip
until regenerated.

## Sending less: shallow, partial, and sparse

**Shallow clone** cuts history. `--depth`, `--shallow-since`, and
`--shallow-exclude` map to `deepen`, `deepen-since`, and `deepen-not`. The
client records the boundary commits in `.git/shallow` and sends them as
`shallow` lines on every later fetch; the server replies with `shallow` and
`unshallow` lines as the boundary moves. `--deepen` and `deepen-relative` move
the boundary back.

**Partial clone** cuts objects. The client sends a `filter`, the server omits
matching objects, and the client fetches them later on demand
([partial-clone design](https://git-scm.com/docs/partial-clone),
[filter specs](https://git-scm.com/docs/git-rev-list#Documentation/git-rev-list.txt---filterltfilter-specgt)):

| Filter | Effect |
| --- | --- |
| `blob:none` | Omit all blobs (a "blobless" clone) |
| `blob:limit=<n>` | Omit blobs of at least n bytes |
| `tree:<depth>` | Omit trees and blobs at depth >= n from the root; `tree:0` is a "treeless" clone |
| `sparse:oid=<blob>` | Omit blobs outside the sparse-checkout patterns stored in that blob |

`object:type` and `combine:` also exist. Servers opt in with
`uploadpack.allowFilter` and can ban filters individually.

**Promisor remotes and lazy fetch.** Packs received under a filter are marked
with a `.promisor` file; any object they reference but do not contain is
treated as promised rather than corrupt, so git need not keep a list of missing
objects (the design notes estimate such a list at about 2 GiB for 100 million
blobs). When a lookup misses, git fetches the object from a promisor remote
(several may be configured, tried in order). Known limitations:

- Dynamic fetches mostly happen **one object at a time**, because most
  algorithms need each object before continuing, adding round trips and
  repeated authentication. `checkout` batches the blobs it needs.
- A lazy fetch reuses fetch without negotiation, so it also returns objects
  referenced by the requested ones; it uses protocol v0, so each one receives
  the full ref advertisement.

Derrick Stolee's [guide](https://github.blog/open-source/git/get-up-to-speed-with-partial-clone-and-shallow-clone/)
(GitHub, 2020) gives the practical consequences. Blobless clones are the most
widely used option; `git log -- <path>` works as in a full clone, but
`git blame` and checkouts download blobs the first time. Treeless clones are
recommended only for automated builds: a path-limited `git log` can download
root trees for almost every commit in history. Shallow clones are recommended
only for builds that delete the repository afterwards, because a shallow
client's later fetch can force the server to walk the full history, without
bitmaps, and serve almost a full clone.

**Sparse checkout** cuts the working tree, not the object store.
`git sparse-checkout` in cone mode (the default) restricts patterns to
directories, which made matching fast enough for large trees; the optional
sparse index shrinks the index to match
([git-sparse-checkout](https://git-scm.com/docs/git-sparse-checkout)). On its
own it still downloads every blob; combined with a blobless clone, only the
blobs inside the cone are fetched at checkout.

**Why the pieces compose poorly.** Each mechanism trims a different axis:
shallow trims the commit graph, filters trim object kinds or sizes, sparse
checkout trims paths in the working tree. They are negotiated separately.
The partial-clone design calls itself independent of DAG-level limits such as
shallow clone, and the only path-aware filter, `sparse:oid`, names a blob the
server must already hold. History queries on a shallow clone stop at the
boundary; on a blobless clone they trigger serial lazy fetches; on a treeless
clone they can fetch a tree per commit. Each lazy fetch is a fresh fetch with
its own advertisement and pack generation. The Scion authors' closing
recommendation, recorded in [`scion.md`](scion.md#caveats-from-the-authors),
was that negotiation, sparse, and shallow be reworked to compose better.

**Where cost scales.** Shallow fetches trade bitmaps for graph walks at the
boundary. Partial clones still hold every commit (and, if blobless, every
tree), so they grow with history, and each missing object costs a round trip.

## Large-repository tooling around git

**Git LFS.** Large files are replaced in git by a pointer under 1024 bytes:
`version https://git-lfs.github.com/spec/v1`, `oid sha256:<hex>`, `size <n>`
([spec](https://github.com/git-lfs/git-lfs/blob/main/docs/spec.md)). A clean
filter stores content under `.git/lfs/objects` and a pre-push hook uploads it;
a smudge filter downloads it at checkout. Transfers go through a separate
[batch API](https://github.com/git-lfs/git-lfs/blob/main/docs/api/batch.md):
`POST .../info/lfs/objects/batch` with `operation` (`download` or `upload`) and
a list of `{oid, size}`, answered with per-object `href`, optional `header`,
and `expires_in`. In effect it is a second, per-object, content-addressed
protocol beside git's, with responses that can point at a CDN.

**VFS for Git and the GVFS protocol.** Microsoft built VFS for Git (formerly
GVFS) to move the Windows codebase to git. Brian Harry's 2017
[post](https://devblogs.microsoft.com/bharry/the-largest-git-repo-on-the-planet/)
gives about 3.5 million files, about 300 GB, roughly 4,000 engineers, and 8,421
pushes per day; before GVFS many git commands took 30 minutes to hours. VFS
for Git virtualizes the working directory on Windows and downloads objects only
as needed ([README](https://github.com/microsoft/VFSForGit)). Its
[protocol](https://github.com/microsoft/VFSForGit/blob/master/Protocol.md) sits
beside git's:

| Endpoint | Returns |
| --- | --- |
| `GET /gvfs/objects/{id}` | One object as a compressed loose object |
| `POST /gvfs/objects` | Many objects by id, as a pack (or loose objects from a cache server); `commitDepth` adds parent commits and their trees, no blobs |
| `GET /gvfs/prefetch` | Timestamped packs of non-blob objects; `lastPackTimestamp` resumes after a cut-off |
| `POST /gvfs/sizes` | Uncompressed sizes for object ids |
| `GET /gvfs/config` | Allowed client versions and a list of cache servers |

This is the closest git-world precedent to a want-only, per-object protocol:
the client names the objects it lacks, and regional cache servers answer.
Proxies cut a clone from North Carolina from almost 25 minutes to 70 seconds
in Harry's figures. The README now recommends Scalar for new deployments.

**Scalar.** The [story of Scalar](https://github.blog/open-source/git/the-story-of-scalar/)
(Stolee and Dye, 2022) explains the pivot: the Office monorepo needed macOS,
where the kernel features virtualization depended on were deprecated, so the
team used sparse checkout instead, adding cone mode and pairing it with the
filesystem monitor. Scalar joined core git in 2.38. `scalar clone` fetches
only commits and trees, starts a cone-mode sparse checkout of top-level files,
enables background maintenance ([scalar](https://git-scm.com/docs/scalar)),
and turns on the built-in FSMonitor where supported. Microsoft's path shows
how far git's own model can be pushed, and where it stops: the commit graph,
trees, and maintenance remain every client's problem.

**FSMonitor.** `core.fsmonitor=true` starts a built-in daemon (Windows and
macOS) that reports changed paths so `git status` need not scan the whole
working tree; older setups use a hook such as Watchman.

**Commit-graph and maintenance.** The commit-graph file stores, per commit, its
parents by integer position, commit date, root tree, and a generation number,
so graph walks skip decompressing and parsing commits
([design](https://github.com/git/git/blob/master/Documentation/technical/commit-graph.adoc)).
`--changed-paths` adds per-commit Bloom filters of paths changed against the
first parent, which speeds `git log -- <path>`. `git maintenance` runs these as
background tasks: `commit-graph`, `prefetch` (fetch into `refs/prefetch/`),
`loose-objects`, `incremental-repack` via multi-pack-index, `pack-refs`, and
`gc`, which the docs warn repacks everything into one pack and can be expensive
([git-maintenance](https://git-scm.com/docs/git-maintenance)).

**Where cost scales.** LFS and GVFS scale with what is read, but only for the
objects they cover. The client-side tools make local operations proportional
to the change, yet every client still holds the commit graph and maintains it.

## Prior art: monorepo systems beyond git

### Google: Piper and CitC

Rachel Potvin and Josh Levenberg,
[*Why Google Stores Billions of Lines of Code in a Single Repository*](https://research.google/pubs/why-google-stores-billions-of-lines-of-code-in-a-single-repository/)
(CACM, 2016), describe the repository as of January 2015: about one billion
files, about 35 million commits, 86 TB, about two billion lines of code in nine
million source files. On a typical workday engineers committed about 16,000
changes and automated systems another 24,000.

- **Piper** is the server, built on Bigtable and later Spanner, distributed
  over 10 data centers with Paxos; caching and asynchronous operations hide
  network latency. It supports file-level access control lists.
- **CitC** (Clients in the Cloud) pairs cloud storage with a Linux-only FUSE
  filesystem. Developers see the whole codebase, but a workspace stores only
  modified files; the average has fewer than 10.
- Development is trunk-based, with changes in a single serial order. The
  authors found moving to git or a DVCS that split the repository not
  compelling, and were experimenting with scaling Mercurial instead.

### Meta: Sapling, EdenFS, and Mononoke

Meta's [Sapling announcement](https://engineering.fb.com/2022/11/15/open-source/sapling-source-control-scalable/)
(2022) open-sourced the client, which also works against git hosts. With the
Meta server and virtual filesystem, the monorepo has tens of millions of files,
commits, and branches. Clones download almost no history; Segmented Changelog
fetches the commit graph's high-level shape in a few megabytes and fills in
individual commits later, and the client fetches "just the commits, trees, and
files you actually need".

**EdenFS** ([overview](https://github.com/facebook/sapling/blob/main/eden/fs/docs/Overview.md))
is the virtual filesystem: FUSE on Linux, NFSv3 on macOS, ProjFS on Windows. It
fetches file data lazily, speeds status and checkout, reports changes through
Watchman, and can return content hashes without reading files.

**Mononoke** ([README](https://github.com/facebook/sapling/blob/main/eden/mononoke/README.md),
[docs](https://github.com/facebook/sapling/tree/main/eden/mononoke/docs)) is
the server, written mainly in Rust and published while still in development,
with some internal pieces omitted. The open-source build has MySQL, SQLite,
file, and S3 backends. Its design is the closest open-source precedent for
OpenScion:

- **Bonsai changesets** ([data model](https://github.com/facebook/sapling/blob/main/eden/mononoke/docs/2.1-bonsai-data-model.md)).
  Every commit, whether from git, Mercurial, or Sapling, is stored as a
  Bonsai changeset: ordered parents, author and optional committer, message,
  VCS-specific extras, and a **flat list of full-path file changes** pointing
  at content ids, with explicit copy-from information. There are no stored
  trees in the changeset. Ids are Blake2b-256 over a Thrift compact
  serialization; file contents are hashed separately and chunked when large.
- **Inherent versus derived data.** Only changesets, content blobs, and the
  original VCS bytes are source of truth. Everything else is derived data:
  fsnodes and unodes (directory manifests), skeleton manifests, blame, fastlog
  history, git commits and trees, Mercurial manifests. Each type implements
  `derive_single` from a changeset plus its parents' derived values, declares
  dependencies on other types, and is stored by changeset id
  ([derived data](https://github.com/facebook/sapling/blob/main/eden/mononoke/docs/2.3-derived-data.md)).
  The write path stores only inherent data; derivation happens asynchronously,
  on demand, by backfill, or through a remote derivation service.
- **Git as a view.** The git server speaks smart HTTP and derives git commits
  and trees from Bonsai on demand, keeping a `bonsai_git_mapping` table
  ([git support](https://github.com/facebook/sapling/blob/main/eden/mononoke/docs/5.1-git-support.md)).
- **Storage split.** An immutable, content-addressed blobstore behind a stack
  of decorators (prefixing, two-level caching, multiplexing, packing,
  redaction, throttling) and a SQL metadata database for bookmarks, VCS
  mappings, and the commit graph index
  ([storage](https://github.com/facebook/sapling/blob/main/eden/mononoke/docs/2.4-storage-architecture.md)).
- **Pushrebase.** The server rebases pushed commits onto a moved bookmark when
  the files touched do not overlap, instead of rejecting the push
  ([pushrebase](https://github.com/facebook/sapling/blob/main/eden/mononoke/docs/4.1-pushrebase.md)).

## Where cost scales: summary

| Mechanism | Grows with |
| --- | --- |
| v0 ref advertisement | Number of refs, on every fetch |
| Negotiation | Divergence between client and server history; number of client refs; resent each round over HTTP |
| Counting objects without bitmaps | Reachable history from the wants |
| Bitmaps and pack reuse | Repack cost proportional to the whole repository |
| Delta search | Objects whose on-disk deltas cannot be reused |
| Response cache | Effective only for identical requests within its window |
| Bundles | Regeneration cadence; staleness against the tip |
| Shallow fetch | Graph walk across the boundary, without bitmaps |
| Blobless clone | Commits and trees for all history on every client |
| Lazy fetch | One round trip per missing object, plus advertisement |
| Commit-graph, maintenance | History size, on every client |
| Piper, Mononoke, GVFS objects | What is read, plus server-side indices |

## What this means for OpenScion

OpenScion's fetch ([`openscion-api.md`](../specs/openscion-api.md#fetch-protocol))
has the client resolve a changeset, read its root tree, and request missing
trees and then blobs by id with `GetObjects`, verifying each against its
BLAKE3 id. There is no have-negotiation, every request names immutable
objects, and the daemon, cache, and server tiers answer the same RPCs.
Against each git mechanism:

- **Ref advertisement.** Replaced by `ResolveRef` for the one ref wanted, so
  ref count never enters the fetch path; v2's `ls-refs` only approximates this.
- **Negotiation.** Gone. The client consults its own store, so no server walks
  the client's history and nothing is resent per round. The price is more
  requests for a cold checkout than one pack, which batching and tiers absorb.
- **Pack generation, bitmaps, delta islands, repacking.** No per-client pack
  exists. Responses are keyed by object id and cacheable indefinitely at any
  tier, where git's pack-objects cache matches identical requests for minutes.
  OpenScion gives up cross-object deltas on the wire and should measure that.
- **Bundle and packfile URIs.** These move git's bytes onto static hosts.
  OpenScion's objects are already static; the daemon and cache tiers do the
  job without staleness, since an id never names different bytes.
- **Shallow clone.** Unneeded: a changeset's tree never requires its history,
  and history questions go to the server's derived data.
- **Partial clone and lazy fetch.** Every checkout is partial by design.
  Batched `GetObjects` replaces one-object dynamic fetch, and there is no
  promisor bookkeeping because the client never claims completeness.
- **Sparse checkout.** Just the path set the client walks, with no filter
  negotiation; sparse and virtual checkouts use the same RPCs. This is the
  composition the Scion authors asked git for.
- **Push.** Replaced by `HasObjects`, `PutBlobs`, and server-side changeset
  creation. Mononoke's pushrebase is the nearest precedent for landing onto a
  moved ref without a client retry loop.
- **LFS and GVFS.** Per-object, content-addressed side protocols bolted onto
  git. OpenScion makes that the only protocol; whether `GetObjects` streams
  large responses is still an open question in the API spec.
- **Client-side tools.** Commit-graph and maintenance exist because each git
  client holds history. OpenScion clients hold a bounded cache, so maintenance
  reduces to eviction; FSMonitor-style change tracking still applies.

**Study Mononoke closely.** Bonsai changesets are a very close precedent for
OpenScion changesets: a flat list of full-path file changes pointing at
content-addressed blobs, with trees and history indices as derived data
computed from a changeset and its parents. OpenScion differs in recording
changes against the first parent only, hashing with BLAKE3, and serving trees
as fetchable objects to a tiered cache. Mononoke's derived-data framework
(dependency ordering, backfill, a remote derivation queue), blobstore
decorator stack, on-demand git view, and pushrebase conflict rule are worked
examples of problems OpenScion's specs leave open. Piper and CitC show the
same split at larger scale but are not open source.
