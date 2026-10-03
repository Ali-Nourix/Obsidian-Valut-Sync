/**
 * Runs supabase/schema.sql on a real Postgres (PGlite, in-process) with
 * Supabase's auth and storage schemas stubbed, and checks the rules the
 * plugin relies on: compare-and-set commits, gap-free seq, path checks, and
 * that one user can neither read nor write another user's vault or blobs.
 */
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { checker } from './harness/load.mjs';

const { eq, ok, count } = checker();
const schema = readFileSync(new URL('../supabase/schema.sql', import.meta.url), 'utf8');

const db = new PGlite();
await db.exec(`
  create role anon nologin;
  create role authenticated nologin;
  create schema auth;
  create table auth.users (id uuid primary key);
  create function auth.uid() returns uuid language sql stable as
    $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
  create schema storage;
  create table storage.buckets (id text primary key, name text not null, public boolean default false);
  create table storage.objects (
    id uuid primary key default gen_random_uuid(),
    bucket_id text references storage.buckets (id),
    name text not null,
    created_at timestamptz default now()
  );
  alter table storage.objects enable row level security;
  create function storage.foldername(name text) returns text[] language sql immutable as
    $$ select (string_to_array(name, '/'))[1:array_length(string_to_array(name, '/'), 1) - 1] $$;
  create publication supabase_realtime;
  grant usage on schema public, auth, storage to anon, authenticated;
  grant select, insert, update, delete on storage.objects to authenticated;
  insert into auth.users values ('11111111-1111-1111-1111-111111111111'), ('22222222-2222-2222-2222-222222222222');
`);
const U1 = '11111111-1111-1111-1111-111111111111';
const U2 = '22222222-2222-2222-2222-222222222222';

await db.exec(schema);
await db.exec(schema); // re-runnable
ok(true, 'schema applies twice');

async function as(user, fn) {
  await db.exec(`set role authenticated; select set_config('request.jwt.claim.sub', '${user ?? ''}', false);`);
  try {
    return await fn();
  } finally {
    await db.exec(`reset role;`);
  }
}
async function fails(promise, pattern, label) {
  try {
    await promise;
  } catch (error) {
    ok(pattern.test(error.message), `${label} (${error.message})`);
    return;
  }
  throw new Error(`${label}: did not fail`);
}
// Runs a statement as the database owner, from inside a user's block.
const admin = async (sql, params) => {
  await db.exec(`reset role`);
  try {
    return await db.query(sql, params);
  } finally {
    await db.exec(`set role authenticated`);
  }
};
const H = (c) => c.repeat(64);
const change = (path, hash, expected, deleted = false) => ({ path, hash: H(hash), size: 3, mtime: 1, deleted, expected_version: expected });
const commit = async (vault, changes, device = 'A') =>
  (await db.query(`select public.commit_files($1, $2, $3::jsonb) as r`, [vault, device, JSON.stringify(changes)])).rows[0].r;

// ── vaults ──────────────────────────────────────────────────────────────────
const vault = await as(U1, async () => (await db.query(`insert into public.vaults (name) values ('Main') returning id, user_id, head_seq`)).rows[0]);
eq(vault.user_id, U1, 'a new vault belongs to the signed-in user');
eq(Number(vault.head_seq), 0, 'and starts at seq 0');
await as(U1, () => fails(db.query(`insert into public.vaults (name) values ('Main')`), /duplicate key/, 'vault names are unique per user'));
await as(U1, () => fails(db.query(`insert into public.vaults (name, user_id) values ('X', '${U2}')`), /permission denied/, 'cannot create a vault for someone else'));
await as(U1, () => fails(db.query(`update public.vaults set head_seq = 99`), /permission denied/, 'head_seq cannot be edited by hand'));
await as(null, () => fails(commit(vault.id, [change('a.md', 'a', 0)]), /not authenticated/, 'signed out cannot commit'));

// ── compare-and-set ─────────────────────────────────────────────────────────
await as(U1, async () => {
  const first = await commit(vault.id, [change('a.md', 'a', 0), change('b.md', 'b', 0)]);
  eq(first.map((r) => [r.ok, r.row.version, r.row.seq]), [[true, 1, 1], [true, 1, 2]], 'two new files: v1, seq 1 and 2');
  eq(Object.keys(first[0].row).sort(), ['deleted', 'device_id', 'hash', 'mtime', 'name_enc', 'path', 'seq', 'size', 'version'], 'row shape returned to the plugin');

  const stale = await commit(vault.id, [change('a.md', 'c', 0)], 'B');
  eq([stale[0].ok, stale[0].row.version, stale[0].row.hash], [false, 1, H('a')], 'creating an existing path is refused with the current row');

  const update = await commit(vault.id, [change('a.md', 'c', 1)], 'B');
  eq([update[0].ok, update[0].row.version, update[0].row.seq, update[0].row.device_id], [true, 2, 3, 'B'], 'an update based on v1 succeeds as v2');

  const lost = await commit(vault.id, [change('a.md', 'd', 1)], 'A');
  eq([lost[0].ok, lost[0].row.version], [false, 2], 'a second update based on v1 is refused');

  const tomb = await commit(vault.id, [change('b.md', 'b', 1, true)]);
  eq([tomb[0].ok, tomb[0].row.deleted, tomb[0].row.version], [true, true, 2], 'a delete is a tombstone with a new version');

  const missing = await commit(vault.id, [change('nope.md', 'a', 3)]);
  eq(missing[0], { i: 0, ok: false, row: null }, 'an update to a path with no row is refused with null');

  const head = (await db.query(`select head_seq, head_device from public.vaults where id = $1`, [vault.id])).rows[0];
  eq([Number(head.head_seq), head.head_device], [4, 'A'], 'head_seq counts only applied commits');
  const seqs = (await db.query(`select seq from public.files where vault_id = $1 order by seq`, [vault.id])).rows.map((r) => Number(r.seq));
  eq(seqs, [3, 4], 'each path carries its latest seq');

  await fails(commit(vault.id, [change('á.md', 'a', 0)]), /files_path_ok/, 'decomposed (NFD) paths are rejected');
  await fails(commit(vault.id, [change('../x.md', 'a', 0)]), /files_path_ok/, 'parent segments are rejected');
  await fails(commit(vault.id, [{ ...change('x.md', 'a', 0), hash: 'zz' }]), /files_hash_ok/, 'malformed ids are rejected');
  await fails(commit(vault.id, Array.from({ length: 201 }, (_, i) => change(`f${i}.md`, 'a', 0))), /at most 200/, 'batches are capped');
  const persian = await commit(vault.id, [change('یادداشت‌ها/آب.md', 'e', 0)]);
  eq(persian[0].ok, true, 'NFC Persian paths with ZWNJ are accepted');
  await fails(db.query(`insert into public.files (vault_id, path, user_id, hash, size, mtime, version, seq) values ($1, 'z.md', $2, $3, 1, 1, 1, 99)`, [vault.id, U1, H('a')]), /permission denied/, 'files cannot be written directly');
});

// ── isolation between users ─────────────────────────────────────────────────
await as(U2, async () => {
  eq((await db.query(`select * from public.vaults`)).rows.length, 0, 'another user sees no vaults');
  eq((await db.query(`select * from public.files`)).rows.length, 0, 'nor files');
  await fails(commit(vault.id, [change('evil.md', 'a', 0)]), /vault not found/, 'nor can commit into the vault');
  await fails(db.query(`insert into storage.objects (bucket_id, name) values ('vault-sync', '${U1}/${vault.id}/aa/x')`), /row-level security/, 'nor write into its storage folder');
  await db.query(`insert into storage.objects (bucket_id, name) values ('vault-sync', '${U2}/v/aa/x')`);
  ok(true, 'but can write into its own');
});
await as(U1, async () => {
  await db.query(`insert into storage.objects (bucket_id, name) values ('vault-sync', '${U1}/${vault.id}/aa/x')`);
  eq((await db.query(`select name from storage.objects`)).rows.map((r) => r.name), [`${U1}/${vault.id}/aa/x`], 'each user lists only their own blobs');
  eq((await db.query(`select public.vault_sync_schema_version() as v`)).rows[0].v, 3, 'schema version is readable');
});

// ── concurrent commits: seq never goes backwards ────────────────────────────
await as(U1, async () => {
  const before = Number((await db.query(`select head_seq from public.vaults where id = $1`, [vault.id])).rows[0].head_seq);
  const results = await Promise.all(Array.from({ length: 10 }, (_, i) => commit(vault.id, [change(`c${i}.md`, 'f', 0)], `D${i}`)));
  const seqs = results.map((r) => r[0].row.seq).sort((a, b) => a - b);
  eq(seqs, Array.from({ length: 10 }, (_, i) => before + 1 + i), 'concurrent commits get consecutive seqs');
});

// ── relay: devices, deliveries, requests, garbage ───────────────────────────
const rpc = async (fn, args) => (await db.query(`select public.${fn}(${args.map((_, i) => `$${i + 1}`).join(', ')}) as r`, args)).rows[0].r;
await as(U1, async () => {
  const relay = (await db.query(`insert into public.vaults (name) values ('Relay') returning id`)).rows[0].id;
  const alone = await rpc('register_device', [relay, 'A']);
  eq([alone.peers, alone.deliveries, alone.requests, Number(alone.head_seq)], [0, [], [], 0], 'a lone device has no peers, is owed nothing and sees the head');
  await commit(relay, [change('solo.md', 'a', 0)], 'A');
  eq((await admin(`select count(*)::int as n from public.deliveries`)).rows[0].n, 0, 'without peers a commit owes nothing to anyone');

  eq((await rpc('register_device', [relay, 'B'])).peers, 1, 'a second device sees one peer');
  eq((await rpc('register_device', [relay, 'A'])).peers, 1, 'and so does the first');
  await commit(relay, [change('n.md', 'b', 0)], 'A');
  eq((await rpc('register_device', [relay, 'B'])).deliveries, [{ hash: H('b'), path: 'n.md', name_enc: null }], 'B is owed the new blob');
  eq((await rpc('register_device', [relay, 'A'])).deliveries, [], 'the committer is not');

  await commit(relay, [change('n.md', 'c', 1)], 'A');
  eq((await rpc('register_device', [relay, 'B'])).deliveries.map((d) => d.hash), [H('c')], 'a newer version replaces what B was owed');
  await commit(relay, [change('n.md', 'd', 2)], 'B');
  eq((await rpc('register_device', [relay, 'B'])).deliveries, [], "B's own commit clears what it was owed for that path");
  eq((await rpc('register_device', [relay, 'A'])).deliveries.map((d) => d.hash), [H('d')], 'and owes A the new version');
  eq(await rpc('ack_received', [relay, 'A', JSON.stringify([{ path: 'n.md', hash: H('d') }])]), 1, 'A acknowledges it');
  eq((await rpc('register_device', [relay, 'A'])).deliveries, [], 'and is owed nothing');

  await commit(relay, [change('t.md', 'e', 0)], 'A');
  await commit(relay, [change('t.md', 'e', 1, true)], 'A');
  eq((await rpc('register_device', [relay, 'B'])).deliveries, [], 'a tombstone cancels what was owed for the path');

  const signal = async () => (await db.query(`select signal_device from public.vaults where id = $1`, [relay])).rows[0].signal_device;
  eq(await rpc('request_blobs', [relay, 'B', JSON.stringify([{ path: 'solo.md', hash: H('a') }])]), 1, 'B asks for a blob no longer on the server');
  eq(await signal(), 'B', 'which wakes the other devices');
  eq(await rpc('open_requests', [relay, 'A']), [H('a')], 'A sees the request');
  eq(await rpc('open_requests', [relay, 'B']), [], 'B does not see its own');
  eq((await rpc('register_device', [relay, 'A'])).requests, [H('a')], 'and so does its check-in');
  eq(await rpc('fulfil_requests', [relay, 'A', JSON.stringify([H('a')])]), 1, 'A uploads and fulfils it');
  eq(await signal(), 'A', 'waking B');
  eq((await rpc('register_device', [relay, 'B'])).deliveries, [{ hash: H('a'), path: 'solo.md', name_enc: null }], 'the request became a delivery');
  eq(await rpc('open_requests', [relay, 'A']), [], 'and is no longer open');

  const blob = (h) => `${U1}/${relay}/${h.slice(0, 2)}/${h}`;
  await admin(`insert into storage.objects (bucket_id, name, created_at) values
    ('vault-sync', $1, now() - interval '1 hour'), ('vault-sync', $2, now() - interval '1 hour'), ('vault-sync', $3, now())`, [blob(H('a')), blob(H('b')), blob(H('f'))]);
  eq(await rpc('garbage_blobs', [relay, 600]), [blob(H('b'))], 'garbage: old blobs nobody is owed, not owed ones and not fresh uploads');
  await rpc('ack_received', [relay, 'B', JSON.stringify([{ path: 'solo.md', hash: H('a') }])]);
  eq((await rpc('garbage_blobs', [relay, 0])).sort(), [blob(H('a')), blob(H('b'))].sort(), 'once B has it, its blob is garbage too (grace never below a minute)');

  await admin(`update public.devices set last_seen = now() - interval '31 days' where device_id = 'B'`);
  await admin(`update public.devices set last_seen = now() - interval '2 hours' where device_id = 'A'`);
  await commit(relay, [change('late.md', 'a', 0)], 'A');
  eq((await rpc('register_device', [relay, 'A'])).peers, 0, 'a device unseen for 30 days is forgotten, with what it was owed');
  await fails(rpc('register_device', ['00000000-0000-0000-0000-000000000000', 'X']), /vault not found/, 'unknown vaults are refused');
});
await as(U2, async () => {
  const id = vault.id;
  await fails(rpc('register_device', [id, 'evil']), /vault not found/, "another user cannot join a vault");
  await fails(rpc('garbage_blobs', [id, 600]), /vault not found/, "nor list its blobs");
  await fails(db.query(`select * from public.deliveries`), /permission denied/, 'deliveries are not readable directly');
});

// ── a quiet check-in writes nothing ─────────────────────────────────────────
await as(U1, async () => {
  const quiet = (await db.query(`insert into public.vaults (name) values ('Quiet') returning id`)).rows[0].id;
  await rpc('register_device', [quiet, 'A']);
  const seen = async () => (await admin(`select last_seen from public.devices where vault_id = $1 and device_id = 'A'`, [quiet])).rows[0].last_seen.toISOString();
  const first = await seen();
  await admin(`update public.devices set last_seen = now() - interval '10 minutes' where vault_id = '${quiet}'`);
  const tenMinutesAgo = await seen();
  await rpc('register_device', [quiet, 'A']);
  eq(await seen(), tenMinutesAgo, 'a check-in within the hour does not touch the device row');
  await admin(`update public.devices set last_seen = now() - interval '2 hours' where vault_id = '${quiet}'`);
  const twoHoursAgo = await seen();
  await rpc('register_device', [quiet, 'A']);
  eq((await seen()) !== twoHoursAgo, true, 'after an hour it records the heartbeat');
  ok(first.length > 0, 'heartbeat time is readable');
  const locks = (await admin(`select count(*)::int as n from pg_locks l join pg_class c on c.oid = l.relation where c.relname = 'vaults' and l.mode like '%Exclusive%'`)).rows[0].n;
  eq(locks, 0, 'no row locks are left behind');
  const xmaxBefore = (await admin(`select xmax::text as x from public.vaults where id = $1`, [quiet])).rows[0].x;
  for (let i = 0; i < 3; i++) {
    await rpc('register_device', [quiet, 'A']);
    await rpc('open_requests', [quiet, 'A']);
    await rpc('garbage_blobs', [quiet, 600]);
  }
  const xmaxAfter = (await admin(`select xmax::text as x from public.vaults where id = $1`, [quiet])).rows[0].x;
  eq(xmaxAfter, xmaxBefore, 'check-ins, request lists and garbage lists never lock (and so never write) the vault row');
  await rpc('ack_received', [quiet, 'A', '[]']);
  const xmaxLocked = (await admin(`select xmax::text as x from public.vaults where id = $1`, [quiet])).rows[0].x;
  eq(xmaxLocked !== xmaxBefore, true, 'control: a call that does lock the row is visible in xmax, so the check above can fail');
});

const pub = (await db.query(`select tablename from pg_publication_tables where pubname = 'supabase_realtime'`)).rows.map((r) => r.tablename);
eq(pub, ['vaults'], 'only vaults is published to realtime');

await db.close();
console.log(`SCHEMA_PGLITE_OK (${count()} checks)`);
