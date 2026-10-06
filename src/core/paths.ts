// ── core/paths.ts ─────────────────────────────────────────────────────────
// Path rules shared by every device. The server always stores the NFC
// spelling, because iOS and macOS can hand back decomposed (NFD) names: a
// Persian "آ" may arrive as "ا" followed by U+0653. Case-insensitive file
// systems (iOS, macOS, Windows, most Android storage) additionally compare
// names without case, so "Note.md" and "note.md" are one file there.
// ─────────────────────────────────────────────────────────────────────────────

export function nfc(path: string): string {
  return path.normalize('NFC');
}

/**
 * The identity of a path on this device: NFC, and lower-cased where the file
 * system ignores case. Two paths with the same key are the same file here.
 * Characters that merely look alike (ي/ی, ك/ک) are different names and stay so.
 */
export function pathKey(path: string, caseInsensitive: boolean): string {
  const normal = nfc(path);
  return caseInsensitive ? normal.toLowerCase() : normal;
}

/** Cleans a folder typed by the user: no surrounding slashes or spaces, NFC. */
export function normalizeFolder(folder: string): string {
  return nfc(folder.trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '').replace(/\/{2,}/g, '/'));
}

export function isInFolder(path: string, folder: string, caseInsensitive: boolean): boolean {
  if (!folder) return false;
  const p = pathKey(path, caseInsensitive);
  const f = pathKey(folder, caseInsensitive);
  return p === f || p.startsWith(f + '/');
}

/** A path the server will accept: relative, no empty or dot segments, not too long. */
export function isValidPath(path: string): boolean {
  if (!path || path.length > 1024) return false;
  if (path.startsWith('/') || path.endsWith('/') || path.includes('//')) return false;
  return !path.split('/').some((part) => part === '.' || part === '..');
}

/** Whether a file takes part in sync at all: hidden files and excluded folders do not. */
export function inScope(path: string, excludedFolders: string[], caseInsensitive: boolean): boolean {
  if (!isValidPath(path)) return false;
  if (path.split('/').some((part) => part.startsWith('.'))) return false;
  return !excludedFolders.some((folder) => isInFolder(path, folder, caseInsensitive));
}

export function parentFolder(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash < 0 ? '' : path.slice(0, slash);
}

/** Every folder above a path, outermost first: "a/b/c.md" → ["a", "a/b"]. */
export function parentFolders(path: string): string[] {
  const parts = path.split('/');
  const out: string[] = [];
  for (let i = 1; i < parts.length; i++) out.push(parts.slice(0, i).join('/'));
  return out;
}

export function extensionOf(path: string): string {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  return dot <= 0 ? '' : name.slice(dot + 1).toLowerCase();
}

function stamp(when: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${when.getFullYear()}-${pad(when.getMonth() + 1)}-${pad(when.getDate())} ${pad(when.getHours())}${pad(when.getMinutes())}`;
}

function splitName(path: string): { stem: string; ext: string } {
  const slash = path.lastIndexOf('/');
  const dot = path.lastIndexOf('.');
  if (dot <= slash + 1) return { stem: path, ext: '' };
  return { stem: path.slice(0, dot), ext: path.slice(dot) };
}

/**
 * Where the other side's version of a conflicting file is saved:
 * "folder/note (conflict 2026-10-03 1430).md", with " 2", " 3"… added when
 * that name is already taken.
 */
export function conflictCopyName(path: string, when: Date, taken: (candidate: string) => boolean): string {
  const { stem, ext } = splitName(path);
  const label = `${stem} (conflict ${stamp(when)}`;
  let candidate = `${label})${ext}`;
  for (let n = 2; taken(candidate); n++) candidate = `${label} ${n})${ext}`;
  return candidate;
}

/** Whether `candidate` is a conflict copy made from `path` by conflictCopyName. */
export function isConflictCopyOf(candidate: string, path: string): boolean {
  const { stem, ext } = splitName(path);
  if (!candidate.startsWith(`${stem} (conflict `) || !candidate.endsWith(`)${ext}`)) return false;
  const middle = candidate.slice(stem.length + ' (conflict '.length, candidate.length - ext.length - 1);
  return /^\d{4}-\d{2}-\d{2} \d{4}( \d+)?$/.test(middle);
}

export function isConflictCopy(path: string): boolean {
  return /\(conflict \d{4}-\d{2}-\d{2} \d{4}( \d+)?\)(\.[^/.]+)?$/.test(path);
}
