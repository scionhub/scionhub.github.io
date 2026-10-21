# Plan: OpenScion core data model

- **Status:** Done (phase 1, in-memory, single ref)
- **Specifications:**
  [`../specs/openscion-data-model.md`](../specs/openscion-data-model.md),
  [`../specs/openscion-api.md`](../specs/openscion-api.md)

## Goal

The smallest end-to-end OpenScion that does real work and can be timed against
git: content-addressed blobs and trees, changesets in an append-only log, refs
moved by compare-and-swap, a server holding all of it, and an `opnscn` client that
imports, commits, and clones — including a one-directory clone.

## Non-goals

Persistence, generation numbers and skip lists, path history, rebase and
landing (a lost ref swap is reported, not retried), the node daemon and
caches, access control, and TLS. Each is a later phase in
[`openscion-architecture.md`](../specs/openscion-architecture.md#delivery-phases).

## Tasks, in order

Every task was test-first: the failing test, then the code that passes it.

1. **Protocol payloads** — `crates/openscion-proto/src/{object,path,tree,changeset,refs,transfer,failure}/`.
   `ObjectId` (64 lowercase hex characters), `RepoPath` validated by the path
   rules, tree entries, `Change` / `CreateChangeset` / `Changeset` /
   `ChangesetInfo` / `ChangesetRecord`, `RefValue` / `UpdateRef`,
   `FetchObjects` / `StoredObjects`, `ErrorBody`. Each pins its JSON form. The
   template `greeting` module is gone.
2. **Hashing and encodings** — `crates/openscion-core/src/{hash,encoding}/`.
   `object_id` hashes `kind ‖ ' ' ‖ len ‖ 0x00 ‖ payload` with BLAKE3; the tree
   and changeset encodings are byte-for-byte the spec's, checked against
   hand-built vectors; the frame stream (`id ‖ u64 len ‖ bytes`) carries
   batches.
3. **Store and repository** — `crates/openscion-core/src/{store,clock,repo}/`.
   `Repository::create_changeset` checks every validity rule, then derives the
   root tree by path copying: only the trees on a changed path are loaded and
   rewritten, and untouched subtrees keep their ids (tested). Deletes apply
   before upserts, so a file can become a directory in one changeset, and the
   other way round. Refs move only by compare-and-swap.
4. **Server routes** — `crates/openscion-server/src/api/`. `POST /v1/blobs`,
   `POST /v1/objects`, `POST /v1/changesets`, `GET /v1/changesets/{id}`, and
   `GET`/`POST /v1/refs/{name}`, over a shared in-memory repository, with
   `404` / `409` / `400` and an `ErrorBody`. Tested over a real socket.
5. **Client** — `crates/openscion/src/{client,workcopy,commands}/`. `opnscn
   import`, `opnscn commit`, `opnscn clone [--path DIR]`. A working copy records
   each file's blob id and stat data in `.opnscn/state.json`, so a commit
   re-reads only files whose size or modification time changed. Files
   modified at or after the state was written are re-read anyway, the same
   racily-clean rule git applies to its index. Clone walks trees breadth
   first, one request per level, and verifies every fetched id.
6. **Benchmarks** — `benchmarks/src/openscion/`. The OpenScion backend runs
   the server and `opnscn` in-process. A new `sparse-clone` scenario fetches one
   top-level directory, and the report puts the two backends side by side.

## Verification

```sh
cargo fmt --all -- --check
cargo clippy --all-targets --all-features -- -D warnings
cargo build --all-targets --all-features
cargo test --all-features
cargo llvm-cov --all-features --json --output-path coverage.json
.github/scripts/check-file-coverage.sh 90 coverage.json
cargo run --release -p openscion-benchmarks -- --runs 7
```

Manual end to end:

```sh
cargo run -p openscion-server &
cargo run -p openscion -- import path/to/tree
echo change >> path/to/tree/README.md
cargo run -p openscion -- commit -m "edit" --dir path/to/tree
cargo run -p openscion -- clone /tmp/copy && diff -r -x .opnscn path/to/tree /tmp/copy
```

## Checklist

- [x] Protocol payloads with wire-form tests
- [x] Hashing, canonical encodings, frames
- [x] Repository: validity rules, path-copying derivation, CAS refs
- [x] Server routes and error mapping
- [x] `opnscn import` / `commit` / `clone`, sparse clone
- [x] OpenScion benchmark backend and `sparse-clone` scenario
