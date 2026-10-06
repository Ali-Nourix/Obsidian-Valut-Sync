/**
 * Hashing and end-to-end encryption on WebCrypto: key derivation, wrong
 * passphrases, tampering, and blob ids that do not reveal the plain hash.
 */
import { loadTs, checker } from './harness/load.mjs';

const mod = await loadTs(`
  export * from "./src/core/crypto";
  export * from "./src/core/blob-codec";
  export * from "./src/core/bytes";
`);
const { sha256Hex, createEncryption, unlock, masterMatches, isEncryptionHeader, PlainCodec, EncryptedCodec, BlobIntegrityError, utf8, decodeUtf8, toBase64, fromBase64 } = mod;
const { eq, count } = checker();

const rejects = async (promise, label) => {
  try {
    await promise;
  } catch (error) {
    eq(error instanceof BlobIntegrityError, true, label);
    return;
  }
  throw new Error(`${label}: did not throw`);
};

eq(await sha256Hex(utf8('')), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855', 'sha256 of empty');
eq(await sha256Hex(utf8('abc')), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad', 'sha256 of abc');
eq(decodeUtf8(new Uint8Array([0xef, 0xbb, 0xbf, 0x61])), '﻿a', 'BOM kept as a character');
eq(decodeUtf8(new Uint8Array([0xff, 0xfe])), null, 'invalid UTF-8 is not text');
eq(Array.from(fromBase64(toBase64(new Uint8Array([0, 1, 254, 255])))), [0, 1, 254, 255], 'base64 round trip');

// ── plain codec ─────────────────────────────────────────────────────────────
const plain = new PlainCodec();
const note = utf8('# سلام\nیادداشت');
const plainId = await plain.id(note);
eq(plainId, await sha256Hex(note), 'plain id is SHA-256');
eq(decodeUtf8(await plain.open(await plain.seal(note, plainId), plainId)), '# سلام\nیادداشت', 'plain round trip');
await rejects(plain.open(utf8('other'), plainId), 'plain download that does not match its id is refused');

// ── encryption ──────────────────────────────────────────────────────────────
// Low iteration counts keep the test fast; the plugin uses 600 000.
const decomposed = 'رمزآ';
const { header, master } = await createEncryption(decomposed, 1000);
eq(isEncryptionHeader(header), true, 'header shape');
eq(header.iterations, 1000, 'iterations recorded');
eq((await unlock('رمزآ', header)) !== null, true, 'NFC and NFD spellings of a passphrase unlock the same vault');
eq(await unlock('wrong', header), null, 'wrong passphrase is refused by the check value');
eq(await masterMatches(master, header), true, 'remembered master still matches');

const codec = await EncryptedCodec.fromMaster(master);
const id = await codec.id(note);
eq(id === plainId, false, 'encrypted id is not the plain SHA-256');
eq(/^[0-9a-f]{64}$/.test(id), true, 'encrypted id is 64 hex');
eq(await codec.id(note), id, 'encrypted id is stable');
const sealed = await codec.seal(note, id);
eq(sealed.length, note.length + 28, 'IV and tag add 28 bytes');
eq(new TextDecoder().decode(sealed).includes('سلام'), false, 'ciphertext holds no plain text');
eq(decodeUtf8(await codec.open(sealed, id)), '# سلام\nیادداشت', 'encrypted round trip');
const sealedAgain = await codec.seal(note, id);
eq(toBase64(sealedAgain) === toBase64(sealed), false, 'a fresh IV each time');

const tampered = sealed.slice();
tampered[20] ^= 1;
await rejects(codec.open(tampered, id), 'a flipped bit is detected');
const otherId = await codec.id(utf8('other'));
await rejects(codec.open(sealed, otherId), 'a blob cannot be passed off under another id');
const stranger = await EncryptedCodec.fromMaster((await createEncryption('another', 1000)).master);
await rejects(stranger.open(sealed, id), 'another vault key cannot open it');

const empty = new Uint8Array(0);
const emptyId = await codec.id(empty);
eq((await codec.open(await codec.seal(empty, emptyId), emptyId)).length, 0, 'empty file round trip');

console.log(`CRYPTO_OK (${count()} checks)`);
