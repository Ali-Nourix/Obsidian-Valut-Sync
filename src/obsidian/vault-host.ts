// ── obsidian/vault-host.ts ────────────────────────────────────────────────
// The engine's view of the vault, through Obsidian's Vault API so the file
// explorer, open editors and other plugins see every change as it happens.
// Every write is guarded: open editors are saved first, then the file must
// still have the size and time the engine planned with, otherwise the write
// is reported as raced and the next cycle merges instead of overwriting.
// ─────────────────────────────────────────────────────────────────────────────

import { App, MarkdownView, normalizePath, TAbstractFile, TFile, TFolder } from 'obsidian';
import { toArrayBuffer } from '../core/bytes';
import { VaultHost } from '../core/engine';
import { LocalFile, LocalStat } from '../core/model';
import { parentFolders, pathKey } from '../core/paths';

export class ObsidianVaultHost implements VaultHost {
  constructor(
    private readonly app: App,
    readonly caseInsensitive: boolean
  ) {}

  /**
   * Path keys of everything in the vault, rebuilt by each scan and kept up to
   * date by the host's own writes, so finding "Note.md" as "note.md" (or an
   * NFD name by its NFC spelling) does not walk the whole vault every time.
   */
  private index: Map<string, string> | null = null;

  private key(path: string): string {
    return pathKey(path, this.caseInsensitive);
  }

  private rebuildIndex(): void {
    this.index = new Map();
    for (const f of this.app.vault.getAllLoadedFiles()) if (f.path !== '/') this.index.set(this.key(f.path), f.path);
  }

  /** The file or folder at a path, matching the way this device's file system compares names. */
  private find(path: string): TAbstractFile | null {
    const exact = this.app.vault.getAbstractFileByPath(normalizePath(path));
    if (exact) return exact;
    if (!this.index) this.rebuildIndex();
    const known = this.index!.get(this.key(path));
    return known ? this.app.vault.getAbstractFileByPath(known) : null;
  }

  private file(path: string): TFile | null {
    const found = this.find(path);
    return found instanceof TFile ? found : null;
  }

  private static stat(file: TFile): LocalStat {
    return { mtime: file.stat.mtime, size: file.stat.size };
  }

  private static same(file: TFile, expect: LocalStat): boolean {
    return file.stat.mtime === expect.mtime && file.stat.size === expect.size;
  }

  /** Writes out editors holding unsaved typing; untouched editors are left alone so no mtime moves. */
  private async saveEditors(path?: string): Promise<void> {
    for (const leaf of this.app.workspace.getLeavesOfType('markdown')) {
      const view = leaf.view;
      if (!(view instanceof MarkdownView) || !view.file || (path && view.file.path !== path)) continue;
      if (view.getViewData() !== view.data) await view.save();
    }
  }

  private async ensureFolders(path: string): Promise<void> {
    for (const folder of parentFolders(path)) {
      if (this.find(folder)) continue;
      try {
        await this.app.vault.createFolder(folder);
        this.index?.set(this.key(folder), folder);
      } catch {
        // Created meanwhile (or exists under another case): fine either way.
      }
    }
  }

  async flush(): Promise<void> {
    await this.saveEditors();
  }

  list(): LocalFile[] {
    this.rebuildIndex();
    return this.app.vault.getFiles().map((f) => ({ path: f.path, mtime: f.stat.mtime, size: f.stat.size }));
  }

  stat(path: string): LocalStat | null {
    const file = this.file(path);
    return file ? ObsidianVaultHost.stat(file) : null;
  }

  exists(path: string): boolean {
    return this.find(path) !== null;
  }

  async read(path: string): Promise<Uint8Array> {
    const file = this.file(path);
    if (!file) throw new Error(`File not found: ${path}`);
    return new Uint8Array(await this.app.vault.readBinary(file));
  }

  async write(path: string, bytes: Uint8Array, expect: LocalStat | null, mtime?: number): Promise<LocalStat | 'raced'> {
    const options = mtime ? { mtime } : undefined;
    if (expect === null) {
      if (this.find(path)) return 'raced';
      await this.ensureFolders(path);
      const created = await this.app.vault.createBinary(normalizePath(path), toArrayBuffer(bytes), options);
      this.index?.set(this.key(created.path), created.path);
      return ObsidianVaultHost.stat(created);
    }
    const file = this.file(path);
    if (!file) return 'raced';
    await this.saveEditors(file.path);
    if (!ObsidianVaultHost.same(file, expect)) return 'raced';
    await this.app.vault.modifyBinary(file, toArrayBuffer(bytes), options);
    return ObsidianVaultHost.stat(file);
  }

  async rename(from: string, to: string, expect: LocalStat): Promise<LocalStat | 'raced'> {
    const file = this.file(from);
    if (!file || !ObsidianVaultHost.same(file, expect) || this.find(to)) return 'raced';
    await this.ensureFolders(to);
    // Vault.rename, not FileManager.renameFile: the device that renamed the
    // file already updated the links, and those edits arrive as ordinary changes.
    await this.app.vault.rename(file, normalizePath(to));
    this.index?.delete(this.key(from));
    this.index?.set(this.key(file.path), file.path);
    return ObsidianVaultHost.stat(file);
  }

  async trash(path: string, expect: LocalStat): Promise<'ok' | 'raced'> {
    const file = this.file(path);
    if (!file) return 'raced';
    await this.saveEditors(file.path);
    if (!ObsidianVaultHost.same(file, expect)) return 'raced';
    // Follows the user's "deleted files" preference (system trash or .trash).
    await this.app.fileManager.trashFile(file);
    this.index?.delete(this.key(path));
    return 'ok';
  }

  async removeEmptyFolders(folders: string[]): Promise<void> {
    const all = new Set<string>();
    for (const folder of folders) for (const f of [...parentFolders(folder), folder]) all.add(f);
    for (const path of [...all].sort((a, b) => b.length - a.length)) {
      const folder = this.find(path);
      if (folder instanceof TFolder && folder.children.length === 0) {
        try {
          await this.app.vault.delete(folder);
          this.index?.delete(this.key(path));
        } catch {
          // Something appeared in it meanwhile.
        }
      }
    }
  }
}

/**
 * Whether this device's file system ignores letter case: writes a probe file
 * in the plugin folder and asks for it under another case.
 */
export async function probeCaseInsensitive(app: App, dir: string): Promise<boolean> {
  const adapter = app.vault.adapter;
  const lower = `${dir}/case-probe`;
  const upper = `${dir}/CASE-PROBE`;
  try {
    await adapter.write(lower, 'probe');
    return await adapter.exists(upper);
  } catch {
    return true; // when unsure, the cautious answer: treat names as equal
  } finally {
    try {
      await adapter.remove(lower);
    } catch {
      // Nothing to clean up.
    }
  }
}
