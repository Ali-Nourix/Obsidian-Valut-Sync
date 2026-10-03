// ── core/model.ts ─────────────────────────────────────────────────────────
// The shapes every part of the sync shares: a file as the device sees it, a
// file as the server records it, and the record of what both agreed on at
// the last successful sync (the "base" the three-way comparison needs).
// ─────────────────────────────────────────────────────────────────────────────

/** Size and modification time, the cheap test for "has this file changed". */
export interface LocalStat {
  mtime: number;
  size: number;
}

/** A file in the vault, under the path the device actually stores it at. */
export interface LocalFile extends LocalStat {
  path: string;
}

/** One file's current record on the server. Deletions stay as tombstones. */
export interface RemoteRow {
  path: string;
  /** Blob id of the content. A tombstone keeps the id of the last content. */
  hash: string;
  size: number;
  mtime: number;
  /** Starts at 1 and grows by one with every commit to this path. */
  version: number;
  /** Position in the vault's commit order; pulls ask for everything after a cursor. */
  seq: number;
  deleted: boolean;
  device: string | null;
}

/**
 * What this device and the server agreed on for a path at the last sync. A
 * base only ever describes a live file: deleting on either side drops it.
 */
export interface BaseEntry {
  /** The server path, which is the canonical (NFC) spelling. */
  path: string;
  hash: string;
  version: number;
  /** The local stat right after the sync, so an untouched file is never re-read. */
  mtime: number;
  size: number;
}

/** Settings the engine reads at the start of every cycle. */
export interface SyncOptions {
  excludedFolders: string[];
  maxFileSize: number;
  /** A cycle that would delete at least this many files asks first… */
  massDeleteCount: number;
  /** …as does one that would delete at least this share (0–100) of the files, once there are five or more. */
  massDeletePercent: number;
  /** How long a file must stay missing before it counts as deleted, when no delete event was seen. */
  unconfirmedDeleteMs: number;
}

export const DEFAULT_SYNC_OPTIONS: SyncOptions = {
  excludedFolders: [],
  maxFileSize: 50 * 1024 * 1024,
  massDeleteCount: 50,
  massDeletePercent: 25,
  unconfirmedDeleteMs: 60_000,
};
