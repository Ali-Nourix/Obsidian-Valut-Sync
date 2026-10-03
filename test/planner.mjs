/**
 * The three-way decision table, one row at a time, plus rename pairing,
 * case collisions, unconfirmed deletes and the mass-delete guard.
 */
import { loadTs, checker } from './harness/load.mjs';

const { plan, deletionsIn, needsDeleteConfirmation } = await loadTs(`export * from "./src/core/planner";`);
const { eq, count } = checker();

const H = (c) => c.repeat(64);
const L = (path, hash, mtime = 10, size = 5) => ({ path, hash: H(hash), mtime, size });
const R = (path, hash, version, deleted = false, seq = version) => ({ path, hash: H(hash), size: 5, mtime: 1, version, seq, deleted, device: 'other' });
const B = (path, hash, version, mtime = 10, size = 5) => ({ path, hash: H(hash), version, mtime, size });

function decide({ local = [], remote = [], base = [], confirmed = [], ci = false }) {
  const { actions } = plan({ local, remote, base, caseInsensitive: ci, confirmedDeletes: new Set(confirmed) });
  return actions.map((a) => (a.kind === 'upload' ? `upload:${a.remotePath}@${a.expected}` : `${a.kind}:${a.key}`)).sort();
}

// ── no base ─────────────────────────────────────────────────────────────────
eq(decide({ local: [L('a.md', 'a')] }), ['upload:a.md@0'], '1. new here, nothing there → upload');
eq(decide({ local: [L('a.md', 'a')], remote: [R('a.md', 'b', 3, true)] }), ['upload:a.md@3'], '1. new here over a tombstone → upload on top of it');
eq(decide({ remote: [R('a.md', 'a', 1)] }), ['download:a.md'], '2. new there → download');
eq(decide({ local: [L('a.md', 'a')], remote: [R('a.md', 'a', 1)] }), ['adopt:a.md'], '3. same content on both → adopt');
eq(decide({ local: [L('a.md', 'a')], remote: [R('a.md', 'b', 1)] }), ['conflict:a.md'], '3. different content, no base → conflict');
eq(decide({ remote: [R('a.md', 'a', 2, true)] }), [], '13. tombstone of a file never seen → nothing');

// ── with base ───────────────────────────────────────────────────────────────
const base = [B('a.md', 'a', 1)];
eq(decide({ local: [L('a.md', 'a')], remote: [R('a.md', 'a', 1)], base }), [], '4. nothing changed');
eq(decide({ local: [L('a.md', 'a', 99)], remote: [R('a.md', 'a', 1)], base }), ['refresh:a.md'], '4. touched but same content → refresh the stat');
eq(decide({ local: [L('a.md', 'x')], remote: [R('a.md', 'a', 1)], base }), ['upload:a.md@1'], '5. changed here → upload with CAS on v1');
eq(decide({ local: [L('a.md', 'a')], remote: [R('a.md', 'b', 2)], base }), ['download:a.md'], '6. changed there → download');
eq(decide({ local: [L('a.md', 'x')], remote: [R('a.md', 'x', 2)], base }), ['adopt:a.md'], '7. both changed to the same → adopt');
eq(decide({ local: [L('a.md', 'x')], remote: [R('a.md', 'y', 2)], base }), ['merge:a.md'], '7. both changed a note → merge');
eq(
  decide({ local: [L('p.png', 'x')], remote: [R('p.png', 'y', 2)], base: [B('p.png', 'a', 1)] }),
  ['conflict:p.png'],
  '7. both changed an image → conflict'
);
eq(decide({ remote: [R('a.md', 'a', 1)], base, confirmed: ['a.md'] }), ['tombstone:a.md'], '8. deleted here (confirmed) → tombstone');
eq(decide({ remote: [R('a.md', 'a', 1)], base }), ['await-delete:a.md'], '8. missing here without a delete event → wait');
eq(decide({ remote: [R('a.md', 'b', 2)], base, confirmed: ['a.md'] }), ['download:a.md'], '9. deleted here, edited there → edit wins');
eq(decide({ local: [L('a.md', 'a')], remote: [R('a.md', 'a', 2, true)], base }), ['trash:a.md'], '10. deleted there → trash here');
eq(decide({ local: [L('a.md', 'x')], remote: [R('a.md', 'a', 2, true)], base }), ['upload:a.md@2'], '11. edited here, deleted there → edit wins');
eq(decide({ remote: [R('a.md', 'a', 2, true)], base, confirmed: ['a.md'] }), ['drop:a.md'], '12. deleted on both → forget');
eq(decide({ local: [L('a.md', 'a')], base }), ['upload:a.md@0'], 'base but no server row → upload again');
eq(decide({ base }), ['drop:a.md'], 'base only → forget');

// ── renames ─────────────────────────────────────────────────────────────────
const renamed = decide({
  local: [L('old.md', 'a')],
  remote: [R('old.md', 'a', 2, true, 5), R('new.md', 'a', 1, false, 6)],
  base: [B('old.md', 'a', 1)],
});
eq(renamed, ['rename:new.md'], 'tombstone + new row with the same content → rename locally');
const ambiguous = decide({
  local: [L('x.md', 'e'), L('y.md', 'e')],
  remote: [R('x.md', 'e', 2, true), R('y.md', 'e', 2, true), R('z.md', 'e', 1), R('w.md', 'e', 1)],
  base: [B('x.md', 'e', 1), B('y.md', 'e', 1)],
});
eq(ambiguous, ['download:w.md', 'download:z.md', 'trash:x.md', 'trash:y.md'], 'ambiguous pairs (e.g. empty files) fall back to trash + download');
const pushRename = plan({
  local: [L('new.md', 'a')],
  remote: [R('old.md', 'a', 1)],
  base: [B('old.md', 'a', 1)],
  caseInsensitive: false,
  confirmedDeletes: new Set(['old.md']),
}).actions;
eq(pushRename.map((a) => a.kind).sort(), ['tombstone', 'upload'], 'a local rename is a tombstone plus an upload');
eq(deletionsIn(pushRename), { local: [], remote: [] }, 'and does not count as a deletion');

// ── case and normalisation ──────────────────────────────────────────────────
const collision = plan({
  local: [],
  remote: [R('Note.md', 'a', 1, false, 1), R('note.md', 'b', 1, false, 2)],
  base: [],
  caseInsensitive: true,
  confirmedDeletes: new Set(),
});
eq(collision.actions.map((a) => `${a.kind}:${a.remote.path}`), ['download:Note.md'], 'case collision: the earlier row syncs');
eq(collision.skipped, [{ path: 'note.md', reason: 'case-collision' }], 'and the later one is reported');
eq(
  decide({ local: [L('Note.md', 'a')], remote: [R('note.md', 'a', 1)], base: [B('note.md', 'a', 1)], ci: true }),
  [],
  'case-insensitive device matches Note.md with note.md'
);
const nfd = 'آب.md';
eq(
  decide({ local: [L(nfd, 'a')], remote: [R('آب.md', 'a', 1)], base: [B('آب.md', 'a', 1)] }),
  [],
  'an NFD local name matches its NFC server row'
);
eq(decide({ local: [L(nfd, 'a')] }), ['upload:آب.md@0'], 'uploads use the NFC spelling');

// ── ignore ──────────────────────────────────────────────────────────────────
eq(
  plan({ local: [L('a.md', 'x')], remote: [R('a.md', 'a', 1)], base, caseInsensitive: false, confirmedDeletes: new Set(), ignore: new Set(['a.md']) }).actions,
  [],
  'ignored keys are left alone'
);

// ── mass-delete guard ───────────────────────────────────────────────────────
const limits = { massDeleteCount: 50, massDeletePercent: 25 };
eq(needsDeleteConfirmation({ local: [], remote: [] }, 0, 10, limits), false, 'nothing to delete');
eq(needsDeleteConfirmation({ local: ['a'], remote: [] }, 0, 1, limits), true, 'emptied vault always asks');
eq(needsDeleteConfirmation({ local: ['a'], remote: [] }, 99, 100, limits), false, 'one of a hundred goes ahead');
eq(needsDeleteConfirmation({ local: Array(30).fill('x'), remote: [] }, 70, 100, limits), true, '30% asks');
eq(needsDeleteConfirmation({ local: Array(50).fill('x'), remote: [] }, 950, 1000, limits), true, '50 files asks');
eq(needsDeleteConfirmation({ local: ['a'], remote: [] }, 3, 4, limits), false, 'small vaults are not held to the percentage');

console.log(`PLANNER_OK (${count()} checks)`);
