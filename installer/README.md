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

There is no hard-coded maintainer host, OAuth secret, PAT, service-role key or user account. Until steps 1–7 are complete, **Connect Supabase will not be a functioning live integration**. This change has not registered an OAuth app or deployed the service.

## User flow

1. Open plugin settings → Set up Supabase automatically; approve trust in the displayed installer host.
2. Authorize in Supabase; click Return to Obsidian (or paste the one-time connection code).
3. Choose a dedicated project. Create one only if explicitly enabled; wait for `ACTIVE_HEALTHY` and refresh before installation.
4. Confirm its ref, enter the separate **sync** email/password, choose create/reuse account and leave project-wide sign-up changes off unless intended.
5. Run setup. It prepares schema/storage/Realtime and the sync account, then discards management credentials.
6. Choose an existing remote vault or create one. Optional encryption is handled locally; keep that passphrase for other devices.
7. Other devices need only the same project URL/publishable key and sync account. Choose the same vault, not a new one. They do not need OAuth/management authorization.

## Limits and production checklist

- Single instance only: session state is in memory. A restart loses pending sessions safely. Multiple replicas need a reviewed encrypted session store, replay protection and shared rate limiting before use; sticky sessions alone do not supply the other protections.
- Start rate limiting (10 sessions/minute/IP and 200 concurrent sessions) is intentionally small. Behind a proxy it may count the proxy IP; configure a proper edge rate limiter without trusting arbitrary forwarded headers in this service.
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
