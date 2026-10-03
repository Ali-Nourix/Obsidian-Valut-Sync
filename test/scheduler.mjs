/**
 * When syncs happen, on a fake clock: startup delay, debounced edits with a
 * ceiling, server pings, resume, the interval, backoff after failures, and
 * a block that only the user lifts.
 */
import { loadTs, checker } from './harness/load.mjs';

const { SyncScheduler, DEFAULT_SCHEDULER_OPTIONS } = await loadTs(`export * from "./src/core/scheduler";`);
const { eq, count } = checker();

class FakeTimers {
  t = 0;
  queue = [];
  nextId = 1;
  now = () => this.t;
  random = () => 0;
  setTimeout = (fn, ms) => {
    const id = this.nextId++;
    this.queue.push({ id, at: this.t + ms, fn });
    return id;
  };
  clearTimeout = (id) => {
    this.queue = this.queue.filter((q) => q.id !== id);
  };
  async advance(ms) {
    const end = this.t + ms;
    for (;;) {
      this.queue.sort((a, b) => a.at - b.at);
      const next = this.queue[0];
      if (!next || next.at > end) break;
      this.queue.shift();
      this.t = next.at;
      next.fn();
      await new Promise((r) => setImmediate(r));
    }
    this.t = end;
  }
}

function setup(results = []) {
  const timers = new FakeTimers();
  const runs = [];
  const scheduler = new SyncScheduler(
    async () => {
      runs.push(timers.now());
      return results.shift() ?? { kind: 'ok' };
    },
    timers,
    { ...DEFAULT_SCHEDULER_OPTIONS, intervalMs: 300_000 }
  );
  return { timers, runs, scheduler };
}

{
  const { timers, runs, scheduler } = setup();
  scheduler.start();
  await timers.advance(2999);
  eq(runs, [], 'nothing before the startup delay');
  await timers.advance(1);
  eq(runs, [3000], 'startup sync after 3 s');

  scheduler.localChange();
  await timers.advance(9000);
  scheduler.localChange();
  await timers.advance(9000);
  eq(runs, [3000], 'edits keep pushing the sync back');
  await timers.advance(1000);
  eq(runs, [3000, 22000], 'and it runs 10 s after the last edit');

  for (let i = 0; i < 40; i++) {
    scheduler.localChange();
    await timers.advance(9000);
  }
  eq(runs.length >= 3 && runs[2] - 22000 <= 180000, true, 'continuous typing still syncs within three minutes');

  const before = runs.length;
  scheduler.remoteChange();
  await timers.advance(1000);
  eq(runs.length, before + 1, 'a server ping syncs after 1 s');

  scheduler.resumed();
  await timers.advance(0);
  eq(runs.length, before + 1, 'resuming right after a sync does not sync again');
  await timers.advance(20_000);
  scheduler.resumed();
  await timers.advance(0);
  eq(runs.length, before + 2, 'resuming after a while syncs at once');

  const last = runs[runs.length - 1];
  await timers.advance(300_000);
  eq(runs[runs.length - 1], last + 300_000, 'the interval is the safety net');
  scheduler.stop();
  const stopped = runs.length;
  await timers.advance(1_000_000);
  eq(runs.length, stopped, 'stopped means silent');
}

{
  const { timers, runs, scheduler } = setup([{ kind: 'transient-error' }, { kind: 'transient-error' }, { kind: 'transient-error' }]);
  scheduler.start();
  await timers.advance(3000);
  await timers.advance(30_000);
  await timers.advance(60_000);
  await timers.advance(120_000);
  eq(runs, [3000, 33000, 93000, 213000], 'backoff doubles: 30 s, 60 s, 120 s');
  eq(scheduler.consecutiveFailures, 0, 'a success resets it');

  const { timers: t2, runs: r2, scheduler: s2 } = setup([{ kind: 'transient-error' }]);
  s2.start();
  await t2.advance(3000);
  s2.localChange();
  await t2.advance(10_000);
  eq(r2.length, 1, 'edits during backoff wait for it');
  s2.runNow();
  await t2.advance(0);
  eq(r2.length, 2, 'but "sync now" does not');
}

{
  const { timers, runs, scheduler } = setup([{ kind: 'blocked' }]);
  scheduler.start();
  await timers.advance(3000);
  scheduler.localChange();
  scheduler.remoteChange();
  await timers.advance(600_000);
  eq(runs.length, 1, 'blocked: nothing automatic');
  eq(scheduler.isBlocked, true, 'reports the block');
  scheduler.runNow();
  await timers.advance(0);
  eq(runs.length, 2, 'the user lifts it');
}

{
  const { timers, runs, scheduler } = setup([{ kind: 'ok', followUpMs: 60_000 }]);
  scheduler.start();
  await timers.advance(3000);
  await timers.advance(60_000);
  eq(runs, [3000, 63000], 'a follow-up request is honoured');
}

console.log(`SCHEDULER_OK (${count()} checks)`);
