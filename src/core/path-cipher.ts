// ── core/path-cipher.ts ───────────────────────────────────────────────────
// File names in an encrypted vault. The server's index sees a keyed id per
// path (an HMAC of the NFC name, stable so compare-and-set still works) and
// the name itself sealed with AES-GCM, bound to that id. Without the
// passphrase the index reveals how many files there are and their sizes,
// but not what they are called.
// ─────────────────────────────────────────────────────────────────────────────

import { decodeUtf8, fromBase64, toBase64, utf8 } from './bytes';
import { ContentKeys, hmacHex, open, pathKeys, seal } from './crypto';

export class PathIntegrityError extends Error {
  constructor(id: string) {
    super(`An encrypted file name does not match its id ${id.slice(0, 12)}…`);
    this.name = 'PathIntegrityError';
  }
}

export class PathCipher {
  private readonly ids = new Map<string, string>();

  private constructor(private readonly keys: ContentKeys) {}

  static async fromMaster(master: Uint8Array): Promise<PathCipher> {
    return new PathCipher(await pathKeys(master));
  }

  async id(path: string): Promise<string> {
    const name = path.normalize('NFC');
    let id = this.ids.get(name);
    if (!id) {
      id = await hmacHex(this.keys.hmac, utf8(name));
      this.ids.set(name, id);
    }
    return id;
  }

  async seal(path: string, id: string): Promise<string> {
    return toBase64(await seal(this.keys.aes, utf8(path.normalize('NFC')), id));
  }

  /** The path behind a sealed name, checked against its id. */
  async open(sealed: string, id: string): Promise<string> {
    let path: string | null;
    try {
      path = decodeUtf8(await open(this.keys.aes, fromBase64(sealed), id));
    } catch {
      throw new PathIntegrityError(id);
    }
    if (path === null || (await this.id(path)) !== id) throw new PathIntegrityError(id);
    return path;
  }
}
