# Background: git internals

Notes on how git stores and models a repository, gathered from git's own format
documentation, the Pro Git book, and git release notes. This is source material,
not a spec: what OpenScion actually does is defined in
[`../specs/`](../specs/openscion-architecture.md). It records where git's costs
grow with repository or history size, and the last section maps each mechanism
to how the OpenScion spec handles it.

## Object model

Git is a content-addressed object store with a ref database on top
([Pro Git, "Git Objects"](https://git-scm.com/book/en/v2/Git-Internals-Git-Objects)).
There are four object types.

| Type | Holds | Points at |
| --- | --- | --- |
| `blob` | a file's bytes, with no name or mode | nothing |
| `tree` | one directory: a list of `(mode, name, id)` entries | blobs, trees, and commits (gitlinks) |
| `commit` | a root tree, parents, author, committer, message | one tree and zero or more commits |
| `tag` | an annotated tag: target id, target type, tag name, tagger, message | any object |

### Header and hashing

Every object id is the hash of a header followed by the payload
([gitformat-loose](https://git-scm.com/docs/gitformat-loose)):

```text
id = H( type ‖ " " ‖ decimal(len(payload)) ‖ "\0" ‖ payload )
```

A blob containing `abc` hashes `blob 3\0abc`. The id covers uncompressed bytes,
so compression never changes an id, and the type in the header gives a blob
and a tree with identical payloads different ids.

### Commits and tags

A commit is a text payload of headers, a blank line, and the message:

```text
tree <tree-id>
parent <commit-id>          (zero or more, in order)
author <name> <<email>> <unix-seconds> <+hhmm>
committer <name> <<email>> <unix-seconds> <+hhmm>
gpgsig ...                  (optional)

<message>
```

A commit is a **snapshot**: it names a complete root tree, not a change. Any
diff git shows is computed by comparing two trees at read time. Renames and
copies are never recorded; they are inferred by diff heuristics (see
[Diff and rename detection](#diff-and-rename-detection)). An annotated tag has
the same shape, with `object`, `type`, `tag`, and `tagger` headers.

### Trees and entry modes

A tree's raw payload is a sequence of entries, each
`<octal mode> SP <name> NUL <raw id>`, with the mode written in ASCII and no
leading zero for directories (`40000`). The modes git writes are:

| Mode | Meaning |
| --- | --- |
| `100644` | regular file |
| `100755` | executable file |
| `120000` | symbolic link; the blob holds the link target |
| `040000` | subdirectory (another tree) |
| `160000` | gitlink: a submodule, whose id is a commit in another repository |

Entries are sorted by name bytes, with one twist: a subtree's name is compared
as if it ended in `/`. So a file `foo.c` sorts before a directory `foo` (`foo/`),
because `.` (0x2E) is less than `/` (0x2F). Every implementation that writes
trees has to reproduce this rule exactly, or it produces different ids for the
same content.

### SHA-1 and the SHA-256 transition

Git was built on SHA-1. After the 2017 SHAttered collision, git switched to a
hardened SHA-1 that detects known collision attacks, and began a move to
SHA-256 described in the
[hash-function-transition](https://git-scm.com/docs/hash-function-transition)
design.

- A SHA-256 repository (`git init --object-format=sha256`) sets
  `core.repositoryFormatVersion = 1` and `extensions.objectFormat = sha256`, so
  older git refuses to operate on it rather than misread it.
- Git 2.42 dropped the "experimental" label on SHA-256 repositories; SHA-1
  remains the default ([2.42 release notes](https://imapserver.alvestrand.no/doc/git/RelNotes/2.42.0.txt)).
- Interoperability is planned through `extensions.compatObjectFormat`: the
  repository keeps a bidirectional SHA-1 to SHA-256 mapping in its pack
  indexes and in loose-object map files, and translates objects on fetch and
  push to SHA-1 servers. Git 2.45 shipped initial interop support
  ([GitHub blog, Git 2.45](https://github.blog/open-source/git/highlights-from-git-2-45/)).
- Git 3.0 plans to make SHA-256 the default for new repositories, with "no
  plan to deprecate the sha1 object format"
  ([BreakingChanges](https://git-scm.com/docs/BreakingChanges)).

The transition shows the cost of hashing over a format: an id is embedded in
every tree, commit, tag, index, pack index, and ref, so changing the function
means translating every one of them.

## Object storage

### Loose objects

A new object is first written **loose**: the header and payload are
zlib-compressed into one file at `objects/<first 2 hex>/<remaining hex>`
([gitformat-loose](https://git-scm.com/docs/gitformat-loose)). The two-character
directory shards the namespace because some filesystems slow down with many
entries in one directory. Loose objects are not delta-compressed.
**Scaling:** one file and one inode per object. Lookup is a filesystem lookup,
but enumeration, `fsck`, and any scan cost O(number of loose objects).

### Packfiles

Maintenance and network transfer both use **packfiles**
([gitformat-pack](https://git-scm.com/docs/gitformat-pack)). A pack is a
header (`PACK`, version 2, object count), entries, and a trailing checksum.
Each entry is a variable-length type and size followed by zlib data; types are
commit (1), tree (2), blob (3), tag (4), `OFS_DELTA` (6), and `REF_DELTA` (7).
An `OFS_DELTA` names its base by a negative offset within the same pack; a
`REF_DELTA` names it by id, which enables **thin packs** on the wire (deltas
against objects the receiver already has, completed by
`index-pack --fix-thin`). A delta is a base size, a result size, and a list of
*copy* (byte range from the base) and *insert* (literal bytes) instructions.

A delta's base can itself be a delta, forming a **delta chain**. When repacking,
git sorts candidate objects by type, a path-name hash, and size, then tries each
against the previous `--window` objects (default 10), capping chain length at
`--depth` (default 50, maximum 4095)
([git-repack](https://git-scm.com/docs/git-repack)). The docs warn that a deep
chain slows readers, "because delta data needs to be applied that many times".

**Scaling:** reading one object costs its chain depth in delta applications.
Finding good deltas is the expensive part of repacking, and a full repack
touches every object in the repository.

### Pack index (`.idx` v2) and reverse index (`.rev`)

Each pack has an index for lookup by id: magic `\377tOc` and version 2; a
256-entry **fan-out** table (entry *i* counts ids whose first byte is at most
*i*, so a lookup binary-searches one bucket); the sorted ids; a CRC32 per
object; 4-byte offsets whose high bit redirects to an 8-byte table for packs
over 2 GiB; then the pack and index checksums. A `.rev` file adds the inverse
mapping, from offset order back to index position, which bitmaps need.
**Scaling:** lookup is O(log n) within one pack, but *p* packs cost
O(p log n) per miss, which is why pack count must be kept down.

### Multi-pack index (MIDX)

A [multi-pack index](https://git-scm.com/docs/gitformat-pack) is one index over
many packs, so lookups stop scaling with pack count. It is a chunked file
(`MIDX` signature) with a pack-name list (`PNAM`), an id fan-out (`OIDF`), the
sorted ids (`OIDL`), and per-object `(pack, offset)` pairs (`OOFF`, with
`LOFF` for large offsets). Objects present in several packs are listed once.
The MIDX defines a "pseudo-pack" ordering (packs in MIDX order, preferred pack
first) so a single reachability bitmap can cover all packs. `git repack
--write-midx=incremental` writes a chain of MIDX layers instead of one flat
file.

### Reachability bitmaps

A [`.bitmap`](https://git-scm.com/docs/bitmap-format) file stores, for a
selection of commits, the set of objects reachable from that commit, as a bit
per object in pack (or MIDX pseudo-pack) order. Bitmaps are EWAH-compressed
(run-length words plus literals, compatible with JGit); four type bitmaps mark
commits, trees, blobs, and tags; each commit's bitmap may be XORed against one
up to 160 entries earlier. Optional sections add a name-hash cache for delta
heuristics, a commit lookup table, and pseudo-merge bitmaps that union the
reachable sets of many refs. Bitmaps turn "which objects does the client lack" from a graph walk into set
operations, which is what makes serving clones and fetches tractable on large
hosted repositories. **Scaling:** a bitmap covers a fixed pack or MIDX, so it
goes stale as new packs arrive and must be rebuilt by a repack that covers all
reachable objects.

### Commit-graph

The [commit-graph](https://git-scm.com/docs/gitformat-commit-graph) file is a
derived cache of the commit DAG, so history walks need not inflate and parse
commit objects. Its chunks are `OIDF`/`OIDL` (fan-out and sorted ids), `CDAT`
(per commit: root tree id, the positions of the first two parents, a 30-bit
generation number, and a 34-bit commit time), `EDGE` (extra octopus parents),
`GDA2`/`GDO2` (corrected commit date offsets and overflow), and `BIDX`/`BDAT`
(Bloom filters). Parents are stored as **positions**, so walking a parent is an
array index. Files can form a **chain** of layers, merged when a layer has
fewer than twice the commits of the one below, so writes are incremental.

**Generation numbers.** Two definitions exist
([commit-graph design](https://git-scm.com/docs/commit-graph)):

| Version | Definition | Root value |
| --- | --- | --- |
| v1, topological level | `1 + max(parent levels)` | 1 |
| v2, corrected commit date | `max(committer date, 1 + max(parent corrected dates))` | the commit's date (1 if the date is 0) |

Both satisfy "if A can reach B, then gen(A) > gen(B)", so a walk can stop
expanding any commit whose generation is below its target. That pruning is what
makes `merge-base`, `--contains`, and `--topo-order` fast. v2 keeps that
guarantee while staying close to commit dates, which git's older date-based
heuristics already relied on. (`GDA2`/`GDO2` replaced the original
`GDAT`/`GDOV` ids after older git wrote possibly erroneous data under them.)

**Changed-path Bloom filters.** Since Git 2.27, `git commit-graph write
--changed-paths` stores one Bloom filter per commit over the paths that changed
relative to its first parent. The defaults in git's
[`bloom.h`](https://github.com/git/git/blob/master/bloom.h) are 7 hash
functions, 10 bits per entry, and at most 512 changed paths; a commit with more
than 512 changes gets a one-word filter with every bit set, which answers
"maybe" for every path
([format](https://git-scm.com/docs/gitformat-commit-graph)). Hash version 2
(murmur3) replaced version 1, which mishandled paths with bytes at or above
0x80 on platforms where `char` is signed. `git log -- <path>` and `git blame`
consult the filter first and skip the tree diff when it says "definitely not
changed".

**Scaling:** the commit-graph grows linearly with commit count but is
incremental to write. Bloom filters remove most tree diffs from path-limited
history, but cannot help for commits over the 512-path cap.

### Garbage collection, cruft packs, and geometric repacking

Unreachable objects cannot be deleted immediately, because an in-flight push
might reference them, so `git gc` expires them after a grace period
(`gc.pruneExpire`, default two weeks).
Historically they were exploded into loose objects to keep per-object mtimes,
which could starve inodes and could not be delta-compressed. **Cruft packs**
(Git 2.37) instead store all unreachable objects in one pack with a `.mtimes`
file recording each object's timestamp
([cruft packs](https://git-scm.com/docs/gitformat-pack)). `gc.cruftPacks`
defaults to true.

`git gc --auto` runs when there are more than about 6,700 loose objects
(`gc.auto`) or more than 50 packs (`gc.autoPackLimit`). An all-into-one repack
costs the whole repository, so `git repack --geometric=<factor>` keeps packs in
a geometric progression, each at least *factor* times the object count of the
next smaller, and rolls up only the smallest packs needed to restore it
([git-repack](https://git-scm.com/docs/git-repack)).

[`git maintenance`](https://git-scm.com/docs/git-maintenance) schedules this
work as tasks:

| Task | What it does | Incremental schedule |
| --- | --- | --- |
| `commit-graph` | write an incremental commit-graph layer | hourly |
| `prefetch` | fetch from remotes into `refs/prefetch/` | hourly |
| `loose-objects` | pack loose objects in batches of 50,000 | daily |
| `incremental-repack` | merge small packs using the MIDX, drop redundant ones | daily |
| `pack-refs` | collect loose refs into `packed-refs` | weekly |
| `gc` | full cleanup and repack; "can be expensive and disruptive" | not scheduled |
| `geometric-repack` | geometric repacking, used by the `geometric` strategy | per strategy |

**Scaling:** maintenance is required for performance, its cost is a function
of the whole object store, and every replica, mirror, and cache of the
repository must run it independently.

## Refs

A ref maps a name such as `refs/heads/main` to an object id.

### Files backend

- **Loose refs**: one file per ref under `.git/refs/`, holding the id as hex.
- **`packed-refs`**: one sorted text file with an `<id> <name>` line per ref
  (an annotated tag may be followed by a `^<id>` peeled line). `git pack-refs`
  fills it; a loose ref shadows a packed one of the same name.
- **Symbolic refs** hold `ref: <other ref>`. `HEAD` is usually symbolic
  (`ref: refs/heads/main`); a detached `HEAD` holds an id.
- **Reflogs** under `.git/logs/<refname>` log each update (old id, new id,
  committer, time, message), expiring after 90 days (`gc.reflogExpire`).

**Locking and atomicity.** To update a ref, git creates `<ref>.lock` with an
exclusive create, which fails if another writer holds the lock, writes the new
value into it, verifies the old value, and renames it over the ref. Deleting a
packed ref also requires `packed-refs.lock` and a rewrite of the entire
`packed-refs` file. A ref transaction (`git update-ref --stdin`, `git push
--atomic`) locks every ref first and only then commits, so concurrent writers
are excluded; the commit itself is still a series of separate renames.

**Scaling:** loose refs cost an inode each. The
[reftable documentation](https://git-scm.com/docs/reftable) cites Android's
866k refs in a 62 MB packed-refs file that needs a linear scan per lookup and a
full rewrite for any transaction that touches it.

### Reftable

[Reftable](https://git-scm.com/docs/reftable), originally designed for JGit, is
a binary, block-based format. A table is a sequence of ref blocks (sorted by
name), optional obj blocks (from abbreviated object ids back to refs), log
blocks (zlib-compressed reflog records), index blocks, and a footer with a
CRC-32. Names are **prefix-compressed** against the previous name, with a
restart table of uncompressed entries that readers binary-search. A repository
holds a **stack** of tables listed in `reftable/tables.list`, searched
newest-first, with deletions as tombstones. A transaction writes a new table
and commits by renaming `tables.list.lock` over `tables.list`: one atomic
rename, with writers serialized by that lock. Adjacent tables are
**compacted** by a merge join while updates continue.

On the Android data set, reftable reduced storage from 62.2 MB to 36.1 MB,
cold lookup by name from 409,660 µs to 33.9 µs, and reflog storage from 173 MB
to 5 MB. Git 2.45 added reftable as a ref backend (`git init
--ref-format=reftable`), and Git 3.0 plans to make it the default
([BreakingChanges](https://git-scm.com/docs/BreakingChanges)).

## The index (staging area)

The index (`.git/index`) is a flat, sorted list of every tracked path with its
blob id and cached `stat(2)` data, plus extensions
([gitformat-index](https://git-scm.com/docs/gitformat-index)). The header is
`DIRC`, a version (2, 3, or 4), and an entry count. Each entry stores ctime,
mtime, dev, inode, mode, uid, gid, size, the object id, flags (assume-valid, a
2-bit merge stage, name length), and the path. Version 3 adds extended flags,
notably **skip-worktree** (sparse checkout) and **intent-to-add**
(`git add -N`). Version 4 prefix-compresses each path against the previous one
and is the default under `feature.manyFiles`. A trailing checksum covers the
whole file (`index.skipHash` skips computing it).

`git status` compares each entry's cached stat data to the file on disk and
rehashes only files whose stat changed. Important extensions:

| Extension | Purpose |
| --- | --- |
| `TREE` (cache tree) | tree ids for unchanged directories, so commit only hashes changed trees |
| `REUC` | saved conflict stages so a resolution can be undone |
| `link` (split index) | a small index of changes on top of a large shared index |
| `UNTR` (untracked cache) | cached untracked-file listings, validated by directory stat data |
| `FSMN` | the token of the last file-system-monitor query |
| `EOIE`, `IEOT` | offsets that let git load entries on multiple threads |
| `sdir` | marks that the index contains sparse-directory entries |

**Split index** writes only the delta when the index changes, instead of
rewriting a large file. **Sparse index** replaces each directory entirely
outside a cone-mode sparse checkout with one entry of mode `040000` pointing at
the tree at `HEAD`. Its design doc names the problem: without it, `git status`
and `git add` are O(files at `HEAD`) rather than O(files populated)
([sparse-index design](https://github.com/git/git/blob/master/Documentation/technical/sparse-index.adoc)).
It is off by default (`index.sparse`).

**File system monitor.** With `core.fsmonitor = true`, the builtin
`git fsmonitor--daemon` watches the worktree and answers "what changed since
token T", so `git status` skips the full stat walk. It runs only on Windows and
macOS ([GitHub blog](https://github.blog/engineering/infrastructure/improve-git-monorepo-performance-with-a-file-system-monitor));
earlier setups used a hook calling an external watcher such as Watchman.

**Scaling:** without these extensions, reading and writing the index and
refreshing status cost O(tracked files) on every command, independent of how
little changed. Each extension removes one term from that cost, and each must be
enabled and understood by every tool that touches the index.

## Working tree features

**Sparse checkout.** `git sparse-checkout` limits which paths are written to
the working tree, using the skip-worktree bit. **Cone mode**, now the default,
restricts patterns to whole directories (every file in a listed directory, plus
the files directly in its ancestors), which allows hash-based matching instead
of gitignore-style patterns tested against every path
([git-sparse-checkout](https://git-scm.com/docs/git-sparse-checkout)).
Sparse checkout limits the working tree, not the object store: a full clone
still downloads every object unless combined with partial clone.

**Worktrees.** `git worktree add` creates extra working trees sharing one object
store and ref namespace. Each has a private `$GIT_DIR/worktrees/<id>/` with its
own `HEAD`, index, and optional `config.worktree`, and its `.git` is a file
pointing there ([git-worktree](https://git-scm.com/docs/git-worktree)).

**Submodules.** A submodule is a gitlink entry (mode `160000`) naming a commit in
another repository; `.gitmodules` maps its path to a URL. The superproject pins
only that commit; fetching and updating the submodule are separate operations.

## History algorithms

### Merge base

`git merge-base` finds the best common ancestors of two commits by walking both
histories in a priority queue and painting commits reachable from each side.
Criss-cross histories can have several best merge bases. Generation numbers
let the walk stop early. **Scaling:** without a commit-graph, the walk parses
each commit object it visits; the walk length depends on how far the two sides
diverged, not on total history, once generation numbers bound it.

### Merge and rebase

`ort` ("Ostensibly Recursive's Twin") replaced `recursive` as the default
two-head strategy in Git 2.34, and since Git 2.50 `recursive` is a synonym
for `ort` ([merge-strategies](https://git-scm.com/docs/merge-strategies)). With
several merge bases, `ort` first merges them into a virtual base tree, then
does a three-way merge. It detects renames but not copies. `octopus` handles
more than two heads; `ours` keeps the current tree; `resolve` is an older
three-way merge without rename handling.

Two commands do this work without a working tree, which is what server-side
merging needs: `git merge-tree --write-tree` computes a merge result as a tree
and conflict list, and `git replay` replays commits onto a new base.
**Scaling:** a merge diffs each side against the base; rename detection adds
pairwise comparison of unmatched added and deleted files (below).

`git rebase` rewrites each commit in the range by cherry-picking it onto the
new base, using the merge machinery once per commit, and creates new commits
with new ids. **Scaling:** cost is proportional to the number of commits
replayed times the cost of one three-way merge, and every descendant commit gets
a new id even when its content is unchanged.

### Blame and path history

`git blame` starts from the file at the given commit and walks history
backwards. At each commit that changed the file, it diffs the file against the
parent and passes blame for unchanged lines to the parent; lines that differ are
attributed to that commit. Finding the commits that changed the path needs a
tree diff per visited commit, which Bloom filters can skip. Copy and move
detection (`-C`, `-M`) searches other files for the moved lines and is much
more expensive. **Scaling:** proportional to the number of commits walked and
the file's size at each, with no persistent index; every blame request is
recomputed from scratch.

`git log -- <path>` simplifies history to commits that are not *TREESAME* to
their parents at that path. Deciding that requires comparing the trees along the
path for every commit walked, unless a Bloom filter says the path did not
change. **Scaling:** O(commits walked), with a tree diff per commit when filters
are absent or overflowed.

### Diff and rename detection

Git diffs two trees in parallel, skipping any subtree whose id is unchanged, so
a diff costs the changed portion of the trees. Renames are then inferred: exact renames by matching blob ids, and inexact renames by
scoring content similarity between unmatched deleted and added files. The
exhaustive pairwise step is capped by `diff.renameLimit` (default 1000) and, for
merges, `merge.renameLimit` (default 7000)
([diff config](https://git-scm.com/docs/git-config#Documentation/git-config.txt-diffrenameLimit)).
**Scaling:** tree diffs scale with the change; inexact rename detection scales
with the product of added and deleted file counts.

## Where costs scale with repository or history size

| Area | Cost grows with | Git's mitigation |
| --- | --- | --- |
| Clone and fetch | reachable objects to enumerate and send | bitmaps, MIDX, partial clone, shallow clone |
| Object lookup | pack count | repacking, MIDX |
| Object read | delta chain depth | `--depth` limit, delta base cache |
| Repacking and gc | total objects | geometric repacking, cruft packs, incremental MIDX |
| Ref lookup and update | ref count (packed-refs) | reftable |
| `status`, `add`, commit | tracked files | index v4, split index, sparse index, untracked cache, fsmonitor |
| Merge base, `--contains` | commits walked | commit-graph, generation numbers |
| Path history, blame | commits walked, tree diffs per commit | changed-path Bloom filters |
| Rename detection | added files times deleted files | rename limits, exact-match first |
| Rebase | commits replayed | `git replay` without a worktree |

Most mitigations are separate derived files that have to be built, kept
current, and understood by every tool that reads the repository.

## What this means for OpenScion

The OpenScion spec keeps git's content addressing and replaces most of the rest
([data model](../specs/openscion-data-model.md)).

| Git mechanism | OpenScion |
| --- | --- |
| Object header `"<type> <len>\0"` hashed with SHA-1 or SHA-256 | Same header idea, `kind ‖ " " ‖ decimal(len) ‖ "\0" ‖ payload`, hashed with BLAKE3. Kinds are `blob`, `tree`, `changeset`. Ids cover uncompressed bytes, as in git. |
| SHA-1 to SHA-256 transition through `objectFormat`/`compatObjectFormat` | One hash function from the start. There is no compatibility mapping; git ingestion assigns new ids. |
| Commit as a full snapshot naming a root tree | A changeset lists file changes relative to its **first parent**. The root tree is derived data, computed eagerly from the parent's root tree plus the change. |
| Tree modes `100644`, `100755`, `120000`, `040000`, `160000` | Kinds `file`, `executable`, `symlink`, `tree`. No gitlinks: submodules are not modelled. |
| Tree order with directories compared as `name/` | Plain byte order on names; a path cannot be both a file and a directory in one tree. |
| Loose objects and packfiles with deltas, `.idx`, MIDX, bitmaps | No packfiles and no deltas. Each object is stored whole, individually compressed, and fetched by id, so there are no indexes over packs to maintain. |
| gc, cruft packs, geometric repacking, `git maintenance` | No maintenance. Objects and changesets are immutable and never deleted, so there is no unreachable set to expire. |
| Commit-graph generation numbers | Precedent for the **generation** derived kind: `1 + max(parent generations)`, root is 1, the same definition as git's v1 topological level. |
| Changed-path Bloom filters and commit-graph chains | Precedent for derived data in general: a per-commit value computed from the commit and its parents, built incrementally, and replaceable without changing stored objects. OpenScion makes this a first-class `(kind, version)` mechanism; **path history** is stored directly rather than probed through a filter. |
| Blame and path-limited log recomputed per request | Answered from derived data (path history, first-parent skip list) following the first parent. Full-DAG blame is a non-goal. |
| Rename detection inferred at diff time | Not recorded either. Copy detection is listed as a later derived kind. |
| Loose refs and packed-refs updated through `.lock` files; reftable stack | A ref is one record moved by **compare-and-swap** against its expected value. No lock files, and no operation moves two refs at once. Few refs are expected. |
| Reflogs | Not specified; each ref carries a `version` that increases on every move. |
| `git commit` writes the commit and moves the branch ref in one step | Appending a changeset to the log never reads or writes a ref. |
| Merge and rebase on the client, with `merge-tree` and `replay` as server-side building blocks | Merges and rebases run on the server and cost the size of the change. |
| Index, split and sparse index, untracked cache, fsmonitor | The client `opnscn` keeps a sparse working copy and a filesystem watcher. The server never needs an index. |
| Sparse checkout limits files, not objects | The client fetches only the trees and blobs under the paths it needs, so sparse checkout needs no protocol support. |
| Worktrees and submodules | Not modelled in the data model. |

Two git lessons carry over directly. First, every format that embeds an id is
tied to its hash function, and changing it means translating everything, which
is why the OpenScion encodings are pinned byte for byte with golden tests.
Second, many of git's fastest paths are derived caches added after the fact
(commit-graph, Bloom filters, bitmaps, cache tree); OpenScion starts from that
model instead of retrofitting it.
