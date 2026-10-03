/**
 * The plugin under an in-memory Obsidian: it loads, registers its commands,
 * stays offline until configured, refuses a secret key, and its vault host
 * and state store carry a real sync between an "Obsidian" device and a
 * simulated phone, surviving a restart without re-uploading anything.
 */
import { readFileSync } from 'node:fs';
import { checker, loadTs } from './harness/load.mjs';

const { eq, ok, count } = checker();
const mockSource = readFileSync(new URL('./harness/obsidian-mock.mjs', import.meta.url), 'utf8');
const mod = await loadTs(
  `
  export { default as VaultSyncPlugin } from "./main";
  export { ObsidianVaultHost, probeCaseInsensitive } from "./src/obsidian/vault-host";
  export { AdapterStateStore } from "./src/obsidian/state-store";
  export { AdapterBaseStore } from "./src/obsidian/base-store";
  export { DeviceStore } from "./src/obsidian/device-store";
  export { SyncEngine } from "./src/core/engine";
  export { MemoryBackend } from "./src/backend/memory-backend";
  export { PlainCodec } from "./src/core/blob-codec";
  export { MemoryVaultHost, Clock } from "./test/harness/memory-vault-host";
  export { utf8, decodeUtf8 } from "./src/core/bytes";
  export * as obsidian from "obsidian";
`,
  { obsidian: mockSource }
);
const { AdapterBaseStore } = mod;
const { VaultSyncPlugin, ObsidianVaultHost, probeCaseInsensitive, AdapterStateStore, DeviceStore, SyncEngine, MemoryBackend, PlainCodec, MemoryVaultHost, Clock, utf8, decodeUtf8, obsidian } = mod;
const { App, Vault, notices } = obsidian;

let fetches = 0;
globalThis.fetch = async () => {
  fetches++;
  throw new Error('no network in this test');
};
const manifest = { id: 'vault-sync', dir: '.obsidian/plugins/vault-sync', version: '0.1.0' };

// ── loading ────────────────────────────────────────────────────────────────
{
  const app = new App(new Vault());
  const plugin = new VaultSyncPlugin(app, manifest);
  await plugin.onload();
  eq(plugin.phase, 'unconfigured', 'a fresh install waits for setup');
  eq(fetches, 0, 'and makes no network request');
  eq(
    plugin.commands.map((c) => c.id),
    ['sync-now', 'toggle-auto-sync', 'open-sync-log', 'unlock-vault', 'show-conflicts', 'reset-sync-state', 'sign-out'],
    'commands registered'
  );
  eq(plugin.settings.maxFileSizeMB, 50, 'defaults applied');
  eq(plugin.tabs.length, 1, 'settings tab added');
  plugin.tabs[0].display();
  ok(true, 'the settings tab renders');
  plugin.syncNow();
  ok(notices.some((n) => /not ready/i.test(n)), '"sync now" explains that setup is unfinished');

  plugin.settings.supabaseUrl = 'abcdefghijklmnopqrst';
  plugin.settings.supabaseKey = 'sb_secret_abc123';
  await plugin.reconnect();
  eq(plugin.phase, 'unconfigured', 'a secret key is refused');
  ok(notices.some((n) => /secret/i.test(n)), 'with an explanation');
  eq(fetches, 0, 'still without touching the network');

  plugin.settings.language = 'fa';
  plugin.renderStatus();
  plugin.tabs[0].display();
  ok(true, 'Persian settings render');
  await plugin.onunload();
}

// ── device store ───────────────────────────────────────────────────────────
{
  const app = new App(new Vault());
  const store = new DeviceStore(app);
  const id = store.deviceId();
  eq(store.deviceId(), id, 'device id is stable');
  const nonce = store.nonce('v1');
  store.renewNonce('v1');
  eq(store.nonce('v1') === nonce, false, 'renewing the nonce invalidates old state');
  store.rememberKey('v1', new Uint8Array([1, 2, 3]));
  eq(Array.from(store.rememberedKey('v1')), [1, 2, 3], 'remembered key round trip');
  store.rememberKey('v1', null);
  eq(store.rememberedKey('v1'), null, 'forgotten key');
  const auth = store.authStorage();
  auth.setItem('s', 'token');
  eq(auth.getItem('s'), 'token', 'session storage');
  eq([...app.local.keys()].every((k) => k.startsWith('vault-sync:')), true, 'everything is namespaced');
}

// ── merge bases on disk ────────────────────────────────────────────────────
{
  const vault = new Vault();
  const bases = new AdapterBaseStore(vault.adapter, manifest.dir, 'v1');
  const a = 'ab'.repeat(32);
  const b = 'cd'.repeat(32);
  await bases.put(a, utf8('base a'));
  await bases.put(b, utf8('base b'));
  eq(decodeUtf8(await bases.get(a)), 'base a', 'a merge base is kept in the plugin folder');
  eq(await bases.get('ef'.repeat(32)), null, 'an unknown base is null');
  await bases.prune(new Set([b]));
  eq([await bases.get(a), decodeUtf8(await bases.get(b))], [null, 'base b'], 'pruning keeps only bases still in use');
}

// ── vault host ─────────────────────────────────────────────────────────────
{
  const vault = new Vault();
  const app = new App(vault);
  const host = new ObsidianVaultHost(app, false);
  const created = await host.write('a/b/c.md', utf8('hi'), null, 5000);
  eq(created.size, 2, 'creates a file');
  ok(vault.folders.has('a') && vault.folders.has('a/b'), 'with its parent folders');
  eq(await host.write('a/b/c.md', utf8('again'), null), 'raced', 'will not create over an existing file');
  eq(await host.write('a/b/c.md', utf8('x'), { mtime: 1, size: 2 }), 'raced', 'will not overwrite a file that changed');
  const updated = await host.write('a/b/c.md', utf8('new'), created);
  eq(decodeUtf8(await host.read('a/b/c.md')), 'new', 'overwrites a file that did not change');
  const moved = await host.rename('a/b/c.md', 'z/c.md', updated);
  ok(moved !== 'raced' && host.exists('z/c.md') && !host.exists('a/b/c.md'), 'renames, creating folders');
  await host.removeEmptyFolders(['a/b']);
  eq([host.exists('a/b'), host.exists('a')], [false, false], 'removes folders left empty');
  eq(await host.trash('z/c.md', { mtime: 0, size: 0 }), 'raced', 'will not trash a file that changed');
  eq(await host.trash('z/c.md', moved), 'ok', 'trashes through the file manager');
  eq(app.trashed, ['z/c.md'], 'respecting the user\'s trash setting');

  const ci = new ObsidianVaultHost(app, true);
  await ci.write('Notes/Idea.md', utf8('x'), null);
  ok(ci.exists('notes/idea.md'), 'a case-insensitive host finds names in any case');
  eq(await probeCaseInsensitive(new App(new Vault({ caseInsensitive: true })), manifest.dir), true, 'case probe: insensitive');
  eq(await probeCaseInsensitive(new App(new Vault()), manifest.dir), false, 'case probe: sensitive');
}

// ── a real sync through the Obsidian adapters ──────────────────────────────
{
  const vault = new Vault();
  const app = new App(vault);
  const backend = new MemoryBackend();
  const { id: vaultId } = await backend.createVault('Main', null);
  const clock = new Clock();
  const phone = new MemoryVaultHost(clock, true);
  const phoneEngine = new SyncEngine({ backend, host: phone, codec: new PlainCodec(), store: { load: async () => null, save: async () => {}, clear: async () => {} }, vaultId, userId: 'u', deviceId: 'phone', nonce: 'n' });

  const makeDesktop = () =>
    new SyncEngine({
      backend,
      host: new ObsidianVaultHost(app, false),
      codec: new PlainCodec(),
      store: new AdapterStateStore(vault.adapter, manifest.dir, vaultId),
      vaultId,
      userId: 'u',
      deviceId: 'desktop',
      nonce: 'desktop-nonce',
    });
  let desktop = makeDesktop();
  const events = [];
  vault.on('modify', (f) => events.push(['modify', f.path, desktop.isOwnWrite(f.path)]));

  vault.put('Notes/one.md', utf8('one\n'));
  vault.put('img.png', new Uint8Array([137, 80, 78, 71]));
  phone.put('Phone/two.md', utf8('two\n'));
  for (let i = 0; i < 3; i++) {
    await desktop.sync();
    await phoneEngine.sync();
  }
  eq(decodeUtf8(phone.get('Notes/one.md')), 'one\n', 'desktop note reached the phone');
  eq(decodeUtf8(new Uint8Array(await vault.readBinary(vault.getFileByPath('Phone/two.md')))), 'two\n', 'phone note reached the desktop vault');

  phone.put('Phone/two.md', utf8('two\nedited on phone\n'));
  await phoneEngine.sync();
  await desktop.sync();
  ok(events.some(([kind, path, own]) => kind === 'modify' && path === 'Phone/two.md' && own), 'the engine recognises its own write events');
  ok(await vault.adapter.exists(`${manifest.dir}/state/${vaultId}.json`), 'state saved in the plugin folder');

  const commits = backend.calls.commit;
  desktop = makeDesktop(); // Obsidian restarted
  const after = await desktop.sync();
  eq([after.uploaded, after.downloaded], [0, 0], 'after a restart nothing moves');
  eq(backend.calls.commit, commits, 'and nothing is committed again');

  vault.put('Notes/one.md', utf8('one\nedited on desktop\n'));
  await desktop.sync();
  await phoneEngine.sync();
  eq(decodeUtf8(phone.get('Notes/one.md')), 'one\nedited on desktop\n', 'edits keep flowing after the restart');
}

console.log(`PLUGIN_LOAD_OK (${count()} checks)`);
