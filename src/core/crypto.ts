// ── core/crypto.ts ────────────────────────────────────────────────────────
// Hashing and the optional end-to-end encryption, on WebCrypto only so it
// runs the same in Obsidian desktop, Obsidian mobile and Node.
//
// A passphrase is stretched with PBKDF2-SHA256 into a master key. HKDF then
// splits the master into an AES-GCM key for contents, an HMAC key for blob
// ids, and a short check value stored on the server, which tells a wrong
// passphrase apart without decrypting any file.
// ─────────────────────────────────────────────────────────────────────────────

import { fromBase64, toArrayBuffer, toBase64, toHex, utf8 } from './bytes';

/** Stored with a remote vault; everything a device needs to re-derive the keys. */
export interface EncryptionHeader {
  v: 1;
  kdf: 'pbkdf2-sha256';
  iterations: number;
  /** Base64 of 16 random bytes. */
  salt: string;
  /** Hex of 16 bytes derived from the master key. */
  check: string;
}

export const DEFAULT_ITERATIONS = 600_000;

const subtle = (): SubtleCrypto => globalThis.crypto.subtle;

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  return toHex(new Uint8Array(await subtle().digest('SHA-256', toArrayBuffer(bytes))));
}

/**
 * The passphrase is normalised to NFC first: a Persian passphrase typed on an
 * iPhone and on Android must stretch to the same key.
 */
export async function deriveMaster(passphrase: string, header: Pick<EncryptionHeader, 'iterations' | 'salt'>): Promise<Uint8Array> {
  const base = await subtle().importKey('raw', toArrayBuffer(utf8(passphrase.normalize('NFC'))), 'PBKDF2', false, ['deriveBits']);
  const bits = await subtle().deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: toArrayBuffer(fromBase64(header.salt)), iterations: header.iterations },
    base,
    256
  );
  return new Uint8Array(bits);
}

async function hkdfBase(master: Uint8Array): Promise<CryptoKey> {
  return subtle().importKey('raw', toArrayBuffer(master), 'HKDF', false, ['deriveKey', 'deriveBits']);
}

function hkdfParams(info: string): HkdfParams {
  return { name: 'HKDF', hash: 'SHA-256', salt: toArrayBuffer(utf8('vault-sync')), info: toArrayBuffer(utf8(info)) };
}

export async function checkValue(master: Uint8Array): Promise<string> {
  const bits = await subtle().deriveBits(hkdfParams('vault-sync/check'), await hkdfBase(master), 128);
  return toHex(new Uint8Array(bits));
}

/** A new header plus its master key, for a vault being created with encryption on. */
export async function createEncryption(
  passphrase: string,
  iterations = DEFAULT_ITERATIONS
): Promise<{ header: EncryptionHeader; master: Uint8Array }> {
  const salt = toBase64(globalThis.crypto.getRandomValues(new Uint8Array(16)));
  const master = await deriveMaster(passphrase, { iterations, salt });
  return { header: { v: 1, kdf: 'pbkdf2-sha256', iterations, salt, check: await checkValue(master) }, master };
}

/** The master key for this passphrase, or null when the passphrase is wrong. */
export async function unlock(passphrase: string, header: EncryptionHeader): Promise<Uint8Array | null> {
  const master = await deriveMaster(passphrase, header);
  return (await masterMatches(master, header)) ? master : null;
}

export async function masterMatches(master: Uint8Array, header: EncryptionHeader): Promise<boolean> {
  return (await checkValue(master)) === header.check;
}

export function isEncryptionHeader(value: unknown): value is EncryptionHeader {
  const h = value as EncryptionHeader;
  return !!h && h.v === 1 && h.kdf === 'pbkdf2-sha256' && Number.isInteger(h.iterations) && h.iterations > 0
    && typeof h.salt === 'string' && typeof h.check === 'string';
}

export interface ContentKeys {
  aes: CryptoKey;
  hmac: CryptoKey;
}

export async function contentKeys(master: Uint8Array): Promise<ContentKeys> {
  const base = await hkdfBase(master);
  const aes = await subtle().deriveKey(hkdfParams('vault-sync/aes-gcm'), base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  const hmac = await subtle().deriveKey(hkdfParams('vault-sync/hmac'), base, { name: 'HMAC', hash: 'SHA-256', length: 256 }, false, ['sign']);
  return { aes, hmac };
}

/** Separate keys for file names, so a name's id never equals any content id. */
export async function pathKeys(master: Uint8Array): Promise<ContentKeys> {
  const base = await hkdfBase(master);
  const aes = await subtle().deriveKey(hkdfParams('vault-sync/path-aes-gcm'), base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  const hmac = await subtle().deriveKey(hkdfParams('vault-sync/path-hmac'), base, { name: 'HMAC', hash: 'SHA-256', length: 256 }, false, ['sign']);
  return { aes, hmac };
}

export async function hmacHex(key: CryptoKey, bytes: Uint8Array): Promise<string> {
  return toHex(new Uint8Array(await subtle().sign('HMAC', key, toArrayBuffer(bytes))));
}

/** Random 12-byte IV, then the AES-GCM ciphertext; the blob id is bound in as associated data. */
export async function seal(key: CryptoKey, plain: Uint8Array, id: string): Promise<Uint8Array> {
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const cipher = await subtle().encrypt({ name: 'AES-GCM', iv, additionalData: toArrayBuffer(utf8(id)) }, key, toArrayBuffer(plain));
  const out = new Uint8Array(12 + cipher.byteLength);
  out.set(iv, 0);
  out.set(new Uint8Array(cipher), 12);
  return out;
}

/** Throws when the bytes were altered, belong to another id, or were sealed with another key. */
export async function open(key: CryptoKey, stored: Uint8Array, id: string): Promise<Uint8Array> {
  if (stored.length < 28) throw new Error('Encrypted blob is too short');
  const plain = await subtle().decrypt(
    { name: 'AES-GCM', iv: toArrayBuffer(stored.subarray(0, 12)), additionalData: toArrayBuffer(utf8(id)) },
    key,
    toArrayBuffer(stored.subarray(12))
  );
  return new Uint8Array(plain);
}

/** Bytes added to every file by encryption: the IV and the GCM tag. */
export const ENCRYPTION_OVERHEAD = 28;
