<div align="center">

# Vault Sync

**Your vault. Your Supabase. Your devices.**

Sync Obsidian notes and files between desktop and mobile using your own Supabase project, with optional client-side encryption and conflict handling.

[فارسی](README.md) · [Installation](#installation) · [Setup](#setup) · [Security](#security) · [Development](#development)

[![Obsidian](https://img.shields.io/badge/Obsidian-Plugin-7C3AED?style=for-the-badge&logo=obsidian&logoColor=white)](https://obsidian.md)
[![Supabase](https://img.shields.io/badge/Backend-Your%20Supabase-3ECF8E?style=for-the-badge&logo=supabase&logoColor=white)](https://supabase.com)
[![License](https://img.shields.io/badge/License-GPL--3.0-46A171?style=for-the-badge)](LICENSE)
[![Platform](https://img.shields.io/badge/Platform-Desktop%20%2B%20Mobile-343A40?style=for-the-badge)](https://github.com/Ali-Nourix/Obsidian-Valut-Sync)

</div>

---

> **Release status:** the `Release` branch is still pre-release. Real-device desktop and mobile testing must be completed before treating it as production-ready. Build from source to try this branch.

## Overview

Vault Sync connects your Obsidian vault across devices through a Supabase project that you control. It is not a hosted sync service: you provide and manage the backend project.

Current design includes:
- Desktop and mobile sync.
- Optional client-side encryption.
- Conflict handling for files changed on multiple devices.
- An onboarding flow for creating or connecting the sync account.
- Supabase as the transfer backend rather than a permanent archive.

## Installation

If a packaged build is available, download the three plugin files — `main.js`, `manifest.json`, and `styles.css` — from the project's [Releases](https://github.com/Ali-Nourix/Obsidian-Valut-Sync/releases) page and place them in:

```text
<vault>/.obsidian/plugins/vault-sync/
```

Then reload Obsidian and enable Vault Sync under **Settings → Community plugins**.

### Build from source

Node.js **22 or newer** is required.

```bash
git clone --branch Release https://github.com/Ali-Nourix/Obsidian-Valut-Sync.git
cd Obsidian-Valut-Sync
npm ci
npm run build
```

Copy the generated plugin files into the plugin directory above. Check the current branch and release notes before relying on a packaged build.

## Setup

1. Create or select your own Supabase project.
2. Follow the onboarding flow to generate a temporary installation token with the documented permissions.
3. Let the plugin complete setup, then revoke the temporary token.
4. Connect the second device using the account created during setup.
5. Keep Obsidian open on the source device while initial files are being uploaded.

Use the exact current instructions in [the Persian README](README.md) if a step or permission has changed; never paste a secret key into an issue, web page, or chat.

## Security

- Enter the installation token only in the plugin's installation window.
- Use a **publishable/anon** key for normal settings; never put a **secret/service_role** key in plugin settings.
- The plugin does not require a creator-operated installation server.
- Optional encryption is performed on the device. Keep the passphrase safe; the server cannot recover it.
- Closing a window does not roll back a request already sent.
- Supabase is used as a transfer layer, not as a permanent archive.
- Hidden folders such as `.obsidian` and `.trash` are not synced. Background activity on phones may be restricted by the operating system.

## Troubleshooting

| Problem | What to check |
| --- | --- |
| Installation token rejected | Confirm the project, expiration, scoped permissions and required grants. |
| Account creation fails | Check API Key Secrets read permission, email settings and project password requirements. |
| Project is not ready | Wait for the project to become active, then reconnect. |
| Sign-in fails | Use the sync account's email and password, not the Supabase dashboard login. |
| Files remain pending | Open Obsidian on the source device so pending files can upload. |

For bug reports, use [GitHub Issues](https://github.com/Ali-Nourix/Obsidian-Valut-Sync/issues). Do not include credentials, tokens, private notes or other sensitive data.

## Development

```bash
npm test
npm run build
npm run preview:onboarding
```

The installation tests run offline. Before release, follow the real-device checklist at `docs/device-test-checklist.md`.

## License

[GNU General Public License v3.0](LICENSE)
