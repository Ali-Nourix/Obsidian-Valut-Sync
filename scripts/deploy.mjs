#!/usr/bin/env node
/**
 * Sets up a Supabase project for Vault Sync, start to finish:
 *
 *   npm run deploy
 *
 * It asks for what it needs (or reads it from the environment):
 *   SUPABASE_PROJECT_URL   https://<ref>.supabase.co, or just the project ref
 *   SUPABASE_ACCESS_TOKEN  a personal access token (sbp_…) from
 *                          https://supabase.com/dashboard/account/tokens
 *   VAULT_SYNC_CLOSE_SIGNUPS  yes / no   (default yes)
 *   VAULT_SYNC_USER_EMAIL, VAULT_SYNC_USER_PASSWORD  optional: create the sync account
 *
 * Then it installs supabase/schema.sql through the Management API, checks
 * it, optionally closes sign-ups and creates your account, and prints the
 * two values to paste into the plugin. Nothing is written to disk; the
 * token and keys live only in this process.
 */
import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { randomBytes } from 'node:crypto';

const API = 'https://api.supabase.com/v1';
const schema = readFileSync(new URL('../supabase/schema.sql', import.meta.url), 'utf8');
const interactive = process.stdin.isTTY && !process.argv.includes('--yes');

function ask(question, { hidden = false, fallback = '' } = {}) {
  if (!interactive) return Promise.resolve(fallback);
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    process.stdout.write(question);
    // Hidden input: echo nothing while the secret is typed.
    if (hidden) rl._writeToOutput = () => {};
    rl.question('', (answer) => {
      rl.close();
      if (hidden) process.stdout.write('\n');
      resolve(answer.trim() || fallback);
    });
  });
}

async function yesNo(question, defaultYes, env) {
  if (env) return /^y(es)?$/i.test(env);
  const answer = await ask(`${question} ${defaultYes ? '[Y/n]' : '[y/N]'} `, { fallback: defaultYes ? 'y' : 'n' });
  return /^y(es)?$/i.test(answer);
}

function projectRef(input) {
  const value = input.trim().replace(/\/+$/, '');
  if (/^[a-z0-9]{20}$/.test(value)) return value;
  const match = /^https:\/\/([a-z0-9]{20})\.supabase\.(co|in)/.exec(value);
  if (!match) throw new Error(`Not a Supabase project URL or ref: ${input}`);
  return match[1];
}

async function api(token, method, path, body) {
  const response = await fetch(`${API}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${method} ${path} → ${response.status}: ${text.slice(0, 500)}`);
  return text ? JSON.parse(text) : null;
}

const sql = (token, ref, query) => api(token, 'POST', `/projects/${ref}/database/query`, { query });

function step(text) {
  process.stdout.write(`• ${text}… `);
}
function done(text = 'done') {
  process.stdout.write(`${text}\n`);
}

async function main() {
  console.log('\nVault Sync — Supabase setup\n');
  const ref = projectRef(process.env.SUPABASE_PROJECT_URL || process.env.SUPABASE_PROJECT_REF || (await ask('Project URL (https://<ref>.supabase.co): ')));
  const token = process.env.SUPABASE_ACCESS_TOKEN || (await ask('Personal access token (sbp_…, input hidden): ', { hidden: true }));
  if (!token) throw new Error('A personal access token is required (https://supabase.com/dashboard/account/tokens).');
  const url = `https://${ref}.supabase.co`;

  step('Checking the project');
  const project = await api(token, 'GET', `/projects/${ref}`);
  if (project.status !== 'ACTIVE_HEALTHY') throw new Error(`Project "${project.name}" is ${project.status}; restore it in the dashboard first.`);
  done(`"${project.name}" (${project.region}, Postgres ${project.database?.version ?? '?'})`);

  step('Installing the database schema');
  await sql(token, ref, schema);
  const [{ version }] = await sql(token, ref, 'select public.vault_sync_schema_version() as version');
  done(`schema version ${version}`);

  step('Checking tables, bucket and realtime');
  const [check] = await sql(
    token,
    ref,
    `select
       (select count(*) from information_schema.tables where table_schema = 'public'
         and table_name in ('vaults', 'files', 'devices', 'deliveries', 'requests'))::int as tables,
       exists (select 1 from storage.buckets where id = 'vault-sync' and not public) as bucket,
       exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'vaults') as realtime`
  );
  if (check.tables !== 5 || !check.bucket || !check.realtime) throw new Error(`Unexpected state: ${JSON.stringify(check)}`);
  done('ok');

  const keys = await api(token, 'GET', `/projects/${ref}/api-keys?reveal=true`);
  const publishable = keys.find((k) => k.type === 'publishable')?.api_key ?? keys.find((k) => k.name === 'anon')?.api_key;
  const secret = keys.find((k) => k.type === 'secret')?.api_key ?? keys.find((k) => k.name === 'service_role')?.api_key;

  let email = process.env.VAULT_SYNC_USER_EMAIL || '';
  let password = process.env.VAULT_SYNC_USER_PASSWORD || '';
  if (!email && (await yesNo('Create the sync account now?', true, interactive ? '' : 'no'))) {
    email = await ask('  Email: ');
    password = await ask('  Password (empty: generate one, input hidden): ', { hidden: true });
  }
  if (email) {
    if (!password) password = randomBytes(18).toString('base64url');
    step(`Creating the account ${email}`);
    const response = await fetch(`${url}/auth/v1/admin/users`, {
      method: 'POST',
      headers: { apikey: secret, Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, email_confirm: true }),
    });
    const body = await response.text();
    if (response.ok) done();
    else if (/already been registered|email_exists/i.test(body)) done('already exists, left unchanged');
    else throw new Error(`Creating the user failed: ${response.status} ${body.slice(0, 300)}`);
  }

  if (await yesNo('Close sign-ups, so only accounts you create can sign in?', true, process.env.VAULT_SYNC_CLOSE_SIGNUPS)) {
    step('Closing sign-ups');
    await api(token, 'PATCH', `/projects/${ref}/config/auth`, { disable_signup: true });
    done();
  }

  console.log('\nDone. In Obsidian → Settings → Vault Sync, on every device:\n');
  console.log(`  Project URL       ${url}`);
  console.log(`  Publishable key   ${publishable}`);
  if (email) console.log(`  Email             ${email}`);
  if (email && !process.env.VAULT_SYNC_USER_PASSWORD) console.log(`  Password          ${password}   (shown once; keep it safe)`);
  if (!email) console.log('  Account           create one under Authentication → Users → Add user (tick "Auto Confirm User")');
  console.log('\nNever put the secret / service_role key or your access token in the plugin.\n');
}

main().catch((error) => {
  console.error(`\n✗ ${error.message}`);
  process.exit(1);
});
