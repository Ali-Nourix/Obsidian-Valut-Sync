# Sync design

This note is for anyone changing `src/core`. It records the rules the sync relies on and why each one exists.

## Data model

**Server**
- `files` holds one row per path: `hash` (content id), `size`, `mtime`, `version`, `seq`, `deleted`, `device_id`.
- Deletions are tombstones: an UPDATE that sets `deleted`, never a DELETE. That way every device eventually hears about them through the `seq` feed.
- `vaults.head_seq` is the seq of the vault's latest commit.

**Blobs**
- Stored in the bucket at `<user>/<vault>/<id[0:2]>/<id>`.
- `id` is SHA-256 of the plain bytes. In an encrypted vault it is HMAC-SHA256 under a key derived from the passphrase.
- Because blobs are content-addressed:
  - equal files are stored once;
  - a rename never re-uploads;
  - an object is never overwritten, so there are no stale CDN reads;
  - the merge base for any past version can be fetched by its id.

**Device**
- The device state is stored in `.obsidian/plugins/vault-sync/state/<vault id>.json`. It holds:
  - `cursor`: the highest seq pulled;
  - `remote`: a mirror of the server rows;
  - `base`: `{path, hash, version, mtime, size}` per file, i.e. what this device and the server agreed on at the last sync;
  - `missingSince`;
  - `rejected`.

## The cycle (`SyncEngine`)

1. **Pull.**
   - If `head_seq` equals the cursor, there is nothing to fetch.
   - Otherwise page through `seq > cursor`, ordered by seq.
   - If the mirror ends up empty while bases exist, the server was wiped. The device then forgets the bases and uploads again; it never treats a wipe as "delete everything here".
2. **Scan.**
   - A file whose (mtime, size) equals its base is unchanged and is not read.
   - Any other file is hashed.
   - Excluded folders and the size limit filter local files, server rows *and* bases alike. Excluding a folder therefore never looks like deleting it.
3. **Plan.** `plan()` is a pure function of L, R and B for each path key. The table below lists its decisions.
4. **Guard.**
   - Deletions above the thresholds, or any deletion while the vault is empty, are held back until the user approves them. Everything else still runs.
5. **Execute**, in this order:
   1. bookkeeping;
   2. server → device: renames, downloads, merges, conflicts;
   3. device → server: blob uploads, then `commit_files` in batches of 100;
   4. local trash;
   5. removal of folders those steps emptied.

A commit refused by compare-and-set updates the mirror with the row that won, and the cycle runs again (at most 4 rounds). The next round merges against the new row.

### Decision table (`planner.ts`)

| B | L | R | Action |
|---|---|---|---|
| – | present | none or tombstone | upload, expected = R.version or 0 |
| – | absent | live | download |
| – | present | live | same hash: adopt; else conflict |
| ✓ | unchanged | unchanged | nothing (refresh B's stat if only the stat moved) |
| ✓ | changed | unchanged | upload, expected = R.version |
| ✓ | unchanged | changed, live | download |
| ✓ | changed | changed, live | same hash: adopt; text: merge; else conflict |
| ✓ | deleted, confirmed | unchanged | tombstone |
| ✓ | deleted, unconfirmed | unchanged | wait (record `missingSince`) |
| ✓ | deleted | changed, live | download (an edit beats a delete) |
| ✓ | unchanged | tombstone | trash |
| ✓ | changed | tombstone | upload (resurrect) |
| ✓ | deleted | tombstone | drop B |
| ✓ | present | no row | upload, expected 0 |

Notes on the table:
- **Changed** means: L changed = hash ≠ B.hash; R changed = version ≠ B.version.
- **A delete is confirmed** when Obsidian reported a delete or rename event for the path or its folder, or when the file has stayed missing for `unconfirmedDeleteMs` (one minute).
- **Renames.** A tombstone and a new row with the same id, matching an untouched local file, become a local rename. They are paired only when the match is unambiguous; the other files are left for trash + download.

### Conflicts

- **Merge.** Text formats (`md`, `txt`, `canvas`, `csv`, `tsv`) are merged with diff3 against the base blob.
  - Changes that overlap or touch each other are conflicts, as in git.
  - One exception: when both sides only *inserted* lines at the same place, both insertions are kept, local first. This covers two devices appending to the same daily note.
  - A merged canvas must still parse as JSON.
- **Conflict copy.** In every other case:
  - this device's version keeps the path and is committed with compare-and-set;
  - the other version is written next to it as `name (conflict YYYY-MM-DD HHmm).ext` and committed as a new file under the same id, so no upload is needed.
  - A copy with the same content left by an interrupted cycle is reused, so a retry never creates a second copy.

## Invariants

These rules are why there is no journal and why a crash at any point is harmless. `test/sync-sim.mjs` crashes a device at every step of a busy cycle to check them.

1. A base changes only after its effect is durable: after the local write, or after the server accepted the commit.
2. An id is committed only after its blob is stored. A row therefore never points at a missing blob.
3. The cursor and the mirror are saved together.
4. A lagging base heals itself. "Changed on both sides to the same content" is simply adopted. A merge interrupted after writing the file re-merges to the same text on the next cycle, because diff3(base, merged, remote) = merged.
5. Writes into the vault are guarded:
   - open editors with unsaved typing are saved first;
   - the file must still have the size and mtime the plan saw;
   - if it does not, the write is skipped and the next cycle merges instead.
6. Server paths are NFC. Local paths are matched by key: NFC, plus lower case on case-insensitive file systems. On such a device, two server paths that differ only in case are both kept on the server; only the first one syncs, and the other is reported, never deleted.
7. A state file is trusted only if its nonce matches the one in this device's local storage. A copied plugin folder therefore starts with first-sync rules, which never delete.

## Server rules (`supabase/schema.sql`)

- `commit_files(p_vault, p_device, p_changes)` is the only way to write `files`.
  - It locks the vault row, so commits to one vault are serialised.
  - Each change applies only if the row's version equals `expected_version` (0 meaning "no row"). It then gets `version + 1` and `seq = head_seq + 1`.
  - Because the vault row is locked, seq order is commit order, and a reader paging `seq > cursor` cannot miss a row that committed late. A plain sequence would allow that.
  - A refused change returns the current row.
- RLS limits every table and storage object to `auth.uid()`. Clients cannot insert or update `files` directly.
