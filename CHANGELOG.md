# Changelog

## Unreleased — direct setup and release cleanup

- Install on your own existing dedicated Supabase project with a short-lived, project-scoped PAT entered only in the local plugin wizard.
- Keep the SQL Editor fallback and a static, credential-free setup guide.
- Remove the retired OAuth/Cloudflare installer, browser callback, terminal deploy script, and their tests and duplicated guides.
- Migrate the obsolete installer URL out of saved settings without resetting sync configuration.
- Existing-user setup does not request administrative key secrets or reset passwords; project-wide sign-up settings are unchanged.
- Live Supabase installation and desktop/mobile acceptance checks are still required before publication.

## 0.3.0 - Far fewer writes, on devices and on Supabase

A sync with nothing to do now writes no file and makes one server call. Measured on a 300-note vault, five idle syncs went from 10 state-file rewrites and 20 server calls to 0 and 5.

### Devices

- The sync state file is written only when its content changed (it used to be rewritten two or three times per sync, even when idle), and during long syncs only every 200 files or 15 seconds.
- The last-sync time lives in device-local storage instead of `data.json`, so settings are no longer rewritten after every sync.
- The log file is written every five minutes at most, not after every entry.
- A merge base is written once per version of a note, never rewritten; unused bases are cleaned up once a day instead of every few minutes.
- Syncs after typing wait for 10 seconds of quiet (up to three minutes), and the default safety-net interval is 15 minutes.

### Supabase

- One check-in call (`register_device`) now returns the head, the peers, what is owed and what others asked for; a quiet sync makes no other call.
- Calls that only read no longer lock the vault row, which is a database write even when nothing changes.
- A device's "last seen" time is written at most once an hour.
- Garbage collection runs once, shortly after something was delivered, plus a safety net every six hours, instead of every five minutes.
- Schema version 3, backward compatible with 0.2.0 plugins. For an existing installation, review and run `supabase/schema.sql` in that dedicated project’s SQL Editor.

## 0.2.0 - Supabase as a relay, not a store

### Relay

- File contents stay on the server only until every other device has them, then they are deleted. Only a small index (names, content ids, versions; no content) remains.
- Content is uploaded only when another device needs it; a device alone uploads none.
- A new device, or one away for more than 30 days, asks the others for what it lacks; they send it on their next sync, and Realtime wakes the asker.
- Merge bases are kept on each device instead of on the server.
- With encryption on, file names in the index are encrypted too.

### Setup

- At that release, a terminal deploy helper installed the backend and optionally created the sync account. That helper was retired in the current Release branch; use the README’s direct or SQL setup instead.
- Schema version 2; running it over a version 1 install upgrades it in place.

## 0.1.0 - First release

### Sync

- Two-way sync of every vault file between desktop and mobile through your own Supabase project.
- Three-way comparison against each file's last synced state: creations, edits, deletions and renames are told apart and travel in both directions.
- Compare-and-set commits (`commit_files`): two devices never silently overwrite each other.
- Line-based merge for notes. Appends on two devices to the same note keep both. Overlapping edits leave a conflict copy next to the note.
- Live updates over Supabase Realtime, plus sync on edit, on returning to the foreground, when the network comes back, and on an interval.

### Safety

- Deleted files go to the trash.
- The first sync never deletes.
- Large deletions wait for approval.
- Files that merely vanished count as deleted only after a minute.
- Crash-safe at every step; checked by tests that interrupt a device at each step of a cycle.

### Encryption

- Optional end-to-end encryption: AES-256-GCM contents, HMAC content ids, and a passphrase key from PBKDF2 with 600 000 iterations.

### Interface

- English and Persian settings, notices and dialogs.
- Status bar, sync log and conflict list.
