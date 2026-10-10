import { build } from 'esbuild';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Offline preview of the actual modal. The SDK/service are not called.
const entry = `
import { SupabaseSetupModal } from './src/ui/setup-modal';
import { deliverSetupReturn } from './src/onboarding/return-channel';
const ref='abcdefghijklmnopqrst', sid='a'.repeat(43), cap='b'.repeat(43), approval='c'.repeat(43);
let state='pending', ticks=0;
const result={projectRef:ref,projectUrl:'https://'+ref+'.supabase.co',publishableKey:'sb_publishable_demo_placeholder',email:'demo@example.invalid',account:'created'};
const qs=new URLSearchParams(location.search), lang=qs.get('lang')==='en'?'en':'fa';
const host={settings:{language:lang,installerUrl:'https://offline-demo.invalid'},
 async applySetupResult(){},async createVault(){},async chooseVault(){},async unlockVault(){return true},
 async listVaults(){return [{id:'demo-vault',name:'Demo vault',encryption:null,headSeq:0,headDevice:null}]}};
const reply=(status,json)=>({status,json});
globalThis.__demoAdapter.requestUrl=async ({url,method,body})=>{
 const path=new URL(url).pathname;
 if(path==='/health')return reply(200,{ready:true,protocol:1,allowProjectCreation:true});
 if(path==='/v1/sessions')return reply(201,{sessionId:sid,pollToken:cap,authorizationUrl:'https://api.supabase.com/v1/oauth/authorize?state=offline-demo'});
 if(method==='DELETE')return reply(200,{});
 if(path.endsWith('/confirm')){state='connected';return reply(200,{connected:true})}
 if(path.endsWith('/organizations'))return reply(200,{organizations:[{slug:'demo-org',name:'Demo organization'}]});
 if(path.endsWith('/projects'))return reply(method==='POST'?201:200,method==='POST'?{project:{ref,name:'Demo project',status:'ACTIVE_HEALTHY'}}:{projects:[{ref,name:'Demo project',status:'ACTIVE_HEALTHY'}]});
 if(path.endsWith('/install')){state='installing';ticks=0;return reply(202,{accepted:true})}
 if(state==='installing' && ++ticks>2)state='complete';
 return reply(200,{status:state,progress:state==='installing'?['checking_project','installing_schema']:state==='complete'?['complete']:[],error:null,result:state==='complete'?result:null});
};
window.open=()=>{
 state='awaiting-confirmation';
 const panel=document.getElementById('browser-demo');panel.hidden=false;
 document.getElementById('approve-demo').onclick=()=>{panel.hidden=true;deliverSetupReturn({session:sid,approval})};
 return null;
};
const modal=new SupabaseSetupModal({},host,()=>{});
modal.email='demo@example.invalid';modal.password='demo-password-123';modal.passwordAgain='demo-password-123';modal.trustInstaller=true;
modal.projects=[{ref,name:'Demo project',status:'ACTIVE_HEALTHY'}];modal.selected=ref;modal.confirmRef=ref;modal.dedicated=true;
modal.remoteVaults=await host.listVaults();modal.remoteSelected='demo-vault';modal.vaultAction='choose';
const initial=qs.get('stage');if(['start','authorizing','project','confirm','installing','vault','done'].includes(initial))modal.phase=initial;
if(initial==='installing'){modal.progress='بررسی پروژه → نصب جدول‌ها و دسترسی‌ها'}
if(initial==='done')modal.result=result;
if(qs.get('expanded')==='create'){modal.showCreate=true;modal.allowCreation=true;modal.organizations=[{slug:'demo-org',name:'Demo organization'}]}
if(qs.get('expanded')==='new-vault')modal.vaultAction='create';
if(qs.get('error')==='true')modal.error='conflicting_tables';
modal.onOpen();globalThis.demoModal=modal;
document.getElementById('language').onclick=()=>{qs.set('lang',lang==='fa'?'en':'fa');location.search=qs.toString()};
`;
const result = await build({ stdin: { contents: entry, resolveDir: resolve('.'), sourcefile: 'onboarding-preview.ts', loader: 'ts' },
  bundle: true, write: false, format: 'esm', platform: 'browser', minify: true,
  plugins: [{ name: 'offline-obsidian', setup(b) {
    b.onResolve({ filter: /^obsidian$/ }, () => ({ path: 'obsidian', namespace: 'demo' }));
    b.onLoad({ filter: /.*/, namespace: 'demo' }, () => ({ contents: `export const {Modal,Setting,Notice}=globalThis.__demoAdapter; export const requestUrl=(args)=>globalThis.__demoAdapter.requestUrl(args);` }));
  } }] });
const adapter = `
for(const [k,fn] of Object.entries({empty(){this.replaceChildren()},setAttr(k,v){this.setAttribute(k,v)},setText(v){this.textContent=v},createEl(tag,options={}){const e=document.createElement(tag);if(options.text)e.textContent=options.text;if(options.cls)e.className=options.cls;this.append(e);return e}}))HTMLElement.prototype[k]=fn;
let seq=0;
class Modal{constructor(){this.modalEl=document.getElementById('modal');this.modalEl.empty();this.titleEl=this.modalEl.createEl('h2');this.contentEl=this.modalEl.createEl('div')}close(){this.modalEl.empty();this.onClose();this.modalEl.createEl('p',{text:'نمایش تمام شد. برای شروع دوباره صفحه را تازه‌سازی کنید.'})}}
class Setting{constructor(el){this.row=el.createEl('div',{cls:'setting'});this.label=this.row.createEl('label',{cls:'label'});this.body=this.row.createEl('div',{cls:'controls'})}setName(v){this.label.setText(v);return this}setDesc(v){this.row.createEl('p',{text:v});return this}addText(fn){const e=this.body.createEl('input');e.id='field-'+(++seq);this.label.htmlFor=e.id;fn({inputEl:e,setValue(v){e.value=v;return this},onChange(f){e.addEventListener('input',()=>f(e.value));return this}});return this}addToggle(fn){const e=this.body.createEl('input');e.type='checkbox';e.id='field-'+(++seq);this.label.htmlFor=e.id;fn({setValue(v){e.checked=v;return this},onChange(f){e.addEventListener('change',()=>f(e.checked));return this}});return this}addDropdown(fn){const e=this.body.createEl('select');e.id='field-'+(++seq);this.label.htmlFor=e.id;const c={addOption(k,v){const o=e.createEl('option',{text:v});o.value=k;return this},addOptions(o){for(const[k,v]of Object.entries(o))this.addOption(k,v);return this},setValue(v){e.value=v;return this},onChange(f){e.addEventListener('change',()=>f(e.value));return this}};fn(c);return this}addButton(fn){this.row.classList.add('action');const e=this.body.createEl('button');e.type='button';fn({setButtonText(v){e.setText(v);return this},setDisabled(v){e.disabled=v;return this},setCta(){e.classList.add('primary');return this},onClick(f){e.onclick=f;return this}});return this}}
globalThis.__demoAdapter={Modal,Setting,Notice:class{constructor(message){document.getElementById('notice').textContent=message}}};
`;
const html = `<!doctype html><html lang="fa" dir="ltr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'none'; img-src data:"><title>Vault Sync — offline onboarding preview</title><style>
:root{font-family:system-ui,-apple-system,'Noto Sans Arabic',sans-serif;color:#2c2c2b;background:#f9f8f7;font-size:16px;line-height:1.6}*{box-sizing:border-box}body{margin:0;padding:24px}.frame{max-width:760px;margin:auto}header{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-bottom:16px}header strong{font-size:22px}.badge{background:#fbebde;color:#75441e;padding:12px 16px;border:1px solid #e6cfb8;border-radius:8px;margin-bottom:16px}.modal{background:white;border:1px solid #e6e5e3;border-radius:12px;padding:24px}h2{font-size:26px;line-height:1.35;margin:0 0 16px}h3{font-size:20px;margin:24px 0 12px}p{margin:12px 0;color:#55524f;overflow-wrap:anywhere}.setting{display:flex;align-items:center;gap:24px;border-top:1px solid #e6e5e3;padding:16px 0}.label{flex:1;min-width:0}.controls{flex:0 1 48%;min-width:0;display:flex;justify-content:flex-end}input:not([type=checkbox]),select{width:100%;min-height:44px;border:1px solid #a9a6a2;border-radius:8px;background:white;color:#2c2c2b;padding:8px;font:inherit}input[type=checkbox]{width:24px;height:24px;accent-color:#1b68b3}.action .label{display:none}.action .controls{flex:1}button{font:inherit;min-height:44px;border:1px solid #a9a6a2;border-radius:8px;background:#f9f8f7;color:#2c2c2b;padding:8px 16px;cursor:pointer}button.primary{background:#1b68b3;border-color:#1b68b3;color:white}button:disabled{opacity:.65;cursor:wait}:focus-visible{outline:3px solid #2783de;outline-offset:3px}.vault-sync-warning{background:#fce9e7;color:#87352b;border-radius:8px;padding:12px}#browser-demo{background:#e5f2fc;border:1px solid #aacfe9;padding:16px;border-radius:8px;margin-bottom:16px}[hidden]{display:none!important}footer{font-size:14px;margin-top:16px;color:#55524f}@media(max-width:520px){body{padding:16px}.modal{padding:16px}.setting{flex-direction:column;align-items:stretch;gap:8px}.controls{flex:1}.controls input[type=checkbox]{margin-inline-start:auto}.action .controls{justify-content:stretch}.action button{width:100%}}@media(prefers-color-scheme:dark){:root{background:#191919;color:#fff}.modal{background:#202020;border-color:#4b4b49}p,footer{color:#d0ceca}.setting{border-color:#4b4b49}input:not([type=checkbox]),select,button{background:#292929;color:#fff;border-color:#777570}.badge{background:#34291f;color:#f1c399;border-color:#846444}#browser-demo{background:#202e3c;border-color:#658aaf}.vault-sync-warning{background:#382622;color:#f2c3ba}}
</style></head><body><div class="frame" dir="rtl"><header><strong dir="ltr">Vault Sync · Release</strong><button id="language">FA / EN</button></header><div class="badge">پیش‌نمایش آفلاینِ ویزارد واقعی — هیچ حساب یا پروژه‌ای ساخته نمی‌شود. هیچ رمز واقعی وارد نکنید؛ همهٔ APIها شبیه‌سازی شده‌اند.</div><section id="browser-demo" hidden><strong>مرورگر Supabase — شبیه‌سازی</strong><p>در نسخهٔ واقعی این مرحله در Supabase انجام می‌شود. این دکمه فقط برگشت امن به ویزارد را شبیه‌سازی می‌کند.</p><button id="approve-demo">تأیید و برگشت به Obsidian</button></section><main id="modal" class="modal"></main><p id="notice" role="status"></p><footer>این نمایش از همان کد SupabaseSetupModal ساخته شده است؛ سرویس OAuth زنده هنوز مستقر نشده.</footer></div><script>${adapter}</script><script type="module">${result.outputFiles[0].text.replace(/<\/script/gi,'<\\/script')}</script></body></html>`;
const out = process.argv[2] || 'preview-onboarding.html';
writeFileSync(out, html);
console.log('Offline preview generated; all network access is blocked by CSP.');
