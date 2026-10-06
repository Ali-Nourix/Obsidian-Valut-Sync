// ── obsidian/device-store.ts ──────────────────────────────────────────────
// Values that belong to this device and this vault only, kept in Obsidian's
// per-vault local storage rather than in data.json, which travels with any
// copy of the vault folder: the device id, the Supabase session, the nonce
// that marks the sync state as this device's, and remembered vault keys.
// ─────────────────────────────────────────────────────────────────────────────

import { App } from 'obsidian';
import { SupportedStorage } from '@supabase/supabase-js';
import { fromBase64, toBase64, toHex } from '../core/bytes';

const PREFIX = 'vault-sync:';

function randomId(): string {
  return toHex(globalThis.crypto.getRandomValues(new Uint8Array(12)));
}

export class DeviceStore {
  constructor(private readonly app: App) {}

  private get(key: string): string | null {
    const value = this.app.loadLocalStorage(PREFIX + key);
    return typeof value === 'string' ? value : null;
  }

  private set(key: string, value: string | null): void {
    this.app.saveLocalStorage(PREFIX + key, value);
  }

  private getOrCreate(key: string): string {
    let value = this.get(key);
    if (!value) {
      value = randomId();
      this.set(key, value);
    }
    return value;
  }

  /** Identifies this device in commits, so it can ignore its own Realtime echoes. */
  deviceId(): string {
    return this.getOrCreate('device-id');
  }

  /** Changes whenever the device forgets a vault's state, invalidating any older state file. */
  nonce(vaultId: string): string {
    return this.getOrCreate(`nonce:${vaultId}`);
  }

  renewNonce(vaultId: string): void {
    this.set(`nonce:${vaultId}`, randomId());
  }

  rememberedKey(vaultId: string): Uint8Array | null {
    const value = this.get(`key:${vaultId}`);
    return value ? fromBase64(value) : null;
  }

  rememberKey(vaultId: string, master: Uint8Array | null): void {
    this.set(`key:${vaultId}`, master ? toBase64(master) : null);
  }

  /** When this device last synced successfully. Device-local: it is no reason to rewrite data.json. */
  lastSyncAt(): number | null {
    const value = Number(this.get('last-sync'));
    return Number.isFinite(value) && value > 0 ? value : null;
  }

  setLastSyncAt(at: number): void {
    this.set('last-sync', String(at));
  }

  caseInsensitive(): boolean | null {
    const value = this.get('case-insensitive');
    return value === null ? null : value === 'true';
  }

  setCaseInsensitive(value: boolean): void {
    this.set('case-insensitive', String(value));
  }

  /** Storage for supabase-js's session. */
  authStorage(): SupportedStorage {
    return {
      getItem: (key) => this.get(`auth:${key}`),
      setItem: (key, value) => this.set(`auth:${key}`, value),
      removeItem: (key) => this.set(`auth:${key}`, null),
    };
  }
}
