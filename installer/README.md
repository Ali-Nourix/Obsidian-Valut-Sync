# Vault Sync OAuth installer — Release preview

This service is an **installer**, not a sync relay. Notes go directly between the plugin and the user's own Supabase project. The service temporarily handles the user's management authorization, project/admin keys and sync password to install the backend and optionally create an Auth user. End users must trust its operator. Choose the manual SQL path if they do not want this trust boundary.

## Current implementation

- OAuth authorization-code flow with PKCE, one-use state and no refresh-token persistence.
- The callback requires an additional one-use browser-to-device approval. **Return to Obsidian** invokes `obsidian://vault-sync-setup`; the active modal accepts only its own session. A pasteable one-time approval code is a fallback. OAuth approval alone cannot give a remote session poller access to projects.
- Existing-project selection and confirmation, collision/future-schema checks, installation of the exact bundled `supabase/schema.sql`, RLS/private-bucket/Realtime verification.
- Create a sync Auth user (auto-confirmed only after explicit user consent), or reuse an existing account without resetting its password. Verify the supplied sync credentials before changing sign-up settings.
- Return only the whitelisted URL, publishable key, email and project ref. The plugin signs in independently; it then offers existing/new remote vault selection. Encryption passphrases remain on the device.
- Project creation is implemented but **disabled by default**. When enabled, require owned organization selection, region group, a user-chosen database password, matching name confirmation and an explicit cost acknowledgement. No guaranteed free project or price quote is implemented. Do not enable creation in production until billing/quota UX is reviewed for your organization policies.
- Installer capabilities and OAuth grants are held in memory, expire after 15 minutes, and are discarded after completion/failure/cancellation. Cancelling interrupts between steps; already committed schema/account/project changes are not rolled back. JavaScript memory clearing means dropping references, not guaranteed forensic zeroization.

## Operator setup (required before real OAuth works)

1. Use Node.js 22+. Register a **Supabase OAuth app** in your organization. Configure the allowed callback as exactly `https://YOUR-INSTALLER-HOST/oauth/callback`.
2. Grant the app only the Management API permissions needed to list/read the user's project, execute schema SQL, and retrieve project API keys. Extra Auth-configuration permission is needed only for the opt-in close-signups feature. Organization/project creation permissions are needed only when creation is enabled. Check the current scope table; do not assume all users or organizations permit these actions.
3. Supply hosting-provider secrets `SUPABASE_OAUTH_CLIENT_ID` and `SUPABASE_OAUTH_CLIENT_SECRET`. Supply non-secret configuration `INSTALLER_PUBLIC_URL` with the HTTPS origin (no path/query/credentials). These values are **not** plugin credentials. There are no real values in this repository. Do not paste them into issues or chat.
4. Keep `INSTALLER_ALLOW_PROJECT_CREATION` absent or `false` unless the creation/cost UX is deliberately enabled. `HOST` defaults to `127.0.0.1`, `PORT` to `8787`; containers set `HOST=0.0.0.0`. Use HTTPS termination at a trusted reverse proxy.
5. Start with `npm run installer`, or build from repository root with `docker build -f installer/Dockerfile -t vault-sync-installer .`. The container/service needs only Node built-ins and the bundled SQL; it does not need the user's database password for an **existing** project.
6. Disable request-body, Authorization-header, callback-query and token-response logging at every proxy/hosting layer. Browser approval codes are sensitive, one-use and short-lived. Do not enable APM request capture for these routes.
7. Configure the installer HTTPS URL in the preview plugin. Complete the flow with a throwaway project/user first. Never begin with a production website's shared project.

The Release plugin now includes the public address `https://vault-sync-installer.alinorizadeh1384.workers.dev` as its default installer. This is a public service URL, **not a credential**. Existing settings with an empty installer URL use this default; a nonempty user override is preserved. There is no embedded OAuth secret, PAT, service-role key or user account.

### Hosted Cloudflare deployment

The Worker and a single SQLite-backed Durable Object namespace have been deployed. `/health` is reachable, but reports `ready: false` until the operator supplies a registered OAuth app's credentials. **Deployment does not mean OAuth activation.** OAuth app registration, credential setup and a real end-to-end install still need completion.

The Durable Object coordinates all sessions so requests do not depend on arbitrary Worker-isolate routing. Session credentials remain **memory-only**. Only a cleanup deadline is written to storage. A restart or eviction drops pending sessions safely and users must reconnect. Completed SQL/account changes are not rolled back.

To reproduce deployment, adapt the public URL to your own host, then:

```bash
node installer/build-cloudflare.mjs
npx wrangler deploy --config wrangler.jsonc
npx wrangler secret put SUPABASE_OAUTH_CLIENT_ID
npx wrangler secret put SUPABASE_OAUTH_CLIENT_SECRET
```

Run the secret commands interactively on a trusted computer; never put values in source, command arguments, logs or issues. The app callback must exactly match `https://vault-sync-installer.alinorizadeh1384.workers.dev/oauth/callback` for the current deployment. For a different host, change both the callback and public URL. Publish/enable the OAuth app for other organizations as required by Supabase.

For existing-project setup the scope requirements are **Projects Read**, **Database Write**, **Secrets Read**, and **Auth Write** only if allowing users to close sign-ups. Project creation remains disabled; do not request Projects Write or Organizations Read solely for unused creation. Scopes are configured in the OAuth app, not added to the authorization URL.

Worker observability and Logpush are disabled. Do not enable tail/APM/request capture for callback or installer routes. Cloudflare still processes network traffic and manages platform data; this is not a claim that the provider records nothing. Start rate limiting uses Cloudflare's ingress IP rather than client-supplied forwarded headers, with a bounded global coordinator. Deployment uses existing account limits and does not upgrade the account plan. Review usage quotas before wider rollout.

`node --test test/installer.mjs test/cloudflare-installer.mjs` runs 17 local tests, including the Fetch adapter, unconfigured fail-closed state, host/origin validation, PKCE/session protection, body limits and ingress rate limiting. These are not proof of live OAuth or a completed Supabase installation.

## User flow

1. Open plugin settings → Set up Supabase automatically; approve trust in the displayed installer host.
2. Authorize in Supabase; click Return to Obsidian (or paste the one-time connection code).
3. Choose a dedicated project. Create one only if explicitly enabled; wait for `ACTIVE_HEALTHY` and refresh before installation.
4. Confirm its ref, enter the separate **sync** email/password, choose create/reuse account and leave project-wide sign-up changes off unless intended.
5. Run setup. It prepares schema/storage/Realtime and the sync account, then discards management credentials.
6. Choose an existing remote vault or create one. Optional encryption is handled locally; keep that passphrase for other devices.
7. Other devices need only the same project URL/publishable key and sync account. Choose the same vault, not a new one. They do not need OAuth/management authorization.

## Limits and production checklist

- Node deployment: single instance only; session state is in memory. Cloudflare deployment routes through one Durable Object coordinator. A restart loses pending sessions safely. Multiple replicas need a reviewed encrypted session store, replay protection and shared rate limiting before use; sticky sessions alone do not supply the other protections.
- Start rate limiting (10 sessions/minute/IP and 200 concurrent sessions) is intentionally small. In the Node deployment, a proxy may make it count the proxy IP; configure a proper edge rate limiter without trusting arbitrary forwarded headers in this service.
- No automatic SQL rollback or account/project deletion after partial failure. Retry with a new authorization; collision/version checks protect known installs. Never reset an existing account password as recovery.
- No OAuth refresh tokens are stored. Expired/missing permissions require reconnecting. The user can revoke the integration in Supabase afterwards; dropping local tokens is not the same as revoking a provider grant.
- No live Supabase OAuth/API calls were made in local tests. Full repository build/sync tests and real desktop/mobile/browser return testing are still required before publishing a release.
- Existing CI/release workflows in `main` use Node 20; the locked SDK requires Node 22. Update those workflow runtimes separately if the GitHub connection lacks permission to edit workflow files. This branch adds Node >=22 metadata and includes onboarding tests in `npm test`, but does not pretend a CI runtime was changed.

## Tests

`npm run test:onboarding` runs the offline installer, client and modal tests plus a targeted TypeScript check. `npm test` additionally runs the pre-existing sync/schema suite in a full checkout. Tests use fake project refs, keys and passwords, no personal credentials.

## References

- https://supabase.com/docs/guides/integrations/build-a-supabase-oauth-integration
- https://supabase.com/docs/guides/platform/oauth-apps/oauth-scopes
- https://supabase.com/docs/reference/javascript/auth-admin-createuser
- https://supabase.com/docs/guides/integrations/supabase-for-platforms
