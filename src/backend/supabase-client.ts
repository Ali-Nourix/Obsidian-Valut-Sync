// ── backend/supabase-client.ts ────────────────────────────────────────────
// The connection to a Supabase project: URL and key checks, the supabase-js
// client, and the signed-in session. The session is kept in device-local
// storage (not data.json): Supabase rotates refresh tokens and revokes both
// sessions if two devices ever present the same one, which a copied plugin
// folder would cause.
// ─────────────────────────────────────────────────────────────────────────────

import { createClient, Session, SupabaseClient, SupportedStorage } from '@supabase/supabase-js';

/** Accepts a full project URL or a bare project ref, and drops trailing slashes. */
export function normalizeProjectUrl(input: string): string {
  const value = input.trim().replace(/\/+$/, '');
  if (/^[a-z0-9]{20}$/.test(value)) return `https://${value}.supabase.co`;
  return value.replace(/\/(rest|auth|storage|realtime)\/v1.*$/, '');
}

export function isProjectUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' || parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1';
  } catch {
    return false;
  }
}

function jwtRole(key: string): string | null {
  const parts = key.split('.');
  if (parts.length !== 3) return null;
  try {
    const json = atob(parts[1].replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(parts[1].length / 4) * 4, '='));
    return JSON.parse(json).role ?? null;
  } catch {
    return null;
  }
}

export type KeyProblem = 'empty' | 'secret' | null;

/**
 * Only the publishable (anon) key belongs in the plugin. A secret or
 * service-role key bypasses row level security and must never sit on a phone.
 */
export function keyProblem(key: string): KeyProblem {
  const value = key.trim();
  if (!value) return 'empty';
  if (value.startsWith('sb_secret_') || jwtRole(value) === 'service_role') return 'secret';
  return null;
}

export class SupabaseConnection {
  readonly client: SupabaseClient;

  constructor(url: string, key: string, storage: SupportedStorage) {
    this.client = createClient(url, key.trim(), {
      auth: {
        storage,
        storageKey: 'vault-sync-auth',
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: false,
      },
    });
  }

  async session(): Promise<Session | null> {
    const { data } = await this.client.auth.getSession();
    return data.session;
  }

  async signIn(email: string, password: string): Promise<Session> {
    const { data, error } = await this.client.auth.signInWithPassword({ email: email.trim(), password });
    if (error || !data.session) throw error ?? new Error('Sign-in returned no session');
    return data.session;
  }

  /** Returns null when the project requires the email address to be confirmed first. */
  async signUp(email: string, password: string): Promise<Session | null> {
    const { data, error } = await this.client.auth.signUp({ email: email.trim(), password });
    if (error) throw error;
    return data.session;
  }

  async signOut(): Promise<void> {
    await this.client.auth.signOut({ scope: 'local' });
  }

  /** Token refresh only runs while the app is in the foreground. */
  setForeground(foreground: boolean): void {
    if (foreground) void this.client.auth.startAutoRefresh();
    else void this.client.auth.stopAutoRefresh();
  }

  async close(): Promise<void> {
    await this.client.auth.stopAutoRefresh();
    await this.client.removeAllChannels();
  }
}
