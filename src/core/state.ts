// ── core/state.ts ─────────────────────────────────────────────────────────
// What a device remembers between syncs: the pull cursor, a mirror of the
// server's rows, and the base (last agreed state) of every file. It is kept
// per remote vault in its own file, never in data.json: a copied base on a
// device that lacks the files would read as "all deleted here". The nonce
// ties the file to this device; a state file copied from elsewhere (by a
// backup, iCloud or a manual copy) carries another nonce and is discarded,
// which falls back to the first-sync rules that never delete anything.
// ─────────────────────────────────────────────────────────────────────────────

import { BaseEntry, RemoteRow } from './model';

export interface PersistedState {
  schema: 1;
  nonce: string;
  userId: string;
  vaultId: string;
  cursor: number;
  remote: RemoteRow[];
  base: BaseEntry[];
  /** Key → when the file was first seen missing without a delete event. */
  missingSince: Record<string, number>;
  /** Server path → content id that failed to upload for good (e.g. too large for the bucket). */
  rejected: Record<string, string>;
  /** When unused merge bases were last deleted (ms); 0 until the first cycle. */
  prunedAt?: number;
}

export interface StateStore {
  load(): Promise<PersistedState | null>;
  save(state: PersistedState): Promise<void>;
  clear(): Promise<void>;
}

export class SyncState {
  cursor = 0;
  /** Server rows by exact server path. */
  readonly remote = new Map<string, RemoteRow>();
  /** Bases by this device's path key. */
  readonly base = new Map<string, BaseEntry>();
  readonly missingSince = new Map<string, number>();
  readonly rejected = new Map<string, string>();
  prunedAt = 0;

  constructor(
    readonly identity: { nonce: string; userId: string; vaultId: string },
    private readonly keyOf: (path: string) => string
  ) {}

  /** The saved state, if it belongs to this device, user and vault; otherwise a fresh one. */
  static restore(
    saved: PersistedState | null,
    identity: { nonce: string; userId: string; vaultId: string },
    keyOf: (path: string) => string
  ): { state: SyncState; discarded: boolean } {
    const state = new SyncState(identity, keyOf);
    if (!saved) return { state, discarded: false };
    const matches = saved.schema === 1 && saved.nonce === identity.nonce && saved.userId === identity.userId && saved.vaultId === identity.vaultId;
    if (!matches) return { state, discarded: true };
    state.cursor = saved.cursor;
    for (const row of saved.remote) state.remote.set(row.path, row);
    for (const entry of saved.base) state.base.set(keyOf(entry.path), entry);
    for (const [key, at] of Object.entries(saved.missingSince ?? {})) state.missingSince.set(key, at);
    for (const [path, id] of Object.entries(saved.rejected ?? {})) state.rejected.set(path, id);
    state.prunedAt = saved.prunedAt ?? 0;
    return { state, discarded: false };
  }

  /** Records a server row, ignoring one older than what the mirror holds. */
  applyRow(row: RemoteRow): void {
    const held = this.remote.get(row.path);
    if (!held || row.seq >= held.seq) this.remote.set(row.path, row);
  }

  setBase(entry: BaseEntry): void {
    const key = this.keyOf(entry.path);
    this.base.set(key, entry);
    this.missingSince.delete(key);
  }

  dropBase(path: string): void {
    const key = this.keyOf(path);
    this.base.delete(key);
    this.missingSince.delete(key);
  }

  toJSON(): PersistedState {
    return {
      schema: 1,
      ...this.identity,
      cursor: this.cursor,
      remote: [...this.remote.values()],
      base: [...this.base.values()],
      missingSince: Object.fromEntries(this.missingSince),
      rejected: Object.fromEntries(this.rejected),
      prunedAt: this.prunedAt,
    };
  }
}
