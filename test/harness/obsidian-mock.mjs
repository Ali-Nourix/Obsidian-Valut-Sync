/**
 * An in-memory Obsidian, enough to load the plugin under Node and to drive
 * ObsidianVaultHost through the same Vault calls the real app answers:
 * files and folders with stats, binary reads and writes, renames, the
 * trash, the config-folder adapter, events and per-vault local storage.
 */

/** Accepts any property access or call, for DOM the tests never inspect. */
const inert = new Proxy(function () {}, {
  get: (_t, prop) => (prop === Symbol.toPrimitive ? () => '' : prop === 'then' ? undefined : inert),
  apply: () => inert,
  construct: () => inert,
});

globalThis.window ??= globalThis;
globalThis.document ??= { visibilityState: 'visible', body: inert, createElement: () => inert, addEventListener() {}, removeEventListener() {} };
globalThis.createSpan ??= () => inert;
globalThis.createDiv ??= () => inert;

export const notices = [];
export class Notice {
  constructor(message) {
    notices.push(String(message));
  }
}

export const Platform = { isMobile: false, isDesktop: true, isPhone: false };
export const setIcon = () => {};
export const normalizePath = (p) => p.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/^\/|\/$/g, '').normalize('NFC');

export class TAbstractFile {
  constructor(path, vault) {
    this.path = path;
    this.name = path.split('/').pop();
    this.vault = vault;
  }
  get parent() {
    const slash = this.path.lastIndexOf('/');
    return slash < 0 ? this.vault.root : this.vault.folders.get(this.path.slice(0, slash)) ?? null;
  }
}

export class TFile extends TAbstractFile {
  constructor(path, vault) {
    super(path, vault);
    this.stat = { ctime: 0, mtime: 0, size: 0 };
  }
  get extension() {
    return this.name.includes('.') ? this.name.split('.').pop() : '';
  }
  get basename() {
    return this.name.replace(/\.[^.]*$/, '');
  }
}

export class TFolder extends TAbstractFile {
  get children() {
    const prefix = this.path === '/' ? '' : this.path + '/';
    const direct = (p) => p.startsWith(prefix) && !p.slice(prefix.length).includes('/');
    return [...this.vault.files.values()].map((e) => e.file).concat([...this.vault.folders.values()]).filter((f) => direct(f.path));
  }
}

export class MarkdownView {}

class Events {
  handlers = new Map();
  on(name, callback) {
    if (!this.handlers.has(name)) this.handlers.set(name, []);
    this.handlers.get(name).push(callback);
    return { name, callback };
  }
  trigger(name, ...args) {
    for (const callback of this.handlers.get(name) ?? []) callback(...args);
  }
}

class Adapter {
  constructor(caseInsensitive) {
    this.data = new Map();
    this.dirs = new Set();
    this.caseInsensitive = caseInsensitive;
  }
  key(p) {
    return this.caseInsensitive ? p.toLowerCase() : p;
  }
  async exists(p) {
    return this.data.has(this.key(p)) || this.dirs.has(this.key(p));
  }
  async read(p) {
    if (!this.data.has(this.key(p))) throw new Error(`ENOENT ${p}`);
    return this.data.get(this.key(p));
  }
  async write(p, text) {
    this.data.set(this.key(p), text);
  }
  async remove(p) {
    this.data.delete(this.key(p));
  }
  async rename(from, to) {
    this.data.set(this.key(to), this.data.get(this.key(from)));
    this.data.delete(this.key(from));
  }
  async mkdir(p) {
    this.dirs.add(this.key(p));
  }
  async writeBinary(p, data) {
    this.data.set(this.key(p), new Uint8Array(data).slice());
  }
  async readBinary(p) {
    if (!this.data.has(this.key(p))) throw new Error(`ENOENT ${p}`);
    return this.data.get(this.key(p)).slice().buffer;
  }
  async list(p) {
    const prefix = this.key(p) + '/';
    const direct = (k) => k.startsWith(prefix) && !k.slice(prefix.length).includes('/');
    return { files: [...this.data.keys()].filter(direct), folders: [...this.dirs].filter(direct) };
  }
}

export class Vault extends Events {
  constructor({ caseInsensitive = false } = {}) {
    super();
    this.files = new Map();
    this.folders = new Map();
    this.root = new TFolder('/', this);
    this.configDir = '.obsidian';
    this.adapter = new Adapter(caseInsensitive);
    this.clock = 1_000;
  }
  tick() {
    return (this.clock += 7);
  }
  getFiles() {
    return [...this.files.values()].map((e) => e.file);
  }
  getAllLoadedFiles() {
    return [this.root, ...this.folders.values(), ...this.getFiles()];
  }
  getAbstractFileByPath(path) {
    return this.files.get(path)?.file ?? this.folders.get(path) ?? null;
  }
  getFileByPath(path) {
    return this.files.get(path)?.file ?? null;
  }
  getFolderByPath(path) {
    return this.folders.get(path) ?? null;
  }
  async readBinary(file) {
    return this.files.get(file.path).bytes.slice().buffer;
  }
  put(path, bytes, mtime) {
    for (let i = path.indexOf('/'); i > 0; i = path.indexOf('/', i + 1)) {
      const folder = path.slice(0, i);
      if (!this.folders.has(folder)) this.folders.set(folder, new TFolder(folder, this));
    }
    const entry = this.files.get(path) ?? { file: new TFile(path, this) };
    entry.bytes = new Uint8Array(bytes);
    entry.file.stat = { ctime: entry.file.stat.ctime || 1, mtime: mtime ?? this.tick(), size: entry.bytes.length };
    const created = !this.files.has(path);
    this.files.set(path, entry);
    this.trigger(created ? 'create' : 'modify', entry.file);
    return entry.file;
  }
  async createBinary(path, data, options) {
    if (this.getAbstractFileByPath(path)) throw new Error('File already exists.');
    const parent = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
    if (parent && !this.folders.has(parent)) throw new Error('Parent folder does not exist.');
    return this.put(path, data, options?.mtime);
  }
  async modifyBinary(file, data, options) {
    this.put(file.path, data, options?.mtime);
  }
  async createFolder(path) {
    if (this.folders.has(path)) throw new Error('Folder already exists.');
    this.folders.set(path, new TFolder(path, this));
  }
  async rename(file, newPath) {
    const entry = this.files.get(file.path);
    const old = file.path;
    this.files.delete(old);
    file.path = newPath;
    file.name = newPath.split('/').pop();
    this.files.set(newPath, entry);
    this.trigger('rename', file, old);
  }
  async delete(target) {
    if (target instanceof TFolder) {
      if (target.children.length) throw new Error('Folder not empty');
      this.folders.delete(target.path);
    } else {
      this.files.delete(target.path);
    }
    this.trigger('delete', target);
  }
}

export class App {
  constructor(vault) {
    this.vault = vault;
    this.trashed = [];
    this.local = new Map();
    this.workspace = {
      onLayoutReady: (cb) => cb(),
      getLeavesOfType: () => [],
      getLeaf: () => ({ openFile: async () => {} }),
    };
    this.fileManager = {
      trashFile: async (file) => {
        this.trashed.push(file.path);
        await vault.delete(file);
      },
    };
  }
  loadLocalStorage(key) {
    return this.local.has(key) ? this.local.get(key) : null;
  }
  saveLocalStorage(key, value) {
    if (value === null) this.local.delete(key);
    else this.local.set(key, value);
  }
}

export class Plugin {
  constructor(app, manifest) {
    this.app = app;
    this.manifest = manifest;
    this.commands = [];
    this.saved = null;
    this.tabs = [];
  }
  async loadData() {
    return this.saved ? JSON.parse(JSON.stringify(this.saved)) : null;
  }
  async saveData(data) {
    this.saved = JSON.parse(JSON.stringify(data));
  }
  addStatusBarItem() {
    return inert;
  }
  addRibbonIcon() {
    return inert;
  }
  addCommand(command) {
    this.commands.push(command);
    return command;
  }
  addSettingTab(tab) {
    this.tabs.push(tab);
  }
  registerInterval(id) {
    clearInterval(id);
    return id;
  }
  registerEvent() {}
  registerDomEvent() {}
}

export class PluginSettingTab {
  constructor(app, plugin) {
    this.app = app;
    this.plugin = plugin;
    this.containerEl = inert;
  }
}
export class Modal {
  constructor(app) {
    this.app = app;
    this.modalEl = inert;
    this.titleEl = inert;
    this.contentEl = inert;
  }
  open() {
    this.onOpen?.();
  }
  close() {
    this.onClose?.();
  }
}
export class FuzzySuggestModal extends Modal {
  setPlaceholder() {}
}
export class Setting {
  constructor() {
    return inert;
  }
}
