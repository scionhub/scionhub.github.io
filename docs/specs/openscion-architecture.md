# OpenScion architecture

- **Status:** Draft
- **Owner:** Maintainers
- **Companion specs:** [`openscion-data-model.md`](openscion-data-model.md),
  [`openscion-api.md`](openscion-api.md)
- **Plan:** not yet written; see [Delivery phases](#delivery-phases)

OpenScion is an open-source, server-centric source control system for
monorepos where most clients are always-online agents and CI jobs rather than
humans with laptops. It follows the design Anthropic described for its internal
system, Scion, in
[*Redesigning source control*](https://www.anthropic.com/engineering/redesigning-source-control),
and adapts it to open-source building blocks. Background notes on the original
system are in [`../research/scion.md`](../research/scion.md).

This document covers the problem, the principles, the components, and how the
work is sequenced. The data model and the RPC surface each have their own spec.

## Problem

Git assumes a decentralized world: every client holds a full copy of history,
computes merges and blame locally, and syncs by negotiating packfiles. An
agent-heavy monorepo inverts every one of those assumptions.

Anthropic reports the pressure concretely. Merged changes grew from about 2,500
per day in May 2026 to over 30,000 per day in September. Main-branch history was
almost 100 GB and a compressed working copy over 25 GB. CI alone performed about
25 million checkouts per day, which fetched naively would be more than 600 PB of
git traffic daily. The workarounds — hundreds of mirrors, shallow and sparse
clones, promisor remotes, blob-stored seeds — drifted from main and made diff
and blame harder to keep working.

The underlying mismatch is that nearly every client is online, short-lived, and
interested in a small slice of the tree, while git makes each one pay for the
whole repository and makes the server pay for packfile negotiation and
maintenance.

## Goals

- Make the cost of every write — commit, rebase, merge — proportional to the
  size of the change, never to the size of the repository or its history.
- Make the cost of every read proportional to what the caller actually asks for:
  a sparse checkout fetches only the trees and blobs under its paths.
- Expose source control as an API, so history, diff, blame, ancestry, rebase,
  revert, and landing work without a local working copy.
- Keep every stored object immutable and content-addressed, so any cache at any
  tier can serve it without coordination and any client can verify it.
- Keep global mutable state to the minimum: a small set of refs, each moved by
  a compare-and-swap on a single record.
- Ship as small, swappable pieces: storage behind ports, served through the
  same RPC contract at every tier.

## Non-goals

- **Replacing git for ordinary repositories.** OpenScion targets very large,
  trunk-based monorepos with many concurrent writers. A small project gets
  nothing from it but operational cost — the original authors say the same of
  Scion.
- **Offline-first operation.** Clients are assumed online. A client keeps a
  bounded cache, not a replica.
- **Branch-heavy workflows.** Refs exist for `main` and release lines. Work in
  progress is a changeset, not a branch.
- **Full DAG blame and history.** History and blame follow the first-parent
  (main) line, which is what matters in trunk-based development.
- **Code review, code search, and CI.** These are separate systems. OpenScion
  provides the APIs they need (see [Adjacent systems](#adjacent-systems)).
- **A global merge-queue lock.** Correctness after landing is the job of
  post-merge and pre-deploy testing, not of serializing every writer.

## Design principles

These are carried over from Scion, each with what it means here.

1. **Clients are always online.** A client fetches objects on demand and keeps
   a bounded local store. Nothing requires a full copy of history.
2. **The server computes; the client lays out files.** History, blame, commit
   creation, rebase, and merge run on the server. The client keeps its object
   cache, materializes working files, watches the filesystem, and provides the
   command-line ergonomics.
3. **Source control is an API.** Every query a CI job, a bisect pipeline, or a
   revert bot needs is an RPC. Those jobs need no checkout at all.
4. **Horizontal scale, no packfiles.** No component holds a materialized copy of
   the repository — not even the server. Objects are stored individually by id,
   so there is no repacking, garbage-collection pass, or other maintenance.
5. **Cheap, lock-free commits.** Creating a changeset appends to a log and does
   not touch any ref. Moving a ref is a separate, single-record compare-and-swap.
6. **Optional, sparse working copies.** CI can ask for a diff against a merge
   base without checking anything out; a checkout requests only the trees it
   needs, so sparse and (later) virtual checkouts need no special protocol.

## System overview

```text
          agents · CI jobs · humans
                    │
             opnscn (client CLI)  ── working copy, fs watcher, bounded cache
                    │  local RPC (Unix socket)
          openscion-daemon     ── one per node; node-wide object store
                    │  network RPC (same contract)
          openscion-cache      ── regional; immutable objects only, in memory
                    │  network RPC (same contract)
          openscion-server     ── authoritative: log, refs, derived data
              │            │
       metadata store   object store
   (log, refs, derived) (blobs, trees)
```

### Components

**`openscion-server`** — the authority. It owns the changeset log, the refs,
and the derived-data indexes, and it is the only component that creates
changesets or moves refs. It reads objects from the object store when no cache
above it has them.

**`openscion-cache`** — a regional read-through cache for content-addressed
objects. Because an object can never change, a cache needs no invalidation and
no long-lived state; it can be restarted empty at any time. It forwards every
non-object RPC upstream unchanged.

**`openscion-daemon`** — one per machine, holding the object store shared by
every job on that machine. It boots from a periodically refreshed snapshot of
recently used objects so that a fresh node does not start cold, and serves local
clients over a Unix socket.

**`opnscn`** — the client. It lays out a (possibly sparse) working copy, watches it
for edits, uploads new blobs, asks the server to create changesets, and offers
`log`, `diff`, `blame`, `land`, and friends as thin wrappers over the API.

### Uniform RPCs and strict tiering

The daemon, the cache, and the server answer the **same object RPCs with the
same semantics**, so a client never needs to know the topology: it talks to
whatever is nearest. Tiering is strict: each tier calls only the tier directly
above it, and each bounds its upstream concurrency. When a tier is saturated it
sheds load with `Unavailable` rather than queueing unboundedly or skipping a
tier, so a failed regional cache cannot turn into a stampede on the server.

Mutable queries — refs, the log, derived-data lookups — are always answered by
the server. Lower tiers forward them; they never cache them.

### Storage ports

Scion stores metadata in Spanner and file contents in cloud blob storage.
OpenScion keeps the same split behind two ports, so the engine never names a
backend:

| Port | Holds | Reference implementations |
| --- | --- | --- |
| `ObjectStore` | blobs and trees, keyed by object id | in-memory; local filesystem; S3-compatible object storage (later) |
| `MetadataStore` | changeset log, refs, derived-data values | in-memory; SQLite (single node); a transactional distributed store such as Postgres or FoundationDB (later) |

`ObjectStore` needs only put-if-absent and get-by-id. `MetadataStore` needs an
append-only log with monotonically increasing sequence numbers, point lookups by
id, and an atomic compare-and-swap on a single ref record. Nothing requires a
cross-record transaction, which is what lets the metadata store shard.

### Crate layout

- `crates/openscion-proto` holds every payload type that crosses a process
  boundary — object ids, changesets, refs, requests, responses, and the
  protocol version — with no transport, no runtime, and no behavior. `opnscn`, the
  daemon, the cache, the GUI's backend calls, and any third-party tool speak
  it.
- `crates/openscion-core` holds the engine: hashing, the data model, the log
  and ref stores behind their ports, derived data, and rebase. It is a plain
  Rust library, usable in-process with no transport, and re-exports the
  protocol crate so both name the same types.
- `crates/openscion-server` serves the engine as an HTTP JSON API. HTTP is the
  initial transport because the GUI and most tools already speak it; the
  open question below is whether tier-to-tier traffic keeps it.
- `crates/openscion` is `opnscn`, the CLI, published to crates.io as `openscion`.
- `apps/web` is the web GUI (Next.js and shadcn/ui). It renders on the server
  side and calls `openscion-server` like any other client.
- `benchmarks/` times the same scenarios against OpenScion and git on
  deterministic synthetic repositories.
- The daemon and the cache arrive as their own crates in the phases that
  introduce them. Every hop carries the same `openscion-proto` payloads, so
  the API contract is identical at every tier.

## Adjacent systems

Scion shipped alongside a review tool (Antique), code search, and CI
integrations. OpenScion leaves those out of scope but commits to the hooks they
need:

- **Review and approval rules.** Changeset metadata is an open key-value map,
  and landing is an explicit RPC. A review system can gate `Land` on its own
  approval state and can classify changes by inspecting the diff API — for
  example, telling a comment-only edit from a change to sensitive logic.
- **Access control.** Write permissions are enforced per directory prefix when a
  changeset is created; see [`openscion-api.md`](openscion-api.md#access-control).
- **CI.** `Diff` against a merge base and `ListTree` let CI select targets and
  read files without a checkout. `Log` with a range is the primitive automated
  bisect and revert pipelines build on.
- **Git interop.** An ingestion pipeline imports git history along the first
  parent into changesets, preserving order. Export to git is not planned for
  the first phases.

## Delivery phases

Each phase ends with the four contract commands green and its own plan in
`docs/plans/`. Later phases may be re-ordered; the first three may not, because
each builds on the one before.

1. **Core data model (in-process).** Object ids and hashing, blobs, trees,
   path validation, changesets, the in-memory log and ref store, root-tree
   derivation, and the in-process API for the basic reads and writes. The
   [core data model plan](../plans/openscion-data-model.md) delivers this
   phase in memory, with the server routes and `opnscn` import, commit, and clone
   on top.
2. **Derived data and queries.** The derived-data framework, generation numbers
   and first-parent skip lists, path history, `Log`, `Diff`, `MergeBase`,
   `IsAncestor`, `ListTree`, `Stat`.
3. **Server-side rebase and landing.** `Rebase`, `Land` with its retry loop over
   ref compare-and-swap, `Revert`, and file-level conflict reporting.
4. **Persistent stores.** Filesystem `ObjectStore`, SQLite `MetadataStore`, and
   crash-recovery tests for the log and refs.
5. **Client and daemon.** `opnscn` with sparse checkout, status via a filesystem
   watcher, commit, and land; the daemon's node-local store and snapshot boot.
6. **Git ingestion.** First-parent import of an existing git repository.
7. **Network tiers.** The inter-machine transport, the regional cache, load
   shedding, and the upstream concurrency bounds.
8. **Later.** Line-level blame, line-level three-way merge, virtual (FUSE)
   checkouts, read access control, and object chunking for very large files.

## Acceptance criteria

The architecture is accepted when:

- the data-model and API specs are accepted;
- every principle above maps to at least one invariant or acceptance criterion
  in those specs;
- a phase-1 plan exists in `docs/plans/` that implements the core data model
  test-first.

## Open questions

- **Transport.** gRPC, a plain HTTP/2 API, or a framed protocol carrying the
  `openscion-proto` payloads directly? It must work both over a local Unix
  socket (client to daemon) and between machines (daemon to cache to server).
- **Single-node first.** Should phases 1–5 target a single-node server with a
  SQLite metadata store as the reference deployment, deferring a distributed
  metadata store entirely? The current assumption is yes.
- **Repository identity.** One server process per repository, or a server that
  hosts many repositories under a namespace? Phase 1 assumes one repository per
  engine instance.
