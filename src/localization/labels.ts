// ── localization/labels.ts ────────────────────────────────────────────────
// Every user-facing string, in English and Persian. The plugin is one
// feature, so one labels file covers settings, notices, status and modals.
// ─────────────────────────────────────────────────────────────────────────────

import { Language } from '../types';

export interface Labels {
  dir: 'ltr' | 'rtl';
  pluginName: string;
  // status
  statusNotConfigured: string;
  statusSignedOut: string;
  statusNoVault: string;
  statusLocked: string;
  statusSyncing: string;
  statusSynced: (ago: string) => string;
  statusNeverSynced: string;
  statusOffline: string;
  statusError: string;
  statusPaused: string;
  statusWaiting: string;
  statusWaitingFiles: (n: number) => string;
  noticeWaitingFiles: (n: number) => string;
  justNow: string;
  minutesAgo: (n: number) => string;
  hoursAgo: (n: number) => string;
  daysAgo: (n: number) => string;
  // notices
  noticeSynced: (up: number, down: number) => string;
  noticeConflict: (path: string, copy: string) => string;
  noticeConflicts: (n: number) => string;
  noticeSchemaMissing: string;
  noticeAuthExpired: string;
  noticeVaultMissing: string;
  noticePaused: string;
  noticeQuota: string;
  noticeSkipped: (n: number) => string;
  noticeWrongPassphrase: string;
  noticeUnlocked: string;
  noticeDeriving: string;
  noticeSignedIn: (email: string) => string;
  noticeCheckEmail: string;
  noticeSignedOut: string;
  noticeConnectionOk: string;
  noticeSecretKey: string;
  noticeStateReset: string;
  noticeNotReady: string;
  noticeVaultCreated: (name: string) => string;
  // commands
  cmdSyncNow: string;
  cmdTogglePause: string;
  cmdOpenLog: string;
  cmdUnlock: string;
  cmdConflicts: string;
  cmdReset: string;
  cmdSignOut: string;
  // settings
  setLanguage: string;
  secConnection: string;
  secConnectionDesc: string;
  setUrl: string;
  setUrlDesc: string;
  setKey: string;
  setKeyDesc: string;
  setTest: string;
  secAccount: string;
  secAccountDesc: string;
  setEmail: string;
  setPassword: string;
  btnSignIn: string;
  btnSignUp: string;
  btnSignOut: string;
  signedInAs: (email: string) => string;
  secVault: string;
  secVaultDesc: string;
  setVault: string;
  setVaultDesc: string;
  noVaultChosen: string;
  btnRefresh: string;
  btnCreateVault: string;
  vaultEncrypted: string;
  vaultPlain: string;
  btnUnlock: string;
  btnForgetKey: string;
  firstSyncHint: string;
  secSync: string;
  setAutoSync: string;
  setAutoSyncDesc: string;
  setInterval: string;
  setIntervalDesc: string;
  intervalOff: string;
  intervalMinutes: (n: number) => string;
  setRealtime: string;
  setRealtimeDesc: string;
  secScope: string;
  setExcluded: string;
  setExcludedDesc: string;
  setMaxSize: string;
  setMaxSizeDesc: string;
  secSafety: string;
  setMassCount: string;
  setMassCountDesc: string;
  setMassPercent: string;
  setMassPercentDesc: string;
  secStatus: string;
  lastSync: string;
  lastError: string;
  none: string;
  btnSyncNow: string;
  btnOpenLog: string;
  btnReset: string;
  resetDesc: string;
  deviceId: string;
  // modals
  createTitle: string;
  createName: string;
  createEncrypt: string;
  createEncryptDesc: string;
  passphrase: string;
  passphraseAgain: string;
  passphraseMismatch: string;
  passphraseTooShort: string;
  passphraseWarning: string;
  rememberKey: string;
  rememberKeyDesc: string;
  btnCreate: string;
  btnCancel: string;
  unlockTitle: (vault: string) => string;
  massTitle: string;
  massIntroLocal: (n: number) => string;
  massIntroRemote: (n: number) => string;
  massExplain: string;
  btnDelete: string;
  btnKeep: string;
  btnPause: string;
  logTitle: string;
  logEmpty: string;
  btnCopy: string;
  conflictsEmpty: string;
  conflictsPlaceholder: string;
  resetTitle: string;
  resetBody: string;
  btnConfirm: string;
  logKinds: Record<string, string>;
}

const EN: Labels = {
  dir: 'ltr',
  pluginName: 'Vault Sync',
  statusNotConfigured: 'Sync: set up',
  statusSignedOut: 'Sync: signed out',
  statusNoVault: 'Sync: choose a vault',
  statusLocked: 'Sync: locked',
  statusSyncing: 'Syncing…',
  statusSynced: (ago) => `Synced ${ago}`,
  statusNeverSynced: 'Not synced yet',
  statusOffline: 'Sync: offline',
  statusError: 'Sync: error',
  statusPaused: 'Sync: paused',
  statusWaiting: 'Sync: waiting for you',
  statusWaitingFiles: (n) => `Sync: ${n} files on their way`,
  noticeWaitingFiles: (n) =>
    `Vault Sync: ${n} files are no longer on the server and were requested from your other devices. They arrive the next time one of those devices has Obsidian open.`,
  justNow: 'just now',
  minutesAgo: (n) => `${n} min ago`,
  hoursAgo: (n) => `${n} h ago`,
  daysAgo: (n) => `${n} d ago`,
  noticeSynced: (up, down) => `Vault Sync: ↑${up} ↓${down}`,
  noticeConflict: (path, copy) => `Conflict in ${path}. The other version was saved as ${copy}.`,
  noticeConflicts: (n) => `${n} conflicts. Open the sync log to see the copies that were made.`,
  noticeSchemaMissing: 'Vault Sync: the database is not set up or out of date. Run `npm run deploy` (or supabase/schema.sql in the Supabase SQL Editor).',
  noticeAuthExpired: 'Vault Sync: your session ended. Sign in again in the settings.',
  noticeVaultMissing: 'Vault Sync: the remote vault was deleted. Choose or create another one in the settings.',
  noticePaused: 'Vault Sync: the Supabase project looks paused (free projects pause after a week without use). Restore it in the Supabase dashboard.',
  noticeQuota: 'Vault Sync: the Supabase storage quota is full.',
  noticeSkipped: (n) => `Vault Sync: ${n} files were skipped. See the sync log.`,
  noticeWrongPassphrase: 'Wrong passphrase.',
  noticeUnlocked: 'Vault unlocked.',
  noticeDeriving: 'Deriving the encryption key… this can take a few seconds.',
  noticeSignedIn: (email) => `Signed in as ${email}.`,
  noticeCheckEmail: 'Account created. Confirm the email Supabase sent you, then sign in.',
  noticeSignedOut: 'Signed out.',
  noticeConnectionOk: 'Connected, and the database is set up.',
  noticeSecretKey: 'This is a secret (service-role) key. Use the publishable / anon key: a secret key must never be stored on a device.',
  noticeStateReset: 'Sync state reset. The next sync compares everything again, without deleting anything.',
  noticeNotReady: 'Vault Sync is not ready yet. Finish the setup in the settings.',
  noticeVaultCreated: (name) => `Remote vault "${name}" created.`,
  cmdSyncNow: 'Sync now',
  cmdTogglePause: 'Pause or resume automatic sync',
  cmdOpenLog: 'Open sync log',
  cmdUnlock: 'Unlock the encrypted vault',
  cmdConflicts: 'Show conflict copies',
  cmdReset: 'Reset sync state on this device',
  cmdSignOut: 'Sign out',
  setLanguage: 'Language',
  secConnection: 'Supabase project',
  secConnectionDesc: 'Create a free project at supabase.com and install the backend once with `npm run deploy` (or run supabase/schema.sql in its SQL Editor), then enter the URL and publishable key it prints. Supabase only relays your files: contents are deleted once your other devices have them.',
  setUrl: 'Project URL',
  setUrlDesc: 'For example https://abcdefghijklmnopqrst.supabase.co',
  setKey: 'Publishable (anon) key',
  setKeyDesc: 'Never paste the secret / service_role key here.',
  setTest: 'Test connection',
  secAccount: 'Account',
  secAccountDesc: 'Use the same account on every device. Your files are only visible to this account.',
  setEmail: 'Email',
  setPassword: 'Password',
  btnSignIn: 'Sign in',
  btnSignUp: 'Create account',
  btnSignOut: 'Sign out',
  signedInAs: (email) => `Signed in as ${email}`,
  secVault: 'Remote vault',
  secVaultDesc: 'One account can hold several vaults. Choose the same one on your phone and your computer.',
  setVault: 'Vault',
  setVaultDesc: 'The vault this Obsidian vault syncs with.',
  noVaultChosen: '— choose —',
  btnRefresh: 'Refresh',
  btnCreateVault: 'Create new',
  vaultEncrypted: 'End-to-end encrypted',
  vaultPlain: 'Not encrypted',
  btnUnlock: 'Unlock',
  btnForgetKey: 'Forget key on this device',
  firstSyncHint: 'The first sync on a device keeps everything from both sides: files missing on one side are copied over, nothing is deleted.',
  secSync: 'Syncing',
  setAutoSync: 'Sync automatically',
  setAutoSyncDesc: 'After edits, when another device changes something, and when Obsidian comes back to the foreground.',
  setInterval: 'Check every',
  setIntervalDesc: 'A safety net in case a live update is missed.',
  intervalOff: 'Off',
  intervalMinutes: (n) => `${n} min`,
  setRealtime: 'Live updates',
  setRealtimeDesc: 'Hear about other devices\' changes within seconds (Supabase Realtime).',
  secScope: 'What to sync',
  setExcluded: 'Excluded folders',
  setExcludedDesc: 'One folder per line. Hidden folders such as .obsidian and .trash are never synced.',
  setMaxSize: 'Largest file (MB)',
  setMaxSizeDesc: 'Bigger files are skipped. Free Supabase projects accept up to 50 MB per file.',
  secSafety: 'Safety',
  setMassCount: 'Ask before deleting this many files',
  setMassCountDesc: 'A sync that would delete at least this many files waits for your approval.',
  setMassPercent: '…or this share of the vault (%)',
  setMassPercentDesc: 'Also ask when a sync would delete at least this percentage of the synced files.',
  secStatus: 'Status',
  lastSync: 'Last sync',
  lastError: 'Last error',
  none: '—',
  btnSyncNow: 'Sync now',
  btnOpenLog: 'Open log',
  btnReset: 'Reset sync state',
  resetDesc: 'Makes this device forget what it synced before. Nothing is deleted; the next sync compares everything again.',
  deviceId: 'Device id',
  createTitle: 'Create a remote vault',
  createName: 'Name',
  createEncrypt: 'Encrypt end-to-end',
  createEncryptDesc: 'Files are encrypted on your devices before upload; Supabase only stores unreadable data. File names stay visible.',
  passphrase: 'Passphrase',
  passphraseAgain: 'Passphrase again',
  passphraseMismatch: 'The passphrases do not match.',
  passphraseTooShort: 'Use at least 8 characters.',
  passphraseWarning: 'If you lose the passphrase, the files on the server cannot be recovered.',
  rememberKey: 'Remember the key on this device',
  rememberKeyDesc: 'Otherwise you unlock the vault each time Obsidian starts.',
  btnCreate: 'Create',
  btnCancel: 'Cancel',
  unlockTitle: (vault) => `Unlock "${vault}"`,
  massTitle: 'Delete many files?',
  massIntroLocal: (n) => `Another device deleted ${n} files. Delete them here too?`,
  massIntroRemote: (n) => `${n} files are missing on this device. Delete them on the server and your other devices too?`,
  massExplain: 'Everything else keeps syncing while you decide. Deleted files go to the trash.',
  btnDelete: 'Delete them',
  btnKeep: 'Keep them',
  btnPause: 'Pause sync',
  logTitle: 'Sync log',
  logEmpty: 'Nothing has happened yet.',
  btnCopy: 'Copy',
  conflictsEmpty: 'There are no conflict copies.',
  conflictsPlaceholder: 'Choose a conflict copy to open',
  resetTitle: 'Reset sync state?',
  resetBody: 'This device forgets what it synced before. No file is deleted; the next sync compares everything again and may create conflict copies where both sides differ.',
  btnConfirm: 'Reset',
  logKinds: {
    upload: 'Uploaded',
    download: 'Downloaded',
    'delete-local': 'Deleted here',
    'delete-remote': 'Deleted on server',
    rename: 'Renamed',
    merge: 'Merged',
    conflict: 'Conflict',
    skip: 'Skipped',
    error: 'Error',
    info: 'Info',
  },
};

const FA: Labels = {
  dir: 'rtl',
  pluginName: 'همگام‌سازی والت',
  statusNotConfigured: 'همگام‌سازی: راه‌اندازی',
  statusSignedOut: 'همگام‌سازی: وارد نشده‌اید',
  statusNoVault: 'همگام‌سازی: والت را انتخاب کنید',
  statusLocked: 'همگام‌سازی: قفل',
  statusSyncing: 'در حال همگام‌سازی…',
  statusSynced: (ago) => `همگام شد ${ago}`,
  statusNeverSynced: 'هنوز همگام نشده',
  statusOffline: 'همگام‌سازی: آفلاین',
  statusError: 'همگام‌سازی: خطا',
  statusPaused: 'همگام‌سازی: متوقف',
  statusWaiting: 'همگام‌سازی: منتظر شما',
  statusWaitingFiles: (n) => `همگام‌سازی: ${n} فایل در راه است`,
  noticeWaitingFiles: (n) =>
    `همگام‌سازی: ${n} فایل دیگر روی سرور نیست و از دستگاه‌های دیگرتان درخواست شد. دفعهٔ بعد که Obsidian روی یکی از آن دستگاه‌ها باز شود، می‌رسند.`,
  justNow: 'همین حالا',
  minutesAgo: (n) => `${n} دقیقه پیش`,
  hoursAgo: (n) => `${n} ساعت پیش`,
  daysAgo: (n) => `${n} روز پیش`,
  noticeSynced: (up, down) => `همگام‌سازی: ↑${up} ↓${down}`,
  noticeConflict: (path, copy) => `تعارض در ${path}. نسخهٔ دیگر با نام ${copy} ذخیره شد.`,
  noticeConflicts: (n) => `${n} تعارض پیش آمد. برای دیدن نسخه‌های ذخیره‌شده، گزارش همگام‌سازی را باز کنید.`,
  noticeSchemaMissing: 'همگام‌سازی: پایگاه داده آماده یا به‌روز نیست. دستور `npm run deploy` را اجرا کنید (یا فایل supabase/schema.sql را در SQL Editor سوپابیس).',
  noticeAuthExpired: 'همگام‌سازی: نشست شما تمام شده. در تنظیمات دوباره وارد شوید.',
  noticeVaultMissing: 'همگام‌سازی: والت روی سرور حذف شده. در تنظیمات والت دیگری انتخاب یا بسازید.',
  noticePaused: 'همگام‌سازی: پروژهٔ سوپابیس متوقف شده است (پروژه‌های رایگان پس از یک هفته استفاده‌نشدن متوقف می‌شوند). آن را از داشبورد سوپابیس دوباره فعال کنید.',
  noticeQuota: 'همگام‌سازی: فضای ذخیره‌سازی سوپابیس پر شده است.',
  noticeSkipped: (n) => `همگام‌سازی: ${n} فایل رد شد. گزارش همگام‌سازی را ببینید.`,
  noticeWrongPassphrase: 'عبارت عبور اشتباه است.',
  noticeUnlocked: 'والت باز شد.',
  noticeDeriving: 'در حال ساختن کلید رمزنگاری… ممکن است چند ثانیه طول بکشد.',
  noticeSignedIn: (email) => `با ${email} وارد شدید.`,
  noticeCheckEmail: 'حساب ساخته شد. ایمیلی را که سوپابیس فرستاده تأیید کنید و بعد وارد شوید.',
  noticeSignedOut: 'از حساب خارج شدید.',
  noticeConnectionOk: 'اتصال برقرار است و پایگاه داده آماده است.',
  noticeSecretKey: 'این کلید مخفی (service_role) است. از کلید publishable / anon استفاده کنید؛ کلید مخفی هرگز نباید روی دستگاه ذخیره شود.',
  noticeStateReset: 'وضعیت همگام‌سازی پاک شد. همگام‌سازی بعدی همه چیز را دوباره مقایسه می‌کند و چیزی حذف نمی‌شود.',
  noticeNotReady: 'همگام‌سازی هنوز آماده نیست. راه‌اندازی را در تنظیمات کامل کنید.',
  noticeVaultCreated: (name) => `والت «${name}» روی سرور ساخته شد.`,
  cmdSyncNow: 'همگام‌سازی همین حالا',
  cmdTogglePause: 'توقف یا ادامهٔ همگام‌سازی خودکار',
  cmdOpenLog: 'باز کردن گزارش همگام‌سازی',
  cmdUnlock: 'باز کردن قفل والت رمزنگاری‌شده',
  cmdConflicts: 'نمایش نسخه‌های تعارض',
  cmdReset: 'بازنشانی وضعیت همگام‌سازی این دستگاه',
  cmdSignOut: 'خروج از حساب',
  setLanguage: 'زبان',
  secConnection: 'پروژهٔ سوپابیس',
  secConnectionDesc: 'یک پروژهٔ رایگان در supabase.com بسازید و یک بار با `npm run deploy` (یا اجرای supabase/schema.sql در SQL Editor) آن را آماده کنید، سپس آدرس و کلید publishable را که چاپ می‌کند وارد کنید. Supabase فقط فایل‌ها را منتقل می‌کند: وقتی دستگاه‌های دیگرتان گرفتند، محتوا پاک می‌شود.',
  setUrl: 'آدرس پروژه',
  setUrlDesc: 'مثلاً https://abcdefghijklmnopqrst.supabase.co',
  setKey: 'کلید publishable (anon)',
  setKeyDesc: 'هرگز کلید secret / service_role را اینجا وارد نکنید.',
  setTest: 'آزمایش اتصال',
  secAccount: 'حساب کاربری',
  secAccountDesc: 'در همهٔ دستگاه‌ها با همین حساب وارد شوید. فایل‌های شما فقط برای این حساب قابل دیدن است.',
  setEmail: 'ایمیل',
  setPassword: 'رمز عبور',
  btnSignIn: 'ورود',
  btnSignUp: 'ساخت حساب',
  btnSignOut: 'خروج',
  signedInAs: (email) => `وارد شده با ${email}`,
  secVault: 'والت روی سرور',
  secVaultDesc: 'یک حساب می‌تواند چند والت داشته باشد. روی گوشی و کامپیوتر همان یکی را انتخاب کنید.',
  setVault: 'والت',
  setVaultDesc: 'والتی که این والت Obsidian با آن همگام می‌شود.',
  noVaultChosen: '— انتخاب کنید —',
  btnRefresh: 'تازه‌سازی',
  btnCreateVault: 'ساخت والت جدید',
  vaultEncrypted: 'رمزنگاری سرتاسری',
  vaultPlain: 'بدون رمزنگاری',
  btnUnlock: 'باز کردن قفل',
  btnForgetKey: 'فراموش کردن کلید در این دستگاه',
  firstSyncHint: 'اولین همگام‌سازی در هر دستگاه همه چیز را از هر دو طرف نگه می‌دارد: فایل‌هایی که در یک طرف نیستند کپی می‌شوند و چیزی حذف نمی‌شود.',
  secSync: 'همگام‌سازی',
  setAutoSync: 'همگام‌سازی خودکار',
  setAutoSyncDesc: 'بعد از ویرایش، وقتی دستگاه دیگری چیزی را تغییر دهد، و وقتی Obsidian دوباره باز شود.',
  setInterval: 'بررسی هر',
  setIntervalDesc: 'یک پشتیبان، برای وقتی که به‌روزرسانی زنده از دست برود.',
  intervalOff: 'خاموش',
  intervalMinutes: (n) => `${n} دقیقه`,
  setRealtime: 'به‌روزرسانی زنده',
  setRealtimeDesc: 'تغییرات دستگاه‌های دیگر در چند ثانیه می‌رسد (Supabase Realtime).',
  secScope: 'چه چیزی همگام شود',
  setExcluded: 'پوشه‌های مستثنا',
  setExcludedDesc: 'هر پوشه در یک خط. پوشه‌های پنهان مثل .obsidian و .trash هیچ‌وقت همگام نمی‌شوند.',
  setMaxSize: 'بزرگ‌ترین فایل (مگابایت)',
  setMaxSizeDesc: 'فایل‌های بزرگ‌تر رد می‌شوند. پروژه‌های رایگان سوپابیس تا ۵۰ مگابایت برای هر فایل می‌پذیرند.',
  secSafety: 'ایمنی',
  setMassCount: 'پیش از حذف این تعداد فایل بپرس',
  setMassCountDesc: 'همگام‌سازی‌ای که دست‌کم این تعداد فایل را حذف کند، منتظر تأیید شما می‌ماند.',
  setMassPercent: '…یا این درصد از والت',
  setMassPercentDesc: 'همچنین وقتی همگام‌سازی دست‌کم این درصد از فایل‌ها را حذف کند، بپرس.',
  secStatus: 'وضعیت',
  lastSync: 'آخرین همگام‌سازی',
  lastError: 'آخرین خطا',
  none: '—',
  btnSyncNow: 'همگام‌سازی همین حالا',
  btnOpenLog: 'باز کردن گزارش',
  btnReset: 'بازنشانی وضعیت',
  resetDesc: 'این دستگاه آنچه قبلاً همگام کرده را فراموش می‌کند. چیزی حذف نمی‌شود؛ همگام‌سازی بعدی همه چیز را دوباره مقایسه می‌کند.',
  deviceId: 'شناسهٔ دستگاه',
  createTitle: 'ساخت والت روی سرور',
  createName: 'نام',
  createEncrypt: 'رمزنگاری سرتاسری',
  createEncryptDesc: 'فایل‌ها پیش از ارسال روی دستگاه شما رمزنگاری می‌شوند و سوپابیس فقط دادهٔ ناخوانا نگه می‌دارد. نام فایل‌ها قابل دیدن می‌ماند.',
  passphrase: 'عبارت عبور',
  passphraseAgain: 'تکرار عبارت عبور',
  passphraseMismatch: 'عبارت‌های عبور یکسان نیستند.',
  passphraseTooShort: 'دست‌کم ۸ نویسه وارد کنید.',
  passphraseWarning: 'اگر عبارت عبور را فراموش کنید، فایل‌های روی سرور قابل بازیابی نیستند.',
  rememberKey: 'کلید را در این دستگاه به خاطر بسپار',
  rememberKeyDesc: 'وگرنه هر بار که Obsidian باز می‌شود باید قفل را باز کنید.',
  btnCreate: 'ساختن',
  btnCancel: 'انصراف',
  unlockTitle: (vault) => `باز کردن قفل «${vault}»`,
  massTitle: 'حذف تعداد زیادی فایل؟',
  massIntroLocal: (n) => `دستگاه دیگری ${n} فایل را حذف کرده. اینجا هم حذف شوند؟`,
  massIntroRemote: (n) => `${n} فایل در این دستگاه نیست. از سرور و دستگاه‌های دیگر هم حذف شوند؟`,
  massExplain: 'تا تصمیم بگیرید، بقیهٔ تغییرات همگام می‌شوند. فایل‌های حذف‌شده به سطل زباله می‌روند.',
  btnDelete: 'حذف شوند',
  btnKeep: 'نگه داشته شوند',
  btnPause: 'توقف همگام‌سازی',
  logTitle: 'گزارش همگام‌سازی',
  logEmpty: 'هنوز اتفاقی نیفتاده.',
  btnCopy: 'کپی',
  conflictsEmpty: 'نسخهٔ تعارضی وجود ندارد.',
  conflictsPlaceholder: 'یک نسخهٔ تعارض را برای باز کردن انتخاب کنید',
  resetTitle: 'بازنشانی وضعیت همگام‌سازی؟',
  resetBody: 'این دستگاه آنچه قبلاً همگام کرده را فراموش می‌کند. هیچ فایلی حذف نمی‌شود؛ همگام‌سازی بعدی همه چیز را دوباره مقایسه می‌کند و جایی که دو طرف فرق دارند ممکن است نسخهٔ تعارض بسازد.',
  btnConfirm: 'بازنشانی',
  logKinds: {
    upload: 'ارسال شد',
    download: 'دریافت شد',
    'delete-local': 'اینجا حذف شد',
    'delete-remote': 'از سرور حذف شد',
    rename: 'تغییر نام',
    merge: 'ادغام شد',
    conflict: 'تعارض',
    skip: 'رد شد',
    error: 'خطا',
    info: 'اطلاع',
  },
};

export function getLabels(language: Language): Labels {
  return language === 'fa' ? FA : EN;
}

/** "2 min ago" in the chosen language. */
export function timeAgo(labels: Labels, then: number, now: number): string {
  const minutes = Math.floor((now - then) / 60_000);
  if (minutes < 1) return labels.justNow;
  if (minutes < 60) return labels.minutesAgo(minutes);
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return labels.hoursAgo(hours);
  return labels.daysAgo(Math.floor(hours / 24));
}
