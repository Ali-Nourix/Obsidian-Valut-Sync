import { InstallInput, SetupProject, SetupResult, SetupState, SetupTransport, validateSetupResult } from './client';
import { SETUP_SCHEMA } from './schema';

export const TOKEN_SETTINGS_URL = 'https://supabase.com/dashboard/account/tokens';
const API = 'https://api.supabase.com/v1';
const REF = /^[a-z0-9]{20}$/;
/** A format check is NOT proof of the scopes selected in Supabase. */
export function isScopedPat(value: string): boolean { return /^sbp_fc[A-Za-z0-9_-]{10,512}$/.test(value); }

/** Direct, transient setup: device -> fixed Supabase endpoints, never a maintainer server. */
export class DirectInstallerClient {
  private pat: string;
  private cancelled = false;
  private busy = false;
  private expiresAt = Date.now() + 15 * 60_000;
  private expiryTimer: ReturnType<typeof setTimeout>;
  private current: SetupState = { status: 'connected', progress: [], error: null, result: null };
  constructor(pat: string, private readonly ref: string, private readonly transport: SetupTransport) {
    if (!isScopedPat(pat)) throw new Error('scoped_pat_required');
    if (!REF.test(ref)) throw new Error('invalid_project_ref');
    this.pat = pat;
    this.expiryTimer = setTimeout(() => {
      this.pat = ''; this.cancelled = true;
      if (this.current.status === 'connected') this.current = {status:'failed',progress:[],error:'session_expired',result:null};
    }, 15 * 60_000);
    (this.expiryTimer as unknown as {unref?: () => void}).unref?.();
  }
  private alive(): void {
    if (this.cancelled) throw new Error('setup_cancelled');
    if (Date.now() >= this.expiresAt) { this.pat = ''; throw new Error('session_expired'); }
  }
  private async remote(url: string, method: string, headers: Record<string,string>, body?: unknown): Promise<{status:number;data:any}> {
    this.alive();
    const u = new URL(url);
    if (u.origin !== 'https://api.supabase.com' && u.origin !== `https://${this.ref}.supabase.co`) throw new Error('invalid_setup_destination');
    let response;
    try { response = await this.transport(url, method, headers, body === undefined ? undefined : JSON.stringify(body)); }
    catch { throw new Error('supabase_unreachable'); }
    this.alive();
    return response;
  }
  private async api(method: string, suffix = '', body?: unknown): Promise<any> {
    if (!this.pat) throw new Error('session_closed');
    const response = await this.remote(`${API}/projects/${this.ref}${suffix}`,method,
      {Authorization:`Bearer ${this.pat}`,'Content-Type':'application/json'},body);
    if (response.status < 200 || response.status >= 300) throw new Error(response.status === 403 ? 'permission_denied' : response.status === 401 ? 'authorization_expired' : 'management_request_failed');
    return response.data;
  }
  private async sql(query: string): Promise<any[]> {
    const data = await this.api('POST','/database/query',{query});
    if (!Array.isArray(data)) throw new Error('invalid_query_response');
    return data;
  }
  async projects(): Promise<SetupProject[]> {
    if (this.busy || this.current.status !== 'connected') throw new Error('not_connected');
    try {
      const p = await this.api('GET');
      if ((p.id ?? p.ref) !== this.ref || typeof p.name !== 'string') throw new Error('project_not_authorized');
      return [{ref:this.ref,name:p.name,status:p.status,region:p.region}];
    } catch (e) { this.pat = ''; clearTimeout(this.expiryTimer); throw e; }
  }
  async install(input: InstallInput): Promise<void> {
    this.alive();
    if (this.busy || !this.pat || this.current.status !== 'connected') throw new Error('not_connected');
    if (input.projectRef !== this.ref || input.confirmRef !== this.ref || !input.dedicatedProject
      || !['create','existing'].includes(input.accountMode) || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.email) || input.email.length > 254
      || typeof input.password !== 'string' || input.password.length < 12 || input.password.length > 1024) throw new Error('invalid_install_confirmation');
    this.busy = true; this.current = {status:'installing',progress:[],error:null,result:null};
    // Copy input: caller still needs its sync password to sign in locally afterwards.
    void this.execute({...input});
  }
  private step(code: string): void { this.alive(); this.current.progress.push(code); }
  private async execute(input: InstallInput): Promise<void> {
    let keys: any = null;
    let login: any = null;
    try {
      this.step('checking_project');
      const p = await this.api('GET');
      if ((p.id ?? p.ref) !== this.ref) throw new Error('project_not_authorized');
      if (p.status !== 'ACTIVE_HEALTHY') throw new Error('project_not_ready');
      // Check key-reading permission BEFORE schema changes. Never create or rotate keys.
      keys = await this.api('GET',input.accountMode === 'create' ? '/api-keys?reveal=true' : '/api-keys');
      if (!Array.isArray(keys)) throw new Error('keys_unavailable');
      const publicKey = keys.find((k:any)=>k.type==='publishable')?.api_key ?? keys.find((k:any)=>k.name==='anon')?.api_key;
      const adminKey = input.accountMode === 'create' ? keys.find((k:any)=>k.type==='secret')?.api_key ?? keys.find((k:any)=>k.name==='service_role')?.api_key : null;
      if (input.accountMode === 'create' && !adminKey) throw new Error('admin_key_missing');
      validateSetupResult({projectRef:this.ref,projectUrl:`https://${this.ref}.supabase.co`,publishableKey:publicKey,email:input.email,account:'existing'});
      this.step('checking_collisions');
      const [pre] = await this.sql(`select exists (select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='vault_sync_schema_version' and p.pronargs=0) as managed,
        coalesce((select json_agg(table_name) from information_schema.tables where table_schema='public' and table_name in ('vaults','files','devices','deliveries','requests')),'[]'::json) as collisions`);
      if (!pre || (!pre.managed && pre.collisions?.length)) throw new Error('conflicting_tables');
      if (pre.managed) { const [v] = await this.sql('select public.vault_sync_schema_version() as version'); if (!v || v.version > 3) throw new Error('newer_schema_installed'); }
      this.step('installing_schema'); await this.sql(SETUP_SCHEMA);
      this.step('verifying_schema');
      const [check] = await this.sql(`select public.vault_sync_schema_version() as version,
        (select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relname in ('vaults','files','devices','deliveries','requests') and c.relrowsecurity)::int as protected_tables,
        exists (select 1 from storage.buckets where id='vault-sync' and not public) as bucket,
        exists (select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='vaults') as realtime`);
      if (!check || check.version !== 3 || check.protected_tables !== 5 || !check.bucket || !check.realtime) throw new Error('verification_failed');
      let account: 'created'|'existing' = 'existing';
      if (input.accountMode === 'create') {
        this.step('creating_account');
        const r = await this.remote(`https://${this.ref}.supabase.co/auth/v1/admin/users`,'POST',
          {apikey:adminKey,Authorization:`Bearer ${adminKey}`,'Content-Type':'application/json'},
          {email:input.email,password:input.password,email_confirm:true});
        if (r.status >= 200 && r.status < 300) account = 'created';
        else if (![409,422].includes(r.status) || !['email_exists','user_already_exists'].includes(r.data?.code ?? r.data?.error_code)) throw new Error('account_creation_failed');
      }
      this.step('checking_account');
      login = await this.remote(`https://${this.ref}.supabase.co/auth/v1/token?grant_type=password`,'POST',
        {apikey:publicKey,'Content-Type':'application/json'},{email:input.email,password:input.password});
      if (login.status < 200 || login.status >= 300 || !login.data?.access_token) throw new Error('sync_sign_in_failed');
      // Revoke only the temporary verification session, not other devices' sessions.
      const out = await this.remote(`https://${this.ref}.supabase.co/auth/v1/logout?scope=local`,'POST',
        {apikey:publicKey,Authorization:`Bearer ${login.data.access_token}`});
      if (out.status < 200 || out.status >= 300) throw new Error('verification_logout_failed');
      login = null;
      this.step('complete');
      this.current.result = validateSetupResult({projectRef:this.ref,projectUrl:`https://${this.ref}.supabase.co`,publishableKey:publicKey,email:input.email,account});
      this.current.status = 'complete';
    } catch (e) {
      this.current.status = 'failed'; this.current.error = e instanceof Error && /^[a-z_]{1,60}$/.test(e.message) ? e.message : 'installation_failed';
    } finally { input.password = ''; keys = null; login = null; this.pat = ''; clearTimeout(this.expiryTimer); this.busy = false; }
  }
  async state(): Promise<SetupState> { return {...this.current,progress:[...this.current.progress],result:this.current.result ? {...this.current.result} : null}; }
  async close(): Promise<void> { this.cancelled = true; this.pat = ''; clearTimeout(this.expiryTimer); this.current.result = null; }
}
