/**
 * Random histories on three devices, with seeded randomness so a failure
 * can be replayed. Users create notes, append lines, rename and move files
 * and sync at random moments (sometimes with the network down). Afterwards
 * every device must hold the same vault as the server, and, in histories
 * without deletions, every line any user ever wrote must still exist
 * somewhere: merged into its note or kept in a conflict copy.
 */
import { checker } from './harness/load.mjs';
import { makeWorld, device, settle, snapshot, assertConverged } from './harness/world.mjs';

const { eq, ok, count } = checker();

function rng(seed) {
  let s = seed >>> 0 || 1;
  return (n) => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) % n;
  };
}

const NAMES = ['a.md', 'b.md', 'c.md', 'notes/d.md', 'notes/e.md', 'f.txt'];

async function history(seed, { deletes }) {
  const rand = rng(seed);
  const world = await makeWorld();
  const devices = [device(world, 'A'), device(world, 'B'), device(world, 'C', { ci: true })];
  for (const dev of devices) dev.options = { ...dev.options, unconfirmedDeleteMs: 0, massDeleteCount: 1000, massDeletePercent: 101 };
  const written = new Set();
  let line = 0;

  for (let step = 0; step < 40; step++) {
    const dev = devices[rand(devices.length)];
    const files = dev.host.list().map((f) => f.path);
    const op = rand(deletes ? 7 : 6);
    if (op === 0 || files.length === 0) {
      const name = NAMES[rand(NAMES.length)];
      const text = `L${++line}\n`;
      if (dev.read(name) === null) {
        dev.write(name, text);
        written.add(text.trim());
      }
    } else if (op <= 2) {
      const name = files[rand(files.length)];
      const text = `L${++line}`;
      dev.write(name, `${dev.read(name)}${text}\n`);
      written.add(text);
    } else if (op === 3) {
      const from = files[rand(files.length)];
      const to = NAMES[rand(NAMES.length)].replace(/(\.\w+)$/, `-${step}$1`);
      if (!dev.host.exists(to)) dev.mv(from, to);
    } else if (op === 4) {
      world.server.offline = rand(4) === 0;
      await dev.sync();
      world.server.offline = false;
    } else if (op === 5) {
      await dev.sync();
    } else {
      dev.del(files[rand(files.length)]);
    }
  }

  await settle(devices, 12);
  world.clock.tick(1000);
  await settle(devices, 12);
  const label = `seed ${seed}${deletes ? ' with deletes' : ''}`;
  const vault = assertConverged(world, devices, eq, label);
  eq(world.server.blobCount(world.vaultId), 0, `${label}: the server keeps no content once everyone has it`);

  if (!deletes) {
    const everything = Object.values(vault).join('\n');
    const lost = [...written].filter((l) => !everything.split('\n').includes(l));
    eq(lost, [], `${label}: no written line was lost`);
  }
  return Object.keys(snapshot(devices[0])).length;
}

let files = 0;
for (let seed = 1; seed <= 150; seed++) files += await history(seed, { deletes: false });
for (let seed = 1; seed <= 100; seed++) files += await history(seed * 7919, { deletes: true });
ok(files > 500, 'the histories produced a meaningful number of files');

console.log(`SYNC_FUZZ_OK (${count()} checks)`);
