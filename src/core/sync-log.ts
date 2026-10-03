// ── core/sync-log.ts ──────────────────────────────────────────────────────
// A short history of what the sync did, for the log window and for bug
// reports. Bounded so a long-running vault never grows it without limit.
// ─────────────────────────────────────────────────────────────────────────────

export type LogKind =
  | 'upload'
  | 'download'
  | 'delete-local'
  | 'delete-remote'
  | 'rename'
  | 'merge'
  | 'conflict'
  | 'skip'
  | 'error'
  | 'info';

export interface LogEntry {
  at: number;
  kind: LogKind;
  path?: string;
  detail?: string;
}

export class SyncLog {
  private entries: LogEntry[] = [];
  private listeners = new Set<() => void>();

  constructor(
    private readonly limit = 500,
    private readonly now: () => number = Date.now
  ) {}

  add(kind: LogKind, path?: string, detail?: string): void {
    this.entries.push({ at: this.now(), kind, path, detail });
    if (this.entries.length > this.limit) this.entries.splice(0, this.entries.length - this.limit);
    for (const listener of this.listeners) listener();
  }

  /** Newest first. */
  list(): LogEntry[] {
    return [...this.entries].reverse();
  }

  load(entries: LogEntry[]): void {
    this.entries = entries.slice(-this.limit);
  }

  toJSON(): LogEntry[] {
    return this.entries;
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
