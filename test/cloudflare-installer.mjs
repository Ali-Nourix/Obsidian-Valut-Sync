import test from 'node:test';
import assert from 'node:assert/strict';
import worker, { InstallerCoordinator } from '../installer/cloudflare.mjs';
const base='https://installer.example.org';
const env={INSTALLER_PUBLIC_URL:base};
test('edge is reachable but fails closed without OAuth configuration',async()=>{
 const r=await worker.fetch(new Request(base+'/health'),env);assert.equal(r.status,200);assert.equal((await r.json()).ready,false);
 assert.equal((await worker.fetch(new Request(base+'/v1/sessions',{method:'POST'}),env)).status,503);
 assert.equal((await worker.fetch(new Request('https://evil.example/health'),env)).status,421);
 assert.equal((await worker.fetch(new Request(base+'/health',{headers:{Origin:'https://evil.example'}}),env)).status,403);
});
const bindings={...env,SUPABASE_OAUTH_CLIENT_ID:'fixture-client',SUPABASE_OAUTH_CLIENT_SECRET:'fixture-secret'};
function coordinator(){
 const storage=new Map();let alarm=null;const ctx={waitUntil(){},storage:{put:async(k,v)=>storage.set(k,v),get:async k=>storage.get(k),delete:async k=>storage.delete(k),getAlarm:async()=>alarm,setAlarm:async t=>{alarm=t}}};
 return {instance:new InstallerCoordinator(ctx,bindings),storage};
}
test('Fetch adapter preserves PKCE, auth, preflight and shared sessions',async()=>{
 const {instance,storage}=coordinator();const req=(path,method='GET',body,cap)=>instance.fetch(new Request(base+path,{method,headers:{'Content-Type':'application/json','CF-Connecting-IP':'192.0.2.1',...(cap?{Authorization:'Bearer '+cap}:{})},body:body===undefined?undefined:JSON.stringify(body)}));
 const start=await req('/v1/sessions','POST',{});assert.equal(start.status,201);const s=await start.json();assert.equal(new URL(s.authorizationUrl).searchParams.get('code_challenge_method'),'S256');
 assert.equal((await req('/v1/sessions/'+s.sessionId)).status,401);
 assert.equal((await(await req('/v1/sessions/'+s.sessionId,'GET',undefined,s.pollToken)).json()).status,'pending');
 assert.equal((await req('/v1/sessions','OPTIONS')).status,204);
 for(const v of storage.values())assert.equal(typeof v,'number');
 assert.equal((await req('/v1/sessions/'+s.sessionId,'DELETE',undefined,s.pollToken)).status,200);
 assert.equal((await req('/v1/sessions/'+s.sessionId,'GET',undefined,s.pollToken)).status,401);
});
test('body limit and per-ingress-IP limit are enforced',async()=>{
 const {instance}=coordinator();
 for(let i=0;i<10;i++)assert.equal((await instance.fetch(new Request(base+'/v1/sessions',{method:'POST',headers:{'CF-Connecting-IP':'192.0.2.2'}}))).status,201);
 assert.equal((await instance.fetch(new Request(base+'/v1/sessions',{method:'POST',headers:{'CF-Connecting-IP':'192.0.2.2'}}))).status,429);
 const r=await worker.fetch(new Request(base+'/v1/sessions',{method:'POST',headers:{'Content-Length':'17000'}}),bindings);assert.equal(r.status,413);
});
