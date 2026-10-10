// ── ui/settings-tab.ts ────────────────────────────────────────────────────
// Settings, in the order a new user goes through them: the Supabase project,
// the account, the remote vault, then how and what to sync, safety limits
// and the current status. Persian switches the whole page to right-to-left.
// ─────────────────────────────────────────────────────────────────────────────

import { App, Notice, PluginSettingTab, Setting, setIcon } from 'obsidian';
import type VaultSyncPlugin from '../../main';
import { RemoteVault } from '../backend/remote-backend';
import { keyProblem } from '../backend/supabase-client';
import { SupabaseSetupModal } from './setup-modal';
import { normalizeFolder } from '../core/paths';
import { timeAgo } from '../localization/labels';
import { Language } from '../types';
import { ConfirmModal, CreateVaultModal, PassphraseModal } from './modals';

const INTERVALS = [0, 1, 2, 5, 10, 30, 60];

export class VaultSyncSettingTab extends PluginSettingTab {
  private email = '';
  private password = '';
  private vaults: RemoteVault[] | null = null;
  private reconnectTimer: number | null = null;

  constructor(
    app: App,
    private readonly plugin: VaultSyncPlugin
  ) {
    super(app, plugin);
  }

  private section(container: HTMLElement, icon: string, title: string, description?: string): void {
    const header = container.createDiv({ cls: 'vault-sync-section' });
    const iconEl = header.createSpan({ cls: 'vault-sync-section__icon' });
    iconEl.setAttribute('aria-hidden', 'true');
    setIcon(iconEl, icon);
    header.createEl('h3', { text: title });
    if (description) container.createEl('p', { cls: 'setting-item-description vault-sync-section__desc', text: description });
  }

  /** Reconnects a moment after the user stops typing in the URL or key fields. */
  private reconnectSoon(): void {
    if (this.reconnectTimer !== null) window.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = window.setTimeout(async () => {
      this.reconnectTimer = null;
      await this.plugin.reconnect();
      this.vaults = null;
      this.display();
    }, 1200);
  }

  private async run(action: () => Promise<void>): Promise<void> {
    try {
      await action();
    } catch (error) {
      new Notice(error instanceof Error ? error.message : String(error));
    }
    this.display();
  }

  display(): void {
    const { containerEl, plugin } = this;
    const l = plugin.labels;
    const settings = plugin.settings;
    containerEl.empty();
    containerEl.addClass('vault-sync-settings');
    containerEl.setAttr('dir', l.dir);
    if (!this.email) this.email = settings.email;

    new Setting(containerEl).setName(l.setLanguage).addDropdown((dropdown) =>
      dropdown
        .addOptions({ en: 'English', fa: 'فارسی' })
        .setValue(settings.language)
        .onChange(async (value) => {
          settings.language = value as Language;
          await plugin.saveSettings();
          plugin.renderStatus();
          this.display();
        })
    );

    const fa = settings.language === 'fa';
    // Setup runs on-device; no installer URL, OAuth app or maintainer server.
    new Setting(containerEl).setName(fa ? 'نصب مستقیم با توکن محدود خودتان' : 'Direct setup with your scoped token')
      .setDesc(fa ? 'بدون سرور واسط. توکن فقط در پنجرهٔ نصب استفاده می‌شود؛ بعداً آن را لغو کنید.' : 'No intermediary server. Your token is used only in the setup window; revoke it afterwards.')
      .addButton(button => button.setButtonText(fa ? 'راه‌اندازی خودکار Supabase' : 'Set up Supabase automatically').setCta()
        .onClick(() => new SupabaseSetupModal(this.app, plugin, () => { this.vaults = null; this.display(); }).open()));

    // ── Supabase project ────────────────────────────────────────────────────
    this.section(containerEl, 'database', l.secConnection, l.secConnectionDesc);
    new Setting(containerEl).setName(l.setUrl).setDesc(l.setUrlDesc).addText((text) =>
      text
        .setPlaceholder('https://….supabase.co')
        .setValue(settings.supabaseUrl)
        .onChange(async (value) => {
          settings.supabaseUrl = value.trim();
          await plugin.saveSettings();
          this.reconnectSoon();
        })
    );
    new Setting(containerEl).setName(l.setKey).setDesc(l.setKeyDesc).addText((text) => {
      text.inputEl.type = 'password';
      text.setValue(settings.supabaseKey).onChange(async (value) => {
        if (keyProblem(value) === 'secret') {
          text.setValue(settings.supabaseKey);
          new Notice(l.noticeSecretKey, 10_000);
          return;
        }
        settings.supabaseKey = value.trim();
        await plugin.saveSettings();
        this.reconnectSoon();
      });
    });
    new Setting(containerEl).addButton((button) => button.setButtonText(l.setTest).onClick(() => this.run(() => plugin.testConnection())));

    if (plugin.phase === 'unconfigured') return;

    // ── Account ─────────────────────────────────────────────────────────────
    this.section(containerEl, 'user', l.secAccount, l.secAccountDesc);
    if (plugin.phase === 'signed-out') {
      new Setting(containerEl).setName(l.setEmail).addText((text) =>
        text.setValue(this.email).onChange((value) => (this.email = value.trim()))
      );
      new Setting(containerEl).setName(l.setPassword).addText((text) => {
        text.inputEl.type = 'password';
        text.onChange((value) => (this.password = value));
      });
      new Setting(containerEl)
        .addButton((button) => button.setButtonText(l.btnSignUp).onClick(() => this.run(() => plugin.signUp(this.email, this.password))))
        .addButton((button) =>
          button
            .setButtonText(l.btnSignIn)
            .setCta()
            .onClick(() =>
              this.run(async () => {
                await plugin.signIn(this.email, this.password);
                this.password = '';
              })
            )
        );
      return;
    }
    new Setting(containerEl)
      .setName(l.signedInAs(plugin.accountEmail ?? ''))
      .addButton((button) => button.setButtonText(l.btnSignOut).onClick(() => this.run(() => plugin.signOut())));

    // ── Remote vault ────────────────────────────────────────────────────────
    this.section(containerEl, 'cloud', l.secVault, l.secVaultDesc);
    if (this.vaults === null) {
      this.vaults = [];
      plugin
        .listVaults()
        .then((vaults) => {
          this.vaults = vaults;
          this.display();
        })
        .catch((error) => new Notice(error instanceof Error ? error.message : String(error)));
    }
    const vaults = this.vaults;
    new Setting(containerEl)
      .setName(l.setVault)
      .setDesc(settings.vaultId ? (settings.vaultEncryption ? l.vaultEncrypted : l.vaultPlain) : l.firstSyncHint)
      .addDropdown((dropdown) => {
        dropdown.addOption('', l.noVaultChosen);
        for (const vault of vaults) dropdown.addOption(vault.id, vault.name + (vault.encryption ? ' 🔒' : ''));
        if (settings.vaultId && !vaults.some((v) => v.id === settings.vaultId)) dropdown.addOption(settings.vaultId, settings.vaultName);
        dropdown.setValue(settings.vaultId ?? '').onChange((id) =>
          this.run(async () => {
            const vault = vaults.find((v) => v.id === id) ?? null;
            await plugin.chooseVault(vault);
            if (vault?.encryption) this.openUnlock();
          })
        );
      })
      .addExtraButton((button) =>
        button
          .setIcon('refresh-cw')
          .setTooltip(l.btnRefresh)
          .onClick(() => {
            this.vaults = null;
            this.display();
          })
      )
      .addButton((button) =>
        button.setButtonText(l.btnCreateVault).onClick(() =>
          new CreateVaultModal(this.app, l, async (input) => {
            await plugin.createVault(input.name, input.passphrase, input.remember);
            this.vaults = null;
            this.display();
          }).open()
        )
      );
    if (settings.vaultId && settings.vaultEncryption) {
      const setting = new Setting(containerEl).setName(l.vaultEncrypted);
      if (plugin.phase === 'locked') setting.addButton((button) => button.setButtonText(l.btnUnlock).setCta().onClick(() => this.openUnlock()));
      else setting.addButton((button) => button.setButtonText(l.btnForgetKey).onClick(() => this.run(() => plugin.forgetKey())));
    }

    // ── Syncing ─────────────────────────────────────────────────────────────
    this.section(containerEl, 'refresh-cw', l.secSync);
    new Setting(containerEl).setName(l.setAutoSync).setDesc(l.setAutoSyncDesc).addToggle((toggle) =>
      toggle.setValue(settings.autoSync).onChange(async (value) => {
        settings.autoSync = value;
        await plugin.saveSettings();
        plugin.applySyncSettings();
      })
    );
    new Setting(containerEl).setName(l.setInterval).setDesc(l.setIntervalDesc).addDropdown((dropdown) => {
      for (const minutes of INTERVALS) dropdown.addOption(String(minutes), minutes ? l.intervalMinutes(minutes) : l.intervalOff);
      dropdown.setValue(String(settings.intervalMinutes)).onChange(async (value) => {
        settings.intervalMinutes = Number(value);
        await plugin.saveSettings();
        plugin.applySyncSettings();
      });
    });
    new Setting(containerEl).setName(l.setRealtime).setDesc(l.setRealtimeDesc).addToggle((toggle) =>
      toggle.setValue(settings.realtime).onChange(async (value) => {
        settings.realtime = value;
        await plugin.saveSettings();
        plugin.applySyncSettings();
      })
    );

    // ── What to sync ────────────────────────────────────────────────────────
    this.section(containerEl, 'folder-tree', l.secScope);
    new Setting(containerEl).setName(l.setExcluded).setDesc(l.setExcludedDesc).addTextArea((area) => {
      area.inputEl.rows = 4;
      area.setValue(settings.excludedFolders.join('\n')).onChange(async (value) => {
        settings.excludedFolders = value.split('\n').map(normalizeFolder).filter(Boolean);
        await plugin.saveSettings();
      });
    });
    new Setting(containerEl).setName(l.setMaxSize).setDesc(l.setMaxSizeDesc).addText((text) => {
      text.inputEl.type = 'number';
      text.setValue(String(settings.maxFileSizeMB)).onChange(async (value) => {
        const mb = Number(value);
        if (Number.isFinite(mb) && mb > 0) {
          settings.maxFileSizeMB = mb;
          await plugin.saveSettings();
        }
      });
    });

    // ── Safety ──────────────────────────────────────────────────────────────
    this.section(containerEl, 'shield', l.secSafety);
    new Setting(containerEl).setName(l.setMassCount).setDesc(l.setMassCountDesc).addText((text) => {
      text.inputEl.type = 'number';
      text.setValue(String(settings.massDeleteCount)).onChange(async (value) => {
        const n = Math.floor(Number(value));
        if (n >= 1) {
          settings.massDeleteCount = n;
          await plugin.saveSettings();
        }
      });
    });
    new Setting(containerEl).setName(l.setMassPercent).setDesc(l.setMassPercentDesc).addText((text) => {
      text.inputEl.type = 'number';
      text.setValue(String(settings.massDeletePercent)).onChange(async (value) => {
        const n = Number(value);
        if (n > 0 && n <= 100) {
          settings.massDeletePercent = n;
          await plugin.saveSettings();
        }
      });
    });

    // ── Status ──────────────────────────────────────────────────────────────
    this.section(containerEl, 'activity', l.secStatus);
    new Setting(containerEl)
      .setName(l.lastSync)
      .setDesc(plugin.lastSyncAt ? `${new Date(plugin.lastSyncAt).toLocaleString()} (${timeAgo(l, plugin.lastSyncAt, Date.now())})` : l.none)
      .addButton((button) => button.setButtonText(l.btnSyncNow).setCta().onClick(() => plugin.syncNow()))
      .addButton((button) => button.setButtonText(l.btnOpenLog).onClick(() => plugin.openLog()));
    new Setting(containerEl).setName(l.lastError).setDesc(plugin.lastError ?? l.none);
    new Setting(containerEl)
      .setName(l.btnReset)
      .setDesc(l.resetDesc)
      .addButton((button) =>
        button
          .setButtonText(l.btnReset)
          .setWarning()
          .onClick(() => new ConfirmModal(this.app, l, l.resetTitle, l.resetBody, l.btnConfirm, () => void this.run(() => plugin.resetState())).open())
      );
    new Setting(containerEl).setName(l.deviceId).setDesc(plugin.deviceId);
  }

  private openUnlock(): void {
    const { plugin } = this;
    new PassphraseModal(this.app, plugin.labels, plugin.settings.vaultName, async (passphrase, remember) => {
      const ok = await plugin.unlockVault(passphrase, remember);
      if (ok) this.display();
      return ok;
    }).open();
  }
}
