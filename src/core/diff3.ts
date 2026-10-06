// ── core/diff3.ts ─────────────────────────────────────────────────────────
// Line-based three-way merge. Each side is diffed against the common
// ancestor with Myers' algorithm; changes that touch separate parts of the
// ancestor are combined, and changes that overlap or touch become conflict
// regions, the same conservative rule git and GNU diff3 follow.
// ─────────────────────────────────────────────────────────────────────────────

/** `o[oStart, oEnd)` of the ancestor became `x[xStart, xEnd)` of one side. */
interface Hunk {
  oStart: number;
  oEnd: number;
  xStart: number;
  xEnd: number;
}

export type MergeRegion =
  | { ok: string[] }
  | { conflict: { a: string[]; o: string[]; b: string[] } };

/**
 * Matched index pairs of a longest common subsequence, or null once the edit
 * distance passes `maxD` (the caller then treats the files as conflicting
 * instead of spending memory on a near-total rewrite).
 */
function myersPairs(a: string[], b: string[], maxD: number): Array<[number, number]> | null {
  const n = a.length;
  const m = b.length;
  const max = n + m;
  if (max === 0) return [];
  const off = max + 1;
  const v = new Int32Array(2 * max + 3);
  // snaps[d] holds v[-d..d] after round d; backtracking reads round d-1.
  const snaps: Int32Array[] = [];
  for (let d = 0; d <= max; d++) {
    if (d > maxD) return null;
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[off + k - 1] < v[off + k + 1]) ? v[off + k + 1] : v[off + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[off + k] = x;
      if (x >= n && y >= m) {
        snaps.push(v.slice(off - d, off + d + 1));
        return backtrack(snaps, n, m);
      }
    }
    snaps.push(v.slice(off - d, off + d + 1));
  }
  return null;
}

function backtrack(snaps: Int32Array[], n: number, m: number): Array<[number, number]> {
  const pairs: Array<[number, number]> = [];
  let x = n;
  let y = m;
  for (let d = snaps.length - 1; d > 0; d--) {
    const prev = snaps[d - 1];
    const at = (k: number) => prev[k + d - 1];
    const k = x - y;
    const prevK = k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1;
    const prevX = at(prevK);
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      x--;
      y--;
      pairs.push([x, y]);
    }
    x = prevX;
    y = prevY;
  }
  while (x > 0 && y > 0) {
    x--;
    y--;
    pairs.push([x, y]);
  }
  return pairs.reverse();
}

/** The changes that turn `o` into `x`, each maximal (separated by at least one unchanged line). */
function diffHunks(o: string[], x: string[], maxD: number): Hunk[] | null {
  let start = 0;
  while (start < o.length && start < x.length && o[start] === x[start]) start++;
  let oEnd = o.length;
  let xEnd = x.length;
  while (oEnd > start && xEnd > start && o[oEnd - 1] === x[xEnd - 1]) {
    oEnd--;
    xEnd--;
  }
  const pairs = myersPairs(o.slice(start, oEnd), x.slice(start, xEnd), maxD);
  if (!pairs) return null;
  const hunks: Hunk[] = [];
  let oi = 0;
  let xi = 0;
  for (const [pi, pj] of [...pairs, [oEnd - start, xEnd - start] as [number, number]]) {
    if (pi > oi || pj > xi) hunks.push({ oStart: oi + start, oEnd: pi + start, xStart: xi + start, xEnd: pj + start });
    oi = pi + 1;
    xi = pj + 1;
  }
  return hunks;
}

function sameLines(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((line, i) => line === b[i]);
}

/**
 * Merges `a` and `b`, both edited from `o`. Returns null when a diff grows
 * past `maxD` edits. Identical changes on both sides are not conflicts.
 */
export function diff3Merge(a: string[], o: string[], b: string[], maxD = 4000): MergeRegion[] | null {
  const ha = diffHunks(o, a, maxD);
  const hb = diffHunks(o, b, maxD);
  if (!ha || !hb) return null;

  const tagged = [
    ...ha.map((h) => ({ side: 'a' as const, h })),
    ...hb.map((h) => ({ side: 'b' as const, h })),
  ].sort((p, q) => p.h.oStart - q.h.oStart || (p.side === q.side ? 0 : p.side === 'a' ? -1 : 1));

  const regions: MergeRegion[] = [];
  const pushOk = (lines: string[]) => {
    if (!lines.length) return;
    const last = regions[regions.length - 1];
    if (last && 'ok' in last) last.ok.push(...lines);
    else regions.push({ ok: [...lines] });
  };

  // Lines each side has gained (or lost) before the current position.
  let shiftA = 0;
  let shiftB = 0;
  let oPos = 0;
  let i = 0;
  while (i < tagged.length) {
    const group = [tagged[i]];
    const gStart = tagged[i].h.oStart;
    let gEnd = tagged[i].h.oEnd;
    i++;
    // Changes that overlap or touch the region join it.
    while (i < tagged.length && tagged[i].h.oStart <= gEnd) {
      gEnd = Math.max(gEnd, tagged[i].h.oEnd);
      group.push(tagged[i]);
      i++;
    }
    pushOk(o.slice(oPos, gStart));

    const span = (side: 'a' | 'b', lines: string[], shift: number) => {
      const own = group.filter((t) => t.side === side).map((t) => t.h);
      if (!own.length) return { lines: lines.slice(gStart + shift, gEnd + shift), shift, changed: false };
      const first = own[0];
      const last = own[own.length - 1];
      const from = first.xStart - (first.oStart - gStart);
      const to = last.xEnd + (gEnd - last.oEnd);
      return { lines: lines.slice(from, to), shift: to - gEnd, changed: true };
    };
    const sa = span('a', a, shiftA);
    const sb = span('b', b, shiftB);
    shiftA = sa.shift;
    shiftB = sb.shift;

    if (sa.changed && !sb.changed) pushOk(sa.lines);
    else if (sb.changed && !sa.changed) pushOk(sb.lines);
    else if (sameLines(sa.lines, sb.lines)) pushOk(sa.lines);
    else regions.push({ conflict: { a: sa.lines, o: o.slice(gStart, gEnd), b: sb.lines } });
    oPos = gEnd;
  }
  pushOk(o.slice(oPos));
  return regions;
}
