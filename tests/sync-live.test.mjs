import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {webcrypto} from 'node:crypto';
const source=fs.readFileSync(new URL('../vault-sync.js',import.meta.url),'utf8');
const copy=x=>JSON.parse(JSON.stringify(x));
const lesson=(id,word)=>({id,name:id,words:[{en:word,vi:'nghĩa',example:`I use ${word} every day.`}]});
const initial=()=>({schema:1,days:[lesson('first','coffee')],stats:{xp:0},errors:[],mistakes:[],logs:[],progress:{},customTopics:[]});
function setup(){
 let cloud=initial(),version=1,signedIn=true;const clients=[];
 let holdRead=null;
 const account={id:'c'.repeat(64),email:'test@example.invalid'};
 const fetch=async(url,options={})=>{
  if(url==='/api/account')return {ok:true,json:async()=>({account:signedIn?account:null})};
  if(!signedIn)return {ok:false,status:401,json:async()=>({error:'Sign in again.'})};
  if(options.method==='GET'){const data={exists:true,snapshot:copy(cloud),etag:String(version),account};const pending=holdRead;holdRead=null;if(pending){pending.started();await pending.wait;}return {ok:true,json:async()=>data};}
  const body=JSON.parse(options.body);
  if(body.etag!==String(version))return {ok:false,status:409,json:async()=>({error:'Stale copy'})};
  cloud=copy(body.snapshot);version++;
  return {ok:true,json:async()=>({saved:true,etag:String(version)})};
 };
 function device(values=new Map()){
  const listeners={},session=new Map();let view=[];const intervals=[];
  const client={values,listeners,intervals};clients.push(client);
  const changed=(key,value)=>{
   const oldValue=values.get(key)||null;
   if(value===null)values.delete(key);else values.set(key,String(value));
   if(oldValue===(values.get(key)||null))return;
   for(const other of clients)if(other!==client&&other.values===values)queueMicrotask(()=>other.listeners.storage?.({key}));
  };
  const localStorage={getItem:k=>values.get(k)||null,setItem:changed,removeItem:k=>changed(k,null)};
  const sessionStorage={getItem:k=>session.get(k)||null,setItem:(k,v)=>session.set(k,String(v)),removeItem:k=>session.delete(k)};
  const context=vm.createContext({localStorage,sessionStorage,crypto:webcrypto,fetch,AbortSignal,Uint8Array,JSON,Response,setTimeout,clearTimeout,
   setInterval:(fn,ms)=>{intervals.push({fn,ms});return 1;},addEventListener:(name,fn)=>{listeners[name]=fn;}});
  vm.runInContext(source,context);client.vault=context.CloudVault;
  client.start=async()=>{await client.vault.init({create:true,onRestore:()=>{view=JSON.parse(values.get('ivDays')||'[]');}});view=JSON.parse(values.get('ivDays')||'[]');};
  client.add=day=>{const days=JSON.parse(values.get('ivDays'));days.push(day);localStorage.setItem('ivDays',JSON.stringify(days));client.vault.queue(100000);};
  client.view=()=>view;return client;
 }
 return {holdRead(){let release,started;const wait=new Promise(r=>release=r),ready=new Promise(r=>started=r);holdRead={wait,started};return {ready,release};},device,cloud:()=>copy(cloud),signIn:value=>{signedIn=value;}};
}
test('another Chrome tab refreshes its displayed lessons from shared storage',async()=>{
 const app=setup(),storage=new Map(),a=app.device(storage),b=app.device(storage);
 await a.start();await b.start();
 a.add(lesson('mac-mini','tea'));await a.vault.flush();
 await new Promise(resolve=>setTimeout(resolve,180));
 assert.ok(b.view().some(x=>x.id==='mac-mini'));
 assert.equal(b.vault.conflict,false);assert.equal(b.vault.dirty,false);
 assert.equal(b.intervals[0].ms,15000);
});
test('two devices preserve independent additions and poll the latest cloud copy',async()=>{
 const app=setup(),a=app.device(),b=app.device();await a.start();await b.start();
 a.add(lesson('mac-mini','tea'));await a.vault.flush();
 b.add(lesson('laptop','bread'));await b.vault.flush();
 assert.equal(b.vault.conflict,false);assert.equal(b.vault.dirty,false);
 assert.deepEqual(app.cloud().days.map(x=>x.id).sort(),['first','laptop','mac-mini']);
 await a.intervals[0].fn();
 // The interval callback starts refresh without blocking the browser event loop.
 await a.vault.refresh();
 assert.equal(a.view().length,3);
});
test('independent words merge within a lesson, while conflicting edits are preserved for review',async()=>{
 const app=setup(),a=app.device();await a.start();
 const base=initial(),left=copy(base),right=copy(base);
 left.days[0].words.push(lesson('x','tea').words[0]);right.days[0].words.push(lesson('x','bread').words[0]);
 const merged=a.vault.mergeSnapshots(base,left,right);
 assert.equal(merged.conflicts.length,0);assert.equal(merged.snapshot.days[0].words.length,3);
 left.days[0].words[0].vi='local edit';right.days[0].words[0].vi='remote edit';
 assert.ok(a.vault.mergeSnapshots(base,left,right).conflicts.length>0);
 const deleted=copy(base);deleted.days=[];
 const added=copy(base);added.days.push(lesson('new','tea'));
 const result=a.vault.mergeSnapshots(base,added,deleted);
 assert.equal(result.conflicts.length,0);assert.deepEqual(Array.from(result.snapshot.days,x=>x.id),['new']);
});
test('an expired session can recover and upload pending changes without a reload',async()=>{
 const app=setup(),a=app.device();await a.start();
 app.signIn(false);await a.vault.refresh();assert.equal(a.vault.mode,'signedout');
 a.add(lesson('offline','tea'));
 app.signIn(true);await a.vault.refresh();
 assert.equal(a.vault.mode,'account');assert.equal(a.vault.dirty,false);
 assert.equal(app.cloud().days.length,2);
});
test('legacy local vocabulary is kept in a recovery copy and can be added to the cloud',async()=>{
 const app=setup(),storage=new Map([
  ['ivAccountId','c'.repeat(64)],['ivAccountEtag','old'],
  ['ivDays',JSON.stringify([lesson('mac-mini-only','tea')])]
 ]),a=app.device(storage);
 await a.start();assert.ok(a.vault.recovery);
 await a.vault.combineVocabulary();
 assert.deepEqual(app.cloud().days.map(x=>x.id).sort(),['first','mac-mini-only']);
 assert.equal(a.vault.dirty,false);assert.equal(a.vault.recovery,null);
});

test('a delayed cloud read cannot roll back an import saved while it was loading',async()=>{
 const app=setup(),a=app.device();await a.start();
 const pending=app.holdRead(),refresh=a.vault.refresh();await pending.ready;
 a.add(lesson('new-import','tea'));await a.vault.flush();
 pending.release();await refresh;
 assert.ok(JSON.parse(a.values.get('ivDays')).some(x=>x.id==='new-import'));
 assert.equal(a.vault.etag,'2');assert.equal(a.vault.dirty,false);
});
test('imports made during a conflict remain pending and combine keeps both current and recovery lessons',async()=>{
 const app=setup(),a=app.device();await a.start();
 a.vault.rememberRecovery({...initial(),days:[lesson('recovered','bread')]});
 a.vault.conflict=true;a.add(lesson('new-import','tea'));
 assert.equal(a.vault.dirty,true);
 const pending=app.holdRead(),combine=a.vault.combineVocabulary();await pending.ready;
 a.add(lesson('during-sync','milk'));pending.release();await combine;
 assert.deepEqual(app.cloud().days.map(x=>x.id).sort(),['during-sync','first','new-import','recovered']);
 assert.equal(a.vault.dirty,false);
});

test('recovery survives a new tab session and combines after a reload',async()=>{
 const app=setup(),a=app.device();await a.start();
 a.add(lesson('unsaved','tea'));a.vault.rememberRecovery(JSON.parse(JSON.stringify({...initial(),days:JSON.parse(a.values.get('ivDays'))})));
 clearTimeout(a.vault.timer);a.vault.timer=null;
 const b=app.device(a.values);await b.start();
 assert.ok(b.vault.recovery.snapshot.days.some(x=>x.id==='unsaved'));
 await b.vault.combineVocabulary();assert.ok(app.cloud().days.some(x=>x.id==='unsaved'));
 assert.equal(b.values.has('ivSyncRecovery:'+b.vault.identity()),false);
});

test('importing in a reopened tab merges cloud changes using the saved baseline',async()=>{
 const app=setup(),a=app.device(),b=app.device();await a.start();await b.start();
 a.add(lesson('pending-import','tea'));clearTimeout(a.vault.timer);a.vault.timer=null;
 b.add(lesson('other-device','bread'));await b.vault.flush();
 const reopened=app.device(a.values);await reopened.start();
 assert.equal(reopened.vault.conflict,false);assert.equal(reopened.vault.dirty,false);
 assert.deepEqual(app.cloud().days.map(x=>x.id).sort(),['first','other-device','pending-import']);
});
