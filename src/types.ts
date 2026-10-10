// ── types.ts ──────────────────────────────────────────────────────────────
// Plugin settings, saved in data.json. Nothing here is secret or tied to one
// device: the session, device id and remembered keys live in device-local
// storage (see obsidian/device-store.ts).
// ─────────────────────────────────────────────────────────────────────────────

import { DEFAULT_INSTALLER_URL } from './onboarding/client';
import { EncryptionHeader } from './core/crypto';

export type Language = 'en' | 'fa';

export interface VaultSyncSettings {
  language: Language;
  /** Public URL of a trusted OAuth installer; never an API/admin key. */
  installerUrl: string;
  /** Project URL, e.g. https://abcd.supabase.co */
  supabaseUrl: string;
  /** The publishable (anon) key. Never the secret / service-role key. */
  supabaseKey: string;
  /** Remembered for the sign-in form only. */
  email: string;
  vaultId: string | null;
  vaultName: string;
  /** A copy of the vault's encryption header, so a locked vault is recognised offline. */
  vaultEncryption: EncryptionHeader | null;
  autoSync: boolean;
  /** Safety-net interval; 0 turns it off. */
  intervalMinutes: number;
  /** Listen for other devices' commits through Supabase Realtime. */
  realtime: boolean;
  excludedFolders: string[];
  maxFileSizeMB: number;
  massDeleteCount: number;
  massDeletePercent: number;
}

export const DEFAULT_SETTINGS: VaultSyncSettings = {
  language: 'en',
  installerUrl: DEFAULT_INSTALLER_URL,
  supabaseUrl: '',
  supabaseKey: '',
  email: '',
  vaultId: null,
  vaultName: '',
  vaultEncryption: null,
  autoSync: true,
  intervalMinutes: 15,
  realtime: true,
  excludedFolders: [],
  maxFileSizeMB: 50,
  massDeleteCount: 50,
  massDeletePercent: 25,
};
