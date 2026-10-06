// ── backend/remote-backend.ts ─────────────────────────────────────────────
// What the sync engine needs from a server, independent of Supabase: a list
// of vaults, an ordered feed of file records, an atomic compare-and-set
// commit, and a blob store keyed by content id. Another backend (Google
// Drive, WebDAV…) only has to implement this interface.
// ─────────────────────────────────────────────────────────────────────────────

import { EncryptionHeader } from '../core/crypto';
import { RemoteRow } from '../core/model';

export interface RemoteVault {
  id: string;
  name: string;
  /** Null for a plaintext vault. Fixed when the vault is created. */
  encryption: EncryptionHeader | null;
  /** The seq of the vault's latest commit; nothing to pull when it equals the cursor. */
  headSeq: number;
  /** The device that made that commit. */
  headDevice: string | null;
}

export interface CommitChange {
  path: string;
  /** Encrypted vaults: the real path, sealed; `path` then holds a keyed id. */
  sealedName?: string | null;
  hash: string;
  size: number;
  mtime: number;
  deleted: boolean;
  /**
   * The version this change was based on; 0 means "no row exists yet". The
   * server applies the change only if the row is still at this version.
   */
  expectedVersion: number;
}

export interface CommitResult {
  ok: boolean;
  /** The row after the commit, or, when refused, the row as it stands (null if none). */
  row: RemoteRow | null;
}

/** A blob a device needs, by the path that refers to it. */
export interface BlobRef {
  path: string;
  hash: string;
}

/**
 * What a device learns when it checks in at the start of a sync. This is the
 * one call a quiet sync makes, so it carries everything the device needs.
 */
export interface CheckIn {
  /** The seq of the vault's latest commit; nothing to pull when it equals the cursor. */
  headSeq: number;
  /** Other devices syncing this vault (seen in the last 30 days). */
  peers: number;
  /** Blobs still owed to this device. */
  deliveries: Array<BlobRef & { sealedName?: string | null }>;
  /** Content ids other devices are asking for. */
  requests: string[];
}

export type BackendErrorKind =
  | 'network'
  | 'auth'
  | 'schema'
  | 'vault-missing'
  | 'blob-missing'
  | 'too-large'
  | 'quota'
  | 'rate-limit'
  /** A free-tier project paused after a week without activity. */
  | 'paused'
  | 'other';

export class BackendError extends Error {
  constructor(
    public readonly kind: BackendErrorKind,
    message: string,
    public readonly cause?: unknown
  ) {
    super(message);
    this.name = 'BackendError';
  }

  /** Errors worth retrying later on their own; the rest need the user. */
  get transient(): boolean {
    return this.kind === 'network' || this.kind === 'rate-limit' || this.kind === 'other';
  }

  /** Errors about one file, after which the rest of the cycle can go on. */
  get perFile(): boolean {
    return this.kind === 'blob-missing' || this.kind === 'too-large';
  }
}

export interface RemoteBackend {
  listVaults(): Promise<RemoteVault[]>;
  createVault(name: string, encryption: EncryptionHeader | null): Promise<RemoteVault>;
  getVault(vaultId: string): Promise<RemoteVault | null>;
  /** Rows with seq > afterSeq, in seq order, at most `limit` of them. */
  pull(vaultId: string, afterSeq: number, limit: number): Promise<RemoteRow[]>;
  /** Applies each change with its own compare-and-set; results are in the same order. */
  commit(vaultId: string, deviceId: string, changes: CommitChange[]): Promise<CommitResult[]>;
  /** Stores a blob; storing an id that already exists succeeds without changing it. */
  putBlob(vaultId: string, id: string, bytes: Uint8Array): Promise<void>;
  /** Throws BackendError('blob-missing') when there is no such blob. */
  getBlob(vaultId: string, id: string): Promise<Uint8Array>;
  /**
   * Calls back when another device commits, asks for blobs or delivers them
   * (`device` is who did it); returns an unsubscribe function.
   */
  subscribe(vaultId: string, onSignal: (headSeq: number, device: string | null) => void): () => void;

  // ── Relay: the server only holds a blob until every device has it ──────
  /**
   * Checks in: records the device as active (at most hourly) and returns the
   * vault's head, the device's peers, what is owed to it and what others asked for.
   * Throws BackendError('vault-missing') when the vault is gone.
   */
  registerDevice(vaultId: string, deviceId: string): Promise<CheckIn>;
  /** This device has these blobs now, or no longer needs them. */
  ackReceived(vaultId: string, deviceId: string, items: BlobRef[]): Promise<void>;
  /** Asks the other devices to upload blobs that are no longer on the server. */
  requestBlobs(vaultId: string, deviceId: string, items: BlobRef[]): Promise<void>;
  /** This device has uploaded these blobs for the devices that asked. */
  fulfilRequests(vaultId: string, deviceId: string, hashes: string[]): Promise<void>;
  /** Deletes blobs no device needs any more; returns how many. */
  collectGarbage(vaultId: string): Promise<number>;
}

/** Most changes one commit call may carry; the server enforces a limit too. */
export const COMMIT_BATCH = 100;
/** Rows per pull page. */
export const PULL_PAGE = 1000;
