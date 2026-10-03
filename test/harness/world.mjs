/**
 * Builds simulated devices that share one in-memory server, each with its
 * own vault, state file and sync engine, plus helpers to sync them until
 * nothing changes and to compare their vaults.
 */
import { loadTs } from './load.mjs';

export const lib = await loadTs(`
  export { SyncEngine } from "./src/core/engine";
  export { MemoryBackend } from "./src/backend/memory-backend";
  export { BackendError } from "./src/backend/remote-backend";
  export { MemoryVaultHost, Clock, CrashError } from "./test/harness/memory-vault-host";
  export { PlainCodec, EncryptedCodec } from "./src/core/blob-codec";
  export { createEncryption } from "./src/core/crypto";
  export { utf8, decodeUtf8 } from "./src/core/bytes";
  export { DEFAULT_SYNC_OPTIONS } from "./src/core/model";
  export { nfc, isConflictCopy } from "./src/core/paths";
  export { SyncLog } from "./src/core/sync-log";
`);

const { SyncEngine, MemoryBackend, MemoryVaultHost, Clock, PlainCodec, EncryptedCodec, createEncryption, utf8, decodeUtf8, DEFAULT_SYNC_OPTIONS, nfc, SyncLog } = lib;

export class MemoryStore {
  saved = null;
  frozen = false;
  saves = 0;
  async load() {
    return this.saved ? JSON.parse(this.saved) : null;
  }
  async save(state) {
    if (this.frozen) return;
    this.saves++;
    this.saved = JSON.stringify(state);
  }
  async clear() {
    this.saved = null;
  }
}

export async function makeWorld({ encrypted = false } = {}) {
  const clock = new Clock();
  const backend = new MemoryBackend();
  let codec = new PlainCodec();
  let header = null;
  if (encrypted) {
    const made = await createEncryption('correct horse', 1000);
    header = made.header;
    codec = await EncryptedCodec.fromMaster(made.master);
  }
  const vault = await backend.createVault('Main', header);
  return { clock, backend, codec, vaultId: vault.id };
}

export function device(world, name, { ci = false, nfd = false, userId = 'user-1' } = {}) {
  const host = new MemoryVaultHost(world.clock, ci, nfd);
  const store = new MemoryStore();
  const dev = {
    name,
    host,
    store,
    log: new SyncLog(1000, world.clock.now),
    options: { ...DEFAULT_SYNC_OPTIONS },
    engine: null,
  };
  dev.restart = () => {
    dev.engine = new SyncEngine({
      backend: world.backend,
      host,
      codec: world.codec,
      store,
      vaultId: world.vaultId,
      userId,
      deviceId: name,
      nonce: `${name}-nonce`,
      now: world.clock.now,
      log: dev.log,
      concurrency: 2,
      options: () => dev.options,
    });
  };
  dev.restart();
  dev.sync = async () => {
    world.clock.tick(10);
    return dev.engine.sync();
  };
  dev.write = (path, text) => host.put(path, utf8(text));
  dev.writeBytes = (path, bytes) => host.put(path, bytes);
  dev.read = (path) => {
    const bytes = host.get(path);
    return bytes ? decodeUtf8(bytes) : null;
  };
  dev.del = (path) => {
    host.remove(path);
    dev.engine.noteLocalDelete(path);
  };
  dev.mv = (from, to) => {
    host.move(from, to);
    dev.engine.noteLocalDelete(from);
  };
  return dev;
}

const changed = (r) => r.uploaded || r.downloaded || r.deletedLocal || r.deletedRemote || r.renamed || r.merged.length || r.conflicts.length;

/** Syncs every device in turn until a whole round changes nothing. Returns the reports. */
export async function settle(devices, maxRounds = 8) {
  const reports = [];
  for (let round = 0; round < maxRounds; round++) {
    let any = false;
    for (const dev of devices) {
      const report = await dev.sync();
      reports.push({ device: dev.name, ...report });
      if (report.status === 'error') throw report.error;
      if (changed(report)) any = true;
    }
    if (!any) return reports;
  }
  throw new Error('Devices did not settle');
}

/** A device's vault as { nfcPath: text }, sorted. */
export function snapshot(dev) {
  const out = {};
  for (const file of [...dev.host.list()].sort((a, b) => nfc(a.path).localeCompare(nfc(b.path)))) {
    const bytes = dev.host.get(file.path);
    out[nfc(file.path)] = decodeUtf8(bytes) ?? `<${bytes.length} bytes>`;
  }
  return out;
}

export function assertConverged(world, devices, eq, label) {
  const first = snapshot(devices[0]);
  for (const dev of devices.slice(1)) eq(snapshot(dev), first, `${label}: ${dev.name} matches ${devices[0].name}`);
  eq(
    world.backend.liveRows(world.vaultId).map((r) => r.path).sort(),
    Object.keys(first).sort(),
    `${label}: server holds the same files`
  );
  return first;
}
