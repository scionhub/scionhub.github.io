# OpenScion API

- **Status:** Draft
- **Owner:** Maintainers
- **Parent spec:** [`openscion-architecture.md`](openscion-architecture.md)
- **Data model:** [`openscion-data-model.md`](openscion-data-model.md)

This spec defines the operations every OpenScion component exposes, their
inputs, outputs, and errors, the object fetch protocol, and server-side rebase
and landing. It is transport-independent: the payload types live in
`crates/openscion-proto`, and the in-process engine, the daemon, the cache, and
the server all speak them.

## Problem

CI jobs, bisect and revert pipelines, review tools, and agents mostly need
answers — what changed, where did this line come from, is this an ancestor of
that — not a working copy. And clients that do need files should fetch exactly
the files they read. Both require the server to own the computation and expose
it as a stable API.

## Goals

- One operation per question a tool asks, answered without a checkout.
- An object fetch that names only what the client wants, so every response is
  cacheable by id at every tier.
- Writes that never take a global lock: create changesets freely, rebase on the
  server, and land with a compare-and-swap retry loop.

## Non-goals

- A transport. The wire framing is an open question in the architecture spec.
- Authentication. The API receives an authenticated principal from its
  transport; how that principal is established is out of scope here.
- Line-level operations (blame, three-way content merge) in the first phases.

## Conventions

- Every operation takes one request struct and returns one response struct, so
  fields can be added compatibly. Request and response types are
  `#[non_exhaustive]` serde types in the protocol crate.
- Ids travel as 64-character lowercase hex strings, paths as strings, bytes as
  standard padded base64 (RFC 4648) strings.
- Adding an optional field or a new operation is compatible and bumps the minor
  protocol version. Removing or renaming a field or operation, or changing a
  type, is breaking and bumps the major version.
- `PROTOCOL_VERSION` is a `(major, minor)` pair. A client binds to a server when
  the majors match and the server's minor is at least the client's.
- Errors are a closed, typed set (see [Errors](#errors)). An error never carries
  file contents.

## Operations

Operations fall into two groups. **Object operations** read immutable data and
are answered identically by every tier; lower tiers serve them from cache.
**Repository operations** read or write mutable state and are always forwarded
to the server.

### Object operations

| Operation | Request | Response |
| --- | --- | --- |
| `GetObjects` | `ids: [ObjectId]` | `objects: [{ id, kind, data }]`, `missing: [ObjectId]` |
| `HasObjects` | `ids: [ObjectId]` | `missing: [ObjectId]` |
| `PutBlobs` | `blobs: [bytes]` | `ids: [ObjectId]` in request order |

- `GetObjects` returns every id it can and lists the rest in `missing`; a
  missing object is not an error, because a lower tier must be able to forward
  exactly the misses. Batches are limited to 1,024 ids and 64 MiB of response
  data; the response says which ids were deferred so the client can ask again.
- `PutBlobs` is idempotent: uploading content that already exists returns its
  id and stores nothing. Clients call `HasObjects` first to skip uploading what
  the server already holds. Writes always go to the server; a lower tier
  forwards them.
- `PutBlobs` accepts blobs only. Trees are derived by the server and changesets
  are created through `CreateChangeset`.

### Writing changesets

| Operation | Request | Response |
| --- | --- | --- |
| `CreateChangeset` | `parents`, `changes`, `author`, `message`, `metadata` | `{ id, lsn, root_tree, created_at }` |
| `GetChangesets` | `ids: [ChangesetId]` | `changesets: [Changeset]`, `missing` |

`CreateChangeset` validates the request against the rules in the data-model
spec, assigns `created_at`, appends the changeset to the log, derives its eager
data, and returns once all of that is durable. It never touches a ref: a
changeset that no ref points at is still a first-class, fetchable, rebasable
changeset. That is how work in progress is represented.

### Refs

| Operation | Request | Response |
| --- | --- | --- |
| `ResolveRef` | `name` | `{ target, version }` or `NotFound` |
| `ListRefs` | `prefix?` | `refs: [{ name, target, version }]` |
| `UpdateRef` | `name`, `expected: Option<ChangesetId>`, `new: ChangesetId` | `{ version }` or `RefConflict { actual }` |

`expected: None` means the ref must not exist yet. Deleting refs is not part of
the first phases.

### Reading snapshots

| Operation | Request | Response |
| --- | --- | --- |
| `Stat` | `changeset`, `path` | `{ kind, id }` or `NotFound` |
| `ListTree` | `changeset`, `path?`, `recursive: bool` | `entries: [{ path, kind, id }]`, `next_page?` |
| `ReadFile` | `changeset`, `path` | `{ kind, data }` |

These resolve a path against a changeset's root tree on the server, so a tool
can read a handful of files without fetching trees. `ListTree` is paginated;
recursive listings are capped per page so a request for the root cannot ask the
server to materialize the repository.

### History and ancestry

| Operation | Request | Response |
| --- | --- | --- |
| `Log` | `from`, `until?`, `path?`, `limit` | `changesets: [ChangesetSummary]`, `next?` |
| `IsAncestor` | `ancestor`, `descendant` | `bool` |
| `MergeBase` | `a`, `b` | `ChangesetId` or `NotFound` (no common ancestor) |
| `Diff` | `from`, `to`, `paths?: [prefix]` | `changes: [Change]` |

- `Log` walks the first-parent line from `from` back to (but excluding)
  `until`, newest first. With `path`, it uses path history and returns only the
  changesets that changed that path. A range plus `IsAncestor` is what an
  automated bisect needs.
- `IsAncestor` considers all parents; generation numbers prune the search.
- `Diff` returns the file-level changes that turn `from`'s snapshot into `to`'s,
  as `Upsert` and `Delete` changes, restricted to the given path prefixes.
  `Diff` against `MergeBase(head, main)` is how CI selects targets without a
  checkout.

### Rebase, revert, and landing

| Operation | Request | Response |
| --- | --- | --- |
| `Rebase` | `changeset`, `onto` | `{ id }` or `MergeConflict { paths }` |
| `Revert` | `changeset`, `onto`, `author`, `message` | `{ id }` or `MergeConflict { paths }` |
| `Land` | `changeset`, `ref`, `max_attempts` | `{ landed: ChangesetId, ref_version }` |

**Rebase** creates a new changeset whose first parent is `onto` and whose
changes are those of `changeset`. Conflict detection is file-level in the first
phases. Let `base` be the first parent of `changeset`. For each path the
changeset touches:

- if the path is unchanged between `base` and `onto`, the change applies as-is;
- if both sides made the identical change (same kind and blob, or both
  deleted), the change is dropped from the result because it is already there;
- otherwise the path conflicts.

Any conflict fails the whole rebase with `MergeConflict`, listing every
conflicting path, and creates nothing. On success the new changeset carries the
original's author, message, and metadata plus `rebased-from: <id>`. Rebasing
onto a changeset that already contains `base`'s content and nothing else on the
touched paths is cheap: it costs the number of changes, not the distance
between `base` and `onto`.

**Revert** is a rebase of the inverse of `changeset` — each `Upsert` restores
the first parent's entry or becomes a `Delete`, each `Delete` restores the
deleted entry — onto `onto`, with `reverts: <id>` in its metadata.

**Land** moves a ref to include a changeset, without a global lock:

```text
for attempt in 1..=max_attempts:
    tip     = ResolveRef(ref)
    landed  = changeset if tip == first_parent(changeset) else Rebase(changeset, onto = tip)
    if UpdateRef(ref, expected = tip, new = landed) succeeds:
        return landed
return RefConflict  # contention outlasted the attempt budget
```

A `MergeConflict` from the rebase ends the loop immediately and is returned to
the caller, whose job — typically an agent's — is to resolve it and try again.
Landing never blocks other writers; two concurrent lands race on the swap, and
the loser rebases onto the winner. Semantic breakage that file-level rebase
cannot see is caught by post-merge and pre-deploy testing, by design.

`Land` refuses to move a ref backwards: `landed` must have the current tip as
an ancestor.

## Fetch protocol

Git negotiation tells the server what the client already has. OpenScion asks
the client to name only what it wants:

1. Resolve the target (`ResolveRef`, or a changeset id the caller already
   holds) and read its `root_tree` (`GetChangesets`).
2. Look the root tree up in the local store; request it with `GetObjects` if
   missing.
3. For each entry under the paths the checkout includes, collect the subtree ids
   the local store lacks and request them in batches. Repeat level by level.
4. Collect the blob ids under the included paths that the local store lacks and
   request them in batches.
5. Verify every received object against its id before storing it.

Every request is for immutable objects, so any tier's cache can answer it and
any interrupted fetch resumes by asking for what is still missing. A sparse
checkout is the same procedure with a narrower path set; nothing about the
protocol changes. Updating a checkout from one changeset to another is a
`Diff` followed by fetching the blobs it names.

## Access control

- **Write.** The server holds a list of rules mapping path prefixes to the
  principals allowed to change them. `CreateChangeset`, `Rebase`, `Revert`, and
  `Land` fail with `PermissionDenied { path }` when any changed path is
  disallowed for the caller. `UpdateRef` is restricted per ref name.
- **Read.** Path-addressed reads (`Stat`, `ListTree`, `ReadFile`, `Diff`, `Log`
  with a path) filter or reject restricted paths. Content-addressed reads cannot
  be restricted by path, because the same blob may appear under several paths;
  read restriction for `GetObjects` is an open question.

## Errors

| Error | When |
| --- | --- |
| `NotFound { what }` | a named changeset, ref, or path does not exist |
| `InvalidPath { path, reason }` | a path breaks the path rules |
| `InvalidChange { path, rule }` | a changeset request breaks a validity rule |
| `UnknownParent { id }` | a parent is not in the log |
| `RefConflict { name, actual }` | a compare-and-swap or `Land` lost the race |
| `MergeConflict { paths }` | a rebase, revert, or land found conflicting paths |
| `PermissionDenied { path }` | the caller may not change or read a path |
| `LimitExceeded { limit }` | a batch, blob, page, or change-count limit was exceeded |
| `CorruptObject { id }` | stored or received bytes do not hash to their id |
| `Unavailable` | a tier is shedding load or its upstream is unreachable; retry with backoff |
| `IncompatibleProtocol { server }` | the client and server protocol versions do not bind |

## Invariants

- Object operations return the same result at every tier for the same ids.
- No operation other than `UpdateRef` and `Land` moves a ref, and each moves at
  most one.
- No operation takes a lock that spans more than one ref or blocks other
  writers.
- `Rebase` and `Revert` either create exactly one changeset or create nothing.
- Every response is bounded in size by a documented limit.

## Acceptance criteria

Phase 1 is complete when, against the in-process engine with in-memory stores:

- `PutBlobs` → `CreateChangeset` → `UpdateRef` → `ResolveRef` →
  `GetChangesets` → `GetObjects` round-trips a small repository, and a fetch of
  the root tree and its subtrees reproduces every uploaded file.
- `PutBlobs` of existing content stores nothing and returns the same id.
- Each error the phase-1 operations can return has a test that produces it.
- Every request and response type pins its serde form in a unit test.

Phases 2 and 3 add acceptance criteria for their operations in their own plans,
including: `Log` with a path returns exactly the changesets that touched it;
`MergeBase` and `IsAncestor` agree with a brute-force walk on randomized
histories; two concurrent `Land` calls on disjoint files both succeed with the
ref ending on a changeset that contains both; and concurrent lands on the same
file produce exactly one `MergeConflict`.

## Open questions

- **Read ACLs on objects.** Restricting `GetObjects` needs either per-object
  ownership or a path-scoped capability issued by a path-addressed read.
- **Line-level merge.** Should `Rebase` fall back to a three-way content merge
  when both sides changed a text file? It would cut conflicts sharply but makes
  rebase cost depend on file size.
- **Streaming large responses.** Whether `GetObjects` streams objects as they
  arrive, or returns whole batches, depends on the transport choice.
