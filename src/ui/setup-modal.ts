import { App, Modal, Notice, requestUrl, Setting } from 'obsidian';
import { SetupProject, SetupResult } from '../onboarding/client';
import { DirectInstallerClient, TOKEN_SETTINGS_URL } from '../onboarding/direct-installer';
import type { RemoteVault } from '../backend/remote-backend';

interface SetupHost {
  settings: { language: 'en' | 'fa' };
  applySetupResult(result: SetupResult, password: string): Promise<void>;
  createVault(name: string, passphrase: string | null, remember: boolean): Promise<void>;
  listVaults(): Promise<RemoteVault[]>;
  chooseVault(vault: RemoteVault | null): Promise<void>;
  unlockVault(passphrase: string, remember: boolean): Promise<boolean>;
}

/** Direct setup with a scoped PAT held only for this modal; no maintainer service. */
export class SupabaseSetupModal extends Modal {
  private client: DirectInstallerClient | null = null;
  private alive = true;
  private busy = false;
  private phase: 'start' | 'project' | 'confirm' | 'installing' | 'vault' | 'done' = 'start';
  private projects: SetupProject[] = [];
  private selected = '';
  private setupRef = '';
  private pat = '';
  private email = '';
  private password = '';
  private passwordAgain = '';
  private confirmRef = '';
  private dedicated = false;
  private accountMode: 'create' | 'existing' = 'create';
  private remoteVaults: RemoteVault[] = [];
  private remoteSelected = '';
  private vaultAction: 'create' | 'choose' = 'create';
  private vaultName = 'My vault';
  private encrypt = true;
  private passphrase = '';
  private passphraseAgain = '';
  private trustLocalSetup = false;
  private poll: number | null = null;
  private progress = '';
  private error = '';
  private result: SetupResult | null = null;

  constructor(app: App, private readonly host: SetupHost, private readonly onDone: () => void) { super(app); }
  private t(en: string, fa: string): string { return this.host.settings.language === 'fa' ? fa : en; }
  onOpen(): void {
    this.alive = true;
    this.modalEl.setAttr('dir', this.host.settings.language === 'fa' ? 'rtl' : 'ltr');
    this.titleEl.setText(this.t('Set up your Supabase', 'راه‌اندازی Supabase شخصی'));
    this.render();
  }
  private explain(code: string): string {
    const messages: Record<string, [string, string]> = {
      checking_project: ['Checking project', 'بررسی پروژه'], checking_collisions: ['Checking table names', 'بررسی تداخل جدول‌ها'],
      installing_schema: ['Installing tables and permissions', 'نصب جدول‌ها و دسترسی‌ها'], verifying_schema: ['Verifying security and Realtime', 'بررسی امنیت و Realtime'],
      creating_account: ['Creating sync account', 'ساخت حساب sync'], checking_account: ['Verifying sync sign-in', 'آزمایش ورود حساب sync'],
      permission_denied: ['Supabase permission is missing. Reconnect with the required permissions.', 'مجوز لازم Supabase وجود ندارد؛ با دسترسی لازم دوباره متصل شوید.'],
      sync_sign_in_failed: ['Cannot sign in to the sync account. Existing passwords were not changed. Use the correct password and retry.', 'ورود به حساب sync ممکن نشد. رمز حساب موجود تغییر نکرده؛ با رمز درست دوباره امتحان کنید.'],
      conflicting_tables: ['This project has conflicting tables. Use a dedicated empty project.', 'این پروژه جدول‌های هم‌نام دارد؛ یک پروژهٔ اختصاصی خالی انتخاب کنید.'],
      project_not_ready: ['Project is not ACTIVE_HEALTHY yet. Wait and reconnect.', 'پروژه هنوز ACTIVE_HEALTHY نیست؛ صبر کنید و دوباره متصل شوید.'],
      session_expired: ['Connection expired. Start a new connection.', 'اتصال منقضی شد؛ اتصال جدید بسازید.'],
      local_setup_approval_required: ['Approve direct setup with your scoped token first.', 'ابتدا نصب مستقیم با توکن محدود خودتان را تأیید کنید.'],
      scoped_pat_required: ['Use a project-scoped PAT (sbp_fc), not a Legacy token or a project API key.', 'توکن محدود به پروژه با پیشوند sbp_fc وارد کنید؛ نه Legacy و نه کلید API پروژه.'],
      invalid_project_ref: ['Enter your 20-character project ref, not the project name.', 'شناسهٔ ۲۰ کاراکتری پروژه را وارد کنید، نه نام پروژه.'],
      authorization_expired: ['The token is expired or revoked. Create a short-lived scoped token and reconnect.', 'توکن منقضی یا لغو شده؛ توکن محدود و کوتاه‌عمر جدید بسازید.'],
      admin_key_missing: ['Automatic account creation needs API Keys: Read and API Key Secrets: Read on this project. Reconnect with those permissions.', 'برای ساخت خودکار حساب، API Keys: Read و API Key Secrets: Read همین پروژه لازم است؛ با این مجوزها دوباره متصل شوید.'],
      account_creation_failed: ['The sync account could not be created. Check the email and project password requirements, then retry.', 'حساب sync ساخته نشد؛ ایمیل و شرایط رمز پروژه را بررسی و دوباره امتحان کنید.'],
      supabase_unreachable: ['Cannot reach Supabase. Check your connection.', 'اتصال به Supabase ممکن نیست؛ شبکه را بررسی کنید.'],
    };
    const label = messages[code]; return label ? this.t(label[0], label[1]) : code;
  }
  private text(name: string, value: string, change: (value: string) => void, secret = false): void {
    new Setting(this.contentEl).setName(name).addText(c => {
      if (secret) { c.inputEl.type = 'password'; c.inputEl.autocomplete = 'new-password'; }
      c.setValue(value).onChange(change);
    });
  }
  private toggle(name: string, value: boolean, change: (value: boolean) => void): void {
    new Setting(this.contentEl).setName(name).addToggle(c => c.setValue(value).onChange(change));
  }
  private button(name: string, action: () => Promise<void> | void, primary = false): void {
    new Setting(this.contentEl).addButton(b => {
      b.setButtonText(name).setDisabled(this.busy);
      if (primary) b.setCta();
      b.onClick(() => void this.run(action));
    });
  }
  private async run(action: () => Promise<void> | void): Promise<void> {
    if (this.busy || !this.alive) return;
    this.busy = true; this.error = ''; this.render();
    try { await action(); }
    catch (e) { this.error = e instanceof Error ? e.message : 'setup_failed'; }
    finally { this.busy = false; if (this.alive) this.render(); }
  }
  private render(): void {
    if (!this.alive) return;
    const el = this.contentEl; el.empty();
    el.createEl('p', { text: this.t('This device sets up your own Supabase project directly. No maintainer server.', 'این دستگاه پروژهٔ Supabase خودتان را مستقیم راه‌اندازی می‌کند؛ بدون سرور واسط سازنده.') });
    if (this.error) el.createEl('p', { cls: 'vault-sync-warning', text: this.t('Setup stopped: ', 'راه‌اندازی متوقف شد: ') + this.explain(this.error) });
    if (this.phase === 'start') {
      el.createEl('p', { text: this.t('First create a dedicated project in Supabase, then a short-lived scoped token for that project only. The guide page never asks for your token.', 'اول در Supabase یک پروژهٔ اختصاصی بسازید؛ سپس توکن محدود و کوتاه‌عمر فقط برای همان پروژه. صفحهٔ راهنما توکن نمی‌گیرد.') });
      el.createEl('p', { text: this.t('Required: Project Settings — Read; Database — Read-write; API Keys — Read. To create the sync user also grant API Key Secrets — Read. Do not grant account-wide listing, billing, organization access, or Auth Config Write.', 'دسترسی‌های لازم: Project Settings: Read، Database: Read-write، API Keys: Read. برای ساخت حساب sync، API Key Secrets: Read هم لازم است. دسترسی فهرست همهٔ پروژه‌ها، پرداخت، سازمان یا Auth Config Write ندهید.') });
      this.button(this.t('Open Supabase: create project', 'بازکردن Supabase: ساخت پروژه'), () => { window.open('https://supabase.com/dashboard', '_blank', 'noopener,noreferrer'); });
      this.button(this.t('Open Supabase: create scoped token', 'بازکردن Supabase: ساخت توکن محدود'), () => { window.open(TOKEN_SETTINGS_URL, '_blank', 'noopener,noreferrer'); });
      this.text(this.t('Dedicated project ref (20 characters)', 'شناسهٔ پروژهٔ اختصاصی (۲۰ کاراکتر)'), this.setupRef, v => { this.setupRef = v.trim(); });
      this.text(this.t('Temporary scoped access token (sbp_fc)', 'توکن دسترسی محدود و موقت (sbp_fc)'), this.pat, v => { this.pat = v.trim(); }, true);
      this.toggle(this.t('I trust this plugin with temporary administration of this project', 'به پلاگین برای مدیریت موقت همین پروژه اعتماد دارم'), this.trustLocalSetup, v => { this.trustLocalSetup = v; });
      el.createEl('p', { text: this.t('The token and admin key are not saved to settings or logs. After setup, revoke the token in Supabase. Clearing it here is not revocation.', 'توکن و کلید مدیریتی در تنظیمات یا لاگ ذخیره نمی‌شوند. بعد از نصب، توکن را در Supabase لغو کنید؛ پاک‌شدن از حافظه به‌معنای لغو توکن نیست.') });
      this.button(this.t('Connect Supabase', 'اتصال به Supabase'), async () => {
        if (!this.trustLocalSetup) throw new Error('local_setup_approval_required');
        await this.client?.close();
        const pat = this.pat; this.pat = '';
        this.client = new DirectInstallerClient(pat, this.setupRef, async (target, method, headers, body) => {
          const response = await requestUrl({ url: target, method, headers, body, throw: false });
          let data: unknown = null; try { data = response.json; } catch { /* never reflect raw error bodies */ }
          return { status: response.status, data };
        });
        this.projects = await this.client.projects();
        if (!this.alive) { await this.client.close(); return; }
        this.selected = this.setupRef; this.phase = 'project';
      }, true);
    } else if (this.phase === 'project') {
      new Setting(el).setName(this.t('Your project', 'پروژهٔ شما')).addDropdown(d => {
        d.addOption('', this.t('Choose a dedicated project', 'یک پروژهٔ اختصاصی انتخاب کنید'));
        for (const p of this.projects) d.addOption(p.ref, `${p.name} — ${p.status}`);
        d.setValue(this.selected).onChange(v => { this.selected = v; });
      });
      this.button(this.t('Refresh projects', 'تازه‌سازی پروژه‌ها'), async () => { this.projects = await this.client!.projects(); });
      this.button(this.t('Use this project', 'استفاده از این پروژه'), () => {
        if (!this.projects.some(p => p.ref === this.selected)) throw new Error('select_project');
        this.phase = 'confirm';
      }, true);
    } else if (this.phase === 'confirm') {
      const p = this.projects.find(x => x.ref === this.selected);
      el.createEl('h3', { text: `${p?.name ?? ''} — ${this.selected}` });
      el.createEl('p', { text: this.t('This installs tables, private storage and Realtime, and replaces this device’s current connection. It does not change existing account passwords.', 'جدول‌ها، فضای خصوصی و Realtime نصب و اتصال فعلی این دستگاه جایگزین می‌شود. رمز حساب‌های موجود تغییر نمی‌کند.') });
      this.text(this.t('Type the project ref to confirm', 'شناسهٔ پروژه را برای تأیید بنویسید'), this.confirmRef, v => { this.confirmRef = v.trim(); });
      this.toggle(this.t('This is my dedicated Vault Sync project', 'این پروژهٔ اختصاصی Vault Sync من است'), this.dedicated, v => { this.dedicated = v; });
      new Setting(el).setName(this.t('Sync account', 'حساب sync')).addDropdown(d => d.addOptions({ create: this.t('Create sync account automatically', 'ساخت خودکار حساب sync'), existing: this.t('Use existing account', 'استفاده از حساب موجود') }).setValue(this.accountMode).onChange(v => { this.accountMode = v as 'create' | 'existing'; }));
      el.createEl('p', { text: this.t('For a new setup, keep automatic account creation selected and choose an email and a separate sync password below. The plugin creates and confirms this user in your project; no manual Add user is needed. If this email already exists, its current password is required and is never reset.', 'برای نصب جدید، ساخت خودکار را انتخاب کنید و پایین ایمیل و رمز مستقل حساب sync را تعیین کنید. پلاگین کاربر را در پروژهٔ شما می‌سازد و تأیید می‌کند؛ Add user دستی لازم نیست. اگر این ایمیل از قبل وجود دارد، رمز فعلی آن لازم است و تغییر نمی‌کند.') });
      this.text(this.t('Sync email', 'ایمیل حساب sync'), this.email, v => { this.email = v.trim(); });
      this.text(this.t('Sync password (12+ characters; not your dashboard password)', 'رمز حساب sync (حداقل ۱۲ کاراکتر؛ نه رمز داشبورد)'), this.password, v => { this.password = v; }, true);
      this.text(this.t('Repeat sync password', 'تکرار رمز sync'), this.passwordAgain, v => { this.passwordAgain = v; }, true);
      el.createEl('p', { text: this.t('Existing passwords and project-wide sign-up settings will not be changed.', 'رمز حساب‌های موجود و تنظیمات ثبت‌نام کل پروژه تغییر نمی‌کنند.') });
      this.button(this.t('Back', 'بازگشت'), () => { this.phase = 'project'; });
      this.button(this.t('Set up Vault Sync', 'راه‌اندازی Vault Sync'), async () => {
        if (this.confirmRef !== this.selected || !this.dedicated) throw new Error('confirm_dedicated_project');
        if (this.password.length < 12 || this.password !== this.passwordAgain) throw new Error('password_mismatch_or_short');
        await this.client!.install({ projectRef: this.selected, confirmRef: this.confirmRef, dedicatedProject: this.dedicated,
          email: this.email, password: this.password, accountMode: this.accountMode });
        this.phase = 'installing'; this.progress = 'starting'; this.schedulePoll();
      }, true);
    } else if (this.phase === 'installing') {
      el.createEl('p', { text: this.t('Preparing your project… ', 'در حال آماده‌سازی پروژه… ') + this.progress });
      el.createEl('p', { text: this.t('Closing requests cancellation between steps. Completed remote changes are not rolled back.', 'بستن پنجره، توقف بین مراحل را درخواست می‌کند. تغییرات انجام‌شده روی سرور بازگردانی نمی‌شوند.') });
    } else if (this.phase === 'vault') {
      el.createEl('h3', { text: this.t('Backend ready — choose your vault', 'بک‌اند آماده است — والت را انتخاب کنید') });
      el.createEl('p', { text: this.t('Revoke the setup token in Supabase now. Sync no longer needs it.', 'حالا توکن نصب را در Supabase لغو کنید؛ همگام‌سازی دیگر به آن نیاز ندارد.') });
      this.button(this.t('Open token settings to revoke', 'بازکردن تنظیمات برای لغو توکن'), () => { window.open(TOKEN_SETTINGS_URL, '_blank', 'noopener,noreferrer'); });
      new Setting(el).setName(this.t('Remote vault', 'والت روی سرور')).addDropdown(d => d
        .addOptions({ create: this.t('Create new vault', 'ساخت والت جدید'), choose: this.t('Use an existing vault', 'انتخاب والت موجود') })
        .setValue(this.vaultAction).onChange(v => { this.vaultAction = v as 'create' | 'choose'; this.passphrase = ''; this.passphraseAgain = ''; this.render(); }));
      if (this.vaultAction === 'create') {
      this.text(this.t('Name for the new remote vault', 'نام والت جدید روی سرور'), this.vaultName, v => { this.vaultName = v; });
      this.toggle(this.t('End-to-end encrypt this vault', 'رمزنگاری سرتاسری این والت'), this.encrypt, v => { this.encrypt = v; this.render(); });
      if (this.encrypt) {
        this.text(this.t('Encryption passphrase (12+ characters)', 'عبارت عبور رمزنگاری (حداقل ۱۲ کاراکتر)'), this.passphrase, v => { this.passphrase = v; }, true);
        this.text(this.t('Repeat passphrase', 'تکرار عبارت عبور'), this.passphraseAgain, v => { this.passphraseAgain = v; }, true);
        el.createEl('p', { text: this.t('The encryption passphrase stays on this device and never goes to the installer. Keep it for your other devices.', 'عبارت عبور روی همین دستگاه می‌ماند و به سرویس نصب نمی‌رود. برای دستگاه‌های دیگر آن را نگه دارید.') });
      }

      } else {
        new Setting(el).setName(this.t('Existing vault', 'والت موجود')).addDropdown(d => {
          d.addOption('', '—');
          for (const v of this.remoteVaults) d.addOption(v.id, v.name + (v.encryption ? ' 🔒' : ''));
          d.setValue(this.remoteSelected).onChange(v => { this.remoteSelected = v; this.render(); });
        });
        if (this.remoteVaults.find(v => v.id === this.remoteSelected)?.encryption) {
          this.text(this.t('Encryption passphrase', 'عبارت عبور رمزنگاری'), this.passphrase, v => { this.passphrase = v; }, true);
        }
      }
      this.button(this.t('Finish setup', 'تکمیل راه‌اندازی'), async () => {
        if (this.vaultAction === 'create') {
          if (!this.vaultName.trim()) throw new Error('vault_name_required');
          if (this.encrypt && (this.passphrase.length < 12 || this.passphrase !== this.passphraseAgain)) throw new Error('passphrase_mismatch_or_short');
          await this.host.createVault(this.vaultName.trim(), this.encrypt ? this.passphrase : null, false);
        } else {
          const vault = this.remoteVaults.find(v => v.id === this.remoteSelected);
          if (!vault) throw new Error('select_vault');
          await this.host.chooseVault(vault);
          if (vault.encryption && !(await this.host.unlockVault(this.passphrase, false))) throw new Error('wrong_passphrase');
        }
        this.clearSecrets(); this.phase = 'done';
      }, true);
    } else {
      el.createEl('h3', { text: this.t('Ready to sync', 'آمادهٔ همگام‌سازی') });
      el.createEl('p', { text: this.result?.projectUrl ?? '' });
      el.createEl('p', { text: this.t('On your next device: enter this project URL and its publishable key, sign in with the same sync account, and choose this vault. Do not create another vault.', 'روی دستگاه بعدی: URL و کلید publishable همین پروژه را وارد کنید، با همین حساب sync وارد شوید و همین والت را انتخاب کنید؛ والت جدید نسازید.') });
      this.button(this.t('Done', 'تمام'), () => { this.onDone(); this.close(); }, true);
    }
  }
  private schedulePoll(): void {
    if (this.poll !== null) window.clearTimeout(this.poll);
    if (this.alive) this.poll = window.setTimeout(() => { this.poll = null; void this.pollState(); }, 1500);
  }
  private async pollState(): Promise<void> {
    if (!this.alive || !this.client || this.phase !== 'installing') return;
    try {
      const state = await this.client.state();
      if (!this.alive) return;
      if (state.status === 'failed') {
        this.error = state.error ?? 'installation_failed'; this.phase = 'start'; this.clearSecrets();
        await this.client.close(); this.render(); return;
      }
      if (this.phase === 'installing' && state.status === 'complete' && state.result) {
        this.result = state.result;
        this.busy = true; this.progress = this.t('Connecting this device', 'اتصال این دستگاه'); this.render();
        // Management credentials are already discarded; only the public connection is applied.
        await this.client.close();
        if (!this.alive) return;
        await this.host.applySetupResult(state.result, this.password);
        if (!this.alive) return;
        this.clearSecrets();
        this.remoteVaults = await this.host.listVaults();
        if (!this.alive) return;
        this.vaultAction = this.remoteVaults.length ? 'choose' : 'create';
        this.remoteSelected = this.remoteVaults[0]?.id ?? '';
        this.busy = false; this.phase = 'vault'; this.render(); return;
      }
      this.progress = state.progress.map(code => this.explain(code)).join(' → ');
      this.render(); this.schedulePoll();
    } catch (e) {
      if (!this.alive) return;
      this.busy = false;
      this.error = e instanceof Error ? e.message : 'setup_failed';
      this.phase = 'start'; this.clearSecrets();
      await this.client?.close(); this.render();
    }
  }
  private clearSecrets(): void { this.pat = ''; this.password = ''; this.passwordAgain = ''; this.passphrase = ''; this.passphraseAgain = ''; }
  onClose(): void {
    this.alive = false;
    if (this.poll !== null) window.clearTimeout(this.poll);
    this.poll = null; this.clearSecrets(); this.contentEl.empty();
    void this.client?.close(); this.client = null;
  }
}
