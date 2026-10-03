// ── core/engine.ts ────────────────────────────────────────────────────────
// Runs a sync cycle: pull the server's new rows, scan the vault, plan with
// the three-way comparison, then carry the plan out in a safe order.
//
//   1. bookkeeping (adopt / refresh / drop)
//   2. server → device: renames, downloads, merges, conflict copies
//   3. device → server: blobs first, then one compare-and-set commit per batch
//   4. local deletions, then empty folders they leave behind
//   5. relay upkeep: serve blobs other devices asked for, ask for blobs that
//      are no longer on the server, acknowledge what arrived, collect garbage
//
// The server is a relay. A blob is uploaded only when another device will
// need it, stays only until every such device has acknowledged it, and is
// then collected. A device that finds a blob gone asks for it; any device
// holding that content uploads it on its next cycle. Merge bases are kept on
// the device itself (BaseStore), not on the server.
//
// The cycle needs no journal because of four rules: a base changes only
// after its effect is durable; a content id is committed only after its blob
// is stored (when anyone else needs it); the cursor and the mirror are saved
// together; and a base that lags behind heals itself ("changed on both sides
// to the same content" is simply adopted). A cycle cut short at any point is
// finished by the next.
// Writes into the vault are guarded: if the user touched a file after the
// scan, the write is skipped and the next cycle merges the edit instead.
// ─────────────────────────────────────────────────────────────────────────────

import { BackendError, BlobRef, COMMIT_BATCH, CommitChange, PULL_PAGE, RemoteBackend } from '../backend/remote-backend';
import { BaseStore, MemoryBaseStore } from './base-store';
import { BlobCodec, BlobIntegrityError } from './blob-codec';
import { decodeUtf8, utf8 } from './bytes';
import { isMergeable, mergeText } from './merge';
import { DEFAULT_SYNC_OPTIONS, LocalFile, LocalStat, RemoteRow, SyncOptions } from './model';
import { conflictCopyName, inScope, isConflictCopyOf, nfc, parentFolder, pathKey } from './paths';
import { Action, DeleteSummary, deletionsIn, LocalEntry, needsDeleteConfirmation, plan } from './planner';
import { SyncState, StateStore } from './state';
import { SyncLog } from './sync-log';

/** The vault as the engine sees it. The Obsidian implementation lives in obsidian/vault-host.ts. */
export interface VaultHost {
  readonly caseInsensitive: boolean;
  /** Saves open editors so the scan sees what the user sees. */
  flush(): Promise<void>;
  list(): LocalFile[];
  stat(path: string): LocalStat | null;
  /** Whether anything (file or folder) exists at the path. */
  exists(path: string): boolean;
  read(path: string): Promise<Uint8Array>;
  /**
   * Writes only if the file still matches `expect` (null: must not exist yet),
   * creating parent folders. Returns the stat after writing, or 'raced'.
   */
  write(path: string, bytes: Uint8Array, expect: LocalStat | null, mtime?: number): Promise<LocalStat | 'raced'>;
  rename(from: string, to: string, expect: LocalStat): Promise<LocalStat | 'raced'>;
  /** Moves a file to the trash if it still matches `expect`. */
  trash(path: string, expect: LocalStat): Promise<'ok' | 'raced'>;
  /** Removes these folders, deepest first, as long as they are empty. */
  removeEmptyFolders(folders: string[]): Promise<void>;
}

export interface EngineDeps {
  backend: RemoteBackend;
  host: VaultHost;
  codec: BlobCodec;
  store: StateStore;
  vaultId: string;
  userId: string;
  deviceId: string;
  /** Device-local value that a copied state file will not match. */
  nonce: string;
  options?: () => SyncOptions;
  log?: SyncLog;
  now?: () => number;
  /** Transfers running at once; lower on phones to bound memory. */
  concurrency?: number;
  /** Local merge bases; kept in memory when not given. */
  baseStore?: BaseStore;
  /** How often to collect blobs nobody needs (default 5 minutes). */
  gcIntervalMs?: number;
}

export type CycleStatus = 'synced' | 'needs-confirmation' | 'error';

export interface CycleReport {
  status: CycleStatus;
  uploaded: number;
  downloaded: number;
  deletedLocal: number;
  deletedRemote: number;
  renamed: number;
  merged: string[];
  conflicts: Array<{ path: string; copy: string }>;
  skipped: string[];
  /** Files this device is waiting for: their content is no longer on the server and was requested. */
  waiting: number;
  /** Files uploaded because another device asked for them. */
  served: number;
  /** Deletions waiting for the user's answer, when status is needs-confirmation. */
  confirmation: DeleteSummary | null;
  /** Ask again after this long: a missing file is waiting to count as deleted. */
  followUpMs: number | null;
  error: unknown;
}

export function emptyReport(): CycleReport {
  return {
    status: 'synced',
    uploaded: 0,
    downloaded: 0,
    deletedLocal: 0,
    deletedRemote: 0,
    renamed: 0,
    merged: [],
    conflicts: [],
    skipped: [],
    waiting: 0,
    served: 0,
    confirmation: null,
    followUpMs: null,
    error: null,
  };
}

/** Runs `fn` over `items` with at most `limit` in flight; the first failure stops new work and is rethrown. */
export async function forEachLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  let failed = false;
  let failure: unknown;
  const worker = async () => {
    while (!failed && next < items.length) {
      const item = items[next++];
      try {
        await fn(item);
      } catch (error) {
        if (!failed) {
          failed = true;
          failure = error;
        }
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  if (failed) throw failure;
}

const yieldToUi = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

interface PendingCommit {
  change: CommitChange;
  onOk(row: RemoteRow): void;
}

/** Per-cycle working set shared by the phases. */
interface Cycle {
  state: SyncState;
  report: CycleReport;
  local: LocalEntry[];
  commits: PendingCommit[];
  uploads: Array<Extract<Action, { kind: 'upload' }>>;
  /** Folders that may have been emptied by a trash or rename. */
  folders: Set<string>;
  /** Keys taken by conflict copies created this cycle. */
  reserved: Set<string>;
  rerun: boolean;
  /** Other devices that will need what this one uploads. */
  peers: number;
  /** Blobs owed to this device when the cycle started. */
  owed: BlobRef[];
  /** Blobs this device needed but did not find on the server, by path. */
  missing: Map<string, BlobRef>;
  /** Content ids uploaded this cycle. */
  uploaded: Set<string>;
  /** Content of files renamed here: peers rename too and need no upload. */
  renamedIds: Set<string>;
}

const MAX_ROUNDS = 4;
const OWN_WRITE_MS = 3000;
const GC_INTERVAL_MS = 5 * 60_000;

export class SyncEngine {
  private state: SyncState | null = null;
  private running: Promise<CycleReport> | null = null;
  private again = false;
  private stopped = false;
  private readonly deleteEvents = new Set<string>();
  private readonly deletedFolders = new Set<string>();
  private readonly approved = new Set<string>();
  private pending: DeleteSummary | null = null;
  private readonly recentWrites = new Map<string, number>();
  private readonly baseStore: BaseStore;
  private lastGc = -Infinity;
  private emptyId: string | null = null;
  private lastSave = 0;
  private unsaved = 0;
  private saving: Promise<void> = Promise.resolve();

  private readonly now: () => number;
  private readonly log: SyncLog;
  private readonly options: () => SyncOptions;
  private readonly keyOf: (path: string) => string;

  constructor(private readonly deps: EngineDeps) {
    this.now = deps.now ?? Date.now;
    this.log = deps.log ?? new SyncLog(500, this.now);
    this.options = deps.options ?? (() => DEFAULT_SYNC_OPTIONS);
    this.keyOf = (path) => pathKey(path, deps.host.caseInsensitive);
    this.baseStore = deps.baseStore ?? new MemoryBaseStore();
  }

  get vaultId(): string {
    return this.deps.vaultId;
  }

  /** Deletions waiting for the user, if the last cycle held any back. */
  get pendingDeletes(): DeleteSummary | null {
    return this.pending;
  }

  get isRunning(): boolean {
    return this.running !== null;
  }

  /** A vault delete or rename event: the old path really was removed by the user. */
  noteLocalDelete(path: string): void {
    this.deleteEvents.add(this.keyOf(path));
  }

  /** The same for a whole folder, which may arrive as one event for all its files. */
  noteLocalFolderDelete(folder: string): void {
    this.deletedFolders.add(this.keyOf(folder));
  }

  /** Whether a vault event for this path is the echo of the engine's own write. */
  isOwnWrite(path: string): boolean {
    const at = this.recentWrites.get(this.keyOf(path));
    return at !== undefined && this.now() - at < OWN_WRITE_MS;
  }

  stop(): void {
    this.stopped = true;
  }

  /** Runs a sync, or joins the one in progress and asks it to go round once more. */
  sync(): Promise<CycleReport> {
    if (this.stopped) return Promise.resolve({ ...emptyReport(), status: 'error', error: new Error('Sync engine stopped') });
    if (this.running) {
      this.again = true;
      return this.running;
    }
    this.running = this.rounds().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  /** The user agreed to the held-back deletions. */
  approveDeletes(): Promise<CycleReport> {
    if (this.pending) {
      for (const path of [...this.pending.local, ...this.pending.remote]) this.approved.add(this.keyOf(path));
    }
    this.pending = null;
    return this.sync();
  }

  /**
   * The user wants the files kept. Forgetting their base turns "deleted on one
   * side" into "exists on one side", so the next cycle restores them.
   */
  async keepDeletes(): Promise<CycleReport> {
    const state = await this.loadState();
    if (this.pending) {
      for (const path of [...this.pending.local, ...this.pending.remote]) {
        state.dropBase(path);
        this.deleteEvents.delete(this.keyOf(path));
      }
      this.log.add('info', undefined, `Kept ${this.pending.local.length + this.pending.remote.length} files instead of deleting them`);
    }
    this.pending = null;
    await this.save(state);
    return this.sync();
  }

  /** Forgets everything this device knew about the vault; the next sync starts like a first one. */
  async reset(): Promise<void> {
    await this.deps.store.clear();
    this.state = null;
    this.pending = null;
    this.deleteEvents.clear();
  }

  private async rounds(): Promise<CycleReport> {
    const total = emptyReport();
    for (let round = 0; round < MAX_ROUNDS && !this.stopped; round++) {
      this.again = false;
      const { report, rerun } = await this.cycle();
      total.status = report.status;
      total.uploaded += report.uploaded;
      total.downloaded += report.downloaded;
      total.deletedLocal += report.deletedLocal;
      total.deletedRemote += report.deletedRemote;
      total.renamed += report.renamed;
      total.merged.push(...report.merged);
      total.conflicts.push(...report.conflicts);
      total.skipped = report.skipped;
      total.waiting = report.waiting;
      total.served += report.served;
      total.confirmation = report.confirmation;
      total.followUpMs = report.followUpMs;
      total.error = report.error;
      if (report.status !== 'synced' || (!rerun && !this.again)) break;
    }
    return total;
  }

  private async loadState(): Promise<SyncState> {
    if (this.state) return this.state;
    const { vaultId, userId, nonce } = this.deps;
    const { state, discarded } = SyncState.restore(await this.deps.store.load(), { vaultId, userId, nonce }, this.keyOf);
    if (discarded) this.log.add('info', undefined, 'Saved sync state belonged to another device or vault; starting fresh');
    this.state = state;
    return state;
  }

  /** Saves are queued so parallel transfers never interleave two writes of the state file. */
  private save(state: SyncState): Promise<void> {
    const snapshot = state.toJSON();
    this.lastSave = this.now();
    this.unsaved = 0;
    const write = this.saving.then(() => this.deps.store.save(snapshot));
    this.saving = write.catch(() => undefined);
    return write;
  }

  /** Saves during long phases, so a crash loses little work. */
  private async checkpoint(state: SyncState): Promise<void> {
    this.unsaved++;
    if (this.unsaved >= 50 || this.now() - this.lastSave >= 2000) await this.save(state);
  }

  private async emptyBlobId(): Promise<string> {
    if (this.emptyId === null) this.emptyId = await this.deps.codec.id(new Uint8Array(0));
    return this.emptyId;
  }

  private markWrite(path: string): void {
    const now = this.now();
    this.recentWrites.set(this.keyOf(path), now);
    for (const [key, at] of this.recentWrites) if (now - at > OWN_WRITE_MS) this.recentWrites.delete(key);
  }

  /** The plain bytes of a blob, verified against its id. Empty files have no blob. */
  private async fetchPlain(id: string): Promise<Uint8Array> {
    if (id === (await this.emptyBlobId())) return new Uint8Array(0);
    const stored = await this.deps.backend.getBlob(this.deps.vaultId, id);
    return this.deps.codec.open(stored, id);
  }

  private async cycle(): Promise<{ report: CycleReport; rerun: boolean }> {
    const report = emptyReport();
    let state: SyncState | null = null;
    try {
      state = await this.loadState();
      try {
        await this.deps.host.flush();
      } catch {
        // An editor that cannot save right now is picked up by the next cycle.
      }
      const checkIn = await this.deps.backend.registerDevice(this.deps.vaultId, this.deps.deviceId);
      await this.pull(state);
      const cycle = await this.prepare(state, report);
      cycle.peers = checkIn.peers;
      cycle.owed = checkIn.deliveries;
      await this.execute(cycle);
      for (const key of this.deleteEvents) if (!state.base.has(key)) this.deleteEvents.delete(key);
      await this.save(state);
      return { report, rerun: cycle.rerun };
    } catch (error) {
      report.status = 'error';
      report.error = error;
      this.log.add('error', undefined, error instanceof Error ? error.message : String(error));
      if (state) {
        try {
          await this.save(state);
        } catch {
          // Already reporting the first error.
        }
      }
      return { report, rerun: false };
    }
  }

  private async pull(state: SyncState): Promise<void> {
    const { backend, vaultId } = this.deps;
    const vault = await backend.getVault(vaultId);
    if (!vault) throw new BackendError('vault-missing', 'The remote vault no longer exists');
    if (vault.headSeq < state.cursor) {
      // The server's history is shorter than what this device saw: start the mirror over.
      state.remote.clear();
      state.cursor = 0;
    }
    if (vault.headSeq === state.cursor) return;
    for (;;) {
      const rows = await backend.pull(vaultId, state.cursor, PULL_PAGE);
      for (const row of rows) state.applyRow(row);
      if (rows.length) state.cursor = rows[rows.length - 1].seq;
      if (rows.length < PULL_PAGE) break;
    }
    if (state.remote.size === 0 && state.base.size > 0) {
      // The server was emptied. Never read that as "delete everything here": upload again.
      this.log.add('info', undefined, 'The remote vault is empty; this device will upload its files again');
      state.base.clear();
    }
    await this.save(state);
  }

  /** Scan, plan, and hold back deletions that need the user's approval. */
  private async prepare(state: SyncState, report: CycleReport): Promise<Cycle & { actions: Action[] }> {
    const opts = this.options();
    const ci = this.deps.host.caseInsensitive;
    const limit = opts.maxFileSize - this.deps.codec.overhead;
    const ignore = new Set<string>();

    const local: LocalEntry[] = [];
    let hashed = 0;
    for (const file of this.deps.host.list()) {
      if (!inScope(file.path, opts.excludedFolders, ci)) continue;
      const key = this.keyOf(file.path);
      if (file.size > limit) {
        ignore.add(key);
        report.skipped.push(file.path);
        continue;
      }
      const base = state.base.get(key);
      if (base && base.mtime === file.mtime && base.size === file.size) {
        local.push({ ...file, hash: base.hash });
        continue;
      }
      try {
        local.push({ ...file, hash: await this.deps.codec.id(await this.deps.host.read(file.path)) });
      } catch {
        ignore.add(key); // vanished or unreadable; the next cycle looks again
      }
      if (++hashed % 20 === 0) await yieldToUi();
    }
    for (const entry of local) {
      if (state.rejected.get(nfc(entry.path)) === entry.hash) ignore.add(this.keyOf(entry.path));
    }

    const remote: RemoteRow[] = [];
    for (const row of state.remote.values()) {
      if (!inScope(row.path, opts.excludedFolders, ci)) continue;
      if (!row.deleted && row.size > limit) {
        ignore.add(this.keyOf(row.path));
        report.skipped.push(row.path);
        continue;
      }
      remote.push(row);
    }
    const base = [...state.base.values()].filter((b) => inScope(b.path, opts.excludedFolders, ci));

    const now = this.now();
    if (this.deletedFolders.size) {
      for (const key of state.base.keys()) {
        for (const folder of this.deletedFolders) if (key.startsWith(folder + '/')) this.deleteEvents.add(key);
      }
      this.deletedFolders.clear();
    }
    const confirmed = new Set<string>();
    for (const key of this.deleteEvents) confirmed.add(key);
    for (const [key, since] of state.missingSince) if (now - since >= opts.unconfirmedDeleteMs) confirmed.add(key);

    const { actions: planned, skipped } = plan({ local, remote, base, caseInsensitive: ci, confirmedDeletes: confirmed, ignore });
    for (const s of skipped) {
      report.skipped.push(s.path);
      this.log.add('skip', s.path, s.reason === 'case-collision' ? 'Another file differs only in letter case' : 'Duplicate name');
    }

    let awaiting = false;
    for (const action of planned) {
      if (action.kind !== 'await-delete') continue;
      awaiting = true;
      if (!state.missingSince.has(action.key)) state.missingSince.set(action.key, now);
    }
    // Forget a missing file's clock once it is back or its base is gone, but not while
    // its deletion only waits for the user's approval.
    const present = new Set(local.map((l) => this.keyOf(l.path)));
    for (const key of [...state.missingSince.keys()]) if (present.has(key) || !state.base.has(key)) state.missingSince.delete(key);
    if (awaiting) report.followUpMs = opts.unconfirmedDeleteMs;

    let actions = planned;
    const deletes = deletionsIn(planned);
    const unapproved: DeleteSummary = {
      local: deletes.local.filter((p) => !this.approved.has(this.keyOf(p))),
      remote: deletes.remote.filter((p) => !this.approved.has(this.keyOf(p))),
    };
    if (needsDeleteConfirmation(unapproved, local.length, base.length, opts)) {
      const held = new Set([...deletes.local, ...deletes.remote]);
      actions = planned.filter((a) => !((a.kind === 'trash' && held.has(a.local.path)) || (a.kind === 'tombstone' && held.has(a.base.path))));
      this.pending = deletes;
      report.status = 'needs-confirmation';
      report.confirmation = deletes;
      this.log.add('info', undefined, `Waiting for approval to delete ${held.size} files`);
    } else {
      this.pending = null;
      this.approved.clear();
    }

    return {
      state,
      report,
      local,
      actions,
      commits: [],
      uploads: [],
      folders: new Set(),
      reserved: new Set(),
      rerun: false,
      peers: 0,
      owed: [],
      missing: new Map(),
      uploaded: new Set(),
      renamedIds: new Set(),
    };
  }

  private async execute(cycle: Cycle & { actions: Action[] }): Promise<void> {
    const { state, actions } = cycle;
    const of = <K extends Action['kind']>(kind: K) => actions.filter((a): a is Extract<Action, { kind: K }> => a.kind === kind);

    for (const a of of('tombstone')) cycle.renamedIds.add(a.base.hash);

    // 1. Bookkeeping.
    for (const a of of('adopt')) {
      if (isMergeable(a.remote.path)) await this.keepBase(a.remote.hash, () => this.deps.host.read(a.local.path));
      state.setBase({ path: a.remote.path, hash: a.remote.hash, version: a.remote.version, mtime: a.local.mtime, size: a.local.size });
      this.deleteEvents.delete(a.key);
    }
    for (const a of of('refresh')) state.setBase({ ...a.base, mtime: a.local.mtime, size: a.local.size });
    for (const a of of('drop')) state.dropBase(a.base.path);
    await this.save(state);

    // 2. Server → device.
    for (const a of of('rename')) await this.perFile(cycle, a.remote.path, () => this.renameLocal(cycle, a));
    await forEachLimit(of('download'), this.deps.concurrency ?? 2, (a) => this.perFile(cycle, a.remote.path, () => this.download(cycle, a)));
    for (const a of of('merge')) await this.perFile(cycle, a.remote.path, () => this.merge(cycle, a));
    for (const a of of('conflict')) await this.perFile(cycle, a.remote.path, () => this.conflict(cycle, a));

    // 3. Device → server.
    cycle.uploads.push(...of('upload'));
    await forEachLimit(cycle.uploads, this.deps.concurrency ?? 2, (a) => this.perFile(cycle, a.remotePath, () => this.upload(cycle, a)));
    for (const a of of('tombstone')) {
      cycle.commits.push({
        change: { path: a.remote.path, hash: a.remote.hash, size: a.remote.size, mtime: this.now(), deleted: true, expectedVersion: a.remote.version },
        onOk: () => {
          state.dropBase(a.base.path);
          this.deleteEvents.delete(a.key);
          cycle.report.deletedRemote++;
          this.log.add('delete-remote', a.base.path);
        },
      });
    }
    await this.commitAll(cycle);

    // 4. Local deletions.
    for (const a of of('trash')) {
      await this.perFile(cycle, a.local.path, async () => {
        const result = await this.deps.host.trash(a.local.path, { mtime: a.local.mtime, size: a.local.size });
        if (result === 'raced') {
          cycle.rerun = true;
          return;
        }
        this.markWrite(a.local.path);
        state.dropBase(a.base.path);
        cycle.folders.add(parentFolder(a.local.path));
        cycle.report.deletedLocal++;
        this.log.add('delete-local', a.local.path);
      });
    }
    const folders = [...cycle.folders].filter(Boolean);
    if (folders.length) await this.deps.host.removeEmptyFolders(folders);

    // 5. Relay upkeep.
    await this.serveRequests(cycle);
    if (cycle.missing.size) {
      await this.deps.backend.requestBlobs(this.deps.vaultId, this.deps.deviceId, [...cycle.missing.values()]);
      cycle.report.waiting = cycle.missing.size;
      this.log.add('info', undefined, `Asked the other devices for ${cycle.missing.size} files that are no longer on the server`);
    }
    await this.acknowledge(cycle);
    await this.collectGarbage(state);
  }

  /**
   * Keeps a merge base for a note, unless one is already kept. `bytes` is a
   * function so the content is only read when it is actually needed.
   */
  private async keepBase(id: string, bytes: () => Promise<Uint8Array>): Promise<void> {
    if (await this.baseStore.get(id)) return;
    try {
      const content = await bytes();
      if ((await this.deps.codec.id(content)) === id) await this.baseStore.put(id, content);
    } catch {
      // Without a kept base a later concurrent edit becomes a conflict copy instead of a merge.
    }
  }

  /**
   * The bytes of a blob for one of this device's actions, or null when the
   * server no longer has it: then it is asked for, and the action waits.
   */
  private async fetchOrRequest(cycle: Cycle, row: RemoteRow): Promise<Uint8Array | null> {
    try {
      return await this.fetchPlain(row.hash);
    } catch (error) {
      if (!(error instanceof BackendError && error.kind === 'blob-missing')) throw error;
      cycle.missing.set(row.path, { path: row.path, hash: row.hash });
      return null;
    }
  }

  /** Uploads content other devices asked for, if this device holds it. */
  private async serveRequests(cycle: Cycle): Promise<void> {
    const { backend, codec, vaultId, deviceId } = this.deps;
    const wanted = await backend.openRequests(vaultId, deviceId);
    if (!wanted.length) return;
    const holders = new Map<string, string>();
    for (const base of cycle.state.base.values()) if (!holders.has(base.hash)) holders.set(base.hash, base.path);
    const served: string[] = [];
    const empty = await this.emptyBlobId();
    await forEachLimit(wanted, this.deps.concurrency ?? 2, async (id) => {
      const path = holders.get(id);
      let bytes: Uint8Array | null = null;
      if (path && this.deps.host.stat(path)) {
        try {
          bytes = await this.deps.host.read(path);
        } catch {
          bytes = null;
        }
      }
      if (!bytes || (await codec.id(bytes)) !== id) bytes = await this.baseStore.get(id);
      if (!bytes || (await codec.id(bytes)) !== id) return;
      if (id !== empty && !cycle.uploaded.has(id)) await backend.putBlob(vaultId, id, await codec.seal(bytes, id));
      cycle.uploaded.add(id);
      served.push(id);
    });
    if (!served.length) return;
    await backend.fulfilRequests(vaultId, deviceId, served);
    cycle.report.served += served.length;
    this.log.add('info', undefined, `Sent ${served.length} files another device asked for`);
  }

  /**
   * Tells the server which owed blobs this device no longer needs: it has
   * them, the path moved on, or the file is outside what this device syncs.
   * Once nobody is owed a blob, it is garbage.
   */
  private async acknowledge(cycle: Cycle): Promise<void> {
    const { state } = cycle;
    const opts = this.options();
    const limit = opts.maxFileSize - this.deps.codec.overhead;
    const settled = cycle.owed.filter((owed) => {
      if (cycle.missing.has(owed.path)) return false;
      if (state.base.get(this.keyOf(owed.path))?.hash === owed.hash) return true;
      const row = state.remote.get(owed.path);
      if (!row || row.deleted || row.hash !== owed.hash) return true;
      return !inScope(owed.path, opts.excludedFolders, this.deps.host.caseInsensitive) || row.size > limit;
    });
    if (settled.length) await this.deps.backend.ackReceived(this.deps.vaultId, this.deps.deviceId, settled.map(({ path, hash }) => ({ path, hash })));
  }

  /** Every few minutes: delete blobs nobody needs, and merge bases no file uses. */
  private async collectGarbage(state: SyncState): Promise<void> {
    const now = this.now();
    if (now - this.lastGc < (this.deps.gcIntervalMs ?? GC_INTERVAL_MS)) return;
    this.lastGc = now;
    try {
      const removed = await this.deps.backend.collectGarbage(this.deps.vaultId);
      if (removed) this.log.add('info', undefined, `Removed ${removed} delivered files from the server`);
    } catch (error) {
      if (error instanceof BackendError && !error.transient) throw error;
    }
    const keep = new Set<string>();
    for (const base of state.base.values()) if (isMergeable(base.path)) keep.add(base.hash);
    await this.baseStore.prune(keep);
  }

  /**
   * Runs one file's work. Errors about that file alone (a bad name, a missing
   * or corrupt blob, a file too large for the bucket) are logged and skipped;
   * anything else, like a dropped connection, ends the cycle.
   */
  private async perFile(cycle: Cycle, path: string, work: () => Promise<void>): Promise<void> {
    try {
      await work();
    } catch (error) {
      if (error instanceof BackendError && !error.perFile) throw error;
      cycle.report.skipped.push(path);
      this.log.add('error', path, error instanceof Error ? error.message : String(error));
    }
    await this.checkpoint(cycle.state);
  }

  private async renameLocal(cycle: Cycle, a: Extract<Action, { kind: 'rename' }>): Promise<void> {
    const target = a.remote.path;
    if (this.deps.host.exists(target)) {
      cycle.rerun = true; // something already sits there; the next cycle plans it as an ordinary file
      return;
    }
    const result = await this.deps.host.rename(a.local.path, target, { mtime: a.local.mtime, size: a.local.size });
    if (result === 'raced') {
      cycle.rerun = true;
      return;
    }
    this.markWrite(a.local.path);
    this.markWrite(target);
    cycle.state.dropBase(a.base.path);
    cycle.state.setBase({ path: a.remote.path, hash: a.remote.hash, version: a.remote.version, ...result });
    cycle.folders.add(parentFolder(a.local.path));
    cycle.report.renamed++;
    this.log.add('rename', target, `from ${a.local.path}`);
  }

  private async download(cycle: Cycle, a: Extract<Action, { kind: 'download' }>): Promise<void> {
    const bytes = await this.fetchOrRequest(cycle, a.remote);
    if (!bytes) return;
    if (isMergeable(a.remote.path)) await this.baseStore.put(a.remote.hash, bytes);
    const target = a.local ? a.local.path : a.remote.path;
    const expect = a.local ? { mtime: a.local.mtime, size: a.local.size } : null;
    const result = await this.deps.host.write(target, bytes, expect, a.remote.mtime);
    if (result === 'raced') {
      cycle.rerun = true;
      return;
    }
    this.markWrite(target);
    cycle.state.setBase({ path: a.remote.path, hash: a.remote.hash, version: a.remote.version, ...result });
    this.deleteEvents.delete(a.key);
    cycle.report.downloaded++;
    this.log.add('download', target);
  }

  private async merge(cycle: Cycle, a: Extract<Action, { kind: 'merge' }>): Promise<void> {
    let baseBytes = await this.baseStore.get(a.base.hash);
    if (baseBytes && (await this.deps.codec.id(baseBytes)) !== a.base.hash) baseBytes = null;
    if (!baseBytes) {
      try {
        baseBytes = await this.fetchPlain(a.base.hash);
      } catch (error) {
        const unavailable = error instanceof BlobIntegrityError || (error instanceof BackendError && error.kind === 'blob-missing');
        if (!unavailable) throw error;
        return this.conflict(cycle, { kind: 'conflict', key: a.key, local: a.local, remote: a.remote });
      }
    }
    const remoteBytes = await this.fetchOrRequest(cycle, a.remote);
    if (!remoteBytes) return;
    const localBytes = await this.deps.host.read(a.local.path);
    if ((await this.deps.codec.id(localBytes)) !== a.local.hash) {
      cycle.rerun = true; // edited again since the scan
      return;
    }
    const [baseText, localText, remoteText] = [baseBytes, localBytes, remoteBytes].map(decodeUtf8);
    const outcome = baseText !== null && localText !== null && remoteText !== null ? mergeText(baseText, localText, remoteText, a.remote.path) : null;
    if (!outcome || !outcome.clean) return this.conflict(cycle, { kind: 'conflict', key: a.key, local: a.local, remote: a.remote });

    const expect = { mtime: a.local.mtime, size: a.local.size };
    if (outcome.text === remoteText) {
      // Everything this device changed is already in the server's version.
      const result = await this.deps.host.write(a.local.path, remoteBytes, expect, a.remote.mtime);
      if (result === 'raced') {
        cycle.rerun = true;
        return;
      }
      this.markWrite(a.local.path);
      await this.baseStore.put(a.remote.hash, remoteBytes);
      cycle.state.setBase({ path: a.remote.path, hash: a.remote.hash, version: a.remote.version, ...result });
    } else {
      if (outcome.text !== localText) {
        const result = await this.deps.host.write(a.local.path, utf8(outcome.text), expect);
        if (result === 'raced') {
          cycle.rerun = true;
          return;
        }
        this.markWrite(a.local.path);
      }
      cycle.uploads.push({ kind: 'upload', key: a.key, local: a.local, remotePath: a.remote.path, expected: a.remote.version });
    }
    cycle.report.merged.push(a.remote.path);
    this.log.add('merge', a.local.path);
  }

  /**
   * Both sides changed a file and no merge is possible. This device's version
   * keeps the name (so an open note is not swapped under the cursor); the
   * other version is saved next to it as a conflict copy, and both sync.
   */
  private async conflict(cycle: Cycle, a: Extract<Action, { kind: 'conflict' }>): Promise<void> {
    const { state, report } = cycle;
    const host = this.deps.host;
    const remoteBytes = await this.fetchOrRequest(cycle, a.remote);
    if (!remoteBytes) return;

    const existing = cycle.local.find((e) => e.hash === a.remote.hash && isConflictCopyOf(e.path, a.local.path));
    let copy: string;
    let stat: LocalStat;
    if (existing) {
      copy = existing.path; // made by an earlier, interrupted cycle
      stat = { mtime: existing.mtime, size: existing.size };
    } else {
      const remoteKeys = new Set([...state.remote.keys()].map(this.keyOf));
      copy = conflictCopyName(a.local.path, new Date(this.now()), (p) => host.exists(p) || cycle.reserved.has(this.keyOf(p)) || remoteKeys.has(this.keyOf(p)));
      const result = await host.write(copy, remoteBytes, null, a.remote.mtime);
      if (result === 'raced') {
        cycle.rerun = true;
        return;
      }
      this.markWrite(copy);
      stat = result;
    }
    cycle.reserved.add(this.keyOf(copy));

    const copyPath = nfc(copy);
    const synced = state.base.get(this.keyOf(copy));
    if (isMergeable(copyPath)) await this.baseStore.put(a.remote.hash, remoteBytes);
    if (!synced || synced.hash !== a.remote.hash) cycle.commits.push({
      // The copy holds the other device's version, which that device already has and
      // which any third device is still owed on the server: nothing to upload.
      change: { path: copyPath, hash: a.remote.hash, size: a.remote.size, mtime: stat.mtime, deleted: false, expectedVersion: state.remote.get(copyPath)?.version ?? 0 },
      onOk: (row) => state.setBase({ path: row.path, hash: row.hash, version: row.version, ...stat }),
    });
    cycle.uploads.push({ kind: 'upload', key: a.key, local: a.local, remotePath: a.remote.path, expected: a.remote.version });
    report.conflicts.push({ path: a.local.path, copy });
    this.log.add('conflict', a.local.path, `The other version was saved as ${copy}`);
  }

  private async upload(cycle: Cycle, a: Extract<Action, { kind: 'upload' }>): Promise<void> {
    const { state, report } = cycle;
    const { backend, codec, vaultId } = this.deps;
    const before = this.deps.host.stat(a.local.path);
    if (!before) {
      cycle.rerun = true;
      return;
    }
    const bytes = await this.deps.host.read(a.local.path);
    const id = await codec.id(bytes);
    // Only what another device will fetch goes up: nothing when this device is
    // alone, and nothing for a rename (the others rename their own copy).
    const needed = cycle.peers > 0 && !cycle.renamedIds.has(id) && !cycle.uploaded.has(id) && id !== (await this.emptyBlobId());
    if (needed) {
      try {
        await backend.putBlob(vaultId, id, await codec.seal(bytes, id));
      } catch (error) {
        if (error instanceof BackendError && error.kind === 'too-large') state.rejected.set(a.remotePath, id);
        throw error;
      }
      cycle.uploaded.add(id);
    }
    if (isMergeable(a.remotePath)) await this.baseStore.put(id, bytes);
    cycle.commits.push({
      change: { path: a.remotePath, hash: id, size: bytes.length, mtime: before.mtime, deleted: false, expectedVersion: a.expected },
      onOk: (row) => {
        state.setBase({ path: row.path, hash: id, version: row.version, mtime: before.mtime, size: before.size });
        state.rejected.delete(a.remotePath);
        report.uploaded++;
        this.log.add('upload', a.local.path);
      },
    });
  }

  private async commitAll(cycle: Cycle): Promise<void> {
    const { state } = cycle;
    // Parallel uploads finish in any order; commit in a fixed one. New content
    // goes before deletions, so a renamed file appears before its old name goes.
    cycle.commits.sort((a, b) => Number(a.change.deleted) - Number(b.change.deleted) || (a.change.path < b.change.path ? -1 : a.change.path > b.change.path ? 1 : 0));
    for (let i = 0; i < cycle.commits.length; i += COMMIT_BATCH) {
      const batch = cycle.commits.slice(i, i + COMMIT_BATCH);
      const results = await this.deps.backend.commit(this.deps.vaultId, this.deps.deviceId, batch.map((c) => c.change));
      results.forEach((result, j) => {
        const pending = batch[j];
        if (result.ok && result.row) {
          state.applyRow(result.row);
          pending.onOk(result.row);
        } else {
          // Someone committed first. Record what they did; the next round plans again.
          if (result.row) state.applyRow(result.row);
          else state.remote.delete(pending.change.path);
          cycle.rerun = true;
          this.log.add('info', pending.change.path, 'Changed on another device at the same time; syncing again');
        }
      });
      await this.save(state);
    }
  }
}
