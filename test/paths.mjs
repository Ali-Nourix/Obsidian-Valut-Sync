/**
 * Path identity across platforms: NFC for Persian names that iOS hands back
 * decomposed, case folding where the file system ignores case, the scope
 * filter, and conflict-copy names.
 */
import { loadTs, checker } from './harness/load.mjs';

const { nfc, pathKey, normalizeFolder, inScope, isValidPath, parentFolders, extensionOf, conflictCopyName, isConflictCopyOf, isConflictCopy } =
  await loadTs(`export * from "./src/core/paths";`);
const { eq, count } = checker();

// ── NFC ─────────────────────────────────────────────────────────────────────
const decomposed = 'آب.md'; // ا + maddah above, as iOS may store "آب.md"
eq(nfc(decomposed), 'آب.md', 'alef + maddah composes to آ');
eq(nfc('ؤ'), 'ؤ', 'waw + hamza composes to ؤ');
eq(nfc('ۀ'), 'ۀ', 'ae + hamza composes to ۀ');
eq(nfc('می‌خواهم.md'), 'می‌خواهم.md', 'ZWNJ is kept');
eq(pathKey('يادداشت.md', true) === pathKey('یادداشت.md', true), false, 'Arabic yeh and Persian yeh stay different names');
eq(pathKey('Notes/Idea.md', true), 'notes/idea.md', 'case folds on a case-insensitive device');
eq(pathKey('Notes/Idea.md', false), 'Notes/Idea.md', 'case kept on a case-sensitive device');
eq(pathKey(decomposed, false), pathKey('آب.md', false), 'decomposed and composed names share a key');

// ── folders and scope ───────────────────────────────────────────────────────
eq(normalizeFolder('  /Private/Journal/ '), 'Private/Journal', 'trims slashes and spaces');
eq(normalizeFolder('a\\b//c'), 'a/b/c', 'backslashes and doubled slashes');
eq(inScope('Private/x.md', ['Private'], false), false, 'excluded folder');
eq(inScope('Private2/x.md', ['Private'], false), true, 'a sibling with a longer name is not excluded');
eq(inScope('private/x.md', ['Private'], true), false, 'exclusion ignores case where the device does');
eq(inScope('private/x.md', ['Private'], false), true, 'and respects it where the device does not');
eq(inScope('.trash/x.md', [], false), false, 'hidden folders never sync');
eq(inScope('a/.hidden.md', [], false), false, 'hidden files never sync');
eq(inScope('a/b.md', [], false), true, 'ordinary file');
eq(isValidPath('../x.md'), false, 'no parent segments');
eq(isValidPath('/x.md'), false, 'no absolute paths');
eq(isValidPath('a//b.md'), false, 'no empty segments');
eq(parentFolders('a/b/c.md'), ['a', 'a/b'], 'parents outermost first');
eq(parentFolders('c.md'), [], 'a root file has no parents');
eq(extensionOf('a/b.MD'), 'md', 'extension lower-cased');
eq(extensionOf('a/.gitignore'), '', 'a dotfile has no extension');
eq(extensionOf('a.b/c'), '', 'a dot in a folder name is not an extension');

// ── conflict copies ─────────────────────────────────────────────────────────
const when = new Date(2026, 9, 3, 14, 5);
eq(conflictCopyName('Daily/2026-10-03.md', when, () => false), 'Daily/2026-10-03 (conflict 2026-10-03 1405).md', 'first copy');
const taken = new Set(['n (conflict 2026-10-03 1405).md']);
eq(conflictCopyName('n.md', when, (p) => taken.has(p)), 'n (conflict 2026-10-03 1405 2).md', 'numbered when taken');
eq(conflictCopyName('folder.v2/README', when, () => false), 'folder.v2/README (conflict 2026-10-03 1405)', 'no extension');
eq(conflictCopyName('یادداشت.md', when, () => false), 'یادداشت (conflict 2026-10-03 1405).md', 'Persian name');
eq(isConflictCopyOf('n (conflict 2026-10-03 1405 2).md', 'n.md'), true, 'recognises a numbered copy');
eq(isConflictCopyOf('n (conflict 2026-10-03 1405).md', 'm.md'), false, 'not a copy of another note');
eq(isConflictCopyOf('n (conflict notes).md', 'n.md'), false, 'needs the date stamp');
eq(isConflictCopy('a/n (conflict 2026-10-03 1405).md'), true, 'any conflict copy');
eq(isConflictCopy('a/n.md'), false, 'ordinary note');

console.log(`PATHS_OK (${count()} checks)`);
