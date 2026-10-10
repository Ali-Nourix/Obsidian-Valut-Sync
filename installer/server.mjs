import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { createInstaller } from './core.mjs';

// Operator secrets are supplied by the hosting provider, never committed or sent to the plugin.
const installer = createInstaller({
  clientId: process.env.SUPABASE_OAUTH_CLIENT_ID,
  clientSecret: process.env.SUPABASE_OAUTH_CLIENT_SECRET,
  publicUrl: process.env.INSTALLER_PUBLIC_URL,
  schema: readFileSync(new URL('../supabase/schema.sql', import.meta.url), 'utf8'),
  allowProjectCreation: process.env.INSTALLER_ALLOW_PROJECT_CREATION === 'true',
});
const server = createServer(installer.handle);
server.requestTimeout = 150_000;
server.headersTimeout = 20_000;
const cleanup = setInterval(() => installer.sweep(), 60_000);
cleanup.unref();
server.listen(Number(process.env.PORT || 8787), process.env.HOST || '127.0.0.1', () => console.log('Vault Sync installer ready'));
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => {
  clearInterval(cleanup); installer.close(); server.close(() => process.exit(0));
});
