import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createInstaller } from '../installer/core.mjs';

const REF = 'abcdefghijklmnopqrst';
const OTHER = 'qrstabcdefghijklmnop';
const oauthAccess = 'fixture-management-value';
const adminKey = 'sb_secret_' + 'fixture-admin-value';
const publicKey = 'sb_publishable_' + 'fixture-public-value';
const password = 'fixture-sync-password';
const schema = readFileSync(new URL('../supabase/schema.sql', import.meta.url), 'utf8');

async function fixture(options = {}) {
  const calls = [];
  let clock = 1_000_000;
  let healthy = options.healthy ?? true;
  let verifyPending;
  const waitVerify = options.pauseVerify ? new Promise(resolve => { verifyPending = resolve; }) : null;
  const upstream = async (url, init) => {
    const path = new URL(url).pathname;
    const data = init?.body && (init.headers['Content-Type'] === 'application/x-www-form-urlencoded'
      ? Object.fromEntries(new URLSearchParams(init.body)) : JSON.parse(init.body));
    calls.push({ path, method: init?.method, data, headers: init?.headers });
    const reply = (data, status = 200) => new Response(JSON.stringify(data), { status });
    if (options.networkFailure) throw new Error('private-network-marker');
    if (path === '/v1/oauth/token') return reply({ access_token: oauthAccess, refresh_token: 'fixture-refresh-value' });
    if (path === '/v1/organizations') return reply([{ id: 'organization-ref', slug: 'my-org', name: 'My org' }]);
    if (path === '/v1/projects' && init.method === 'POST') return reply({ id: OTHER, name: data.name, status: 'COMING_UP', region: 'emea' }, 201);
    if (path === '/v1/projects') return reply([{ id: REF, name: 'Fixture', status: healthy ? 'ACTIVE_HEALTHY' : 'COMING_UP' }]);
    if (path === `/v1/projects/${REF}`) return reply({ id: REF, name: 'Fixture', status: healthy ? 'ACTIVE_HEALTHY' : 'COMING_UP' });
    if (path.endsWith('/database/query')) {
      if (data.query === schema) return reply([]);
      if (data.query.includes('as collisions')) return reply([{ managed: !!options.managed, collisions: options.collision ? ['files'] : [] }]);
      if (data.query.includes('protected_tables')) {
        if (waitVerify) await waitVerify;
        return reply([{ version: 3, protected_tables: options.badRls ? 4 : 5, bucket: true, realtime: true }]);
      }
      return reply([{ version: options.futureSchema ? 4 : 3 }]);
    }
    if (path.endsWith('/api-keys')) return reply([{ type: 'publishable', api_key: publicKey }, { type: 'secret', api_key: adminKey }]);
    if (path.endsWith('/admin/users')) return options.accountExists ? reply({ code: 'email_exists', message: 'private-response-marker' }, 422) : reply({ id: 'user' }, 201);
    if (path.endsWith('/auth/v1/token')) return options.badLogin ? reply({ message: 'private-response-marker' }, 400) : reply({ access_token: 'fixture-project-login-value' });
    if (path.endsWith('/auth/v1/logout')) return reply({});
    if (path.endsWith('/config/auth')) return reply({});
    return reply({ message: 'private-response-marker' }, 403);
  };
  const instance = createInstaller({ clientId: 'fixture-client', clientSecret: 'fixture-oauth-secret',
    publicUrl: 'https://installer.example.org', schema, fetchImpl: upstream, now: () => clock,
    allowProjectCreation: options.creation ?? false });
  const server = createServer(instance.handle);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const request = async (path, method = 'GET', data, capability, extraHeaders = {}) => {
    const response = await fetch(origin + path, { method, headers: { 'Content-Type': 'application/json',
      ...(capability ? { Authorization: `Bearer ${capability}` } : {}), ...extraHeaders }, body: data === undefined ? undefined : JSON.stringify(data) });
    const text = await response.text();
    let body; try { body = JSON.parse(text); } catch { body = text; }
    return { status: response.status, body, headers: response.headers };
  };
  const begin = async () => (await request('/v1/sessions', 'POST', {})).body;
  const connect = async () => {
    const s = await begin();
    const u = new URL(s.authorizationUrl);
    const cb = await request(`/oauth/callback?state=${u.searchParams.get('state')}&code=fixture-code`);
    assert.equal(cb.status, 200);
    const approval = /<code id="approval">([A-Za-z0-9_-]+)<\/code>/.exec(cb.body)?.[1];
    assert.ok(approval);
    assert.equal((await request(`/v1/sessions/${s.sessionId}/confirm`, 'POST', {approval}, s.pollToken)).status, 200);
    return s;
  };
  const installInput = (extra = {}) => ({ projectRef: REF, confirmRef: REF, dedicatedProject: true,
    email: 'fixture@example.com', password, accountMode: 'create', closeSignups: false, ...extra });
  const state = s => request(`/v1/sessions/${s.sessionId}`, 'GET', undefined, s.pollToken);
  const finish = async s => {
    for (let i = 0; i < 100; i++) {
      const r = await state(s);
      if (['complete', 'failed'].includes(r.body.status)) return r.body;
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.fail('installer did not complete');
  };
  return { calls, request, begin, connect, installInput, state, finish, releaseVerify: () => verifyPending?.(),
    advance: ms => { clock += ms; }, close: async () => { instance.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } };
}

async function withFixture(options, fn) { const f = await fixture(options); try { await fn(f); } finally { await f.close(); } }

test('OAuth uses PKCE, consumes state once and protects session results', async () => withFixture({}, async f => {
  const s = await f.begin(), u = new URL(s.authorizationUrl);
  assert.equal(u.origin, 'https://api.supabase.com');
  assert.equal(u.searchParams.get('code_challenge_method'), 'S256');
  assert.equal((await f.request(`/v1/sessions/${s.sessionId}`)).status, 401);
  assert.equal((await f.request(`/v1/sessions/${s.sessionId}`, 'GET', undefined, 'wrong')).status, 401);
  const callback = `/oauth/callback?state=${u.searchParams.get('state')}&code=fixture-code`;
  assert.equal((await f.request(callback)).status, 200);
  assert.equal((await f.request(callback)).status, 400);
  const exchange = f.calls.find(c => c.path === '/v1/oauth/token');
  assert.equal(createHash('sha256').update(exchange.data.code_verifier).digest('base64url'), u.searchParams.get('code_challenge'));
  const serialized = JSON.stringify((await f.state(s)).body);
  assert.equal(serialized.includes(oauthAccess), false);
  assert.equal(serialized.includes('refresh'), false);
}));

test('full install creates account, verifies login and returns public config only', async () => withFixture({}, async f => {
  const s = await f.connect();
  const response = await f.request(`/v1/sessions/${s.sessionId}/install`, 'POST', f.installInput(), s.pollToken);
  assert.equal(response.status, 202);
  const done = await f.finish(s);
  assert.equal(done.status, 'complete');
  assert.equal(done.result.projectUrl, `https://${REF}.supabase.co`);
  assert.equal(done.result.publishableKey, publicKey);
  assert.equal(done.result.account, 'created');
  for (const secret of [password, adminKey, oauthAccess, 'fixture-oauth-secret', 'fixture-project-login-value']) assert.equal(JSON.stringify(done).includes(secret), false);
  assert.equal(f.calls.find(c => c.path.endsWith('/admin/users')).data.email_confirm, true);
  assert.equal(f.calls.some(c => c.path.endsWith('/config/auth')), false);
  assert.equal((await f.request(`/v1/sessions/${s.sessionId}/projects`, 'GET', undefined, s.pollToken)).status, 409);
  assert.equal((await f.request(`/v1/sessions/${s.sessionId}`, 'DELETE', undefined, s.pollToken)).status, 200);
  assert.equal((await f.state(s)).status, 401);
}));

test('existing account is reused without resetting its password', async () => withFixture({ accountExists: true }, async f => {
  const s = await f.connect();
  await f.request(`/v1/sessions/${s.sessionId}/install`, 'POST', f.installInput(), s.pollToken);
  assert.equal((await f.finish(s)).result.account, 'existing');
  assert.equal(f.calls.some(c => c.path.endsWith('/admin/users') && c.method !== 'POST'), false);
}));

test('existing-account mode never fetches or uses an admin operation', async () => withFixture({}, async f => {
  const s = await f.connect();
  await f.request(`/v1/sessions/${s.sessionId}/install`, 'POST', f.installInput({ accountMode: 'existing' }), s.pollToken);
  assert.equal((await f.finish(s)).status, 'complete');
  assert.equal(f.calls.some(c => c.path.endsWith('/admin/users')), false);
}));

test('wrong existing password fails without a reset or signup change', async () => withFixture({ accountExists: true, badLogin: true }, async f => {
  const s = await f.connect();
  await f.request(`/v1/sessions/${s.sessionId}/install`, 'POST', f.installInput({ closeSignups: true }), s.pollToken);
  const done = await f.finish(s);
  assert.equal(done.error, 'sync_sign_in_failed');
  assert.equal(f.calls.some(c => c.path.endsWith('/config/auth')), false);
  assert.equal(JSON.stringify(done).includes('private-response-marker'), false);
}));

test('conflicting tables and future schemas stop before schema mutation', async () => {
  for (const options of [{ collision: true }, { managed: true, futureSchema: true }]) await withFixture(options, async f => {
    const s = await f.connect();
    await f.request(`/v1/sessions/${s.sessionId}/install`, 'POST', f.installInput(), s.pollToken);
    assert.equal((await f.finish(s)).status, 'failed');
    assert.equal(f.calls.some(c => c.data?.query === schema), false);
  });
});

test('confirmation and authorization are enforced before installation', async () => withFixture({}, async f => {
  const s = await f.connect();
  assert.equal((await f.request(`/v1/sessions/${s.sessionId}/install`, 'POST', f.installInput({ confirmRef: '' }), s.pollToken)).status, 400);
  assert.equal((await f.request(`/v1/sessions/${s.sessionId}/install`, 'POST', f.installInput({ projectRef: OTHER, confirmRef: OTHER }), s.pollToken)).status, 403);
  assert.equal(f.calls.some(c => c.data?.query === schema), false);
}));

test('RLS verification and unhealthy project errors are safe and fail closed', async () => {
  for (const options of [{ badRls: true }, { healthy: false }]) await withFixture(options, async f => {
    const s = await f.connect();
    await f.request(`/v1/sessions/${s.sessionId}/install`, 'POST', f.installInput(), s.pollToken);
    const done = await f.finish(s); assert.equal(done.status, 'failed');
    assert.equal(f.calls.some(c => c.path.endsWith('/admin/users')), false);
  });
});

test('closing signups is explicit and happens after account verification', async () => withFixture({}, async f => {
  const s = await f.connect();
  await f.request(`/v1/sessions/${s.sessionId}/install`, 'POST', f.installInput({ closeSignups: true }), s.pollToken);
  assert.equal((await f.finish(s)).status, 'complete');
  assert.ok(f.calls.findIndex(c => c.path.endsWith('/config/auth')) > f.calls.findIndex(c => c.path.endsWith('/auth/v1/token')));
}));

test('project creation requires operator enablement, cost confirmation and owned organization', async () => {
  await withFixture({}, async f => {
    const s = await f.connect();
    assert.equal((await f.request(`/v1/sessions/${s.sessionId}/projects`, 'POST', {}, s.pollToken)).status, 403);
  });
  await withFixture({ creation: true }, async f => {
    const s = await f.connect();
    const input = { name: 'New fixture', confirmName: 'New fixture', organizationSlug: 'my-org', region: 'emea', databasePassword: 'fixture-database-password', acceptCosts: true };
    assert.equal((await f.request(`/v1/sessions/${s.sessionId}/projects`, 'POST', { ...input, acceptCosts: false }, s.pollToken)).status, 400);
    assert.equal((await f.request(`/v1/sessions/${s.sessionId}/projects`, 'POST', { ...input, organizationSlug: 'not-owned' }, s.pollToken)).status, 403);
    const created = await f.request(`/v1/sessions/${s.sessionId}/projects`, 'POST', input, s.pollToken);
    assert.equal(created.status, 201);
    assert.equal(JSON.stringify(created.body).includes(input.databasePassword), false);
    const call = f.calls.find(c => c.path === '/v1/projects' && c.method === 'POST');
    assert.equal(call.data.organization_slug, 'my-org');
    assert.equal(call.data.desired_instance_size, undefined);
  });
});

test('expiry, denied browser origin and unknown callback are rejected', async () => withFixture({}, async f => {
  const s = await f.connect(); f.advance(15 * 60_000 + 1);
  assert.equal((await f.state(s)).status, 401);
  assert.equal((await f.request('/health', 'GET', undefined, undefined, { Origin: 'https://evil.example' })).status, 403);
  assert.equal((await f.request('/oauth/callback?state=unknown&code=fixture')).status, 400);
  const health = await f.request('/health');
  assert.equal(health.headers.get('cache-control'), 'no-store');
}));

test('untrusted callback errors do not reflect remote secrets', async () => withFixture({ networkFailure: true }, async f => {
  const s = await f.begin(), u = new URL(s.authorizationUrl);
  const response = await f.request(`/oauth/callback?state=${u.searchParams.get('state')}&code=fixture`);
  assert.equal(response.status, 400);
  assert.equal(response.body.includes('private-network-marker'), false);
  assert.equal((await f.state(s)).body.error, 'authorization_failed');
}));

test('cancel during install stops between steps; no implicit rollback', async () => withFixture({ pauseVerify: true }, async f => {
  const s = await f.connect();
  await f.request(`/v1/sessions/${s.sessionId}/install`, 'POST', f.installInput(), s.pollToken);
  while (!f.calls.some(c => c.data?.query?.includes('protected_tables'))) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal((await f.request(`/v1/sessions/${s.sessionId}`, 'DELETE', undefined, s.pollToken)).status, 202);
  f.releaseVerify();
  for (let i = 0; i < 50 && (await f.state(s)).status !== 401; i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal((await f.state(s)).status, 401);
  assert.equal(f.calls.some(c => c.path.endsWith('/admin/users')), false);
}));

test('OAuth authorization alone cannot give a remote poller project access', async () => withFixture({}, async f => {
  const s = await f.begin(), u = new URL(s.authorizationUrl);
  const cb = await f.request(`/oauth/callback?state=${u.searchParams.get('state')}&code=fixture-code`);
  assert.equal(cb.status, 200);
  assert.equal((await f.state(s)).body.status, 'awaiting-confirmation');
  assert.equal((await f.request(`/v1/sessions/${s.sessionId}/projects`, 'GET', undefined, s.pollToken)).status, 409);
  assert.equal((await f.request(`/v1/sessions/${s.sessionId}/confirm`, 'POST', { approval: 'wrong' }, s.pollToken)).status, 403);
  const approval = /<code id="approval">([A-Za-z0-9_-]+)<\/code>/.exec(cb.body)[1];
  assert.equal(JSON.stringify((await f.state(s)).body).includes(approval), false);
  assert.equal((await f.request(`/v1/sessions/${s.sessionId}/confirm`, 'POST', { approval }, s.pollToken)).status, 200);
  assert.equal((await f.request(`/v1/sessions/${s.sessionId}/confirm`, 'POST', { approval }, s.pollToken)).status, 409);
}));
