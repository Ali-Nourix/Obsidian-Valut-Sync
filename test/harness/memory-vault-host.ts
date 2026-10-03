// ── test/harness/memory-vault-host.ts ─────────────────────────────────────
// A device's vault held in memory, behaving like the real file systems the
// plugin meets: optionally case-insensitive (iOS, macOS, Windows), optionally
// storing names decomposed (NFD) as older Apple file systems do. Hooks let a
// test edit a file at the worst moment or "crash" the device mid-cycle.
// ─────────────────────────────────────────────────────────────────────────────

import { VaultHost } from '../../src/core/engine';
import { LocalFile, LocalStat } from '../../src/core/model';
import { parentFolders, pathKey } from '../../src/core/paths';

export class Clock {
  private t = 1_000_000;
  now = (): number => this.t;
  tick(ms = 1): number {
    this.t += ms;
    return this.t;
  }
}

interface StoredFile {
  path: string;
  bytes: Uint8Array;
  mtime: number;
}

export class CrashError extends Error {}

export class MemoryVaultHost implements VaultHost {
  readonly files = new Map<string, StoredFile>();
  readonly folders = new Map<string, string>();
  readonly trashed: Array<{ path: string; bytes: Uint8Array }> = [];
  /** Runs inside write() before its guard: a test edits the file "while the download lands". */
  beforeWrite: ((path: string) => void) | null = null;
  crashed = false;

  constructor(
    private readonly clock: Clock,
    readonly caseInsensitive = false,
    private readonly storesNfd = false
  ) {}

  private key(path: string): string {
    return pathKey(path, this.caseInsensitive);
  }

  private stored(path: string): string {
    return this.storesNfd ? path.normalize('NFD') : path;
  }

  private mutate(): void {
    if (this.crashed) throw new CrashError('Device is down');
  }

  private ensureParents(path: string): void {
    for (const folder of parentFolders(path)) {
      if (!this.folders.has(this.key(folder))) this.folders.set(this.key(folder), this.stored(folder));
    }
  }

  // ── user actions (not part of VaultHost) ─────────────────────────────────
  put(path: string, bytes: Uint8Array): void {
    const existing = this.files.get(this.key(path));
    this.ensureParents(path);
    this.files.set(this.key(path), { path: existing?.path ?? this.stored(path), bytes: bytes.slice(), mtime: this.clock.tick() });
  }

  remove(path: string): void {
    this.files.delete(this.key(path));
  }

  move(from: string, to: string): void {
    const file = this.files.get(this.key(from));
    if (!file) throw new Error(`No ${from}`);
    this.files.delete(this.key(from));
    this.ensureParents(to);
    this.files.set(this.key(to), { path: this.stored(to), bytes: file.bytes, mtime: file.mtime });
  }

  get(path: string): Uint8Array | null {
    return this.files.get(this.key(path))?.bytes ?? null;
  }

  // ── VaultHost ─────────────────────────────────────────────────────────────
  async flush(): Promise<void> {}

  list(): LocalFile[] {
    return [...this.files.values()].map((f) => ({ path: f.path, mtime: f.mtime, size: f.bytes.length }));
  }

  stat(path: string): LocalStat | null {
    const file = this.files.get(this.key(path));
    return file ? { mtime: file.mtime, size: file.bytes.length } : null;
  }

  exists(path: string): boolean {
    return this.files.has(this.key(path)) || this.folders.has(this.key(path));
  }

  async read(path: string): Promise<Uint8Array> {
    const file = this.files.get(this.key(path));
    if (!file) throw new Error(`No such file ${path}`);
    return file.bytes.slice();
  }

  private matches(path: string, expect: LocalStat | null): boolean {
    const now = this.stat(path);
    if (expect === null) return now === null;
    return !!now && now.mtime === expect.mtime && now.size === expect.size;
  }

  async write(path: string, bytes: Uint8Array, expect: LocalStat | null): Promise<LocalStat | 'raced'> {
    this.mutate();
    this.beforeWrite?.(path);
    if (!this.matches(path, expect)) return 'raced';
    this.put(path, bytes);
    return this.stat(path)!;
  }

  async rename(from: string, to: string, expect: LocalStat): Promise<LocalStat | 'raced'> {
    this.mutate();
    if (!this.matches(from, expect) || this.exists(to)) return 'raced';
    this.move(from, to);
    return this.stat(to)!;
  }

  async trash(path: string, expect: LocalStat): Promise<'ok' | 'raced'> {
    this.mutate();
    if (!this.matches(path, expect)) return 'raced';
    const file = this.files.get(this.key(path))!;
    this.trashed.push({ path: file.path, bytes: file.bytes });
    this.files.delete(this.key(path));
    return 'ok';
  }

  async removeEmptyFolders(folders: string[]): Promise<void> {
    this.mutate();
    const all = new Set<string>();
    for (const folder of folders) for (const f of [...parentFolders(folder), folder]) all.add(f);
    for (const folder of [...all].sort((a, b) => b.length - a.length)) {
      const prefix = this.key(folder) + '/';
      const used = [...this.files.keys(), ...this.folders.keys()].some((k) => k.startsWith(prefix));
      if (!used) this.folders.delete(this.key(folder));
    }
  }
}
