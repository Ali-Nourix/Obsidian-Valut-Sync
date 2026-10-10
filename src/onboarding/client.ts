export type SetupStatus = 'connected' | 'installing' | 'complete' | 'failed';
export interface SetupProject { ref: string; name: string; status: string; region?: string; }
export interface SetupResult {
  projectRef: string; projectUrl: string; publishableKey: string; email: string; account: 'created' | 'existing';
}
export interface SetupState { status: SetupStatus; progress: string[]; error: string | null; result: SetupResult | null; }
export interface InstallInput {
  projectRef: string; confirmRef: string; dedicatedProject: boolean;
  email: string; password: string; accountMode: 'create' | 'existing';
}
export type SetupTransport = (url: string, method: string, headers: Record<string, string>, body?: string) => Promise<{ status: number; data: unknown }>;

export function isPublicKey(key: string): boolean {
  if (key.startsWith('sb_publishable_')) return true;
  try {
    const payload = key.split('.')[1];
    return key.split('.').length === 3 && JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(payload.length / 4) * 4, '='))).role === 'anon';
  } catch { return false; }
}
export function validateSetupResult(value: unknown): SetupResult {
  const r = value as SetupResult;
  if (!r || !/^[a-z0-9]{20}$/.test(r.projectRef) || r.projectUrl !== `https://${r.projectRef}.supabase.co`
    || typeof r.publishableKey !== 'string' || !isPublicKey(r.publishableKey) || typeof r.email !== 'string'
    || !['created', 'existing'].includes(r.account)) throw new Error('invalid_setup_result');
  return { projectRef: r.projectRef, projectUrl: r.projectUrl, publishableKey: r.publishableKey, email: r.email, account: r.account };
}

