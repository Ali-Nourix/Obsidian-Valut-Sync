# Optional legacy OAuth installer

The main Release plugin now performs direct, on-device setup using the user's scoped PAT. It does not call this service or require Cloudflare/OAuth credentials. The previously deployed public endpoint is disabled. Nothing here is a required step for users.

For direct setup, use the main README and `docs/setup/index.html`. Choose an existing dedicated project and project-scoped token. The static guide collects no credentials.

The files in this directory remain an optional development implementation of OAuth authorization, collision checks and schema/account installation. Its tests are separate from the direct client. Do not deploy it by accident or treat it as a live installer.

If deliberately operating this optional service, register a Supabase OAuth app, set the callback to your own HTTPS origin plus `/oauth/callback`, and inject `SUPABASE_OAUTH_CLIENT_ID`, `SUPABASE_OAUTH_CLIENT_SECRET` and `INSTALLER_PUBLIC_URL` through secure hosting configuration. Keep project creation disabled unless its billing UX is reviewed. Configure minimum OAuth scopes from current official docs. Never commit credential values or log bodies, authorization headers, callback queries, approval codes or token responses.

Node entry point: `installer/server.mjs` (Node 22+). Cloudflare adapter: `installer/cloudflare.mjs`; bundle SQL with `node installer/build-cloudflare.mjs` and configure your own hostname in `wrangler.jsonc` before deployment. Memory-only sessions disappear on restarts/eviction; cancellation does not roll back remote changes. Credential references are cleared, not guaranteed forensically erased. Tokens discarded here are not automatically revoked at Supabase.

No live OAuth or direct Supabase installation was performed in the offline tests. See https://supabase.com/docs/guides/platform/oauth-apps/build-a-supabase-integration and https://supabase.com/docs/guides/platform/oauth-apps/oauth-scopes before using the optional path.
