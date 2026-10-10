// ── main.ts ───────────────────────────────────────────────────────────────
// Vault Sync: keeps this vault in sync with the same vault on other devices
// through the user's own Supabase project. This file only wires things
// together: the connection and session, the engine for the chosen remote
// vault, the scheduler that decides when to run it, vault and app events,
// the status bar, commands and settings. The sync logic is in src/core.
// ─────────────────────────────────────────────────────────────────────────────

import { deliverSetupReturn } from './src/onboarding/return-channel';
import { validateSetupResult, SetupResult } from './src/onboarding/client';
import { Notice, Platform, Plugin, setIcon, TAbstractFile, TFile, TFolder } from 'obsidian';
import { EncryptedPathBackend } from './src/backend/encrypted-paths';
import { BackendError, RemoteBackend, RemoteVault } from './src/backend/remote-backend';
import { SupabaseBackend } from './src/backend/supabase-backend';
import { isProjectUrl, keyProblem, normalizeProjectUrl, SupabaseConnection } from './src/backend/supabase-client';
import { BlobCodec, EncryptedCodec, PlainCodec } from './src/core/blob-codec';
import { createEncryption, masterMatches, unlock } from './src/core/crypto';
import { CycleReport, SyncEngine } from './src/core/engine';
import { SyncOptions } from './src/core/model';
import { PathCipher } from './src/core/path-cipher';
import { isConflictCopy } from './src/core/paths';
import { DEFAULT_SCHEDULER_OPTIONS, RunResult, SyncScheduler } from './src/core/scheduler';
import { LogEntry, SyncLog } from './src/core/sync-log';
import { getLabels, Labels, timeAgo } from './src/localization/labels';
import { DeviceStore } from './src/obsidian/device-store';
import { AdapterBaseStore } from './src/obsidian/base-store';
import { AdapterStateStore, JsonFile } from './src/obsidian/state-store';
import { ObsidianVaultHost, probeCaseInsensitive } from './src/obsidian/vault-host';
import { DEFAULT_SETTINGS, VaultSyncSettings } from './src/types';
import { ConfirmModal, ConflictListModal, MassDeleteModal, PassphraseModal, SyncLogModal } from './src/ui/modals';
import { VaultSyncSettingTab } from './src/ui/settings-tab';

/** How far along the setup this device is. */
export type Phase = 'unconfigured' | 'signed-out' | 'no-vault' | 'locked' | 'ready';
type Activity = 'idle' | 'syncing' | 'offline' | 'error' | 'waiting';

export default class VaultSyncPlugin extends Plugin {
  settings: VaultSyncSettings = { ...DEFAULT_SETTINGS };
  phase: Phase = 'unconfigured';
  lastError: string | null = null;
  accountEmail: string | null = null;

  private device!: DeviceStore;
  private readonly log = new SyncLog();
  private logFile!: JsonFile<LogEntry[]>;
  private logTimer: number | null = null;
  private activity: Activity = 'idle';
  /** Files this device asked its other devices for in the last sync. */
  private waitingFiles = 0;
  private connection: SupabaseConnection | null = null;
  private backend: SupabaseBackend | null = null;
  private userId: string | null = null;
  private engine: SyncEngine | null = null;
  private scheduler: SyncScheduler | null = null;
  private unsubscribe: (() => void) | null = null;
  private realtimeUp = false;
  /** A key unlocked for this session only ("remember" was off). */
  private sessionMaster: Uint8Array | null = null;
  private statusEl!: HTMLElement;
  private ribbonEl!: HTMLElement;
  private deleteModalOpen = false;
  private lastNotice = '';
  private notifiedSkips = new Set<string>();
  /** Bumped by every reconnect, so a slower earlier one cannot win. */
  private generation = 0;

  get labels(): Labels {
    return getLabels(this.settings.language);
  }

  get lastSyncAt(): number | null {
    return this.device.lastSyncAt();
  }

  get deviceId(): string {
    return this.device.deviceId();
  }

  private get pluginDir(): string {
    return this.manifest.dir ?? `${this.app.vault.configDir}/plugins/${this.manifest.id}`;
  }

  async onload(): Promise<void> {
    await this.loadSettings();
    this.registerObsidianProtocolHandler('vault-sync-setup', params => deliverSetupReturn(params));
    this.device = new DeviceStore(this.app);
    this.logFile = new JsonFile(this.app.vault.adapter, `${this.pluginDir}/state/log.json`);
    this.log.load((await this.logFile.load()) ?? []);
    this.log.onChange(() => this.saveLogSoon());

    this.statusEl = this.addStatusBarItem();
    this.statusEl.addClass('vault-sync-status', 'mod-clickable');
    this.statusEl.addEventListener('click', () => this.openLog());
    this.ribbonEl = this.addRibbonIcon('refresh-cw', this.labels.cmdSyncNow, () => this.syncNow());
    this.addCommands();
    this.addSettingTab(new VaultSyncSettingTab(this.app, this));
    this.registerInterval(window.setInterval(() => this.renderStatus(), 30_000));
    this.renderStatus();

    this.app.workspace.onLayoutReady(() => this.onLayoutReady());
  }

  async onunload(): Promise<void> {
    await this.teardown();
    if (this.logTimer !== null) window.clearTimeout(this.logTimer);
    await this.logFile.save(this.log.toJSON());
  }

  async loadSettings(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    if (keyProblem(this.settings.supabaseKey) === 'secret') {
      this.settings.supabaseKey = '';
      await this.saveSettings();
      new Notice(this.labels.noticeSecretKey, 10_000);
    }
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  private onLayoutReady(): void {
    // Registered only now: Obsidian fires "create" for every file while the vault loads.
    const vault = this.app.vault;
    this.registerEvent(vault.on('create', (file) => this.onLocalChange(file)));
    this.registerEvent(vault.on('modify', (file) => this.onLocalChange(file)));
    this.registerEvent(
      vault.on('delete', (file) => {
        if (file instanceof TFolder) this.engine?.noteLocalFolderDelete(file.path);
        else this.engine?.noteLocalDelete(file.path);
        this.onLocalChange(file);
      })
    );
    this.registerEvent(
      vault.on('rename', (file, oldPath) => {
        if (file instanceof TFolder) this.engine?.noteLocalFolderDelete(oldPath);
        else this.engine?.noteLocalDelete(oldPath);
        this.onLocalChange(file);
      })
    );
    this.registerDomEvent(document, 'visibilitychange', () => {
      const visible = document.visibilityState === 'visible';
      // On phones the app is frozen in the background; refresh the token only in the foreground.
      if (Platform.isMobile) this.connection?.setForeground(visible);
      if (!visible) return;
      if (this.settings.realtime && this.phase === 'ready' && !this.realtimeUp) this.subscribe();
      this.scheduler?.resumed();
    });
    this.registerDomEvent(window, 'online', () => this.scheduler?.resumed());
    void this.reconnect();
  }

  private onLocalChange(file: TAbstractFile): void {
    if (!this.engine || !this.scheduler) return;
    if (file instanceof TFile && this.engine.isOwnWrite(file.path)) return;
    this.scheduler.localChange();
  }

  // ── Connection and vault lifecycle ──────────────────────────────────────

  private setPhase(phase: Phase): void {
    this.phase = phase;
    this.renderStatus();
  }

  /** Stops syncing the current remote vault, keeping the connection. */
  private async closeVault(): Promise<void> {
    this.scheduler?.stop();
    this.engine?.stop();
    this.unsubscribe?.();
    this.scheduler = null;
    this.engine = null;
    this.unsubscribe = null;
    this.realtimeUp = false;
  }

  private async teardown(): Promise<void> {
    await this.closeVault();
    const connection = this.connection;
    this.connection = null;
    this.backend = null;
    this.userId = null;
    if (connection) await connection.close();
  }

  /** Builds everything again from the settings: connection, session, vault. */
  async reconnect(): Promise<void> {
    const generation = ++this.generation;
    await this.teardown();
    this.lastError = null;
    const url = normalizeProjectUrl(this.settings.supabaseUrl);
    const key = this.settings.supabaseKey;
    if (!url || !isProjectUrl(url) || keyProblem(key)) {
      if (keyProblem(key) === 'secret') new Notice(this.labels.noticeSecretKey, 10_000);
      this.setPhase('unconfigured');
      return;
    }
    const connection = new SupabaseConnection(url, key, this.device.authStorage());
    this.connection = connection;
    connection.client.auth.onAuthStateChange((event) => {
      if (generation !== this.generation || event !== 'SIGNED_OUT') return;
      // Outside the auth callback: supabase-js must not be re-entered from it.
      window.setTimeout(() => {
        void this.closeVault();
        this.accountEmail = null;
        this.userId = null;
        this.backend = null;
        this.setPhase('signed-out');
      }, 0);
    });
    let session = null;
    try {
      session = await connection.session();
    } catch {
      // Treated as signed out below; signing in again fixes it.
    }
    if (generation !== this.generation) return;
    if (!session) {
      this.setPhase('signed-out');
      return;
    }
    this.userId = session.user.id;
    this.accountEmail = session.user.email ?? null;
    this.backend = new SupabaseBackend(connection.client, session.user.id);
    await this.openVault(generation);
  }

  private syncOptions(): SyncOptions {
    return {
      excludedFolders: this.settings.excludedFolders,
      maxFileSize: this.settings.maxFileSizeMB * 1024 * 1024,
      massDeleteCount: this.settings.massDeleteCount,
      massDeletePercent: this.settings.massDeletePercent,
      unconfirmedDeleteMs: 60_000,
    };
  }

  private async openVault(generation = this.generation): Promise<void> {
    await this.closeVault();
    const { vaultId, vaultEncryption } = this.settings;
    if (!this.backend || !this.userId) return this.setPhase('signed-out');
    if (!vaultId) return this.setPhase('no-vault');

    let codec: BlobCodec = new PlainCodec();
    let backend: RemoteBackend = this.backend;
    if (vaultEncryption) {
      const master = this.sessionMaster ?? this.device.rememberedKey(vaultId);
      if (!master || !(await masterMatches(master, vaultEncryption))) return this.setPhase('locked');
      codec = await EncryptedCodec.fromMaster(master);
      backend = new EncryptedPathBackend(this.backend, await PathCipher.fromMaster(master));
    }
    let caseInsensitive = this.device.caseInsensitive();
    if (caseInsensitive === null) {
      caseInsensitive = await probeCaseInsensitive(this.app, this.pluginDir);
      this.device.setCaseInsensitive(caseInsensitive);
    }
    if (generation !== this.generation) return;

    this.engine = new SyncEngine({
      backend,
      host: new ObsidianVaultHost(this.app, caseInsensitive),
      codec,
      store: new AdapterStateStore(this.app.vault.adapter, this.pluginDir, vaultId),
      baseStore: new AdapterBaseStore(this.app.vault.adapter, this.pluginDir, vaultId),
      vaultId,
      userId: this.userId,
      deviceId: this.device.deviceId(),
      nonce: this.device.nonce(vaultId),
      options: () => this.syncOptions(),
      log: this.log,
      concurrency: Platform.isMobile ? 2 : 4,
    });
    this.scheduler = new SyncScheduler(
      () => this.runCycle(),
      {
        setTimeout: (fn, ms) => window.setTimeout(fn, ms),
        clearTimeout: (handle) => window.clearTimeout(handle as number),
        now: () => Date.now(),
        random: () => Math.random(),
      },
      { ...DEFAULT_SCHEDULER_OPTIONS, intervalMs: this.settings.intervalMinutes * 60_000 }
    );
    this.setPhase('ready');
    this.applySyncSettings();
  }

  /** Starts or stops automatic sync and live updates to match the settings. */
  applySyncSettings(): void {
    const scheduler = this.scheduler;
    if (!scheduler) return;
    scheduler.setOptions({ intervalMs: this.settings.intervalMinutes * 60_000 });
    if (this.settings.autoSync) scheduler.start();
    else scheduler.stop();
    if (this.settings.realtime && this.settings.autoSync) this.subscribe();
    else {
      this.unsubscribe?.();
      this.unsubscribe = null;
      this.realtimeUp = false;
    }
    this.renderStatus();
  }

  private subscribe(): void {
    this.unsubscribe?.();
    const { backend } = this;
    const vaultId = this.settings.vaultId;
    if (!backend || !vaultId) return;
    const me = this.device.deviceId();
    this.unsubscribe = backend.subscribe(
      vaultId,
      (_head, device) => {
        if (device !== me) this.scheduler?.remoteChange();
      },
      (status) => {
        this.realtimeUp = status === 'SUBSCRIBED';
      }
    );
  }

  // ── Running a sync ──────────────────────────────────────────────────────

  private async runCycle(): Promise<RunResult> {
    const engine = this.engine;
    if (!engine) return { kind: 'blocked' };
    this.activity = 'syncing';
    this.renderStatus();
    const report = await engine.sync();
    if (engine !== this.engine) return { kind: 'ok' };
    const result = await this.handleReport(report);
    this.renderStatus();
    return result;
  }

  private notifyOnce(message: string): void {
    if (message === this.lastNotice) return;
    this.lastNotice = message;
    new Notice(message, 10_000);
  }

  private async handleReport(report: CycleReport): Promise<RunResult> {
    const l = this.labels;
    if (report.status === 'error') {
      const error = report.error;
      this.lastError = error instanceof Error ? error.message : String(error);
      if (!(error instanceof BackendError)) {
        this.activity = 'error';
        return { kind: 'transient-error' };
      }
      switch (error.kind) {
        case 'network':
          this.activity = 'offline';
          return { kind: 'transient-error' };
        case 'paused':
          this.activity = 'error';
          this.notifyOnce(l.noticePaused);
          return { kind: 'transient-error' };
        case 'auth':
          this.activity = 'error';
          this.notifyOnce(l.noticeAuthExpired);
          return { kind: 'blocked' };
        case 'schema':
          this.activity = 'error';
          this.notifyOnce(l.noticeSchemaMissing);
          return { kind: 'blocked' };
        case 'vault-missing':
          this.activity = 'error';
          this.notifyOnce(l.noticeVaultMissing);
          return { kind: 'blocked' };
        case 'quota':
          this.activity = 'error';
          this.notifyOnce(l.noticeQuota);
          return { kind: 'blocked' };
        default:
          this.activity = 'error';
          return { kind: 'transient-error' };
      }
    }

    this.lastError = null;
    this.lastNotice = '';
    this.activity = report.status === 'needs-confirmation' ? 'waiting' : 'idle';
    if (report.waiting && !this.waitingFiles) new Notice(l.noticeWaitingFiles(report.waiting), 10_000);
    this.waitingFiles = report.waiting;
    this.device.setLastSyncAt(Date.now());

    if (report.conflicts.length > 0 && report.conflicts.length < 5) {
      for (const c of report.conflicts) new Notice(l.noticeConflict(c.path, c.copy), 10_000);
    } else if (report.conflicts.length >= 5) {
      new Notice(l.noticeConflicts(report.conflicts.length), 10_000);
    }
    const newSkips = report.skipped.filter((p) => !this.notifiedSkips.has(p));
    if (newSkips.length) {
      newSkips.forEach((p) => this.notifiedSkips.add(p));
      new Notice(l.noticeSkipped(newSkips.length));
    }
    if (report.status === 'needs-confirmation' && report.confirmation) this.askAboutDeletes();
    return { kind: 'ok', followUpMs: report.followUpMs };
  }

  private askAboutDeletes(): void {
    const engine = this.engine;
    const pending = engine?.pendingDeletes;
    if (!engine || !pending || this.deleteModalOpen) return;
    this.deleteModalOpen = true;
    new MassDeleteModal(this.app, this.labels, pending, (choice) => {
      this.deleteModalOpen = false;
      if (engine !== this.engine || !choice) return;
      if (choice === 'pause') {
        this.settings.autoSync = false;
        void this.saveSettings().then(() => this.applySyncSettings());
        return;
      }
      this.activity = 'syncing';
      this.renderStatus();
      const run = choice === 'delete' ? engine.approveDeletes() : engine.keepDeletes();
      void run.then((report) => this.handleReport(report)).then(() => this.renderStatus());
    }).open();
  }

  syncNow(): void {
    if (this.phase === 'locked') return this.openUnlock();
    if (this.phase !== 'ready' || !this.engine) {
      new Notice(this.labels.noticeNotReady);
      return;
    }
    if (this.settings.autoSync && this.scheduler) this.scheduler.runNow();
    else void this.runCycle();
  }

  // ── Account and vault actions (used by the settings tab) ────────────────

  /** Only public configuration is persisted; password is used for a local sign-in. */
  async applySetupResult(value: SetupResult, password: string): Promise<void> {
    const result = validateSetupResult(value);
    await this.closeVault();
    this.sessionMaster = null;
    this.settings.supabaseUrl = result.projectUrl;
    this.settings.supabaseKey = result.publishableKey;
    this.settings.email = result.email;
    this.settings.vaultId = null;
    this.settings.vaultName = '';
    this.settings.vaultEncryption = null;
    await this.saveSettings();
    await this.reconnect();
    await this.signIn(result.email, password);
  }

  async testConnection(): Promise<void> {
    await this.reconnect();
    if (!this.connection) throw new Error(this.labels.noticeNotReady);
    await new SupabaseBackend(this.connection.client, this.userId ?? '').checkSchema();
    new Notice(this.labels.noticeConnectionOk);
  }

  async signIn(email: string, password: string): Promise<void> {
    if (!this.connection) await this.reconnect();
    if (!this.connection) throw new Error(this.labels.noticeNotReady);
    await this.connection.signIn(email, password);
    this.settings.email = email.trim();
    await this.saveSettings();
    await this.reconnect();
    new Notice(this.labels.noticeSignedIn(this.accountEmail ?? email));
  }

  async signUp(email: string, password: string): Promise<void> {
    if (!this.connection) await this.reconnect();
    if (!this.connection) throw new Error(this.labels.noticeNotReady);
    const session = await this.connection.signUp(email, password);
    this.settings.email = email.trim();
    await this.saveSettings();
    if (!session) {
      new Notice(this.labels.noticeCheckEmail, 15_000);
      return;
    }
    await this.reconnect();
    new Notice(this.labels.noticeSignedIn(this.accountEmail ?? email));
  }

  async signOut(): Promise<void> {
    await this.closeVault();
    await this.connection?.signOut();
    this.accountEmail = null;
    this.setPhase('signed-out');
    new Notice(this.labels.noticeSignedOut);
  }

  async listVaults(): Promise<RemoteVault[]> {
    return this.backend ? this.backend.listVaults() : [];
  }

  async chooseVault(vault: RemoteVault | null): Promise<void> {
    this.settings.vaultId = vault?.id ?? null;
    this.settings.vaultName = vault?.name ?? '';
    this.settings.vaultEncryption = vault?.encryption ?? null;
    this.sessionMaster = null;
    await this.saveSettings();
    await this.openVault();
  }

  async createVault(name: string, passphrase: string | null, remember: boolean): Promise<void> {
    if (!this.backend) throw new Error(this.labels.noticeNotReady);
    let header = null;
    let master: Uint8Array | null = null;
    if (passphrase) {
      new Notice(this.labels.noticeDeriving);
      ({ header, master } = await createEncryption(passphrase));
    }
    const vault = await this.backend.createVault(name, header);
    if (master && remember) this.device.rememberKey(vault.id, master);
    await this.chooseVault(vault);
    if (master && !remember) {
      this.sessionMaster = master;
      await this.openVault();
    }
    new Notice(this.labels.noticeVaultCreated(name));
  }

  async unlockVault(passphrase: string, remember: boolean): Promise<boolean> {
    const { vaultId, vaultEncryption } = this.settings;
    if (!vaultId || !vaultEncryption) return true;
    new Notice(this.labels.noticeDeriving);
    const master = await unlock(passphrase, vaultEncryption);
    if (!master) {
      new Notice(this.labels.noticeWrongPassphrase);
      return false;
    }
    if (remember) this.device.rememberKey(vaultId, master);
    else this.sessionMaster = master;
    await this.openVault();
    new Notice(this.labels.noticeUnlocked);
    return true;
  }

  async forgetKey(): Promise<void> {
    if (this.settings.vaultId) this.device.rememberKey(this.settings.vaultId, null);
    this.sessionMaster = null;
    await this.openVault();
  }

  async resetState(): Promise<void> {
    const vaultId = this.settings.vaultId;
    if (!this.engine || !vaultId) return;
    await this.engine.reset();
    this.device.renewNonce(vaultId);
    this.notifiedSkips.clear();
    await this.openVault();
    new Notice(this.labels.noticeStateReset);
  }

  openLog(): void {
    new SyncLogModal(this.app, this.labels, () => this.log.list()).open();
  }

  private openUnlock(): void {
    new PassphraseModal(this.app, this.labels, this.settings.vaultName, (passphrase, remember) => this.unlockVault(passphrase, remember)).open();
  }

  // ── Commands and status ─────────────────────────────────────────────────

  private addCommands(): void {
    const l = this.labels;
    this.addCommand({ id: 'sync-now', name: l.cmdSyncNow, callback: () => this.syncNow() });
    this.addCommand({
      id: 'toggle-auto-sync',
      name: l.cmdTogglePause,
      callback: async () => {
        this.settings.autoSync = !this.settings.autoSync;
        await this.saveSettings();
        this.applySyncSettings();
      },
    });
    this.addCommand({ id: 'open-sync-log', name: l.cmdOpenLog, callback: () => this.openLog() });
    this.addCommand({
      id: 'unlock-vault',
      name: l.cmdUnlock,
      checkCallback: (checking) => {
        if (this.phase !== 'locked') return false;
        if (!checking) this.openUnlock();
        return true;
      },
    });
    this.addCommand({
      id: 'show-conflicts',
      name: l.cmdConflicts,
      callback: () => {
        const files = this.app.vault.getFiles().filter((f) => isConflictCopy(f.path));
        if (!files.length) new Notice(this.labels.conflictsEmpty);
        else new ConflictListModal(this.app, this.labels, files).open();
      },
    });
    this.addCommand({
      id: 'reset-sync-state',
      name: l.cmdReset,
      checkCallback: (checking) => {
        if (!this.engine) return false;
        if (!checking) {
          const t = this.labels;
          new ConfirmModal(this.app, t, t.resetTitle, t.resetBody, t.btnConfirm, () => void this.resetState()).open();
        }
        return true;
      },
    });
    this.addCommand({
      id: 'sign-out',
      name: l.cmdSignOut,
      checkCallback: (checking) => {
        if (!this.accountEmail) return false;
        if (!checking) void this.signOut();
        return true;
      },
    });
  }

  renderStatus(): void {
    if (!this.statusEl) return;
    const l = this.labels;
    let icon = 'check';
    let text: string;
    switch (this.phase) {
      case 'unconfigured':
        icon = 'settings';
        text = l.statusNotConfigured;
        break;
      case 'signed-out':
        icon = 'log-in';
        text = l.statusSignedOut;
        break;
      case 'no-vault':
        icon = 'cloud';
        text = l.statusNoVault;
        break;
      case 'locked':
        icon = 'lock';
        text = l.statusLocked;
        break;
      default:
        if (this.activity === 'syncing') {
          icon = 'refresh-cw';
          text = l.statusSyncing;
        } else if (this.activity === 'offline') {
          icon = 'cloud-off';
          text = l.statusOffline;
        } else if (this.activity === 'error') {
          icon = 'alert-triangle';
          text = l.statusError;
        } else if (this.activity === 'waiting') {
          icon = 'alert-circle';
          text = l.statusWaiting;
        } else if (!this.settings.autoSync) {
          icon = 'pause';
          text = l.statusPaused;
        } else {
          if (this.waitingFiles) {
            icon = 'hourglass';
            text = l.statusWaitingFiles(this.waitingFiles);
          } else {
            const last = this.lastSyncAt;
            text = last ? l.statusSynced(timeAgo(l, last, Date.now())) : l.statusNeverSynced;
          }
        }
    }
    this.statusEl.empty();
    const iconEl = this.statusEl.createSpan({ cls: `vault-sync-status__icon${this.activity === 'syncing' && this.phase === 'ready' ? ' is-spinning' : ''}` });
    setIcon(iconEl, icon);
    this.statusEl.createSpan({ text });
    this.statusEl.setAttr('aria-label', this.lastError ? `${text}\n${this.lastError}` : text);
    // Phones have no status bar: the ribbon icon carries the state there.
    if (Platform.isMobile && this.ribbonEl) setIcon(this.ribbonEl, icon);
    this.ribbonEl?.setAttr('aria-label', `${l.cmdSyncNow} — ${text}`);
  }

  /**
   * The log is a diagnostic aid, not data: it is written at most every five
   * minutes (and when the plugin unloads), not after every entry, so it does
   * not keep touching a file inside the vault.
   */
  private saveLogSoon(): void {
    if (this.logTimer !== null) return;
    this.logTimer = window.setTimeout(() => {
      this.logTimer = null;
      void this.logFile.save(this.log.toJSON());
    }, 5 * 60_000);
  }
}
