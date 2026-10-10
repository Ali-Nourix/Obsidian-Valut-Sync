<div align="center">

# Vault Sync

[فارسی](README.md)

**Your vault. Your Supabase. Your devices.**

Sync Obsidian notes and files between your phone and computer using your own Supabase project.

[![Obsidian](https://img.shields.io/badge/Obsidian-Plugin-7C3AED?style=for-the-badge&logo=obsidian&logoColor=white)](https://obsidian.md)
[![Supabase](https://img.shields.io/badge/Backend-Your%20Supabase-3ECF8E?style=for-the-badge&logo=supabase&logoColor=white)](https://supabase.com)
[![License](https://img.shields.io/badge/License-GPL--3.0-46A171?style=for-the-badge)](LICENSE)
[![Platform](https://img.shields.io/badge/Platform-Desktop%20%2B%20Mobile-343A40?style=for-the-badge)](https://github.com/Ali-Nourix/Obsidian-Valut-Sync)

**Desktop + Mobile · Persian / English · Optional encryption · Conflict handling**

[**Installation**](#installation) · [**Setup**](#setup) · [**Screenshots**](#screenshots) · [**Security**](#security)

</div>

---

> The `Release` branch is still being prepared before public release. Live installation and real desktop/mobile testing must be completed; for now, build the source to try this branch.

## Install the plugin

<a id="installation"></a>

If a ready-to-install package is available under [Releases](https://github.com/Ali-Nourix/Obsidian-Valut-Sync/releases), get the three files `main.js`, `manifest.json` and `styles.css` from that release and place them in this vault folder:

```text
<vault>/.obsidian/plugins/vault-sync/
```

In Obsidian, open **Settings → Community plugins**; disable Restricted mode if needed, then enable Vault Sync.

**To build the current branch**, you need Node.js **22+**:

```bash
git clone --branch Release https://github.com/Ali-Nourix/Obsidian-Valut-Sync.git
cd Obsidian-Valut-Sync
npm ci
npm run build
```

Then copy those same three files into the plugin folder. The ZIP downloaded through **Code → Download ZIP** is the source code, not a ready-to-install package. Since the repository is public, its source can be obtained through GitHub.

## Setup — on the first device only

<a id="setup"></a>

Back up your vault before you begin. **Sync is not a backup.**

### 1. Create your own project

Open the [Supabase Dashboard](https://supabase.com/dashboard), create a **dedicated, empty** project for Vault Sync, and wait until it is ready. Get the 20-character project reference from the settings or dashboard URL.

Do not use the project for your main website or another application. Costs and capacity depend on your Supabase plan.

### 2. Create a temporary installation token

On [Access Tokens](https://supabase.com/dashboard/account/tokens), select **Generate new token**:

- Create a **Scoped** token, not a **Legacy / Account-wide** token.
- Select **only the Vault Sync project**.
- Choose a name, such as `Vault Sync setup`, and a short expiry suitable for installation.
- Select only these four permissions, then choose **Review access → Create token**:

| Permission | Access |
| --- | --- |
| Project Settings | Read |
| Database | Read-write |
| API Keys | Read |
| API Key Secrets | Read |

`API Key Secrets: Read` is required to **create the sync account automatically**. These permissions are powerful; restrict the token to your dedicated project. Organization access, billing, all-project access, and changes to Auth Config are not required.

A Scoped token starts with `sbp_fc`. The [official guide](https://supabase.com/docs/guides/platform/personal-access-tokens) explains permissions in detail. The link above opens the token page; you select the permissions yourself in the dashboard.

### 3. Let the plugin finish the setup

In Vault Sync settings:

1. Open **Direct setup with your own restricted token**.
2. Enter the project reference and temporary token, then confirm temporary management access to this project.
3. Select **Connect to Supabase**; verify the project name and type its reference again to confirm the destination.
4. Keep **Create sync account automatically** enabled and enter an email plus a separate password of at least **12 characters**; enter the password again to confirm it.
5. Select **Set up Vault Sync**. The plugin prepares the backend, creates and confirms the user **inside this project**, and tests the login. **You do not need to add a user manually.**
6. Create a new vault or select an existing one. If you enable encryption, keep the passphrase for your other devices.

The password above is for the sync account, **not your main Supabase Dashboard password**. If that email already has a user in this project, enter the current password for that account; the plugin will not change it. **Use existing account** is also available for existing users.

### 4. Revoke the installation token

Return to [Access Tokens](https://supabase.com/dashboard/account/tokens) and **Revoke** the token. You do not need it for syncing or for a second device. Removing the token from the plugin's memory is not a substitute for revoking it in Supabase.

You can also open the [web guide](docs/setup/index.html) locally; that page does not receive any token or password.

## Connect a second device

1. Install the plugin on the second device.
2. Enter the **same Project URL and publishable/anon key**; copy them from the first device's settings.
3. Sign in with the **same sync-account email and password**.
4. Select the **same vault**; do not create a new one.
5. If encryption is enabled, enter that vault's passphrase.

You do not need a new project, account, or installation token. Keep Obsidian open on both devices, select **Sync now**, and verify that a test note travels in both directions.

## Screenshots

<a id="screenshots"></a>

These are offline previews of the wizard code using sample data; they are not evidence of a live installation on Supabase.

![Connect to your own Supabase project](docs/images/setup-connect.svg)

<details>
<summary>Automatic sync-account creation and vault selection</summary>

![Project confirmation and automatic sync-account creation](docs/images/setup-account.svg)

![Vault selection and encryption](docs/images/setup-encryption.svg)

</details>

## Security and important notes

<a id="security"></a>

- Enter the installation token **only in the installation dialog**—never in the Publishable key field, a web page, an issue, or a chat.
- Normal settings use only the **publishable/anon** key and URL. Do not enter the **secret/service_role** key.
- The plugin does not require an installation server operated by the developer. The token and management key are not saved in settings or logs; they are kept temporarily in memory during setup.
- Optional encryption happens on the device. Keep the passphrase; the server cannot recover it.
- Closing the dialog does not roll back changes already made to the project. A submitted request may still finish.
- Supabase is a transfer intermediary, not a permanent archive. If a new device is waiting for a file, keep Obsidian open on the previous device too.
- Hidden folders such as `.obsidian` and `.trash` are not synced. Background activity on phones is limited.

## Troubleshooting

| Problem | Solution |
| --- | --- |
| Token is rejected | Check that it is Scoped, the selected project, expiry, and the four permissions above |
| Account creation fails | Check the API Key Secrets: Read permission, email, and the project's password requirements |
| Email already exists | Enter the current password for that account; its password is not changed automatically |
| Project is not ready | Wait until the project becomes active, then connect again |
| Sign-in fails | Check the sync-account email and password, not your Supabase Dashboard account |
| Files are still pending | Open Obsidian on the previous device so the files can be uploaded |

Report issues through [Issues](https://github.com/Ali-Nourix/Obsidian-Valut-Sync/issues); do not send sensitive information.

## Development

```bash
npm test
npm run build
npm run preview:onboarding
```

The installation tests run offline. Before release, complete the [real-device test checklist](docs/device-test-checklist.md).

## License

[GNU General Public License v3.0](LICENSE)
