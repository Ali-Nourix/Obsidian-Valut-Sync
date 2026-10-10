# Release: Supabase onboarding

Implementation target: an Obsidian setup wizard backed by a separate OAuth installer service. The public plugin must not contain OAuth client secrets, management tokens or service-role keys.

Flow: authorize Supabase in the browser, choose an existing dedicated project (or explicitly confirm creation), confirm target, install the bundled schema, create or reuse the user's sync account, return only the project URL and publishable key to the plugin, sign in locally, and select/create the vault. End-to-end encryption passphrases remain on the device.

The installer requires operator-provided OAuth app registration and HTTPS hosting before a real OAuth flow can run. Tests use fake Management/Auth API responses. No real project is created or modified during implementation. Existing accounts must not have passwords reset automatically; sign-up settings stay unchanged unless explicitly opted into.

This branch is for review, not an automatic publication or production deployment.
