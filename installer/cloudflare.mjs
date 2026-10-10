import { createInstaller } from './core.mjs';
import schema from './schema-bundle.mjs';

const headers = { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff' };
const reply = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { ...headers, 'Content-Type': 'application/json' } });

// One coordinator, rather than a Map in each randomly routed Worker isolate.
// Credentials are deliberately never written to Durable Object storage.
export class InstallerCoordinator {
  constructor(ctx, env) { this.ctx = ctx; this.env = env; this.installer = null; this.alarmUntil = 0; }
  async fetch(request) {
    if (!this.installer) {
      this.installer = createInstaller({
        clientId: this.env.SUPABASE_OAUTH_CLIENT_ID,
        clientSecret: this.env.SUPABASE_OAUTH_CLIENT_SECRET,
        publicUrl: this.env.INSTALLER_PUBLIC_URL,
        schema,
        allowProjectCreation: this.env.INSTALLER_ALLOW_PROJECT_CREATION === 'true',
        waitUntil: task => this.ctx.waitUntil(task),
      });
    }
    // Only an expiry timestamp is durable; no OAuth credentials or passwords.
    // Stop recurring alarms after all 15-minute sessions have expired.
    this.alarmUntil = Date.now() + 16 * 60_000;
    await this.ctx.storage.put('cleanupUntil', this.alarmUntil);
    if (await this.ctx.storage.getAlarm() === null) await this.ctx.storage.setAlarm(Date.now() + 60_000);
    const url = new URL(request.url);
    const req = {
      method: request.method, url: url.pathname + url.search,
      headers: Object.fromEntries(request.headers),
      // CF-Connecting-IP is set by Cloudflare on external ingress, never X-Forwarded-For.
      socket: { remoteAddress: request.headers.get('CF-Connecting-IP') || 'unknown' },
      async *[Symbol.asyncIterator]() {
        if (!request.body) return;
        const reader = request.body.getReader();
        try { while (true) { const {value, done} = await reader.read(); if (done) break; yield Buffer.from(value); } }
        finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
      },
    };
    return new Promise((resolve, reject) => {
      const responseHeaders = new Headers(headers);
      let status = 200;
      const res = {
        headersSent: false,
        setHeader(name, value) { responseHeaders.set(name, value); },
        writeHead(code, values = {}) { status = code; this.headersSent = true; for (const [k,v] of Object.entries(values)) responseHeaders.set(k,v); },
        end(value) { resolve(new Response([204,304].includes(status) ? null : value ?? null, { status, headers: responseHeaders })); },
      };
      this.installer.handle(req, res).catch(reject);
    });
  }
  async alarm() {
    this.installer?.sweep();
    const until = await this.ctx.storage.get('cleanupUntil') || 0;
    if (until > Date.now()) await this.ctx.storage.setAlarm(Date.now() + 60_000);
    else await this.ctx.storage.delete('cleanupUntil');
  }
}

export default {
  async fetch(request, env) {
    try {
      const url = new URL(request.url);
      if (url.origin !== env.INSTALLER_PUBLIC_URL) return reply({ error: 'invalid_host' }, 421);
      const configured = Boolean(env.SUPABASE_OAUTH_CLIENT_ID && env.SUPABASE_OAUTH_CLIENT_SECRET);
      const origin = request.headers.get('Origin');
      const allowed = ['app://obsidian.md', 'capacitor://localhost', url.origin];
      if (origin && !allowed.includes(origin)) return reply({error:'origin_denied'}, 403);
      if (url.pathname === '/health' && request.method === 'GET') {
        const r = reply({ ready: configured, protocol: 1, allowProjectCreation: configured && env.INSTALLER_ALLOW_PROJECT_CREATION === 'true', ...(configured ? {} : { error: 'installer_not_configured' }) });
        if (origin) { r.headers.set('Access-Control-Allow-Origin', origin); r.headers.set('Vary','Origin'); }
        return r;
      }
      if (!configured) return reply({ error: 'installer_not_configured' }, 503);
      if (request.headers.has('Content-Length') && Number(request.headers.get('Content-Length')) > 16_384) return reply({error:'body_too_large'}, 413);
      if (!/^\/(oauth\/callback|v1\/sessions(?:\/[A-Za-z0-9_-]+(?:\/(projects|organizations|install|confirm))?)?)$/.test(url.pathname)) return reply({error:'not_found'},404);
      const id = env.INSTALLER_COORDINATOR.idFromName('vault-sync-installer-v1');
      return await env.INSTALLER_COORDINATOR.get(id).fetch(request);
    } catch { return reply({ error: 'installer_unavailable' }, 503); }
  },
};
