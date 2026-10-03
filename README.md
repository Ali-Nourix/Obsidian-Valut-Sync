# Vault Sync

Keep one Obsidian vault in sync between your phone and your computer through **your own Supabase project**. Notes and attachments flow both ways within seconds. Edits made on two devices at once are merged automatically, and when they truly collide both versions are kept. Optional end-to-end encryption means Supabase only ever stores unreadable data.

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
- **Renames** travel as renames, without re-uploading the content.
- **Persian and other non-Latin names** work across iOS, macOS, Android and Windows. Names are compared in Unicode NFC, and letter case is handled on case-insensitive file systems.
- **Optional end-to-end encryption**: AES-256-GCM, with a key from your passphrase via PBKDF2 (600 000 iterations). File names stay visible to the server; contents do not.
- **English and Persian** interface.

## Setup

1. **Create a Supabase project** at [supabase.com](https://supabase.com). The free tier is enough for most vaults: 1 GB of storage and files up to 50 MB.
2. **Run the schema.** In the project, open **SQL Editor**, paste the whole of [`supabase/schema.sql`](supabase/schema.sql) and click **Run**. It is safe to run again later.
3. **Create your account.** Either use **Create account** in the plugin settings and confirm the email Supabase sends, or add a user under **Authentication → Users → Add user** with "Auto confirm" ticked.
4. **Install the plugin** on every device. Until it is in the community list, use [BRAT](https://github.com/TfTHacker/obsidian42-brat) or copy `main.js`, `manifest.json` and `styles.css` from a release into `<vault>/.obsidian/plugins/vault-sync/`.
5. **In the plugin settings, on each device:**
   1. Paste the **Project URL** and the **publishable (anon) key** from *Project Settings → API*. Never use the secret / service_role key.
   2. Sign in with the same account on every device.
   3. Under **Remote vault**, click **Create new** on the first device. Encryption is optional and cannot be changed later.
   4. On the other devices, **choose** that same vault.

On a device that already has files, the first sync keeps everything from both sides. Files missing on one side are copied over, and files that differ become conflict copies. Nothing is deleted.

## How it works

Each file has a row in `public.files` with a content id (SHA-256, or HMAC when encrypted), a version and a `seq` number. The contents themselves live in the private `vault-sync` storage bucket, under their content id.

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
- With encryption on, file contents and their ids are unreadable to Supabase. File paths, sizes and times are not encrypted.
- If you lose the encryption passphrase, the encrypted files on the server cannot be recovered. Your local files are not affected.
- This plugin connects to the Supabase project you configure and to nothing else.

## Limits

- Hidden folders (`.obsidian`, `.trash`) are not synced, so settings, themes and plugins stay per device.
- Files larger than the configured limit (default 50 MB, the free-tier maximum) are skipped and listed in the sync log.
- Free Supabase projects pause after a week without activity. The plugin tells you when that happens; restore the project in the dashboard.
- Keeping the vault in iCloud Drive *and* syncing it with this plugin is not recommended: two sync systems on one folder fight each other.
- Old file versions stay in storage; there is no clean-up of unreferenced blobs yet.

## Development

```bash
npm install
npm test            # unit tests, two/three-device simulations, fuzzing, schema on PGlite, plugin load
npm run build       # type-check and bundle main.js
npm run dev         # rebuild on change
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
