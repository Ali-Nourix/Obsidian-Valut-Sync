# Vault Sync

Keep one Obsidian vault in sync between your phone and your computer through **your own Supabase project**. Notes and attachments flow both ways within seconds. Edits made on two devices at once are merged automatically, and when they truly collide both versions are kept.

Supabase is used as a **relay, not as storage**: a file's content stays on the server only until your other devices have received it, and is then deleted. What remains is a small index of names, fingerprints and versions (no content) that lets devices detect concurrent edits. With end-to-end encryption on, even the names in that index are encrypted.

> راهنمای فارسی نصب و راه‌اندازی: [docs/setup-supabase.fa.md](docs/setup-supabase.fa.md)

## Features

- **Two-way sync** of every file in the vault (notes, images, PDFs, canvases…), on desktop and mobile (iOS, Android).
- **Near-instant**: Supabase Realtime tells the other devices about a change; they also check when Obsidian returns to the foreground and on a safety-net interval.
- **No lost edits**:
  - Notes edited on two devices are merged line by line.
  - Two devices appending to the same daily note keep both additions.
  - Overlapping edits, or edits to binary files, keep your version under the original name and save the other version as `note (conflict 2026-10-03 1430).md`.
- **Safe deletes**:
  - Deleted files go to the trash.
  - The first sync on a device never deletes anything.
  - A sync that would delete many files waits for your approval.
  - A file that merely vanished (for example evicted by iCloud) is not treated as deleted until it has stayed missing for a minute.
- **Relay, not storage**: content is uploaded only when another device needs it and deleted once delivered. A device alone uploads no content at all. A new device, or one that was away for a long time, asks the others for what it lacks; they send it the next time they run Obsidian.
- **Renames** travel as renames, without re-uploading the content.
- **Persian and other non-Latin names** work across iOS, macOS, Android and Windows. Names are compared in Unicode NFC, and letter case is handled on case-insensitive file systems.
- **Optional end-to-end encryption**: AES-256-GCM, with a key from your passphrase via PBKDF2 (600 000 iterations). Contents and file names are both unreadable to the server.
- **English and Persian** interface.

## Setup

1. **Create a Supabase project** at [supabase.com](https://supabase.com). The free tier is plenty: the server only ever holds files in transit.
2. **Install the backend with one command.** Create a personal access token at [supabase.com/dashboard/account/tokens](https://supabase.com/dashboard/account/tokens), then in this project:

   ```bash
   npm install
   npm run deploy
   ```

   It asks for the project URL and the token, installs [`supabase/schema.sql`](supabase/schema.sql) (tables, functions, private bucket, realtime), can create your sync account, offers to close public sign-ups, and prints the URL and publishable key for the plugin. It is safe to run again, for example after an update. You can also paste `supabase/schema.sql` into the dashboard's **SQL Editor** by hand.
3. **Your account.** If you did not create it with `npm run deploy`, add a user under **Authentication → Users → Add user** with "Auto Confirm User" ticked (or use **Create account** in the plugin while sign-ups are open).
4. **Install the plugin** on every device. Until it is in the community list, use [BRAT](https://github.com/TfTHacker/obsidian42-brat) or copy `main.js`, `manifest.json` and `styles.css` from a release into `<vault>/.obsidian/plugins/vault-sync/`.
5. **In the plugin settings, on each device:**
   1. Paste the **Project URL** and the **publishable (anon) key** from *Project Settings → API*. Never use the secret / service_role key.
   2. Sign in with the same account on every device.
   3. Under **Remote vault**, click **Create new** on the first device. Encryption is optional and cannot be changed later.
   4. On the other devices, **choose** that same vault.

On a device that already has files, the first sync keeps everything from both sides. Files missing on one side are copied over, and files that differ become conflict copies. Nothing is deleted.

## How it works

Each file has a row in `public.files` (the index) with a content id (SHA-256, or HMAC when encrypted), a version and a `seq` number. Contents travel through the private `vault-sync` storage bucket, named by content id, and only for as long as needed:

- When a device commits a change, the server records that every *other* device is owed that blob. The blob is uploaded only if there is another device.
- A device that has received a blob (or no longer needs it) acknowledges it. A blob nobody is owed is deleted.
- A device that needs content the server no longer has asks for it; any device holding that content uploads it on its next sync, and Realtime wakes the asker.
- Devices unseen for 30 days are forgotten, so nothing is held for them; when they return, they ask.
- Merging needs the common ancestor of two edits. Each device keeps that copy of its notes locally (in the plugin folder), so merging works without the server keeping old versions.

Every device remembers the **base**: what it and the server agreed on at the last sync. Each sync compares three things for every path: the local file (L), the server row (R) and the base (B). Comparing against B is what tells "created here" apart from "deleted there", and "edited on both sides" apart from "edited on one".

| B | Local | Server | Result |
|---|---|---|---|
| – | new | – | upload |
| – | – | new | download |
| ✓ | changed | same | upload (compare-and-set on the version) |
| ✓ | same | changed | download |
| ✓ | changed | changed | merge, or keep both |
| ✓ | deleted | same | delete on the server |
| ✓ | same | deleted | move to trash here |
| ✓ | deleted | changed | the edit wins: download |
| ✓ | changed | deleted | the edit wins: upload |

Writes go through one database function, `commit_files`. It applies each change only if the row is still at the version the device saw, so two devices can never silently overwrite each other. The loser merges and tries again. The full decision table and the reasons the cycle is crash-safe are in [docs/sync-design.md](docs/sync-design.md).

## Privacy and security

- Every row and every stored file belongs to your Supabase user (row level security). The publishable key alone can read or write nothing.
- The session, the device id and any remembered encryption key are stored in Obsidian's per-device local storage, not in `data.json`, so they do not travel with a copy of the vault folder.
- File contents are on the server only in transit and are deleted after delivery.
- With encryption on, file contents, content ids and file names are unreadable to Supabase. Sizes and times are not encrypted.
- If you lose the encryption passphrase, the encrypted files on the server cannot be recovered. Your local files are not affected.
- This plugin connects to the Supabase project you configure and to nothing else.

## Limits

- Hidden folders (`.obsidian`, `.trash`) are not synced, so settings, themes and plugins stay per device.
- Files larger than the configured limit (default 50 MB, the free-tier maximum) are skipped and listed in the sync log.
- Free Supabase projects pause after a week without activity. The plugin tells you when that happens; restore the project in the dashboard.
- Keeping the vault in iCloud Drive *and* syncing it with this plugin is not recommended: two sync systems on one folder fight each other.
- Because the server keeps no copies, a new device only fills up once one of your existing devices has run Obsidian after it joined. Phones only sync while Obsidian is open.
- The server does not keep history: it is not a backup. Keep your own backups.

## Development

```bash
npm install
npm test            # unit tests, two/three-device simulations, fuzzing, schema on PGlite, plugin load
npm run build       # type-check and bundle main.js
npm run dev         # rebuild on change
npm run deploy      # install or update the Supabase backend (asks for project URL and access token)
```

`npm test` runs entirely offline. To also run the backend contract and a two-device sync against a real project, use a throwaway project or user:

```bash
VAULT_SYNC_SUPABASE_URL=https://xxxx.supabase.co \
VAULT_SYNC_SUPABASE_KEY=<publishable key> \
VAULT_SYNC_SUPABASE_EMAIL=test@example.com \
VAULT_SYNC_SUPABASE_PASSWORD=... \
npm run test:live
```

Layout:

- `src/core/`: the sync itself, with no Obsidian imports.
  - `planner.ts`: the three-way decisions.
  - `engine.ts`: the cycle.
  - `merge.ts` and `diff3.ts`: merging.
  - `crypto.ts`: encryption.
  - `scheduler.ts`: when to sync.
- `src/backend/`: the `RemoteBackend` interface, the Supabase implementation and an in-memory one for tests. A different storage service only needs another implementation of `RemoteBackend`.
- `src/obsidian/`: the vault, state files and device storage on top of Obsidian's API.
- `src/ui/` and `main.ts`: settings, dialogs, commands and the status bar.
- `supabase/schema.sql`: the database setup.

### Releasing

Same flow as TaskPro:

1. Bump `version` in `manifest.json`, `package.json` and `package-lock.json`, and add the version to `versions.json`.
2. Push a tag with exactly that version, without a `v` prefix.

The `release` workflow then tests, builds and publishes `main.js`, `manifest.json`, `styles.css` and a zip.

## License

MIT
