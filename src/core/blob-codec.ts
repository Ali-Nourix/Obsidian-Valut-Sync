// ── core/blob-codec.ts ────────────────────────────────────────────────────
// How file contents become stored blobs and back. Blobs are addressed by
// their content: the id is SHA-256 of the plain bytes, or, in an encrypted
// vault, an HMAC under the vault key, so the server can still store equal
// files once without being able to confirm a guess about their contents.
// Every download is checked against its id before it reaches the vault.
// ─────────────────────────────────────────────────────────────────────────────

import { ContentKeys, contentKeys, ENCRYPTION_OVERHEAD, hmacHex, open, seal, sha256Hex } from './crypto';

export class BlobIntegrityError extends Error {
  constructor(public readonly id: string) {
    super(`Downloaded content does not match ${id.slice(0, 12)}…`);
    this.name = 'BlobIntegrityError';
  }
}

export interface BlobCodec {
  readonly encrypted: boolean;
  /** Extra bytes a stored blob carries over the plain file. */
  readonly overhead: number;
  id(plain: Uint8Array): Promise<string>;
  seal(plain: Uint8Array, id: string): Promise<Uint8Array>;
  /** Restores the plain bytes and verifies them against `id`; throws BlobIntegrityError otherwise. */
  open(stored: Uint8Array, id: string): Promise<Uint8Array>;
}

export class PlainCodec implements BlobCodec {
  readonly encrypted = false;
  readonly overhead = 0;

  id(plain: Uint8Array): Promise<string> {
    return sha256Hex(plain);
  }

  async seal(plain: Uint8Array): Promise<Uint8Array> {
    return plain;
  }

  async open(stored: Uint8Array, id: string): Promise<Uint8Array> {
    if ((await sha256Hex(stored)) !== id) throw new BlobIntegrityError(id);
    return stored;
  }
}

export class EncryptedCodec implements BlobCodec {
  readonly encrypted = true;
  readonly overhead = ENCRYPTION_OVERHEAD;

  private constructor(private readonly keys: ContentKeys) {}

  static async fromMaster(master: Uint8Array): Promise<EncryptedCodec> {
    return new EncryptedCodec(await contentKeys(master));
  }

  id(plain: Uint8Array): Promise<string> {
    return hmacHex(this.keys.hmac, plain);
  }

  seal(plain: Uint8Array, id: string): Promise<Uint8Array> {
    return seal(this.keys.aes, plain, id);
  }

  async open(stored: Uint8Array, id: string): Promise<Uint8Array> {
    let plain: Uint8Array;
    try {
      plain = await open(this.keys.aes, stored, id);
    } catch {
      throw new BlobIntegrityError(id);
    }
    if ((await this.id(plain)) !== id) throw new BlobIntegrityError(id);
    return plain;
  }
}
