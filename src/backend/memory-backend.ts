// ── backend/memory-backend.ts ─────────────────────────────────────────────
// A server held in memory, with the same rules as supabase/schema.sql:
// per-path compare-and-set, a per-vault commit counter for seq, NFC paths,
// and content-addressed blobs. The tests run whole devices against it, and
// its hooks let them cut the network or slip in a competing commit.
// ─────────────────────────────────────────────────────────────────────────────

import { EncryptionHeader } from '../core/crypto';
import { RemoteRow } from '../core/model';
import { isValidPath, nfc } from '../core/paths';
import { BackendError, CommitChange, CommitResult, RemoteBackend, RemoteVault } from './remote-backend';

interface StoredVault {
  vault: RemoteVault;
  files: Map<string, RemoteRow>;
}

export class MemoryBackend implements RemoteBackend {
  readonly vaults = new Map<string, StoredVault>();
  readonly blobs = new Map<string, Uint8Array>();
  readonly calls = { pull: 0, commit: 0, putBlob: 0, getBlob: 0 };
  /** Every call fails as if the network were down. */
  offline = false;
  /** Runs before each commit is applied; a test can commit from "another device" here. */
  beforeCommit: ((vaultId: string, changes: CommitChange[]) => Promise<void> | void) | null = null;
  /** Called on every call; throwing from it fails the call. */
  onCall: ((op: string) => void) | null = null;
  maxBlobSize = Infinity;
  private listeners = new Map<string, Set<(head: number, device: string | null) => void>>();
  private nextVault = 1;

  private enter(op: string): void {
    if (this.offline) throw new BackendError('network', 'Offline');
    this.onCall?.(op);
  }

  private stored(vaultId: string): StoredVault {
    const stored = this.vaults.get(vaultId);
    if (!stored) throw new BackendError('vault-missing', 'Vault not found');
    return stored;
  }

  async listVaults(): Promise<RemoteVault[]> {
    this.enter('listVaults');
    return [...this.vaults.values()].map((v) => ({ ...v.vault }));
  }

  async createVault(name: string, encryption: EncryptionHeader | null): Promise<RemoteVault> {
    this.enter('createVault');
    if ([...this.vaults.values()].some((v) => v.vault.name === name)) throw new BackendError('other', 'A vault with this name exists');
    const vault: RemoteVault = { id: `vault-${this.nextVault++}`, name, encryption, headSeq: 0, headDevice: null };
    this.vaults.set(vault.id, { vault, files: new Map() });
    return { ...vault };
  }

  async getVault(vaultId: string): Promise<RemoteVault | null> {
    this.enter('getVault');
    const stored = this.vaults.get(vaultId);
    return stored ? { ...stored.vault } : null;
  }

  async pull(vaultId: string, afterSeq: number, limit: number): Promise<RemoteRow[]> {
    this.enter('pull');
    this.calls.pull++;
    return [...this.stored(vaultId).files.values()]
      .filter((r) => r.seq > afterSeq)
      .sort((a, b) => a.seq - b.seq)
      .slice(0, limit)
      .map((r) => ({ ...r }));
  }

  async commit(vaultId: string, deviceId: string, changes: CommitChange[]): Promise<CommitResult[]> {
    this.enter('commit');
    this.calls.commit++;
    if (this.beforeCommit) {
      const hook = this.beforeCommit;
      this.beforeCommit = null;
      await hook(vaultId, changes);
    }
    return this.apply(vaultId, deviceId, changes);
  }

  /** The commit itself, also usable by a test to act as another device without hooks. */
  apply(vaultId: string, deviceId: string, changes: CommitChange[]): CommitResult[] {
    const stored = this.stored(vaultId);
    if (changes.length > 200) throw new BackendError('other', 'Too many changes');
    const results: CommitResult[] = [];
    let head = stored.vault.headSeq;
    for (const change of changes) {
      if (change.path !== nfc(change.path) || !isValidPath(change.path)) throw new BackendError('other', `Bad path ${change.path}`);
      if (!/^[0-9a-f]{64}$/.test(change.hash)) throw new BackendError('other', `Bad hash for ${change.path}`);
      const current = stored.files.get(change.path);
      if ((current?.version ?? 0) !== change.expectedVersion) {
        results.push({ ok: false, row: current ? { ...current } : null });
        continue;
      }
      head++;
      const row: RemoteRow = {
        path: change.path,
        hash: change.hash,
        size: change.size,
        mtime: change.mtime,
        version: (current?.version ?? 0) + 1,
        seq: head,
        deleted: change.deleted,
        device: deviceId,
      };
      stored.files.set(change.path, row);
      results.push({ ok: true, row: { ...row } });
    }
    if (head > stored.vault.headSeq) {
      stored.vault.headSeq = head;
      stored.vault.headDevice = deviceId;
      for (const listener of this.listeners.get(vaultId) ?? []) listener(head, deviceId);
    }
    return results;
  }

  async putBlob(vaultId: string, id: string, bytes: Uint8Array): Promise<void> {
    this.enter('putBlob');
    this.calls.putBlob++;
    if (bytes.length > this.maxBlobSize) throw new BackendError('too-large', 'Payload too large');
    const key = `${vaultId}/${id}`;
    if (!this.blobs.has(key)) this.blobs.set(key, bytes.slice());
  }

  async getBlob(vaultId: string, id: string): Promise<Uint8Array> {
    this.enter('getBlob');
    this.calls.getBlob++;
    const bytes = this.blobs.get(`${vaultId}/${id}`);
    if (!bytes) throw new BackendError('blob-missing', `Blob ${id.slice(0, 12)}… not found`);
    return bytes.slice();
  }

  subscribe(vaultId: string, onHead: (head: number, device: string | null) => void): () => void {
    const set = this.listeners.get(vaultId) ?? new Set();
    set.add(onHead);
    this.listeners.set(vaultId, set);
    return () => set.delete(onHead);
  }

  /** Live rows of a vault, for assertions. */
  liveRows(vaultId: string): RemoteRow[] {
    return [...this.stored(vaultId).files.values()].filter((r) => !r.deleted).sort((a, b) => a.path.localeCompare(b.path));
  }

  /** Empties a vault's rows and blobs, as if the server had been wiped. */
  wipe(vaultId: string): void {
    const stored = this.stored(vaultId);
    stored.files.clear();
    stored.vault.headSeq = 0;
    for (const key of [...this.blobs.keys()]) if (key.startsWith(`${vaultId}/`)) this.blobs.delete(key);
  }
}
