# Background: Scion

Notes on the system OpenScion is modelled on, from Anthropic's engineering post
[*Redesigning source control*](https://www.anthropic.com/engineering/redesigning-source-control).
This is source material, not a spec: what OpenScion actually does is defined in
[`../specs/`](../specs/openscion-architecture.md). Where OpenScion departs from
Scion, the spec says so.

## Why Scion exists

Anthropic's monorepo grew as Claude took over most of the coding. Merged changes
went from about 2,500 per day in May 2026 to over 30,000 per day in September,
and the bottleneck moved to developer infrastructure built for human scale:
source control, builds, and CI.

| Pressure | Figure |
| --- | --- |
| Main-branch history | almost 100 GB |
| Compressed working copy | more than 25 GB |
| CI checkouts | about 25 million per day, excluding dev environments, agent sandboxes, and research jobs |
| Naive git traffic for those checkouts | over 600 PB per day |
| Git mirrors at peak | several hundred |

The workarounds — mirrors, shallow clones, sparse checkouts, promisor remotes,
seeds stored in blob storage — were strained. Seeds drifted from the tip of
main, and diff and blame on partial clones got harder to keep working. The root
problem was a model mismatch: git is decentralized and built for offline
clients holding full copies, and Anthropic was running it as a centralized
system where nearly every client was an always-online agent or job.

Prior art the team cites: Google's Piper and Meta's Sapling.

## Principles

1. **Always-online clients** fetch on demand instead of holding full copies.
2. **Client-server asymmetry.** The server does history, blame, commit
   creation, merges, and rebases. The client keeps a bounded object cache, lays
   out working files, watches the filesystem, and provides ergonomics.
3. **Source control as an API.** Many jobs need no local repository; automated
   bisect and revert pipelines depend on this.
4. **Horizontal scalability.** No fully materialized copy of the repo exists
   anywhere, even on the server. No packfiles, so no repository maintenance.
5. **Cheap, incremental, lock-free commits.** Server-side commits, rebases, and
   merges cost the size of the change. Refs are discouraged except for main and
   release branches, because global state every server must agree on is a
   scaling problem.
6. **Optional, sparse working copy.** CI can request a diff against a merge base
   without a checkout; checkouts are sparse, and virtualized checkouts
   materialize files on demand.

## Data model

- The unit of work is a **changeset**: an entry in a write-ahead log, created
  server-side and immediately visible everywhere.
- Unlike a git commit, which points at a tree, a changeset lists the files
  changed relative to its **first parent**, with content-addressed pointers to
  compressed blobs.
- Storing changes against the first parent only is a deliberate simplification:
  in trunk-based development, history and blame matter mainly on the main line.
- **Refs** are not involved in creating or fetching commits. Moving one is a
  compare-and-swap on a single Spanner row, separate from changeset creation.
- Everything else is **derived data** — blame indices, path history, skip lists
  over the commit graph — each type defined recursively from its parents'
  values. New indices (copy detection, path-based file search) can be added,
  each type can be computed eagerly or deferred, and internals can change
  without touching the client.
- The post does not specify how trees and blobs are hashed, only that all data
  is content-addressed and therefore cacheable anywhere.

## Storage and serving

- **Storage:** Spanner for metadata and refs; cloud blob storage for contents.
- **scion-daemon:** one per node, holding objects for every job on that node,
  reached over a socket, booted from a periodically refreshed snapshot.
- **scion-cache:** regional, streaming objects from memory in the disk format
  the daemon consumes.
- **scion-server:** authoritative; reads Spanner or blob storage on a miss.
- All three tiers answer **identical RPCs**, so clients never need to know the
  topology. Tiering is strictly enforced to isolate failure domains: a regional
  cache failure must not overwhelm the servers.

## Fetch protocol (`scn`)

- Negotiation does not tell the server what the client has; the client names
  only the trees and blobs it wants.
- From a root tree, the client checks its local store, fetches missing trees
  recursively, then missing blobs.
- Every request targets an immutable object, so tiered caches work well, and
  there is no multi-gigabyte packfile: transfers are efficient and resumable.
- Sparse and virtual checkouts need no special support — the client never asks
  for trees it does not need.

## Results reported

- Cache hit rate above 99% at each tier, with no long-lived state.
- CPU and memory footprint about 200x smaller than the git mirror fleet.
- CI and research checkouts dropped from minutes to seconds; CI alone gained a
  25% CPU capacity win.
- No repository maintenance for clients or caches.

## Merging, review, and access control

- Merges and rebases run on the server, so there is nothing to push.
- There is no global lock on the merge queue. Post-merge and pre-deploy testing
  catch breakage; concurrent changes can conflict, and Claude usually fixes the
  conflict faster than a human would notice it.
- The review tool, **Antique**, expresses semantic approval rules — for
  example, distinguishing a comment-only change from a change to sensitive
  logic, so humans spend attention on consequential edits.
- Per-directory permissions protect sensitive code inside the monorepo.

## Building it

- A seven-person team built Scion, Antique, and related systems and completed
  the migration in five months while daily merges grew tenfold.
- The hand-written git ingestion pipeline was later rewritten by a model with no
  extra instructions; the rewrite used 20x less memory and ran 4x faster while
  preserving ordering and data-structure invariants.
- Recurring human work was saying "no" when generated code violated system
  constraints: brute-force scanning the commit log instead of querying the
  index, or over-defensive validation driven by hypothetical concerns.
- Agents ("superfans") watched individual components through telemetry and logs
  and caught anomalies static alerts missed.

## Caveats from the authors

- Scion is not a general git replacement. It makes sense only for enormous
  monorepos with tens of thousands of engineers or swarms of agents.
- Adopting it means migrating the whole development lifecycle — review, code
  search, CI — and those integrations are bespoke.
- The authors chose not to publish a generic version, worrying it would serve
  no one well. They suggest instead that git forges offer comprehensive
  server-side RPCs, ideally standardized, and that git's negotiation, sparse,
  and shallow features be reworked to compose better.

## What this means for OpenScion

OpenScion is exactly the generic version the authors chose not to build, so it
has to earn its keep where they said such a system would struggle:

- **Small deployments must stay simple.** A single-node server with a local
  metadata store is the reference deployment; the tiers are optional.
- **Adoption cannot require replacing everything at once.** Git ingestion and
  an API that review, search, and CI tools can call are first-class goals.
- **The storage backends are ports**, not Spanner and a specific blob store.
