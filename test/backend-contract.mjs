/**
 * The contract every RemoteBackend must keep, checked against the in-memory
 * backend on every run and against a real Supabase project when these
 * variables are set (use a throwaway project or user):
 *
 *   VAULT_SYNC_SUPABASE_URL, VAULT_SYNC_SUPABASE_KEY (publishable / anon),
 *   VAULT_SYNC_SUPABASE_EMAIL, VAULT_SYNC_SUPABASE_PASSWORD
 *
 * The live run also syncs two simulated devices through the project and
 * removes the test vault and its blobs afterwards.
 */
import { checker, loadTs } from './harness/load.mjs';
import { lib, device, settle, assertConverged } from './harness/world.mjs';

const { eq, ok, count } = checker();
const { MemoryBackend, BackendError, PlainCodec, Clock } = lib;
const live = await loadTs(`
  export { SupabaseBackend, BUCKET, toBackendError } from "./src/backend/supabase-backend";
  export { SupabaseConnection, normalizeProjectUrl, keyProblem } from "./src/backend/supabase-client";
`);

const H = (c) => c.repeat(64);
const change = (path, hash, expectedVersion, deleted = false) => ({ path, hash: H(hash), size: 1, mtime: 1, deleted, expectedVersion });

async function contract(backend, label) {
  const name = `contract-${Date.now()}`;
  const vault = await backend.createVault(name, null);
  eq([vault.name, vault.headSeq, vault.encryption], [name, 0, null], `${label}: create`);
  ok((await backend.listVaults()).some((v) => v.id === vault.id), `${label}: listed`);

  const heads = [];
  const unsubscribe = backend.subscribe(vault.id, (head, dev) => heads.push([head, dev]));
  await new Promise((r) => setTimeout(r, label === 'memory' ? 0 : 3000)); // let the channel join

  const first = await backend.commit(vault.id, 'dev-A', [change('a.md', 'a', 0), change('b.md', 'b', 0)]);
  eq(first.map((r) => [r.ok, r.row.version, r.row.seq, r.row.device]), [[true, 1, 1, 'dev-A'], [true, 1, 2, 'dev-A']], `${label}: commit two`);
  const refused = await backend.commit(vault.id, 'dev-B', [change('a.md', 'e', 0)]);
  eq([refused[0].ok, refused[0].row.hash], [false, H('a')], `${label}: CAS refuses a stale create`);
  const updated = await backend.commit(vault.id, 'dev-B', [change('a.md', 'e', 1), change('b.md', 'b', 1, true)]);
  eq(updated.map((r) => [r.ok, r.row.version, r.row.deleted]), [[true, 2, false], [true, 2, true]], `${label}: update and tombstone`);

  eq((await backend.getVault(vault.id)).headSeq, 4, `${label}: head moved`);
  eq((await backend.pull(vault.id, 0, 1000)).map((r) => [r.path, r.seq]), [['a.md', 3], ['b.md', 4]], `${label}: pull in seq order`);
  eq((await backend.pull(vault.id, 3, 1000)).map((r) => r.path), ['b.md'], `${label}: pull after a cursor`);
  eq((await backend.pull(vault.id, 0, 1)).length, 1, `${label}: pull honours the limit`);

  const id = H('c');
  await backend.putBlob(vault.id, id, new Uint8Array([1, 2, 3]));
  await backend.putBlob(vault.id, id, new Uint8Array([1, 2, 3]));
  ok(true, `${label}: storing a blob twice is fine`);
  eq(Array.from(await backend.getBlob(vault.id, id)), [1, 2, 3], `${label}: blob round trip`);
  try {
    await backend.getBlob(vault.id, H('d'));
    throw new Error('missing blob did not throw');
  } catch (error) {
    eq(error instanceof BackendError ? error.kind : String(error), 'blob-missing', `${label}: a missing blob is reported as such`);
  }

  for (let i = 0; i < 20 && !heads.some(([h]) => h === 4); i++) await new Promise((r) => setTimeout(r, 250));
  ok(heads.some(([h, dev]) => h === 4 && dev === 'dev-B'), `${label}: subscribers hear the new head`);
  unsubscribe();
  return vault;
}

await contract(new MemoryBackend(), 'memory');

const env = process.env;
if (!env.VAULT_SYNC_SUPABASE_URL || !env.VAULT_SYNC_SUPABASE_KEY || !env.VAULT_SYNC_SUPABASE_EMAIL || !env.VAULT_SYNC_SUPABASE_PASSWORD) {
  console.log('LIVE_SUPABASE_SKIPPED (set VAULT_SYNC_SUPABASE_* to run against a real project)');
} else {
  const url = live.normalizeProjectUrl(env.VAULT_SYNC_SUPABASE_URL);
  eq(live.keyProblem(env.VAULT_SYNC_SUPABASE_KEY), null, 'live: the key is a publishable key');
  const memoryStorage = () => {
    const m = new Map();
    return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v), removeItem: (k) => void m.delete(k) };
  };
  const connect = async () => {
    const connection = new live.SupabaseConnection(url, env.VAULT_SYNC_SUPABASE_KEY, memoryStorage());
    const session = await connection.signIn(env.VAULT_SYNC_SUPABASE_EMAIL, env.VAULT_SYNC_SUPABASE_PASSWORD);
    return { connection, backend: new live.SupabaseBackend(connection.client, session.user.id), userId: session.user.id };
  };
  const one = await connect();
  await one.backend.checkSchema();
  ok(true, 'live: schema installed');

  const uploaded = [];
  const tracked = (backend) =>
    new Proxy(backend, {
      get(target, prop) {
        if (prop === 'putBlob') return (vaultId, id, bytes) => (uploaded.push(id), target.putBlob(vaultId, id, bytes));
        const value = target[prop];
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });

  const vaults = [];
  try {
    vaults.push(await contract(tracked(one.backend), 'live'));

    const two = await connect();
    const world = { clock: new Clock(), backend: tracked(one.backend), codec: new PlainCodec(), vaultId: null };
    const vault = await one.backend.createVault(`sim-${Date.now()}`, null);
    vaults.push(vault);
    world.vaultId = vault.id;
    world.clock.tick(Date.now());
    const A = device(world, 'A', { userId: one.userId });
    const worldB = { ...world, backend: tracked(two.backend) };
    const B = device(worldB, 'B', { ci: true, userId: two.userId });
    A.write('Daily/روزانه.md', '# امروز\n');
    A.write('img.bin', 'binary');
    await settle([A, B]);
    eq(B.read('Daily/روزانه.md'), '# امروز\n', 'live: B received A\'s note');
    A.write('Daily/روزانه.md', '# امروز\n- A\n');
    B.write('Daily/روزانه.md', '# امروز\n- B\n');
    await settle([A, B]);
    eq(A.read('Daily/روزانه.md'), '# امروز\n- A\n- B\n', 'live: concurrent appends merged');
    const rows = (await one.backend.pull(vault.id, 0, 1000)).filter((r) => !r.deleted).map((r) => r.path).sort();
    eq(rows, ['Daily/روزانه.md', 'img.bin'], 'live: the server holds the synced files');
    await two.connection.close();
  } finally {
    for (const v of vaults) await one.connection.client.from('vaults').delete().eq('id', v.id);
    const keys = [...new Set(uploaded)].flatMap((id) => vaults.map((v) => `${one.userId}/${v.id}/${id.slice(0, 2)}/${id}`));
    if (keys.length) await one.connection.client.storage.from(live.BUCKET).remove(keys);
    await one.connection.close();
  }
  console.log('LIVE_SUPABASE_OK');
}

console.log(`BACKEND_CONTRACT_OK (${count()} checks)`);
