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
    name text not null
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
  eq(Object.keys(first[0].row).sort(), ['deleted', 'device_id', 'hash', 'mtime', 'path', 'seq', 'size', 'version'], 'row shape returned to the plugin');

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
  eq((await db.query(`select public.vault_sync_schema_version() as v`)).rows[0].v, 1, 'schema version is readable');
});

// ── concurrent commits: seq never goes backwards ────────────────────────────
await as(U1, async () => {
  const before = Number((await db.query(`select head_seq from public.vaults where id = $1`, [vault.id])).rows[0].head_seq);
  const results = await Promise.all(Array.from({ length: 10 }, (_, i) => commit(vault.id, [change(`c${i}.md`, 'f', 0)], `D${i}`)));
  const seqs = results.map((r) => r[0].row.seq).sort((a, b) => a - b);
  eq(seqs, Array.from({ length: 10 }, (_, i) => before + 1 + i), 'concurrent commits get consecutive seqs');
});

const pub = (await db.query(`select tablename from pg_publication_tables where pubname = 'supabase_realtime'`)).rows.map((r) => r.tablename);
eq(pub, ['vaults'], 'only vaults is published to realtime');

await db.close();
console.log(`SCHEMA_PGLITE_OK (${count()} checks)`);
