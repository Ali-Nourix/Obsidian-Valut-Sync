// ── core/base-store.ts ────────────────────────────────────────────────────
// Local copies of the last synced version of each mergeable note: the common
// ancestor a three-way merge needs. The server no longer keeps old contents
// (it only relays them), so each device keeps its own merge bases, keyed by
// content id, in the plugin folder. Only text formats are kept, so the space
// it takes is about that of the notes themselves.
// ─────────────────────────────────────────────────────────────────────────────

export interface BaseStore {
  /** Whether a copy is kept; cheaper than reading it, and what a write is checked against. */
  has(id: string): Promise<boolean>;
  get(id: string): Promise<Uint8Array | null>;
  put(id: string, bytes: Uint8Array): Promise<void>;
  /** Deletes every copy whose id is not in `keep`. */
  prune(keep: Set<string>): Promise<void>;
}

export class MemoryBaseStore implements BaseStore {
  readonly copies = new Map<string, Uint8Array>();

  readonly writes = { count: 0 };

  async has(id: string): Promise<boolean> {
    return this.copies.has(id);
  }

  async get(id: string): Promise<Uint8Array | null> {
    return this.copies.get(id)?.slice() ?? null;
  }

  async put(id: string, bytes: Uint8Array): Promise<void> {
    this.writes.count++;
    this.copies.set(id, bytes.slice());
  }

  async prune(keep: Set<string>): Promise<void> {
    for (const id of [...this.copies.keys()]) if (!keep.has(id)) this.copies.delete(id);
  }
}
