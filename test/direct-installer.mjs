import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
const out=await build({entryPoints:[new URL('../src/onboarding/direct-installer.ts',import.meta.url).pathname],bundle:true,write:false,format:'esm',platform:'node'});
const {DirectInstallerClient,isScopedPat}=await import('data:text/javascript;base64,'+Buffer.from(out.outputFiles[0].text).toString('base64'));
const ref='abcdefghijklmnopqrst',other='qrstabcdefghijklmnop',pat='sbp_fc_fixture_scoped_token',admin='sb_secret_fixture_admin',publicKey='sb_publishable_fixture_public',password='fixture-sync-password';
function fixture(opts={}){
 const calls=[];let release;const paused=new Promise(r=>{release=r});
 const transport=async(url,method,headers,body)=>{
  const u=new URL(url),data=body?JSON.parse(body):undefined;calls.push({url,method,headers,data});
  const reply=(data,status=200)=>({status,data});
  if(opts.networkFailure)throw new Error('private-network-marker');
  if(u.pathname.endsWith('/api-keys'))return opts.deniedKeys?reply({error:'private-marker'},403):reply([{type:'publishable',api_key:publicKey},{type:'secret',api_key:admin}]);
  if(u.pathname.endsWith('/database/query')){
   if(data.query.includes('as collisions'))return reply([{managed:!!opts.future,collisions:opts.collision?['files']:[]}]);
   if(data.query.includes('protected_tables')){if(opts.pause)await paused;return reply([{version:3,protected_tables:opts.badRls?4:5,bucket:true,realtime:true}]);}
   if(data.query==='select public.vault_sync_schema_version() as version')return reply([{version:4}]);
   return reply([]);
  }
  if(u.pathname.endsWith('/admin/users'))return opts.exists?reply({code:'email_exists'},422):reply({id:'user'},201);
  if(u.pathname.endsWith('/auth/v1/token'))return opts.badPassword?reply({error:'private-marker'},400):reply({access_token:'fixture-verification-session'});
  if(u.pathname.endsWith('/auth/v1/logout'))return reply(null,204);
  return reply({id:ref,name:'Fixture',status:opts.unhealthy?'COMING_UP':'ACTIVE_HEALTHY'});
 };
 const client=new DirectInstallerClient(pat,ref,transport);
 const input={projectRef:ref,confirmRef:ref,dedicatedProject:true,email:'fixture@example.invalid',password,accountMode:'create',closeSignups:false};
 async function finish(){for(let i=0;i<100;i++){const s=await client.state();if(['complete','failed'].includes(s.status))return s;await new Promise(r=>setTimeout(r,1));}assert.fail('setup did not finish');}
 return {calls,client,input,finish,release};
}
test('only scoped PAT format accepted, with a dedicated project ref',()=>{
 assert.equal(isScopedPat(pat),true);for(const key of ['sbp_fixture_legacy','sb_secret_fixture','sb_publishable_fixture',''])assert.equal(isScopedPat(key),false);
 assert.throws(()=>new DirectInstallerClient('sbp_legacy_value',ref,()=>{}),/scoped_pat_required/);
 assert.throws(()=>new DirectInstallerClient(pat,'https://evil.example',()=>{}),/invalid_project_ref/);
});
test('full direct setup touches only selected Supabase project and returns public config',async()=>{
 const f=fixture();assert.equal((await f.client.projects())[0].ref,ref);await f.client.install(f.input);const s=await f.finish();assert.equal(s.status,'complete');assert.equal(s.result.account,'created');
 for(const secret of [pat,admin,password,'fixture-verification-session'])assert.equal(JSON.stringify(s).includes(secret),false);
 for(const c of f.calls){assert.ok(['https://api.supabase.com',`https://${ref}.supabase.co`].includes(new URL(c.url).origin));assert.equal(c.url.includes(pat),false);if(new URL(c.url).origin==='https://api.supabase.com')assert.equal(c.headers.Authorization,`Bearer ${pat}`);}
 assert.equal(f.calls.some(c=>new URL(c.url).pathname==='/v1/projects'),false);assert.equal(f.calls.some(c=>c.url.includes('/config/auth')),false);assert.equal(f.client.pat,'');
});
test('existing user mode never requests secret reveal or runs Auth admin operations',async()=>{
 const f=fixture();await f.client.install({...f.input,accountMode:'existing'});assert.equal((await f.finish()).status,'complete');assert.equal(f.calls.some(c=>c.url.includes('reveal=true')||c.url.includes('/admin/users')),false);
});
test('existing user is reused without reset; wrong password is safe',async()=>{
 for(const badPassword of [false,true]){const f=fixture({exists:true,badPassword});await f.client.install(f.input);const s=await f.finish();assert.equal(s.status,badPassword?'failed':'complete');if(badPassword)assert.equal(s.error,'sync_sign_in_failed');else assert.equal(s.result.account,'existing');assert.equal(f.calls.some(c=>c.method==='PUT'||c.method==='PATCH'),false);assert.equal(JSON.stringify(s).includes('private-marker'),false);assert.equal(f.client.pat,'');}
});
test('permission preflight, collisions, newer schema and unhealthy project stop safely',async()=>{
 for(const options of [{deniedKeys:true},{collision:true},{future:true},{unhealthy:true}]){const f=fixture(options);await f.client.install(f.input);assert.equal((await f.finish()).status,'failed');assert.equal(f.calls.some(c=>c.data?.query?.includes('begin;')),false);assert.equal(f.client.pat,'');}
});
test('target confirmation, sign-up changes and concurrent installation rejected',async()=>{
 const f=fixture({pause:true});for(const extra of [{confirmRef:''},{projectRef:other,confirmRef:other},{dedicatedProject:false},{closeSignups:true}])await assert.rejects(()=>f.client.install({...f.input,...extra}),/invalid_install_confirmation/);
 await f.client.install(f.input);await assert.rejects(()=>f.client.install(f.input),/not_connected/);f.release();await f.finish();
});
test('cancellation during setup stops following mutations; completed schema is not rolled back',async()=>{
 const f=fixture({pause:true});await f.client.install(f.input);while(!f.calls.some(c=>c.data?.query?.includes('protected_tables')))await new Promise(r=>setTimeout(r,1));await f.client.close();f.release();assert.equal((await f.finish()).error,'setup_cancelled');assert.equal(f.calls.some(c=>c.url.includes('/admin/users')),false);assert.equal(f.client.pat,'');
});
test('RLS verification and network errors return safe codes and clear PAT',async()=>{
 for(const opts of [{badRls:true},{networkFailure:true}]){const f=fixture(opts);await f.client.install(f.input);const s=await f.finish();assert.equal(s.status,'failed');assert.equal(JSON.stringify(s).includes('private-network-marker'),false);assert.equal(f.client.pat,'');}
});
