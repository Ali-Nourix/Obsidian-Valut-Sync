# Device test checklist

The automated tests cover the sync logic. This list covers what only a real device can show. Run it on one desktop and one phone with a throwaway Supabase project, before each release that touches syncing.

## Setup

- [ ] Fresh install on desktop: the status bar shows "Sync: set up". No network requests until a URL and key are entered.
- [ ] A secret / service_role key is refused with an explanation.
- [ ] "Test connection" before running `schema.sql` reports the missing schema. After running it, the test succeeds.
- [ ] Create account → confirmation email → sign in. Signing in with a dashboard-created user also works.
- [ ] Create a remote vault on desktop. Choose it on the phone.
- [ ] Encrypted vault:
  - [ ] creating it asks for the passphrase twice;
  - [ ] the phone asks to unlock;
  - [ ] a wrong passphrase is refused;
  - [ ] "remember" survives a restart.

## Everyday sync

- [ ] Edit a note on the desktop. The phone, with Obsidian open, shows the change within a few seconds (live updates).
- [ ] Edit a note on the phone, switch away and back. The desktop receives it.
- [ ] Add an image on the phone; it appears on the desktop.
- [ ] Type continuously in a note for two minutes; it still syncs while you type, and the cursor never jumps.
- [ ] Edit the same note on both devices while one is offline (airplane mode). It is merged, or a conflict copy appears with a notice.
- [ ] Append to today's daily note on both devices. Both lines are kept.
- [ ] Rename a folder of notes on the desktop. The phone renames it too, and no copies appear in its trash.
- [ ] Delete a note on the phone. It goes to the desktop's trash, and the setting "Files & links → Deleted files" is respected.
- [ ] Delete 30 notes at once. Both devices ask before deleting. "Keep them" restores the notes.

## Names

- [ ] Persian names with آ, ۀ, ؤ and a half-space (ZWNJ) created on an iPhone open on Windows and Android, and vice versa.
- [ ] A note renamed only in letter case on desktop.
- [ ] A file name containing `:` created on macOS. Windows reports it as skipped instead of failing the whole sync.

## Robustness

- [ ] Kill Obsidian on the phone in the middle of a large first sync and reopen it. The sync finishes without duplicates.
- [ ] Paused project: pause the project in the dashboard. The plugin shows the "project paused" notice; restoring the project resumes syncing.
- [ ] A 60 MB file is skipped and listed in the sync log.
- [ ] A vault with 5,000 files: the first sync completes on the phone, and later syncs take seconds.
- [ ] "Reset sync state" followed by a sync changes nothing.
