// ── backend/memory-backend.ts ─────────────────────────────────────────────
// A server held in memory, with the same rules as supabase/schema.sql:
// per-path compare-and-set, a per-vault commit counter for seq, NFC paths,
// and the relay bookkeeping (devices, deliveries owed to them, requests for
// blobs no longer stored, garbage collection of blobs nobody needs). The
// tests run whole devices against it, and its hooks let them cut the network
// or slip in a competing commit.
// ─────────────────────────────────────────────────────────────────────────────

import { EncryptionHeader } from '../core/crypto';
import { RemoteRow } from '../core/model';
import { isValidPath, nfc } from '../core/paths';
import { BackendError, BlobRef, CheckIn, CommitChange, CommitResult, RemoteBackend, RemoteVault } from './remote-backend';

interface StoredVault {
  vault: RemoteVault;
  files: Map<string, RemoteRow>;
  /** Device id → when it last checked in (refreshed at most hourly, like the server). */
  devices: Map<string, number>;
  /** Device id → path → content id still owed to it. */
  deliveries: Map<string, Map<string, string>>;
  /** Device id → path → content id it asked for. */
  requests: Map<string, Map<string, string>>;
}

export interface MemoryBackendOptions {
  now?: () => number;
  /** A blob nobody is owed is kept this long before it counts as garbage. */
  garbageGraceMs?: number;
  /** Devices unseen this long are forgotten. */
  staleDeviceMs?: number;
  /** A device's check-in time is refreshed at most this often. */
  heartbeatMs?: number;
}

export class MemoryBackend implements RemoteBackend {
  readonly vaults = new Map<string, StoredVault>();
  readonly blobs = new Map<string, { bytes: Uint8Array; at: number }>();
  readonly calls = { total: 0, pull: 0, commit: 0, putBlob: 0, getBlob: 0, garbage: 0, checkIn: 0 };
  /** Every call fails as if the network were down. */
  offline = false;
  /** Runs before each commit is applied; a test can commit from "another device" here. */
  beforeCommit: ((vaultId: string, changes: CommitChange[]) => Promise<void> | void) | null = null;
  /** Called on every call; throwing from it fails the call. */
  onCall: ((op: string) => void) | null = null;
  maxBlobSize = Infinity;
  private listeners = new Map<string, Set<(head: number, device: string | null) => void>>();
  private nextVault = 1;
  private readonly now: () => number;
  private readonly garbageGraceMs: number;
  private readonly staleDeviceMs: number;
  private readonly heartbeatMs: number;

  constructor(options: MemoryBackendOptions = {}) {
    this.now = options.now ?? Date.now;
    this.garbageGraceMs = options.garbageGraceMs ?? 10 * 60_000;
    this.staleDeviceMs = options.staleDeviceMs ?? 30 * 24 * 3600_000;
    this.heartbeatMs = options.heartbeatMs ?? 3600_000;
  }

  private enter(op: string): void {
    this.calls.total++;
    if (this.offline) throw new BackendError('network', 'Offline');
    this.onCall?.(op);
  }

  private stored(vaultId: string): StoredVault {
    const stored = this.vaults.get(vaultId);
    if (!stored) throw new BackendError('vault-missing', 'Vault not found');
    return stored;
  }

  private signal(vaultId: string, device: string): void {
    const stored = this.stored(vaultId);
    for (const listener of this.listeners.get(vaultId) ?? []) listener(stored.vault.headSeq, device);
  }

  async listVaults(): Promise<RemoteVault[]> {
    this.enter('listVaults');
    return [...this.vaults.values()].map((v) => ({ ...v.vault }));
  }

  async createVault(name: string, encryption: EncryptionHeader | null): Promise<RemoteVault> {
    this.enter('createVault');
    if ([...this.vaults.values()].some((v) => v.vault.name === name)) throw new BackendError('other', 'A vault with this name exists');
    const vault: RemoteVault = { id: `vault-${this.nextVault++}`, name, encryption, headSeq: 0, headDevice: null };
    this.vaults.set(vault.id, { vault, files: new Map(), devices: new Map(), deliveries: new Map(), requests: new Map() });
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
        sealedName: change.sealedName ?? null,
      };
      stored.files.set(change.path, row);
      for (const owed of stored.deliveries.values()) owed.delete(change.path);
      if (change.deleted) {
        for (const asked of stored.requests.values()) asked.delete(change.path);
      } else {
        for (const device of stored.devices.keys()) {
          if (device === deviceId) continue;
          const owed = stored.deliveries.get(device) ?? new Map<string, string>();
          owed.set(change.path, change.hash);
          stored.deliveries.set(device, owed);
        }
      }
      results.push({ ok: true, row: { ...row } });
    }
    if (head > stored.vault.headSeq) {
      stored.vault.headSeq = head;
      stored.vault.headDevice = deviceId;
      this.signal(vaultId, deviceId);
    }
    return results;
  }

  async putBlob(vaultId: string, id: string, bytes: Uint8Array): Promise<void> {
    this.enter('putBlob');
    this.calls.putBlob++;
    if (bytes.length > this.maxBlobSize) throw new BackendError('too-large', 'Payload too large');
    const key = `${vaultId}/${id}`;
    if (!this.blobs.has(key)) this.blobs.set(key, { bytes: bytes.slice(), at: this.now() });
  }

  async getBlob(vaultId: string, id: string): Promise<Uint8Array> {
    this.enter('getBlob');
    this.calls.getBlob++;
    const blob = this.blobs.get(`${vaultId}/${id}`);
    if (!blob) throw new BackendError('blob-missing', `Blob ${id.slice(0, 12)}… not found`);
    return blob.bytes.slice();
  }

  subscribe(vaultId: string, onSignal: (head: number, device: string | null) => void): () => void {
    const set = this.listeners.get(vaultId) ?? new Set();
    set.add(onSignal);
    this.listeners.set(vaultId, set);
    return () => set.delete(onSignal);
  }

  async registerDevice(vaultId: string, deviceId: string): Promise<CheckIn> {
    this.enter('registerDevice');
    this.calls.checkIn++;
    const stored = this.stored(vaultId);
    const now = this.now();
    const seen = stored.devices.get(deviceId);
    if (seen === undefined || now - seen > this.heartbeatMs) {
      stored.devices.set(deviceId, now);
      for (const [device, last] of stored.devices) {
        if (now - last <= this.staleDeviceMs) continue;
        stored.devices.delete(device);
        stored.deliveries.delete(device);
        stored.requests.delete(device);
      }
    }
    const owed = stored.deliveries.get(deviceId) ?? new Map<string, string>();
    const asked = new Set<string>();
    for (const [device, map] of stored.requests) if (device !== deviceId) for (const hash of map.values()) asked.add(hash);
    return {
      headSeq: stored.vault.headSeq,
      peers: stored.devices.size - 1,
      deliveries: [...owed].map(([path, hash]) => ({ path, hash, sealedName: stored.files.get(path)?.sealedName ?? null })),
      requests: [...asked],
    };
  }

  async ackReceived(vaultId: string, deviceId: string, items: BlobRef[]): Promise<void> {
    this.enter('ackReceived');
    const stored = this.stored(vaultId);
    const owed = stored.deliveries.get(deviceId);
    const asked = stored.requests.get(deviceId);
    for (const item of items) {
      if (owed?.get(item.path) === item.hash) owed.delete(item.path);
      asked?.delete(item.path);
    }
  }

  async requestBlobs(vaultId: string, deviceId: string, items: BlobRef[]): Promise<void> {
    this.enter('requestBlobs');
    const stored = this.stored(vaultId);
    if (!stored.devices.has(deviceId) || !items.length) return;
    const asked = stored.requests.get(deviceId) ?? new Map<string, string>();
    for (const item of items) asked.set(item.path, item.hash);
    stored.requests.set(deviceId, asked);
    this.signal(vaultId, deviceId);
  }

  async fulfilRequests(vaultId: string, deviceId: string, hashes: string[]): Promise<void> {
    this.enter('fulfilRequests');
    const stored = this.stored(vaultId);
    const wanted = new Set(hashes);
    let moved = 0;
    for (const [device, asked] of stored.requests) {
      if (device === deviceId) continue;
      for (const [path, hash] of [...asked]) {
        if (!wanted.has(hash)) continue;
        asked.delete(path);
        const owed = stored.deliveries.get(device) ?? new Map<string, string>();
        owed.set(path, hash);
        stored.deliveries.set(device, owed);
        moved++;
      }
    }
    if (moved) this.signal(vaultId, deviceId);
  }

  async collectGarbage(vaultId: string): Promise<number> {
    this.enter('collectGarbage');
    this.calls.garbage++;
    const stored = this.stored(vaultId);
    const owed = new Set<string>();
    for (const map of stored.deliveries.values()) for (const hash of map.values()) owed.add(hash);
    const now = this.now();
    let deleted = 0;
    for (const [key, blob] of [...this.blobs]) {
      if (!key.startsWith(`${vaultId}/`) || owed.has(key.slice(vaultId.length + 1)) || now - blob.at < this.garbageGraceMs) continue;
      this.blobs.delete(key);
      deleted++;
    }
    return deleted;
  }

  /** Blobs currently stored for a vault, for assertions. */
  blobCount(vaultId: string): number {
    return [...this.blobs.keys()].filter((k) => k.startsWith(`${vaultId}/`)).length;
  }

  /** Live rows of a vault, for assertions. */
  liveRows(vaultId: string): RemoteRow[] {
    return [...this.stored(vaultId).files.values()].filter((r) => !r.deleted).sort((a, b) => a.path.localeCompare(b.path));
  }

  /** Empties a vault's rows and blobs, as if the server had been wiped. */
  wipe(vaultId: string): void {
    const stored = this.stored(vaultId);
    stored.files.clear();
    stored.deliveries.clear();
    stored.requests.clear();
    stored.vault.headSeq = 0;
    for (const key of [...this.blobs.keys()]) if (key.startsWith(`${vaultId}/`)) this.blobs.delete(key);
  }
}
