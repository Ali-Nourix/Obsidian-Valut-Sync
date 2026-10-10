import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';

const API = 'https://api.supabase.com/v1';
const REF = /^[a-z0-9]{20}$/;
const REGION_GROUPS = new Set(['americas', 'emea', 'apac']);
const TTL = 15 * 60_000;
const token = () => randomBytes(32).toString('base64url');
const hash = (value) => createHash('sha256').update(value).digest();
class Problem extends Error {
  constructor(code, status = 400) { super(code); this.status = status; }
}
const fail = (code, status) => { throw new Problem(code, status); };
const project = (p) => ({ ref: p.id ?? p.ref, name: p.name, status: p.status, region: p.region });
const validEmail = (email) => typeof email === 'string' && email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);

/** In-memory, single-instance OAuth installer. Never use these secrets in the plugin. */
export function createInstaller({ clientId, clientSecret, publicUrl, schema, fetchImpl = fetch,
  now = Date.now, allowProjectCreation = false, sessionTtlMs = TTL, waitUntil = () => {} }) {
  const base = new URL(publicUrl);
  if (base.username || base.password || base.search || base.hash || base.pathname !== '/') fail('invalid_public_url');
  const loopback = ['localhost', '127.0.0.1'].includes(base.hostname);
  if (base.protocol !== 'https:' && !(loopback && base.protocol === 'http:')) fail('https_required');
  if (!clientId || !clientSecret || !schema || !Number.isFinite(sessionTtlMs) || sessionTtlMs <= 0 || sessionTtlMs > TTL) fail('missing_configuration');
  const redirectUri = new URL('/oauth/callback', base).href;
  const sessions = new Map();
  const states = new Map();
  const rate = new Map();
  const origins = new Set(['app://obsidian.md', 'capacitor://localhost', base.origin]);

  function forget(s) {
    s.accessToken = null;
    s.verifier = null;
    states.delete(s.state);
    sessions.delete(s.id);
  }
  function sweep() {
    for (const s of sessions.values()) if (s.expiresAt <= now() && !s.busy) forget(s);
    for (const [ip, r] of rate) if (r.until <= now()) rate.delete(ip);
  }
  function getSession(req, id) {
    const s = sessions.get(id);
    const supplied = (req.headers.authorization ?? '').replace(/^Bearer /, '');
    if (!s || !timingSafeEqual(hash(supplied), s.pollHash)) fail('session_not_found', 401);
    if (s.expiresAt <= now()) { if (!s.busy) forget(s); fail('session_expired', 401); }
    return s;
  }
  function connected(s) {
    if (s.status !== 'connected' || !s.accessToken || s.busy) fail('not_connected', 409);
  }
  function summary(s) {
    return { status: s.status, expiresAt: s.expiresAt, progress: [...s.progress],
      error: s.error ?? null, result: s.result ?? null };
  }
  async function remote(url, options = {}) {
    let response;
    try { response = await fetchImpl(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(120_000) }); }
    catch { fail('upstream_unreachable', 502); }
    let data = null;
    try { data = await response.json(); } catch { /* never echo response bodies */ }
    return { response, data };
  }
  function alive(s) {
    if (s.cancelled) fail('setup_cancelled', 409);
    if (s.expiresAt <= now()) fail('session_expired', 401);
  }
  async function api(s, method, path, body) {
    alive(s);
    if (!s.accessToken) fail('not_connected', 409);
    const { response, data } = await remote(`${API}${path}`, {
      method, headers: { Authorization: `Bearer ${s.accessToken}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!response.ok) fail(response.status === 403 ? 'permission_denied' : response.status === 401 ? 'authorization_expired' : 'management_request_failed', 502);
    return data;
  }
  const sql = (s, ref, query) => api(s, 'POST', `/projects/${ref}/database/query`, { query });
  function step(s, code) { alive(s); s.progress.push(code); }

  async function install(s, input) {
    let keys = null;
    try {
      step(s, 'checking_project');
      const p = await api(s, 'GET', `/projects/${input.projectRef}`);
      if (p.status !== 'ACTIVE_HEALTHY') fail('project_not_ready', 409);
      step(s, 'checking_collisions');
      const [pre] = await sql(s, input.projectRef, `select
        exists (select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
          where n.nspname='public' and p.proname='vault_sync_schema_version' and p.pronargs=0) as managed,
        coalesce((select json_agg(table_name) from information_schema.tables where table_schema='public'
          and table_name in ('vaults','files','devices','deliveries','requests')), '[]'::json) as collisions`);
      if (!pre || (!pre.managed && pre.collisions?.length)) fail('conflicting_tables', 409);
      if (pre.managed) {
        const [v] = await sql(s, input.projectRef, 'select public.vault_sync_schema_version() as version');
        if (v.version > 3) fail('newer_schema_installed', 409);
      }
      step(s, 'installing_schema');
      await sql(s, input.projectRef, schema);
      step(s, 'verifying_schema');
      const [check] = await sql(s, input.projectRef, `select public.vault_sync_schema_version() as version,
        (select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace
          where n.nspname='public' and c.relname in ('vaults','files','devices','deliveries','requests') and c.relrowsecurity)::int as protected_tables,
        exists (select 1 from storage.buckets where id='vault-sync' and not public) as bucket,
        exists (select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='vaults') as realtime`);
      if (!check || check.version !== 3 || check.protected_tables !== 5 || !check.bucket || !check.realtime) fail('verification_failed', 502);
      keys = await api(s, 'GET', `/projects/${input.projectRef}/api-keys?reveal=true`);
      if (!Array.isArray(keys)) fail('keys_unavailable', 502);
      const publishable = keys.find(k => k.type === 'publishable')?.api_key ?? keys.find(k => k.name === 'anon')?.api_key;
      const publicRole = (() => { try { return JSON.parse(Buffer.from(publishable.split('.')[1], 'base64url').toString()).role; } catch { return null; } })();
      if (!publishable || (!publishable.startsWith('sb_publishable_') && publicRole !== 'anon')) fail('publishable_key_missing', 502);
      let account = 'existing';
      if (input.accountMode === 'create') {
        step(s, 'creating_account');
        const secret = keys.find(k => k.type === 'secret')?.api_key ?? keys.find(k => k.name === 'service_role')?.api_key;
        if (!secret) fail('admin_key_missing', 502);
        const { response, data } = await remote(`https://${input.projectRef}.supabase.co/auth/v1/admin/users`, {
          method: 'POST', headers: { apikey: secret, Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: input.email, password: input.password, email_confirm: true }),
        });
        if (response.ok) account = 'created';
        else if ([409, 422].includes(response.status) && ['email_exists', 'user_already_exists'].includes(data?.code ?? data?.error_code)) account = 'existing';
        else fail('account_creation_failed', 502);
      }
      // Verify ownership of the sync account before closing sign-ups or returning success.
      step(s, 'checking_account');
      const login = await remote(`https://${input.projectRef}.supabase.co/auth/v1/token?grant_type=password`, {
        method: 'POST', headers: { apikey: publishable, 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: input.email, password: input.password }),
      });
      if (!login.response.ok || !login.data?.access_token) fail('sync_sign_in_failed', 409);
      // Revoke this temporary verification session; the plugin signs in independently.
      await remote(`https://${input.projectRef}.supabase.co/auth/v1/logout?scope=local`, {
        method: 'POST', headers: { apikey: publishable, Authorization: `Bearer ${login.data.access_token}` },
      });
      login.data = null;
      if (input.closeSignups === true) {
        step(s, 'closing_signups');
        await api(s, 'PATCH', `/projects/${input.projectRef}/config/auth`, { disable_signup: true });
      }
      s.result = { projectRef: input.projectRef, projectUrl: `https://${input.projectRef}.supabase.co`,
        publishableKey: publishable, email: input.email, account };
      s.status = 'complete';
      step(s, 'complete');
    } catch (error) {
      s.status = 'failed';
      s.error = error instanceof Problem ? error.message : 'installation_failed';
    } finally {
      // No password, admin key, OAuth token or refresh token is included in results/logs.
      input.password = '';
      keys = null;
      s.accessToken = null;
      s.verifier = null;
      s.busy = false;
      if (s.expiresAt <= now() || s.cancelled) forget(s);
    }
  }

  async function body(req) {
    let size = 0; const chunks = [];
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 16_384) fail('body_too_large', 413);
      chunks.push(chunk);
    }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); }
    catch { fail('invalid_json'); }
  }
  function json(res, status, data) {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(data));
  }
  function callbackPage(res, ok, sessionId, approval) {
    res.writeHead(ok ? 200 : 400, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'" });
    const returnLink = ok ? `obsidian://vault-sync-setup?session=${sessionId}&approval=${approval}` : '';
    res.end(`<!doctype html><meta charset="utf-8"><title>Vault Sync</title><h1>${ok ? 'Finish connecting Supabase' : 'Connection failed'}</h1><p>${ok ? 'Return to the Obsidian window that started this setup. Never share this connection code.' : 'Return to Obsidian and start a new connection.'}</p>${ok ? `<p><a href="${returnLink}">Return to Obsidian and approve this connection</a></p><p>If the button does not open Obsidian, paste this one-time connection code into your setup window:</p><code id="approval">${approval}</code>` : ''}`);
  }

  async function handle(req, res) {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    const origin = req.headers.origin;
    if (origin && !origins.has(origin)) return json(res, 403, { error: 'origin_denied' });
    if (origin) { res.setHeader('Access-Control-Allow-Origin', origin); res.setHeader('Vary', 'Origin'); }
    if (req.method === 'OPTIONS') {
      res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
      res.writeHead(204); return res.end();
    }
    try {
      sweep();
      const url = new URL(req.url, base);
      if (url.pathname === '/health' && req.method === 'GET') return json(res, 200, { ready: true, protocol: 1, allowProjectCreation });
      if (url.pathname === '/v1/sessions' && req.method === 'POST') {
        const ip = req.socket.remoteAddress ?? 'unknown';
        if (!rate.has(ip) && rate.size >= 10_000) fail('try_later', 429);
        const r = rate.get(ip) ?? { count: 0, until: now() + 60_000 };
        if (++r.count > 10 || sessions.size >= 200) fail('try_later', 429);
        rate.set(ip, r);
        const id = token(), pollToken = token(), state = token(), verifier = token();
        const s = { id, pollHash: hash(pollToken), state, verifier, status: 'pending',
          expiresAt: now() + sessionTtlMs, accessToken: null, busy: false, progress: [], result: null, error: null };
        sessions.set(id, s); states.set(state, id);
        const authorize = new URL(`${API}/oauth/authorize`);
        authorize.search = new URLSearchParams({ client_id: clientId, response_type: 'code', redirect_uri: redirectUri,
          state, code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256' });
        return json(res, 201, { sessionId: id, pollToken, authorizationUrl: authorize.href, expiresAt: s.expiresAt });
      }
      if (url.pathname === '/oauth/callback' && req.method === 'GET') {
        const state = url.searchParams.get('state');
        const s = sessions.get(states.get(state));
        if (!s || s.status !== 'pending' || s.expiresAt <= now()) return callbackPage(res, false);
        states.delete(state); // one-use state, consumed before any network await
        const code = url.searchParams.get('code');
        if (!code || code.length > 4096 || url.searchParams.has('error')) {
          s.status = 'failed'; s.error = 'authorization_denied'; s.verifier = null;
          return callbackPage(res, false);
        }
        let exchanged;
        try { exchanged = await remote(`${API}/oauth/token`, {
          method: 'POST', headers: { Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
            'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirectUri, code_verifier: s.verifier }).toString(),
        }); } catch {
          s.status = 'failed'; s.error = 'authorization_failed'; s.verifier = null;
          return callbackPage(res, false);
        }
        s.verifier = null;
        if (!exchanged.response.ok || !exchanged.data?.access_token || s.expiresAt <= now() || sessions.get(s.id) !== s) {
          if (sessions.has(s.id)) { s.status = 'failed'; s.error = 'authorization_failed'; }
          return callbackPage(res, false);
        }
        s.accessToken = exchanged.data.access_token; // refresh token deliberately discarded
        const approval = token(); s.approvalHash = hash(approval); s.confirmAttempts = 0;
        // OAuth alone does not authorize the poller: prove the browser returned to this device.
        s.status = 'awaiting-confirmation'; return callbackPage(res, true, s.id, approval);
      }
      const match = /^\/v1\/sessions\/([A-Za-z0-9_-]+)(?:\/(projects|organizations|install|confirm))?$/.exec(url.pathname);
      if (!match) fail('not_found', 404);
      const s = getSession(req, match[1]);
      const resource = match[2];
      if (resource === 'confirm' && req.method === 'POST') {
        if (s.status !== 'awaiting-confirmation' || !s.approvalHash) fail('confirmation_not_pending', 409);
        const input = await body(req);
        if (typeof input.approval !== 'string' || !timingSafeEqual(hash(input.approval), s.approvalHash)) {
          if (++s.confirmAttempts >= 5) forget(s);
          fail('invalid_browser_confirmation', 403);
        }
        s.approvalHash = null; s.status = 'connected';
        return json(res, 200, { connected: true });
      }
      if (!resource && req.method === 'GET') return json(res, 200, summary(s));
      if (!resource && req.method === 'DELETE') {
        if (s.busy) { s.cancelled = true; return json(res, 202, { disconnected: true, operationMayHaveStarted: true }); }
        forget(s); return json(res, 200, { disconnected: true });
      }
      if (resource === 'projects' && req.method === 'GET') {
        connected(s); const list = await api(s, 'GET', '/projects');
        if (!Array.isArray(list)) fail('projects_unavailable', 502);
        return json(res, 200, { projects: list.filter(p => REF.test(p.id ?? p.ref)).map(project) });
      }
      if (resource === 'organizations' && req.method === 'GET') {
        connected(s); if (!allowProjectCreation) fail('creation_disabled', 403);
        const list = await api(s, 'GET', '/organizations');
        return json(res, 200, { organizations: list.map(o => ({ slug: o.slug ?? o.id, name: o.name })) });
      }
      if (resource === 'projects' && req.method === 'POST') {
        connected(s); if (!allowProjectCreation) fail('creation_disabled', 403);
        const input = await body(req);
        if (typeof input.name !== 'string' || !input.name.trim() || input.name.length > 100 || !REGION_GROUPS.has(input.region)
          || typeof input.databasePassword !== 'string' || input.databasePassword.length < 16 || input.databasePassword.length > 128
          || input.acceptCosts !== true || input.confirmName !== input.name) fail('invalid_project_confirmation');
        const orgs = await api(s, 'GET', '/organizations');
        if (!orgs.some(o => (o.slug ?? o.id) === input.organizationSlug)) fail('organization_not_authorized', 403);
        connected(s);
        s.busy = true;
        try {
          const p = await api(s, 'POST', '/projects', { name: input.name, organization_slug: input.organizationSlug,
            db_pass: input.databasePassword, region_selection: { type: 'smartGroup', code: input.region } });
          if (!REF.test(p.id ?? p.ref)) fail('invalid_project_response', 502);
          return json(res, 201, { project: project(p) });
        } finally { input.databasePassword = ''; s.busy = false; if (s.cancelled) forget(s); }
      }
      if (resource === 'install' && req.method === 'POST') {
        connected(s);
        const input = await body(req);
        if (!REF.test(input.projectRef) || input.confirmRef !== input.projectRef || input.dedicatedProject !== true
          || !validEmail(input.email) || !['create', 'existing'].includes(input.accountMode)
          || typeof input.password !== 'string' || input.password.length < 12 || input.password.length > 1024
          || typeof input.closeSignups !== 'boolean') fail('invalid_install_confirmation');
        // Refresh permission listing before any mutation; do not trust refs supplied by a client.
        const list = await api(s, 'GET', '/projects');
        if (!list.some(p => (p.id ?? p.ref) === input.projectRef)) fail('project_not_authorized', 403);
        // Serialize concurrent requests including awaits above.
        connected(s);
        s.busy = true; s.status = 'installing'; s.progress = []; s.error = null;
        const task = install(s, input);
        waitUntil(task); // Keep async installation alive in serverless runtimes.
        return json(res, 202, { accepted: true });
      }
      fail('method_not_allowed', 405);
    } catch (error) {
      if (!res.headersSent) json(res, error instanceof Problem ? error.status : 500,
        { error: error instanceof Problem ? error.message : 'installer_error' });
      else res.end();
    }
  }
  return { handle, sweep, close() { for (const s of sessions.values()) forget(s); rate.clear(); } };
}
