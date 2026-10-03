// ── backend/encrypted-paths.ts ────────────────────────────────────────────
// Wraps a RemoteBackend for an encrypted vault so the server never sees a
// file name: paths go out as keyed ids with the name sealed alongside, and
// come back decrypted. The engine keeps working with ordinary paths.
// ─────────────────────────────────────────────────────────────────────────────

import { RemoteRow } from '../core/model';
import { PathCipher } from '../core/path-cipher';
import { BackendError, BlobRef, CheckIn, CommitChange, CommitResult, RemoteBackend } from './remote-backend';

export class EncryptedPathBackend implements RemoteBackend {
  /** Ids of owed deliveries whose name could not be read (their row is gone); acknowledged as they are. */
  private readonly rawIds = new Set<string>();

  constructor(
    private readonly inner: RemoteBackend,
    private readonly cipher: PathCipher
  ) {}

  private async reveal(row: RemoteRow): Promise<RemoteRow> {
    if (!row.sealedName) throw new BackendError('other', 'A file in this vault has no encrypted name; was it written without encryption?');
    const path = await this.cipher.open(row.sealedName, row.path);
    return { ...row, path, sealedName: undefined };
  }

  private async ids(items: BlobRef[]): Promise<BlobRef[]> {
    return Promise.all(items.map(async (i) => ({ path: this.rawIds.has(i.path) ? i.path : await this.cipher.id(i.path), hash: i.hash })));
  }

  listVaults = () => this.inner.listVaults();
  createVault: RemoteBackend['createVault'] = (name, encryption) => this.inner.createVault(name, encryption);
  getVault = (vaultId: string) => this.inner.getVault(vaultId);
  putBlob = (vaultId: string, id: string, bytes: Uint8Array) => this.inner.putBlob(vaultId, id, bytes);
  getBlob = (vaultId: string, id: string) => this.inner.getBlob(vaultId, id);
  subscribe: RemoteBackend['subscribe'] = (vaultId, onSignal) => this.inner.subscribe(vaultId, onSignal);
  openRequests = (vaultId: string, deviceId: string) => this.inner.openRequests(vaultId, deviceId);
  fulfilRequests = (vaultId: string, deviceId: string, hashes: string[]) => this.inner.fulfilRequests(vaultId, deviceId, hashes);
  collectGarbage = (vaultId: string) => this.inner.collectGarbage(vaultId);

  async pull(vaultId: string, afterSeq: number, limit: number): Promise<RemoteRow[]> {
    return Promise.all((await this.inner.pull(vaultId, afterSeq, limit)).map((row) => this.reveal(row)));
  }

  async commit(vaultId: string, deviceId: string, changes: CommitChange[]): Promise<CommitResult[]> {
    const hidden = await Promise.all(
      changes.map(async (c) => {
        const id = await this.cipher.id(c.path);
        return { ...c, path: id, sealedName: await this.cipher.seal(c.path, id) };
      })
    );
    const results = await this.inner.commit(vaultId, deviceId, hidden);
    return Promise.all(results.map(async (r) => ({ ok: r.ok, row: r.row ? await this.reveal(r.row) : null })));
  }

  async registerDevice(vaultId: string, deviceId: string): Promise<CheckIn> {
    const checkIn = await this.inner.registerDevice(vaultId, deviceId);
    const deliveries = await Promise.all(
      checkIn.deliveries.map(async (d) => {
        if (!d.sealedName) {
          this.rawIds.add(d.path);
          return { path: d.path, hash: d.hash };
        }
        return { path: await this.cipher.open(d.sealedName, d.path), hash: d.hash };
      })
    );
    return { peers: checkIn.peers, deliveries };
  }

  async ackReceived(vaultId: string, deviceId: string, items: BlobRef[]): Promise<void> {
    await this.inner.ackReceived(vaultId, deviceId, await this.ids(items));
  }

  async requestBlobs(vaultId: string, deviceId: string, items: BlobRef[]): Promise<void> {
    await this.inner.requestBlobs(vaultId, deviceId, await this.ids(items));
  }
}
