import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { readFileSync } from 'node:fs';
const bundle = async (path, plugins = []) => {
  const output = await build({ entryPoints: [new URL(path, import.meta.url).pathname], bundle: true, write: false,
    format: 'esm', platform: 'node', plugins });
  return import(`data:text/javascript;base64,${Buffer.from(output.outputFiles[0].text).toString('base64')}`);
};
const { InstallerClient, installerOrigin, validateSetupResult } = await bundle('../src/onboarding/client.ts');
const { deliverSetupReturn, watchSetupReturn } = await bundle('../src/onboarding/return-channel.ts');
const id = 'a'.repeat(43), capability = 'b'.repeat(43), approval = 'c'.repeat(43);
const ref = 'abcdefghijklmnopqrst';
const result = { projectRef: ref, projectUrl: `https://${ref}.supabase.co`, publishableKey: 'sb_publishable_' + 'fixture', email: 'fixture@example.com', account: 'created' };

test('installer URL rejects credentials, queries, fragments and non-HTTPS hosts', () => {
  assert.equal(installerOrigin('https://installer.example.org/'), 'https://installer.example.org');
  assert.equal(installerOrigin('http://127.0.0.1:8787'), 'http://127.0.0.1:8787');
  for (const url of ['https://user:password@example.org', 'https://example.org?token=x', 'https://example.org#x', 'http://evil.example', 'file://localhost/test', 'https://example.org/path']) assert.throws(() => installerOrigin(url));
});

test('returned config is whitelisted and cannot substitute an admin key or another origin', () => {
  assert.deepEqual(validateSetupResult({ ...result, accessToken: 'fixture-private' }), result);
  for (const key of ['sb_secret_' + 'fixture', 'sbp_' + 'fixture', 'unrecognized']) assert.throws(() => validateSetupResult({ ...result, publishableKey: key }));
  assert.throws(() => validateSetupResult({ ...result, projectUrl: 'https://evil.example' }));
});

test('session capability is sent in a header, not URL or persisted configuration', async () => {
  const calls = [];
  const client = new InstallerClient('https://installer.example.org', async (url, method, headers, body) => {
    calls.push({ url, method, headers, body });
    if (url.endsWith('/v1/sessions')) return { status: 201, data: { sessionId: id, pollToken: capability, authorizationUrl: 'https://api.supabase.com/v1/oauth/authorize?state=fixture' } };
    if (url.endsWith('/confirm')) return { status: 200, data: { connected: true } };
    if (method === 'DELETE') return { status: 200, data: { disconnected: true } };
    return { status: 200, data: { status: 'complete', progress: ['complete'], result } };
  });
  await client.begin();
  assert.equal(client.ownsSession(id), true);
  assert.equal(client.ownsSession('other'), false);
  await client.confirmBrowser(approval);
  assert.deepEqual((await client.state()).result, result);
  assert.ok(calls.some(c => c.headers.Authorization === `Bearer ${capability}`));
  assert.equal(calls.some(c => c.url.includes(capability) || c.url.includes(approval)), false);
  await client.close();
  assert.equal(client.ownsSession(id), false);
  await assert.rejects(() => client.state(), /session_closed/);
});

test('closing while begin is in flight revokes the late session', async () => {
  let resolve; const calls = [];
  const delayed = new Promise(r => { resolve = r; });
  const client = new InstallerClient('https://installer.example.org', async (url, method) => {
    calls.push({ url, method });
    if (method === 'POST') return delayed;
    return { status: 200, data: {} };
  });
  const begun = client.begin();
  await new Promise(r => setTimeout(r, 0));
  await client.close();
  resolve({ status: 201, data: { sessionId: id, pollToken: capability, authorizationUrl: 'https://api.supabase.com/v1/oauth/authorize' } });
  await assert.rejects(() => begun, /session_closed/);
  assert.equal(calls.at(-1).method, 'DELETE');
});

test('untrusted OAuth redirects and reflected response-body errors are rejected', async () => {
  const client = new InstallerClient('https://installer.example.org', async () => ({ status: 201, data: { sessionId: id, pollToken: capability, authorizationUrl: 'https://evil.example' } }));
  await assert.rejects(() => client.begin(), /invalid_authorization_url/);
  const bad = new InstallerClient('https://installer.example.org', async () => ({ status: 500, data: { error: 'private token: fixture' } }));
  await assert.rejects(() => bad.health(), /installer_request_failed/);
});

test('protocol dispatch is ephemeral, validates shape and ignores unrelated returns', async () => {
  const seen = [];
  const stop = watchSetupReturn(async (session, code) => { seen.push({ session, code }); });
  deliverSetupReturn({ session: 'invalid', approval }); assert.equal(seen.length, 0);
  deliverSetupReturn({ session: id, approval }); await new Promise(r => setTimeout(r, 0));
  assert.deepEqual(seen, [{ session: id, code: approval }]);
  stop(); deliverSetupReturn({ session: id, approval }); assert.equal(seen.length, 1);
});

// A small offline Obsidian adapter exercises the actual modal, not a separate mock wizard.
class Element {
  children = []; controls = [];
  empty() { this.children = []; this.controls = []; }
  createEl(tag, options) { const child = new Element(); child.tag = tag; child.text = options?.text; this.children.push(child); return child; }
  setAttr() {} setText(text) { this.text = text; }
}
class Control {
  inputEl = { type: '', autocomplete: '' }; value = ''; options = {};
  setValue(v) { this.value = v; return this; } onChange(fn) { this.change = fn; return this; }
  setButtonText(v) { this.label = v; return this; } setDisabled(v) { this.disabled = v; return this; }
  setCta() { return this; } onClick(fn) { this.click = fn; return this; }
  addOption(k, v) { this.options[k] = v; return this; } addOptions(o) { Object.assign(this.options, o); return this; }
}
class Setting {
  constructor(el) { this.el = el; }
  setName(name) { this.name = name; return this; } setDesc() { return this; }
  addText(fn) { return this.add('text', fn); } addToggle(fn) { return this.add('toggle', fn); }
  addDropdown(fn) { return this.add('dropdown', fn); } addButton(fn) { return this.add('button', fn); }
  add(kind, fn) { const c = new Control(); c.kind = kind; c.name = this.name; this.el.controls.push(c); fn(c); return this; }
}
class Modal {
  constructor() { this.contentEl = new Element(); this.modalEl = new Element(); this.titleEl = new Element(); }
  close() { this.onClose(); }
}
globalThis.__vaultTestAdapter = { Modal, Setting, Notice: class {}, requestUrl: async () => { throw new Error('No external network allowed'); } };
const { SupabaseSetupModal } = await bundle('../src/ui/setup-modal.ts', [{ name: 'mock-obsidian', setup(b) {
  b.onResolve({ filter: /^obsidian$/ }, () => ({ path: 'obsidian', namespace: 'mock' }));
  b.onLoad({ filter: /.*/, namespace: 'mock' }, () => ({ contents: 'export const {Modal,Setting,Notice,requestUrl}=globalThis.__vaultTestAdapter;' }));
} }]);
const fakeHost = () => ({ settings: { language: 'fa', installerUrl: 'https://installer.example.org' },
  async applySetupResult() {}, async createVault() {}, async listVaults() { return []; }, async chooseVault() {}, async unlockVault() { return true; } });

test('wizard renders Persian and clears all secret inputs on close', () => {
  const modal = new SupabaseSetupModal({}, fakeHost(), () => {});
  modal.onOpen();
  assert.equal(modal.titleEl.text, 'راه‌اندازی Supabase شخصی');
  assert.ok(modal.contentEl.controls.some(c => c.label === 'اتصال به Supabase'));
  modal.password = 'fixture-secret'; modal.passphrase = 'fixture-encryption'; modal.databasePassword = 'fixture-db'; modal.browserCode = approval;
  modal.onClose();
  for (const key of ['password', 'passphrase', 'databasePassword', 'browserCode']) assert.equal(modal[key], '');
});

test('existing vault is selectable locally without sending its encryption passphrase to installer', async () => {
  const host = fakeHost(); const local = [];
  host.chooseVault = async v => { local.push(v.id); };
  host.unlockVault = async pass => { local.push(pass); return true; };
  const modal = new SupabaseSetupModal({}, host, () => {});
  modal.onOpen(); modal.phase = 'vault'; modal.vaultAction = 'choose'; modal.remoteSelected = 'vault-one';
  modal.remoteVaults = [{ id: 'vault-one', name: 'Existing', encryption: { v: 1 }, headSeq: 0, headDevice: null }];
  modal.passphrase = 'fixture-encryption'; modal.render();
  modal.contentEl.controls.find(c => c.label === 'تکمیل راه‌اندازی').click();
  for (let i = 0; i < 20 && modal.phase !== 'done'; i++) await new Promise(r => setTimeout(r, 0));
  assert.equal(modal.phase, 'done'); assert.deepEqual(local, ['vault-one', 'fixture-encryption']);
  assert.equal(modal.passphrase, ''); modal.onClose();
});
