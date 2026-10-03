# Changelog

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
