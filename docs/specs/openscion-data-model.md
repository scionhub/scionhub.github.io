# OpenScion data model

- **Status:** Draft
- **Owner:** Maintainers
- **Parent spec:** [`openscion-architecture.md`](openscion-architecture.md)
- **API:** [`openscion-api.md`](openscion-api.md)

This spec defines what OpenScion stores and how every stored value is
identified: objects (blobs and trees), changesets and the log that orders them,
refs, and derived data. The encodings here are durable formats — once data is
written in them, a change is a migration — so they are specified byte for byte.

## Problem

A git commit names a full tree snapshot. Producing one costs a walk from the
changed paths to the root, and comparing two commits, computing blame, or
finding history for a path all need trees the server may not have materialized.
At agent scale the unit of work has to be cheap to create, cheap to ship, and
cheap to query, with everything that is expensive to compute moved into indexes
that can be built incrementally and added later without touching clients.

## Goals

- A changeset records only *what changed* relative to its first parent, so its
  size and the cost to create it scale with the change.
- Every immutable value — blob, tree, changeset — is content-addressed and
  verifiable by any reader.
- Snapshots (root trees) still exist for fetch and checkout, but as derived
  data computed from the parent's snapshot plus the change.
- New indexes can be added without changing stored changesets or clients.

## Non-goals

- Storing full-DAG history or blame. Both follow the first parent.
- Delta compression between objects. Each object is stored whole, compressed
  individually; storage dedupes identical content by id.
- Signed changesets. Signatures can live in changeset metadata later.

## Object identifiers

Every object, tree, and changeset is named by an `ObjectId`: the 32-byte BLAKE3
hash of its canonical encoding, prefixed by a header that binds the kind and
length:

```text
id = BLAKE3( kind ‖ 0x20 ‖ decimal(len(payload)) ‖ 0x00 ‖ payload )
kind ∈ { "blob", "tree", "changeset" }
```

- The textual form is 64 lowercase hexadecimal characters. Parsers reject
  uppercase, other lengths, and non-hex characters.
- The header stops a payload of one kind from colliding with another kind that
  happens to share its bytes.
- An id is computed over the **uncompressed** payload, so storage compression
  can change without changing any id.
- BLAKE3 is chosen for speed on large inputs and because its tree structure
  allows verified streaming of large blobs in a later phase.

`ObjectId` parsing and display live in the protocol crate; hashing lives in the
engine, so the protocol crate needs no hash implementation.

## Paths

A `RepoPath` names a file relative to the repository root.

- UTF-8, components separated by `/`, no leading or trailing `/`, no empty
  components, and no `.` or `..` component.
- No component contains NUL. Components are at most 255 bytes; a full path is at
  most 4096 bytes.
- Paths compare and sort by their UTF-8 bytes. They are case-sensitive.
- The root itself is not a valid `RepoPath`; APIs that address a directory take
  an optional path where absent means the root.

Every API that accepts a path validates it and rejects an invalid one with
`InvalidPath` before doing anything else.

## Blobs

A blob is a file's contents: an arbitrary byte string, payload = the bytes.
Blobs carry no name and no mode; those belong to the tree entry that points at
them. The engine enforces a configurable maximum blob size (default 100 MiB)
and rejects larger uploads with `LimitExceeded`.

## Trees

A tree lists one directory's entries. Each entry is:

| Field | Meaning |
| --- | --- |
| `name` | a single valid path component |
| `kind` | `file`, `executable`, `symlink` (the blob holds the link target), or `tree` |
| `id` | the blob id for files and symlinks, the tree id for directories |

The canonical payload is the entries sorted by `name` bytes, each encoded as:

```text
kind-byte ‖ name ‖ 0x00 ‖ id (32 raw bytes)
kind-byte: 'f' file · 'x' executable · 'l' symlink · 'd' tree
```

- Names are unique within a tree.
- A tree has at least one entry, except the root tree of an empty repository.
  Removing the last file in a directory removes the directory.
- Trees are never written by clients. The server derives them (see
  [Root trees](#root-trees)) and serves them for fetch.

## Changesets

A changeset is the unit of work. It names its parents and lists the file-level
changes relative to its **first** parent.

| Field | Meaning |
| --- | --- |
| `parents` | ordered list of changeset ids; empty only for the root changeset |
| `changes` | file changes relative to `parents[0]`, sorted by path |
| `author` | free-form identity of the human or agent that wrote it |
| `message` | description |
| `created_at` | server-assigned creation time, milliseconds since the Unix epoch |
| `metadata` | sorted string-to-string map for tools: review links, trailers, the changeset a rebase came from |

A change is one of:

- `Upsert { path, kind, blob }` — create or replace a file, executable, or
  symlink at `path` with the given blob. `kind` is never `tree`.
- `Delete { path }` — remove the file at `path`.

### Validity

The server rejects a changeset that breaks any of these rules, with
`InvalidChange` naming the path and the rule:

1. Every parent exists. A changeset with no parents is accepted only if the log
   is empty.
2. Every path is valid and appears in at most one change.
3. Every `Upsert` blob already exists in the object store.
4. A `Delete` names a file that exists in the first parent's snapshot. Deleting
   a directory is spelled as deleting every file under it.
5. An `Upsert` is not a no-op: the first parent does not already hold the same
   kind and blob at that path.
6. The result is a well-formed tree: no path is both a file and a directory.
   Upserting `a/b` while `a` is a file in the parent requires a `Delete { a }`
   in the same changeset, and vice versa.
7. The number of changes is at most a configured limit (default 100,000).

A changeset with no changes is valid only if it has more than one parent (a
merge that took the first parent's content unchanged).

### Merges

A merge changeset has two or more parents. Its `changes` still describe the
difference from `parents[0]`. History and blame walk the first parent; the
other parents record ancestry for `IsAncestor` and `MergeBase`. This is the
trade Scion makes deliberately: in trunk-based development what matters is the
main line, and storing changes against one parent keeps every changeset small.

### Canonical encoding

The changeset id hashes this payload. All integers are big-endian; `str` is a
`u32` byte length followed by UTF-8 bytes.

```text
u8   format version (1)
u32  parent count, then each parent id (32 raw bytes)
u32  change count, then each change in path order:
       'u' ‖ str(path) ‖ kind-byte ‖ blob id      (Upsert)
       'd' ‖ str(path)                            (Delete)
str  author
str  message
u64  created_at
u32  metadata count, then each entry in key order: str(key) ‖ str(value)
```

Because `created_at` is part of the id and is assigned by the server, two
otherwise identical requests produce different changesets. The engine takes its
clock through a port so tests can fix it.

## The log

The server appends every changeset to a single write-ahead log.

- Each entry gets a **log sequence number** (LSN), a `u64` that strictly
  increases. The LSN is the server's record of order; it is not part of the
  changeset id.
- Every parent of a changeset has a lower LSN than the changeset. The log is
  therefore always a topological order, and ingestion that preserves log order
  preserves ancestry.
- A changeset is visible to every reader as soon as its append is durable. It is
  never modified and never removed.
- Appending touches only the new entry. It does not read or write any ref.

## Refs

A ref maps a name to a changeset id and carries a `version` that increases on
every move.

- Names follow path rules and are expected to be few: `main`, `release/<x>`,
  and a small number of tool-owned refs. A large population of refs is a
  scaling problem, because every server must agree on their values.
- A ref moves only by **compare-and-swap**: the caller states the id it expects
  the ref to hold (or that it must not exist), and the update succeeds only if
  that is still true. A failed swap returns `RefConflict` with the current value
  and changes nothing.
- A ref may point at any changeset in the log. Fast-forward-only and protected
  refs are policies the API layer enforces, not properties of the store.
- A swap writes exactly one record. No operation ever moves two refs atomically.

## Derived data

Anything not stored in the changeset itself is **derived data**: a value of some
derived kind for a given changeset, computed from that changeset and the same
kind's values on its parents.

```text
derive(kind, changeset) = f_kind( changeset, [derive(kind, p) for p in needed parents] )
```

- A derived kind declares which parents it needs — the first parent only, or
  all of them — and a version. Values are stored keyed by
  `(kind, version, changeset id)`.
- A value is a pure function of its inputs, so it can be recomputed and
  compared at any time; bumping a kind's version recomputes it without touching
  changesets.
- Each kind is computed **eagerly** (on append, before the append is
  acknowledged) or **lazily** (on first request, walking back to the nearest
  ancestor that has a value). Lazy derivation must cost the distance walked, not
  the length of history.
- Clients never see how a value is computed, only the queries it answers, so
  internals can change freely.

### Phase-1 and phase-2 kinds

| Kind | Parents | Mode | Value | Answers |
| --- | --- | --- | --- | --- |
| **Root tree** | first | eager | the root tree id of the snapshot | fetch, checkout, `Stat`, `ListTree`, validity checks |
| **Generation** | all | eager | `1 + max(parent generations)`; root is 1 | ancestry pruning |
| **First-parent skip list** | first | eager | the first-parent ancestor at distance 2^k for each k | `Log` ranges, first-parent ancestry in O(log n) |
| **Path history** | first | lazy | for each path changed, the previous changeset that changed it | per-path `Log`, file-level blame |

### Root trees

The root tree of a changeset is its first parent's root tree with the changes
applied. Applying a change rewrites only the trees on the path from that file to
the root; every untouched subtree keeps its id and is shared. The cost of
deriving a root tree is therefore proportional to the number of changes times
the depth of their paths — never to the size of the repository. New trees are
written to the object store before the append is acknowledged, so a reader that
sees a changeset can always fetch its snapshot.

### Later kinds

Line-level blame, copy detection, and a path index for file search are
expected as later kinds. Each is a new `(kind, version)` and needs no change to
stored changesets.

## Invariants

1. **Immutability.** The bytes behind an id never change. No API modifies or
   deletes an object or a changeset.
2. **Verifiability.** For every object or changeset any component serves,
   hashing its canonical encoding yields its id. A reader that sees a mismatch
   reports `CorruptObject` and discards the value.
3. **Proportional cost.** Creating a changeset, including its eager derived
   data, costs O(changes × path depth), independent of repository size and
   history length.
4. **Topological log.** Parents always precede children in log order.
5. **Refs are separate.** Creating a changeset never reads or writes a ref;
   moving a ref never creates a changeset.
6. **Determinism.** Given the same inputs — including `created_at` — the engine
   produces the same changeset id, root tree id, and derived values on every
   machine.
7. **No full materialization.** No operation requires walking or holding the
   full repository tree.

## Acceptance criteria

- Ids for a fixed blob, tree, and changeset match golden values pinned in tests,
  so an accidental encoding change fails the build.
- Hex parsing accepts exactly 64 lowercase hex characters.
- Path validation accepts and rejects the cases listed under [Paths](#paths),
  each with its own test.
- Each validity rule produces `InvalidChange` (or `InvalidPath`) with a test.
- Deriving the root tree of a changeset that touches one file in a large tree
  writes only the trees on that file's path, asserted by counting writes.
- A ref compare-and-swap with a stale expectation returns `RefConflict` and
  leaves the ref unchanged.
- The log rejects a changeset whose parent is not yet in it.

## Open questions

- **Compression.** zstd for stored objects is the working assumption; the
  storage format is not part of any id, so this can be decided in phase 4.
- **Large files.** Should blobs above a threshold be chunked (with a chunk-list
  object) so fetch can resume and dedupe within a file? Deferred to phase 8.
- **Timestamps.** Is a server-assigned `created_at` in the id the right call, or
  should identical requests be idempotent? The current choice favors distinct
  changesets for repeated work.
- **Multiple roots.** Git ingestion of repositories with several root commits
  would need more than one parentless changeset. Phase 1 allows exactly one.
