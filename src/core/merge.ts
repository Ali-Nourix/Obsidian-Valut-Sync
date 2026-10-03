// ── core/merge.ts ─────────────────────────────────────────────────────────
// Automatic merging of a note edited on two devices since their last sync.
// Only text formats are merged. One extra rule on top of plain diff3: when
// both sides only *added* lines at the same spot (two devices appending to
// the same daily note), both additions are kept, this device's first. Any
// other overlap is a real conflict and the caller keeps both versions.
// ─────────────────────────────────────────────────────────────────────────────

import { diff3Merge } from './diff3';
import { extensionOf } from './paths';

const MERGEABLE = new Set(['md', 'markdown', 'txt', 'canvas', 'csv', 'tsv']);

/** Formats whose result must still parse after a line merge. */
const MUST_PARSE_JSON = new Set(['canvas']);

export function isMergeable(path: string): boolean {
  return MERGEABLE.has(extensionOf(path));
}

export type MergeOutcome = { clean: true; text: string } | { clean: false };

export function mergeText(base: string, local: string, remote: string, path = 'note.md'): MergeOutcome {
  if (local === remote) return { clean: true, text: local };
  if (local === base) return { clean: true, text: remote };
  if (remote === base) return { clean: true, text: local };

  const regions = diff3Merge(local.split('\n'), base.split('\n'), remote.split('\n'));
  if (!regions) return { clean: false };

  const out: string[] = [];
  for (const region of regions) {
    if ('ok' in region) {
      out.push(...region.ok);
    } else if (region.conflict.o.length === 0) {
      out.push(...region.conflict.a, ...region.conflict.b);
    } else {
      return { clean: false };
    }
  }
  const text = out.join('\n');

  if (MUST_PARSE_JSON.has(extensionOf(path))) {
    try {
      JSON.parse(text);
    } catch {
      return { clean: false };
    }
  }
  return { clean: true, text };
}
