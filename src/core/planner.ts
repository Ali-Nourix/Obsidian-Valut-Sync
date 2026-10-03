// ── core/planner.ts ───────────────────────────────────────────────────────
// The heart of the sync: a pure function that compares, for every path, the
// file on this device (L), the server's record (R) and what both agreed on
// at the last sync (B), and decides what to do. Comparing against B is what
// separates "created here" from "deleted there", and "edited on both" from
// "edited on one". The decision table is in docs/sync-design.md.
// ─────────────────────────────────────────────────────────────────────────────

import { BaseEntry, LocalFile, RemoteRow } from './model';
import { isMergeable } from './merge';
import { nfc, pathKey } from './paths';

/** A local file with its content id: hashed when its stat moved, else B's id. */
export interface LocalEntry extends LocalFile {
  hash: string;
}

export type Action =
  /** Both sides already hold the same content; record it as the new base. */
  | { kind: 'adopt'; key: string; local: LocalEntry; remote: RemoteRow }
  /** The stat moved but the content did not; refresh B so the file is not re-read. */
  | { kind: 'refresh'; key: string; local: LocalEntry; base: BaseEntry }
  /** Gone on both sides; forget it. */
  | { kind: 'drop'; key: string; base: BaseEntry }
  | { kind: 'download'; key: string; remote: RemoteRow; local?: LocalEntry }
  | { kind: 'upload'; key: string; local: LocalEntry; remotePath: string; expected: number }
  /** Deleted here: record the deletion on the server. */
  | { kind: 'tombstone'; key: string; base: BaseEntry; remote: RemoteRow }
  /** Deleted on the server: move the local file to the trash. */
  | { kind: 'trash'; key: string; local: LocalEntry; base: BaseEntry; remote: RemoteRow }
  /** Renamed on another device: rename here instead of trashing and downloading. */
  | { kind: 'rename'; key: string; fromKey: string; local: LocalEntry; base: BaseEntry; remote: RemoteRow }
  | { kind: 'merge'; key: string; local: LocalEntry; base: BaseEntry; remote: RemoteRow }
  | { kind: 'conflict'; key: string; local: LocalEntry; remote: RemoteRow }
  /** Missing here, but not yet known to be a deliberate delete. */
  | { kind: 'await-delete'; key: string; base: BaseEntry };

export interface Skipped {
  path: string;
  reason: 'case-collision' | 'name-collision';
}

export interface PlanInput {
  local: LocalEntry[];
  remote: RemoteRow[];
  base: BaseEntry[];
  caseInsensitive: boolean;
  /** Keys whose local absence is a confirmed delete (a delete event, or missing long enough). */
  confirmedDeletes: Set<string>;
  /** Keys to leave alone this cycle, e.g. a file that could not be read. */
  ignore?: Set<string>;
}

export interface Plan {
  actions: Action[];
  skipped: Skipped[];
}

/**
 * One local file per key. Two only collide when a case-sensitive file system
 * holds the same name in NFC and NFD; the NFC spelling wins.
 */
function indexLocal(local: LocalEntry[], keyOf: (p: string) => string, skipped: Skipped[]): Map<string, LocalEntry> {
  const out = new Map<string, LocalEntry>();
  for (const file of local) {
    const key = keyOf(file.path);
    const held = out.get(key);
    if (!held) {
      out.set(key, file);
    } else {
      const keep = held.path === nfc(held.path) ? held : file;
      skipped.push({ path: keep === held ? file.path : held.path, reason: 'name-collision' });
      out.set(key, keep);
    }
  }
  return out;
}

/**
 * One server row per key. On a case-insensitive device "Note.md" and
 * "note.md" from a Linux machine are one file: the live row committed first
 * syncs and the other is reported and left alone (never deleted).
 */
function indexRemote(remote: RemoteRow[], keyOf: (p: string) => string, skipped: Skipped[]): Map<string, RemoteRow> {
  const groups = new Map<string, RemoteRow[]>();
  for (const row of remote) {
    const key = keyOf(row.path);
    const group = groups.get(key);
    if (group) group.push(row);
    else groups.set(key, [row]);
  }
  const out = new Map<string, RemoteRow>();
  for (const [key, rows] of groups) {
    if (rows.length === 1) {
      out.set(key, rows[0]);
      continue;
    }
    const live = rows.filter((r) => !r.deleted).sort((a, b) => a.seq - b.seq);
    if (live.length) {
      out.set(key, live[0]);
      for (const other of live.slice(1)) skipped.push({ path: other.path, reason: 'case-collision' });
    } else {
      out.set(key, rows.reduce((a, b) => (b.seq > a.seq ? b : a)));
    }
  }
  return out;
}

function decide(
  key: string,
  l: LocalEntry | undefined,
  r: RemoteRow | undefined,
  b: BaseEntry | undefined,
  confirmed: boolean
): Action | null {
  const rLive = !!r && !r.deleted;

  if (!b) {
    if (l && !rLive) return { kind: 'upload', key, local: l, remotePath: r ? r.path : nfc(l.path), expected: r ? r.version : 0 };
    if (!l && r && rLive) return { kind: 'download', key, remote: r };
    if (l && r && rLive) return l.hash === r.hash ? { kind: 'adopt', key, local: l, remote: r } : { kind: 'conflict', key, local: l, remote: r };
    return null;
  }

  if (!r) {
    // B without any server row: the row was lost on the server. Re-upload what is here.
    return l ? { kind: 'upload', key, local: l, remotePath: b.path, expected: 0 } : { kind: 'drop', key, base: b };
  }

  const rChanged = r.version !== b.version;

  if (!l) {
    if (!rChanged) return confirmed ? { kind: 'tombstone', key, base: b, remote: r } : { kind: 'await-delete', key, base: b };
    if (r.deleted) return { kind: 'drop', key, base: b };
    return { kind: 'download', key, remote: r }; // an edit elsewhere beats a delete here
  }

  const lChanged = l.hash !== b.hash;
  if (!lChanged && !rChanged) {
    return l.mtime !== b.mtime || l.size !== b.size ? { kind: 'refresh', key, local: l, base: b } : null;
  }
  if (lChanged && !rChanged) return { kind: 'upload', key, local: l, remotePath: r.path, expected: r.version };
  if (!lChanged) {
    return r.deleted ? { kind: 'trash', key, local: l, base: b, remote: r } : { kind: 'download', key, remote: r, local: l };
  }
  // Changed on both sides.
  if (r.deleted) return { kind: 'upload', key, local: l, remotePath: r.path, expected: r.version }; // an edit here beats a delete there
  if (l.hash === r.hash) return { kind: 'adopt', key, local: l, remote: r };
  return isMergeable(r.path) ? { kind: 'merge', key, local: l, base: b, remote: r } : { kind: 'conflict', key, local: l, remote: r };
}

/**
 * A rename on another device arrives as a tombstone for the old path and a new
 * row with the same content id. When exactly one such pair matches a local
 * file that is still untouched, the file is renamed rather than trashed and
 * downloaded again (which would also leave a copy in the trash).
 */
function pairRenames(actions: Action[]): Action[] {
  const trashes = new Map<string, Array<Extract<Action, { kind: 'trash' }>>>();
  const arrivals = new Map<string, Array<Extract<Action, { kind: 'download' }>>>();
  for (const action of actions) {
    if (action.kind === 'trash' && action.remote.hash === action.base.hash) {
      const list = trashes.get(action.base.hash) ?? [];
      list.push(action);
      trashes.set(action.base.hash, list);
    } else if (action.kind === 'download' && !action.local) {
      const list = arrivals.get(action.remote.hash) ?? [];
      list.push(action);
      arrivals.set(action.remote.hash, list);
    }
  }
  const replaced = new Set<Action>();
  const renames: Action[] = [];
  for (const [hash, outgoing] of trashes) {
    const incoming = arrivals.get(hash);
    if (outgoing.length !== 1 || !incoming || incoming.length !== 1) continue;
    const [from] = outgoing;
    const [to] = incoming;
    replaced.add(from).add(to);
    renames.push({ kind: 'rename', key: to.key, fromKey: from.key, local: from.local, base: from.base, remote: to.remote });
  }
  return [...actions.filter((a) => !replaced.has(a)), ...renames];
}

export function plan(input: PlanInput): Plan {
  const keyOf = (p: string) => pathKey(p, input.caseInsensitive);
  const skipped: Skipped[] = [];
  const L = indexLocal(input.local, keyOf, skipped);
  const R = indexRemote(input.remote, keyOf, skipped);
  const B = new Map<string, BaseEntry>();
  for (const entry of input.base) B.set(keyOf(entry.path), entry);

  const keys = new Set<string>([...L.keys(), ...R.keys(), ...B.keys()]);
  const actions: Action[] = [];
  for (const key of keys) {
    if (input.ignore?.has(key)) continue;
    const action = decide(key, L.get(key), R.get(key), B.get(key), input.confirmedDeletes.has(key));
    if (action) actions.push(action);
  }
  return { actions: pairRenames(actions), skipped };
}

export interface DeleteSummary {
  /** Local files the server says to delete. */
  local: string[];
  /** Server files this device deleted. */
  remote: string[];
}

/**
 * Deletions in a plan, leaving out the old half of a rename: a tombstone whose
 * content is being uploaded under a new name in the same plan.
 */
export function deletionsIn(actions: Action[]): DeleteSummary {
  const uploaded = new Set(actions.filter((a) => a.kind === 'upload').map((a) => (a as { local: LocalEntry }).local.hash));
  return {
    local: actions.filter((a) => a.kind === 'trash').map((a) => (a as { local: LocalEntry }).local.path),
    remote: actions
      .filter((a) => a.kind === 'tombstone' && !uploaded.has((a as { base: BaseEntry }).base.hash))
      .map((a) => (a as { base: BaseEntry }).base.path),
  };
}

/**
 * Whether a plan deletes enough to ask first: an emptied vault folder always
 * asks; otherwise the count or the share of synced files decides.
 */
export function needsDeleteConfirmation(
  deletes: DeleteSummary,
  localCount: number,
  baseCount: number,
  limits: { massDeleteCount: number; massDeletePercent: number }
): boolean {
  const n = deletes.local.length + deletes.remote.length;
  if (n === 0) return false;
  if (localCount === 0 && baseCount > 0) return true;
  if (n >= limits.massDeleteCount) return true;
  return baseCount >= 5 && (n * 100) / baseCount >= limits.massDeletePercent;
}
