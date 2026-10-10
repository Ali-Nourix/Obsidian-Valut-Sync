/** Public installer address only. OAuth secrets are server-side bindings. */
export const DEFAULT_INSTALLER_URL = 'https://vault-sync-installer.alinorizadeh1384.workers.dev';

export type SetupStatus = 'pending' | 'awaiting-confirmation' | 'connected' | 'installing' | 'complete' | 'failed';
export interface SetupProject { ref: string; name: string; status: string; region?: string; }
export interface SetupOrganization { slug: string; name: string; }
export interface SetupResult {
  projectRef: string; projectUrl: string; publishableKey: string; email: string; account: 'created' | 'existing';
}
export interface SetupState { status: SetupStatus; progress: string[]; error: string | null; result: SetupResult | null; }
export interface InstallInput {
  projectRef: string; confirmRef: string; dedicatedProject: boolean;
  email: string; password: string; accountMode: 'create' | 'existing'; closeSignups: boolean;
}
export type SetupTransport = (url: string, method: string, headers: Record<string, string>, body?: string) => Promise<{ status: number; data: unknown }>;

export function installerOrigin(value: string): string {
  const url = new URL(value.trim());
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('invalid_installer_url');
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname))) throw new Error('installer_https_required');
  return url.origin;
}
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

/** Only an ephemeral installer capability lives here. OAuth/admin credentials stay server-side. */
export class InstallerClient {
  private session: { id: string; capability: string } | null = null;
  private generation = 0;
  readonly origin: string;
  constructor(origin: string, private readonly transport: SetupTransport) { this.origin = installerOrigin(origin); }

  private async request(path: string, method = 'GET', body?: unknown, capability?: string): Promise<any> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (capability) headers.Authorization = `Bearer ${capability}`;
    let response;
    try { response = await this.transport(this.origin + path, method, headers, body === undefined ? undefined : JSON.stringify(body)); }
    catch { throw new Error('installer_unreachable'); }
    if (response.status < 200 || response.status >= 300) {
      const error = (response.data as { error?: unknown })?.error;
      throw new Error(typeof error === 'string' && /^[a-z_]{1,60}$/.test(error) ? error : 'installer_request_failed');
    }
    return response.data;
  }
  private credentials(): { path: string; capability: string } {
    if (!this.session) throw new Error('session_closed');
    return { path: `/v1/sessions/${this.session.id}`, capability: this.session.capability };
  }
  async health(): Promise<{ allowProjectCreation: boolean }> {
    const h = await this.request('/health');
    if (h?.protocol === 1 && h.ready === false && h.error === 'installer_not_configured') throw new Error('installer_not_configured');
    if (h?.protocol !== 1 || h.ready !== true) throw new Error('unsupported_installer');
    return { allowProjectCreation: h.allowProjectCreation === true };
  }
  async begin(): Promise<string> {
    await this.close();
    const generation = this.generation;
    const s = await this.request('/v1/sessions', 'POST', {});
    if (!/^[A-Za-z0-9_-]{40,64}$/.test(s?.sessionId) || !/^[A-Za-z0-9_-]{40,64}$/.test(s?.pollToken)) throw new Error('invalid_setup_session');
    const url = new URL(s.authorizationUrl);
    if (url.origin !== 'https://api.supabase.com' || url.pathname !== '/v1/oauth/authorize') throw new Error('invalid_authorization_url');
    if (this.generation !== generation) {
      await this.request(`/v1/sessions/${s.sessionId}`, 'DELETE', undefined, s.pollToken).catch(() => {});
      throw new Error('session_closed');
    }
    this.session = { id: s.sessionId, capability: s.pollToken };
    return url.href;
  }
  ownsSession(id: string): boolean { return this.session?.id === id; }
  async confirmBrowser(approval: string): Promise<void> {
    if (!/^[A-Za-z0-9_-]{40,64}$/.test(approval)) throw new Error('invalid_browser_confirmation');
    const { path, capability } = this.credentials();
    await this.request(path + '/confirm', 'POST', { approval }, capability);
  }
  async state(): Promise<SetupState> {
    const { path, capability } = this.credentials();
    const value = await this.request(path, 'GET', undefined, capability);
    if (!['pending', 'awaiting-confirmation', 'connected', 'installing', 'complete', 'failed'].includes(value?.status) || !Array.isArray(value.progress)) throw new Error('invalid_setup_state');
    const result = value.status === 'complete' ? validateSetupResult(value.result) : null;
    return { status: value.status, progress: value.progress.filter((x: unknown) => typeof x === 'string'), error: value.error, result };
  }
  async projects(): Promise<SetupProject[]> {
    const { path, capability } = this.credentials();
    const data = await this.request(path + '/projects', 'GET', undefined, capability);
    if (!Array.isArray(data?.projects)) throw new Error('invalid_project_list');
    return data.projects.filter((p: SetupProject) => /^[a-z0-9]{20}$/.test(p.ref) && typeof p.name === 'string');
  }
  async organizations(): Promise<SetupOrganization[]> {
    const { path, capability } = this.credentials();
    const data = await this.request(path + '/organizations', 'GET', undefined, capability);
    if (!Array.isArray(data?.organizations)) throw new Error('invalid_organization_list');
    return data.organizations;
  }
  async createProject(input: { name: string; confirmName: string; organizationSlug: string; region: string; databasePassword: string; acceptCosts: boolean }): Promise<SetupProject> {
    const { path, capability } = this.credentials();
    const result = await this.request(path + '/projects', 'POST', input, capability);
    if (!/^[a-z0-9]{20}$/.test(result?.project?.ref)) throw new Error('invalid_project_response');
    return result.project;
  }
  async install(input: InstallInput): Promise<void> {
    const { path, capability } = this.credentials();
    await this.request(path + '/install', 'POST', input, capability);
  }
  async close(): Promise<void> {
    ++this.generation;
    const s = this.session;
    this.session = null;
    if (s) await this.request(`/v1/sessions/${s.id}`, 'DELETE', undefined, s.capability).catch(() => {});
  }
}
