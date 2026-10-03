// ── core/scheduler.ts ─────────────────────────────────────────────────────
// Decides when to sync. Edits wait for a quiet moment (with a ceiling, so a
// long typing session still syncs); a ping from the server, the app coming
// back to the foreground, or the network returning sync soon; an interval
// is the safety net. Failures back off exponentially, and an error the user
// must fix (signed out, wrong key) stops automatic syncing until they act.
// Timers are injected so the behaviour is tested with a fake clock.
// ─────────────────────────────────────────────────────────────────────────────

export interface Timers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  now(): number;
  random(): number;
}

export type RunResult =
  | { kind: 'ok'; followUpMs?: number | null }
  | { kind: 'transient-error' }
  /** Needs the user (sign in, unlock, fix settings): no automatic retries. */
  | { kind: 'blocked' };

export interface SchedulerOptions {
  startupDelayMs: number;
  localDebounceMs: number;
  localMaxWaitMs: number;
  remoteDebounceMs: number;
  /** 0 turns the interval off. */
  intervalMs: number;
  /** Coming back to the foreground syncs only if the last sync is older than this. */
  resumeMinGapMs: number;
  backoffBaseMs: number;
  backoffMaxMs: number;
}

export const DEFAULT_SCHEDULER_OPTIONS: SchedulerOptions = {
  startupDelayMs: 3000,
  // A burst of typing is one sync, not one every few seconds: each sync costs
  // server calls and file writes on every device.
  localDebounceMs: 10_000,
  localMaxWaitMs: 180_000,
  remoteDebounceMs: 1000,
  intervalMs: 15 * 60_000,
  resumeMinGapMs: 15_000,
  backoffBaseMs: 30_000,
  backoffMaxMs: 30 * 60_000,
};

export class SyncScheduler {
  private timer: unknown = null;
  private debounceDue: number | null = null;
  private soonDue: number | null = null;
  private intervalDue: number | null = null;
  private firstLocalAt: number | null = null;
  private backoffUntil = 0;
  private failures = 0;
  private running = false;
  private queued = false;
  private blocked = false;
  private stopped = true;
  private lastRunAt = 0;

  constructor(
    private readonly run: () => Promise<RunResult>,
    private readonly timers: Timers,
    private options: SchedulerOptions = DEFAULT_SCHEDULER_OPTIONS
  ) {}

  get isBlocked(): boolean {
    return this.blocked;
  }

  get consecutiveFailures(): number {
    return this.failures;
  }

  start(): void {
    this.stopped = false;
    this.blocked = false;
    this.soonDue = this.timers.now() + this.options.startupDelayMs;
    this.arm();
  }

  stop(): void {
    this.stopped = true;
    this.clear();
  }

  setOptions(options: Partial<SchedulerOptions>): void {
    this.options = { ...this.options, ...options };
    if (this.intervalDue !== null || options.intervalMs !== undefined) {
      this.intervalDue = this.options.intervalMs > 0 ? this.timers.now() + this.options.intervalMs : null;
    }
    this.arm();
  }

  /** A file changed in the vault. */
  localChange(): void {
    const now = this.timers.now();
    if (this.firstLocalAt === null) this.firstLocalAt = now;
    this.debounceDue = Math.min(now + this.options.localDebounceMs, this.firstLocalAt + this.options.localMaxWaitMs);
    this.arm();
  }

  /** The server announced a commit from another device. */
  remoteChange(): void {
    this.soonest(this.timers.now() + this.options.remoteDebounceMs);
  }

  /** The app came back to the foreground, or the network returned. */
  resumed(): void {
    if (this.timers.now() - this.lastRunAt >= this.options.resumeMinGapMs) this.soonest(this.timers.now());
  }

  /** The user asked: sync now, past any backoff or block. */
  runNow(): void {
    this.blocked = false;
    this.failures = 0;
    this.backoffUntil = 0;
    if (this.stopped) return;
    this.soonest(this.timers.now());
  }

  private soonest(at: number): void {
    this.soonDue = this.soonDue === null ? at : Math.min(this.soonDue, at);
    this.arm();
  }

  private clear(): void {
    if (this.timer !== null) this.timers.clearTimeout(this.timer);
    this.timer = null;
  }

  private arm(): void {
    this.clear();
    if (this.stopped || this.blocked || this.running) return;
    const due = [this.debounceDue, this.soonDue, this.intervalDue].filter((t): t is number => t !== null);
    if (!due.length) return;
    const at = Math.max(Math.min(...due), this.backoffUntil);
    this.timer = this.timers.setTimeout(() => void this.fire(), Math.max(0, at - this.timers.now()));
  }

  private async fire(): Promise<void> {
    this.timer = null;
    if (this.running) {
      this.queued = true;
      return;
    }
    this.running = true;
    this.debounceDue = null;
    this.soonDue = null;
    this.firstLocalAt = null;
    this.lastRunAt = this.timers.now();
    let result: RunResult;
    try {
      result = await this.run();
    } catch {
      result = { kind: 'transient-error' };
    }
    this.running = false;
    if (this.stopped) return;

    const now = this.timers.now();
    if (result.kind === 'ok') {
      this.failures = 0;
      this.backoffUntil = 0;
      if (result.followUpMs != null) this.soonest(now + result.followUpMs);
    } else if (result.kind === 'transient-error') {
      this.failures++;
      const delay = Math.min(this.options.backoffMaxMs, this.options.backoffBaseMs * 2 ** (this.failures - 1));
      this.backoffUntil = now + delay * (1 + 0.2 * this.timers.random());
      this.soonDue = this.backoffUntil;
    } else {
      this.blocked = true;
    }
    this.intervalDue = this.options.intervalMs > 0 ? now + this.options.intervalMs : null;
    if (this.queued) {
      this.queued = false;
      this.soonDue = this.soonDue === null ? now : Math.min(this.soonDue, now);
    }
    this.arm();
  }
}
