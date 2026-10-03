// ── obsidian/state-store.ts ───────────────────────────────────────────────
// Sync state and the log, as JSON files in the plugin's own folder (inside
// the config folder, which the sync never touches). A save writes a temporary
// file and then swaps it in, so a crash mid-save leaves the previous state.
// ─────────────────────────────────────────────────────────────────────────────

import { DataAdapter } from 'obsidian';
import { PersistedState, StateStore } from '../core/state';

async function readJson<T>(adapter: DataAdapter, path: string): Promise<T | null> {
  try {
    if (!(await adapter.exists(path))) return null;
    return JSON.parse(await adapter.read(path)) as T;
  } catch {
    return null;
  }
}

async function writeJson(adapter: DataAdapter, path: string, value: unknown): Promise<void> {
  const folder = path.slice(0, path.lastIndexOf('/'));
  if (!(await adapter.exists(folder))) await adapter.mkdir(folder);
  const temp = `${path}.tmp`;
  await adapter.write(temp, JSON.stringify(value));
  if (await adapter.exists(path)) await adapter.remove(path);
  await adapter.rename(temp, path);
}

export class AdapterStateStore implements StateStore {
  private readonly path: string;

  constructor(
    private readonly adapter: DataAdapter,
    pluginDir: string,
    vaultId: string
  ) {
    this.path = `${pluginDir}/state/${vaultId}.json`;
  }

  async load(): Promise<PersistedState | null> {
    return (await readJson<PersistedState>(this.adapter, this.path)) ?? (await readJson<PersistedState>(this.adapter, `${this.path}.tmp`));
  }

  save(state: PersistedState): Promise<void> {
    return writeJson(this.adapter, this.path, state);
  }

  async clear(): Promise<void> {
    for (const path of [this.path, `${this.path}.tmp`]) {
      if (await this.adapter.exists(path)) await this.adapter.remove(path);
    }
  }
}

export class JsonFile<T> {
  constructor(
    private readonly adapter: DataAdapter,
    private readonly path: string
  ) {}

  load(): Promise<T | null> {
    return readJson<T>(this.adapter, this.path);
  }

  save(value: T): Promise<void> {
    return writeJson(this.adapter, this.path, value);
  }
}
