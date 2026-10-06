// ── backend/supabase-backend.ts ───────────────────────────────────────────
// RemoteBackend on Supabase: rows in public.files through PostgREST, the
// commit_files RPC for writes, blobs in the private "vault-sync" bucket and
// Realtime on public.vaults for wake-ups. Requests use supabase-js's fetch,
// not Obsidian's requestUrl, which on mobile passes bodies through base64
// and runs out of memory on large attachments.
// ─────────────────────────────────────────────────────────────────────────────

import { SupabaseClient } from '@supabase/supabase-js';
import { EncryptionHeader, isEncryptionHeader } from '../core/crypto';
import { toArrayBuffer } from '../core/bytes';
import { RemoteRow } from '../core/model';
import { BackendError, BackendErrorKind, BlobRef, CheckIn, CommitChange, CommitResult, RemoteBackend, RemoteVault } from './remote-backend';

export const BUCKET = 'vault-sync';
export const SCHEMA_VERSION = 3;
/** How long a blob nobody is owed stays before it is collected (the server never goes below a minute). */
export const GARBAGE_GRACE_SECONDS = 600;

interface ErrorLike {
  message?: string;
  code?: string;
  status?: number;
  statusCode?: string;
  name?: string;
}

/** Sorts a supabase-js error (PostgREST, Storage, or a failed fetch) into a BackendError. */
export function toBackendError(error: unknown, status?: number): BackendError {
  const e = (error ?? {}) as ErrorLike;
  const message = e.message ?? String(error);
  const code = e.code ?? '';
  const http = status ?? e.status ?? (e.statusCode ? Number(e.statusCode) : undefined);
  let kind: BackendErrorKind = 'other';
  if (/fetch|network|load failed|ECONN|ETIMEDOUT|ENOTFOUND|socket|offline/i.test(message) || http === 0) kind = 'network';
  else if (http === 540 || /paused/i.test(message)) kind = 'paused';
  else if (code === 'PGRST202' || code === 'PGRST205' || code === '42P01' || code === '42883' || /schema cache/i.test(message)) kind = 'schema';
  else if (code === 'P0002' || /vault not found/i.test(message)) kind = 'vault-missing';
  else if (http === 401 || http === 403 || code === 'PGRST301' || code === '42501' || /jwt|not authenticated/i.test(message)) kind = 'auth';
  else if (http === 413 || /maximum allowed size|too large/i.test(message)) kind = 'too-large';
  else if (http === 404 || /not found/i.test(message)) kind = 'blob-missing';
  else if (http === 429) kind = 'rate-limit';
  else if (/quota|exceed/i.test(message)) kind = 'quota';
  return new BackendError(kind, message, error);
}

interface VaultRecord {
  id: string;
  name: string;
  encryption: unknown;
  head_seq: number | string;
  head_device: string | null;
}

interface FileRecord {
  path: string;
  hash: string;
  size: number | string;
  mtime: number | string;
  version: number;
  seq: number | string;
  deleted: boolean;
  device_id: string | null;
  name_enc?: string | null;
}

const VAULT_COLUMNS = 'id,name,encryption,head_seq,head_device';
const FILE_COLUMNS = 'path,hash,size,mtime,version,seq,deleted,device_id,name_enc';

function toVault(record: VaultRecord): RemoteVault {
  return {
    id: record.id,
    name: record.name,
    encryption: isEncryptionHeader(record.encryption) ? record.encryption : null,
    headSeq: Number(record.head_seq),
    headDevice: record.head_device,
  };
}

function toRow(record: FileRecord): RemoteRow {
  return {
    path: record.path,
    hash: record.hash,
    size: Number(record.size),
    mtime: Number(record.mtime),
    version: Number(record.version),
    seq: Number(record.seq),
    deleted: record.deleted,
    device: record.device_id,
    sealedName: record.name_enc ?? null,
  };
}

export class SupabaseBackend implements RemoteBackend {
  constructor(
    private readonly client: SupabaseClient,
    private readonly userId: string
  ) {}

  private objectKey(vaultId: string, id: string): string {
    return `${this.userId}/${vaultId}/${id.slice(0, 2)}/${id}`;
  }

  /** Throws BackendError('schema') unless supabase/schema.sql is installed and current. */
  async checkSchema(): Promise<void> {
    const { data, error, status } = await this.client.rpc('vault_sync_schema_version');
    if (error) throw toBackendError(error, status);
    if (typeof data !== 'number' || data < SCHEMA_VERSION) throw new BackendError('schema', 'The database schema is out of date');
  }

  async listVaults(): Promise<RemoteVault[]> {
    const { data, error, status } = await this.client.from('vaults').select(VAULT_COLUMNS).order('name');
    if (error) throw toBackendError(error, status);
    return (data as VaultRecord[]).map(toVault);
  }

  async createVault(name: string, encryption: EncryptionHeader | null): Promise<RemoteVault> {
    const { data, error, status } = await this.client.from('vaults').insert({ name, encryption }).select(VAULT_COLUMNS).single();
    if (error) throw toBackendError(error, status);
    return toVault(data as VaultRecord);
  }

  async getVault(vaultId: string): Promise<RemoteVault | null> {
    const { data, error, status } = await this.client.from('vaults').select(VAULT_COLUMNS).eq('id', vaultId).maybeSingle();
    if (error) throw toBackendError(error, status);
    return data ? toVault(data as VaultRecord) : null;
  }

  async pull(vaultId: string, afterSeq: number, limit: number): Promise<RemoteRow[]> {
    const { data, error, status } = await this.client
      .from('files')
      .select(FILE_COLUMNS)
      .eq('vault_id', vaultId)
      .gt('seq', afterSeq)
      .order('seq', { ascending: true })
      .limit(limit);
    if (error) throw toBackendError(error, status);
    return (data as FileRecord[]).map(toRow);
  }

  async commit(vaultId: string, deviceId: string, changes: CommitChange[]): Promise<CommitResult[]> {
    const p_changes = changes.map((c) => ({
      path: c.path,
      hash: c.hash,
      size: c.size,
      mtime: Math.round(c.mtime),
      deleted: c.deleted,
      expected_version: c.expectedVersion,
      name_enc: c.sealedName ?? null,
    }));
    const { data, error, status } = await this.client.rpc('commit_files', { p_vault: vaultId, p_device: deviceId, p_changes });
    if (error) throw toBackendError(error, status);
    const results = data as Array<{ i: number; ok: boolean; row: FileRecord | null }>;
    return results.map((r) => ({ ok: r.ok, row: r.row ? toRow(r.row) : null }));
  }

  async putBlob(vaultId: string, id: string, bytes: Uint8Array): Promise<void> {
    const body = new Blob([toArrayBuffer(bytes)], { type: 'application/octet-stream' });
    const { error } = await this.client.storage.from(BUCKET).upload(this.objectKey(vaultId, id), body, {
      contentType: 'application/octet-stream',
      // Blobs are only in transit: no CDN copy may outlive their deletion.
      cacheControl: '0',
      upsert: false,
    });
    if (!error) return;
    const e = error as ErrorLike;
    // Content-addressed: an existing object already holds exactly these bytes.
    if (e.statusCode === '409' || /already exists|duplicate/i.test(e.message ?? '')) return;
    throw toBackendError(error);
  }

  async getBlob(vaultId: string, id: string): Promise<Uint8Array> {
    // A fresh nonce keeps the CDN from answering with a copy of a blob that has since been deleted.
    const cacheNonce = Math.random().toString(36).slice(2);
    const { data, error } = await this.client.storage.from(BUCKET).download(this.objectKey(vaultId, id), { cacheNonce }, { cache: 'no-store' });
    if (error || !data) throw toBackendError(error ?? new Error('Empty download'));
    return new Uint8Array(await data.arrayBuffer());
  }

  private async call<T>(fn: string, args: Record<string, unknown>): Promise<T> {
    const { data, error, status } = await this.client.rpc(fn, args);
    if (error) throw toBackendError(error, status);
    return data as T;
  }

  async registerDevice(vaultId: string, deviceId: string): Promise<CheckIn> {
    const data = await this.call<{
      peers: number;
      head_seq: number | string;
      deliveries: Array<{ path: string; hash: string; name_enc: string | null }>;
      requests: string[];
    }>('register_device', { p_vault: vaultId, p_device: deviceId });
    return {
      headSeq: Number(data.head_seq),
      peers: data.peers,
      deliveries: data.deliveries.map((d) => ({ path: d.path, hash: d.hash, sealedName: d.name_enc })),
      requests: data.requests,
    };
  }

  async ackReceived(vaultId: string, deviceId: string, items: BlobRef[]): Promise<void> {
    for (let i = 0; i < items.length; i += 500) {
      await this.call('ack_received', { p_vault: vaultId, p_device: deviceId, p_items: items.slice(i, i + 500) });
    }
  }

  async requestBlobs(vaultId: string, deviceId: string, items: BlobRef[]): Promise<void> {
    for (let i = 0; i < items.length; i += 500) {
      await this.call('request_blobs', { p_vault: vaultId, p_device: deviceId, p_items: items.slice(i, i + 500) });
    }
  }

  async fulfilRequests(vaultId: string, deviceId: string, hashes: string[]): Promise<void> {
    if (hashes.length) await this.call('fulfil_requests', { p_vault: vaultId, p_device: deviceId, p_hashes: hashes });
  }

  async collectGarbage(vaultId: string, graceSeconds = GARBAGE_GRACE_SECONDS): Promise<number> {
    const names = await this.call<string[]>('garbage_blobs', { p_vault: vaultId, p_grace_seconds: graceSeconds });
    for (let i = 0; i < names.length; i += 100) {
      const { error } = await this.client.storage.from(BUCKET).remove(names.slice(i, i + 100));
      if (error) throw toBackendError(error);
    }
    return names.length;
  }

  subscribe(vaultId: string, onHead: (headSeq: number, device: string | null) => void, onStatus?: (status: string) => void): () => void {
    const channel = this.client
      .channel(`vault-sync:${vaultId}`)
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'vaults', filter: `id=eq.${vaultId}` }, (payload) => {
        const row = payload.new as Partial<VaultRecord> & { signal_device?: string | null };
        if (row.head_seq !== undefined) onHead(Number(row.head_seq), row.signal_device ?? row.head_device ?? null);
      })
      .subscribe((status) => onStatus?.(status));
    return () => {
      void this.client.removeChannel(channel);
    };
  }
}
