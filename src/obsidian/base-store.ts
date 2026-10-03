// ── obsidian/base-store.ts ────────────────────────────────────────────────
// Merge bases on disk, in the plugin's folder inside the config folder (which
// never syncs): <plugin>/base/<vault id>/<id[0:2]>/<id>. Only mergeable text
// files are kept, one copy per distinct content.
// ─────────────────────────────────────────────────────────────────────────────

import { DataAdapter } from 'obsidian';
import { toArrayBuffer } from '../core/bytes';
import { BaseStore } from '../core/base-store';

export class AdapterBaseStore implements BaseStore {
  private readonly root: string;

  constructor(
    private readonly adapter: DataAdapter,
    pluginDir: string,
    vaultId: string
  ) {
    this.root = `${pluginDir}/base/${vaultId}`;
  }

  private path(id: string): string {
    return `${this.root}/${id.slice(0, 2)}/${id}`;
  }

  async get(id: string): Promise<Uint8Array | null> {
    try {
      if (!(await this.adapter.exists(this.path(id)))) return null;
      return new Uint8Array(await this.adapter.readBinary(this.path(id)));
    } catch {
      return null;
    }
  }

  async put(id: string, bytes: Uint8Array): Promise<void> {
    const folder = `${this.root}/${id.slice(0, 2)}`;
    for (const dir of [`${this.root.slice(0, this.root.lastIndexOf('/'))}`, this.root, folder]) {
      if (!(await this.adapter.exists(dir))) await this.adapter.mkdir(dir);
    }
    await this.adapter.writeBinary(this.path(id), toArrayBuffer(bytes));
  }

  async prune(keep: Set<string>): Promise<void> {
    if (!(await this.adapter.exists(this.root))) return;
    for (const folder of (await this.adapter.list(this.root)).folders) {
      for (const file of (await this.adapter.list(folder)).files) {
        const id = file.slice(file.lastIndexOf('/') + 1);
        if (!keep.has(id)) await this.adapter.remove(file);
      }
    }
  }
}
