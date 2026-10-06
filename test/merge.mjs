/**
 * Three-way merging of notes edited on two devices: clean merges, real
 * conflicts, the "both appended" rule, and randomised properties checked
 * against the definition of a merge.
 */
import { loadTs, checker } from './harness/load.mjs';

const { mergeText, isMergeable, diff3Merge } = await loadTs(
  `export { mergeText, isMergeable } from "./src/core/merge"; export { diff3Merge } from "./src/core/diff3";`
);
const { eq, count } = checker();

const lines = (...xs) => xs.join('\n') + '\n';

// ── trivial cases ───────────────────────────────────────────────────────────
eq(mergeText('a\n', 'a\n', 'a\n'), { clean: true, text: 'a\n' }, 'nothing changed');
eq(mergeText('a\n', 'b\n', 'a\n'), { clean: true, text: 'b\n' }, 'only local changed');
eq(mergeText('a\n', 'a\n', 'c\n'), { clean: true, text: 'c\n' }, 'only remote changed');
eq(mergeText('a\n', 'z\n', 'z\n'), { clean: true, text: 'z\n' }, 'same change on both sides');

// ── clean merges ────────────────────────────────────────────────────────────
const base = lines('# Title', '', 'one', 'two', 'three', 'four', 'five');
eq(
  mergeText(base, lines('# Title', '', 'ONE', 'two', 'three', 'four', 'five'), lines('# Title', '', 'one', 'two', 'three', 'four', 'FIVE')),
  { clean: true, text: lines('# Title', '', 'ONE', 'two', 'three', 'four', 'FIVE') },
  'edits to different lines merge'
);
eq(
  mergeText(base, lines('# Title', '', 'one', 'two', 'three', 'four', 'five', 'six'), lines('# New title', '', 'one', 'two', 'three', 'four', 'five')),
  { clean: true, text: lines('# New title', '', 'one', 'two', 'three', 'four', 'five', 'six') },
  'append on one side, edit on the other'
);
eq(
  mergeText(base, lines('# Title', '', 'one', 'three', 'four', 'five'), lines('# Title', '', 'one', 'two', 'three', 'four', 'five', '- [ ] new')),
  { clean: true, text: lines('# Title', '', 'one', 'three', 'four', 'five', '- [ ] new') },
  'delete on one side, append on the other'
);

// ── both appended at the end: keep both, local first ────────────────────────
eq(
  mergeText(lines('# 2026-10-03'), lines('# 2026-10-03', '- from phone'), lines('# 2026-10-03', '- from desktop')),
  { clean: true, text: lines('# 2026-10-03', '- from phone', '- from desktop') },
  'daily note appended on two devices'
);
eq(
  mergeText('a\nb', 'a\nb\nc', 'a\nb\nd'),
  { clean: true, text: 'a\nb\nc\nd' },
  'append without a trailing newline'
);

// ── conflicts ───────────────────────────────────────────────────────────────
eq(mergeText(base, base.replace('two', 'TWO'), base.replace('two', 'deux')), { clean: false }, 'same line edited differently');
eq(mergeText(base, base.replace('two', 'TWO'), base.replace('three', 'THREE')), { clean: false }, 'adjacent lines are a conflict, as in git');
eq(mergeText('', 'a\n', 'b\n'), { clean: true, text: 'a\nb\n' }, 'two new files from empty both kept');

// ── line endings and Persian text ───────────────────────────────────────────
const crlf = 'یک\r\nدو\r\nسه\r\nچهار\r\n';
eq(
  mergeText(crlf, crlf.replace('یک', 'یکم'), crlf.replace('چهار', 'چهارم')),
  { clean: true, text: 'یکم\r\nدو\r\nسه\r\nچهارم\r\n' },
  'CRLF Persian note merges and keeps CRLF'
);

// ── canvas must stay valid JSON ─────────────────────────────────────────────
const canvasBase = '{\n\t"nodes":[\n\t\t{"id":"a"}\n\t],\n\t"edges":[]\n}';
eq(
  mergeText(canvasBase, canvasBase.replace('{"id":"a"}', '{"id":"a"},\n\t\t{"id":"b"}'), canvasBase.replace('{"id":"a"}', '{"id":"a"},\n\t\t{"id":"c"}'), 'board.canvas'),
  { clean: false },
  'two nodes added to a canvas would give invalid JSON, so it is a conflict'
);
eq(isMergeable('a/b.md'), true, 'markdown is mergeable');
eq(isMergeable('a/b.canvas'), true, 'canvas is mergeable');
eq(isMergeable('a/b.png'), false, 'images are not');
eq(isMergeable('a/b.pdf'), false, 'PDFs are not');

// ── randomised properties ───────────────────────────────────────────────────
let seed = 42;
const rand = (n) => {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed % n;
};
const words = ['a', 'b', 'c', 'd', 'e', 'f'];
const randomLines = () => Array.from({ length: rand(12) }, () => words[rand(words.length)]);
function mutate(xs) {
  const out = [...xs];
  for (let n = rand(4); n > 0; n--) {
    const op = rand(3);
    const at = rand(out.length + 1);
    if (op === 0) out.splice(at, 0, words[rand(words.length)]);
    else if (op === 1 && out.length) out.splice(Math.min(at, out.length - 1), 1);
    else if (out.length) out[Math.min(at, out.length - 1)] = words[rand(words.length)] + '!';
  }
  return out;
}
const flatten = (regions) => regions.flatMap((r) => ('ok' in r ? r.ok : null));
let props = 0;
for (let round = 0; round < 400; round++) {
  const o = randomLines();
  const a = mutate(o);
  const b = mutate(o);
  // One side unchanged: the merge is exactly the other side.
  eq(flatten(diff3Merge(a, o, o)), a, `round ${round}: only a changed`);
  eq(flatten(diff3Merge(o, o, b)), b, `round ${round}: only b changed`);
  eq(flatten(diff3Merge(a, o, a)), a, `round ${round}: same change both sides`);
  // A clean merge contains every line either side kept and adds nothing else.
  const merged = diff3Merge(a, o, b);
  if (merged.every((r) => 'ok' in r)) {
    const out = flatten(merged);
    for (const line of out) if (!a.includes(line) && !b.includes(line) && !o.includes(line)) throw new Error(`round ${round}: invented ${line}`);
    props++;
  }
}
eq(props > 50, true, 'enough random rounds merged cleanly to mean something');

// A near-total rewrite of a long note gives up instead of grinding.
const long = Array.from({ length: 3000 }, (_, i) => `line ${i}`);
eq(diff3Merge(long.map((l) => l + '?'), long, long, 100), null, 'diff larger than the limit returns null');

console.log(`MERGE_OK (${count()} checks)`);
