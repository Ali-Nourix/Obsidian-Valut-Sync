import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
const bundle = async (path, plugins = []) => {
  const output = await build({ entryPoints: [new URL(path, import.meta.url).pathname], bundle: true, write: false,
    format: 'esm', platform: 'node', plugins });
  return import(`data:text/javascript;base64,${Buffer.from(output.outputFiles[0].text).toString('base64')}`);
};
const { validateSetupResult } = await bundle('../src/onboarding/client.ts');
const ref = 'abcdefghijklmnopqrst';
const result = { projectRef: ref, projectUrl: `https://${ref}.supabase.co`, publishableKey: 'sb_publishable_' + 'fixture', email: 'fixture@example.com', account: 'created' };

test('returned config is whitelisted and cannot substitute an admin key or another origin', () => {
  assert.deepEqual(validateSetupResult({ ...result, accessToken: 'fixture-private' }), result);
  for (const key of ['sb_secret_' + 'fixture', 'sbp_' + 'fixture', 'unrecognized']) assert.throws(() => validateSetupResult({ ...result, publishableKey: key }));
  assert.throws(() => validateSetupResult({ ...result, projectUrl: 'https://evil.example' }));
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
const fakeHost = () => ({ settings: { language: 'fa' },
  async applySetupResult() {}, async createVault() {}, async listVaults() { return []; }, async chooseVault() {}, async unlockVault() { return true; } });

test('wizard renders Persian and clears all secret inputs on close', () => {
  const modal = new SupabaseSetupModal({}, fakeHost(), () => {});
  modal.onOpen();
  assert.equal(modal.titleEl.text, 'راه‌اندازی Supabase شخصی');
  assert.ok(modal.contentEl.controls.some(c => c.label === 'اتصال به Supabase'));
  modal.password = 'fixture-secret'; modal.passphrase = 'fixture-encryption'; modal.pat = 'sbp_fc_fixture_scoped_token';
  modal.onClose();
  for (const key of ['password', 'passphrase', 'pat']) assert.equal(modal[key], '');
});

test('existing vault is selectable locally without sending its encryption passphrase to Supabase', async () => {
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

test('direct setup sends no request before local approval and never uses a hosted installer', async () => {
  const modal = new SupabaseSetupModal({}, fakeHost(), () => {});
  modal.onOpen(); modal.setupRef = ref; modal.pat = 'sbp_fc_fixture_scoped_token';
  modal.contentEl.controls.find(c => c.label === 'اتصال به Supabase').click();
  for (let i = 0; i < 20 && modal.busy; i++) await new Promise(r => setTimeout(r, 0));
  assert.equal(modal.phase, 'start');
  assert.equal(modal.client, null);
  modal.onClose();
});

test('new setup defaults to automatic user creation and applies only public config after completion', async () => {
  globalThis.window ??= globalThis;
  const host = fakeHost(); const applied = []; const installed = [];
  host.applySetupResult = async (config, password) => { applied.push({ config, password }); };
  const modal = new SupabaseSetupModal({}, host, () => {});
  modal.onOpen(); modal.phase = 'confirm'; modal.selected = ref; modal.confirmRef = ref; modal.dedicated = true;
  modal.projects = [{ ref, name: 'Fixture', status: 'ACTIVE_HEALTHY' }];
  modal.email = result.email; modal.password = 'fixture-password-123'; modal.passwordAgain = modal.password;
  modal.client = { async install(input) { installed.push({ ...input }); }, async state() { return { status: 'complete', progress: [], result }; }, async close() {} };
  modal.render();
  const account = modal.contentEl.controls.find(c => c.name === 'حساب sync');
  assert.equal(account.value, 'create'); assert.equal(account.options.create, 'ساخت خودکار حساب sync');
  modal.contentEl.controls.find(c => c.label === 'راه‌اندازی Vault Sync').click();
  for (let i = 0; i < 20 && modal.phase !== 'installing'; i++) await new Promise(r => setTimeout(r, 0));
  assert.equal(installed.length, 1); assert.equal(installed[0].accountMode, 'create');
  await modal.pollState();
  assert.equal(modal.phase, 'vault'); assert.deepEqual(applied, [{ config: result, password: 'fixture-password-123' }]);
  assert.equal(modal.password, ''); assert.equal(modal.pat, ''); modal.onClose();
});
