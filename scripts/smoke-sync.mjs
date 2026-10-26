// Uses an isolated random account; never prints its credentials or cookies.
import {randomBytes,webcrypto} from 'node:crypto';
import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
const base=process.argv[2]||'https://ielts-vocab-master-pi.vercel.app';
const source=fs.readFileSync(new URL('../vault-sync.js',import.meta.url),'utf8');
const clients=[];
const lesson=(id,en)=>({id,name:id,words:[{en,vi:'nghĩa',example:`I use ${en} every day.`}]});
async function account(action,email,password,snapshot){
 const res=await fetch(`${base}/api/account`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action,email,password,snapshot})});
 assert.ok(res.ok,`Account HTTP ${res.status}`);
 const cookie=res.headers.getSetCookie().find(x=>x.startsWith('iv_session='))?.split(';')[0];
 assert.ok(cookie,'Session cookie was not issued.');return cookie;
}
function client(cookie,values=new Map()){
 const listeners={},session=new Map();let view=[];
 const c={values,listeners};clients.push(c);
 const change=(key,value)=>{
  const before=values.get(key)||null;
  if(value===null)values.delete(key);else values.set(key,String(value));
  if(before===(values.get(key)||null))return;
  for(const other of clients)if(other!==c&&other.values===values)queueMicrotask(()=>other.listeners.storage?.({key}));
 };
 const context=vm.createContext({crypto:webcrypto,AbortSignal,Response,Uint8Array,JSON,setTimeout,clearTimeout,setInterval:()=>1,
  localStorage:{getItem:k=>values.get(k)||null,setItem:change,removeItem:k=>change(k,null)},
  sessionStorage:{getItem:k=>session.get(k)||null,setItem:(k,v)=>session.set(k,String(v)),removeItem:k=>session.delete(k)},
  addEventListener:(key,fn)=>{listeners[key]=fn;},
  fetch:(path,options={})=>fetch(base+path,{...options,headers:{...options.headers,Cookie:cookie}})});
 vm.runInContext(source,context);c.vault=context.CloudVault;
 c.start=async()=>{await c.vault.init({create:true,onRestore:()=>{view=JSON.parse(values.get('ivDays')||'[]');}});assert.equal(c.vault.mode,'account',JSON.stringify({status:c.vault.lastStatus,error:c.vault.lastError}));view=JSON.parse(values.get('ivDays')||'[]');};
 c.add=day=>{const days=JSON.parse(values.get('ivDays')||'[]');days.push(day);change('ivDays',JSON.stringify(days));c.vault.queue(100000);};
 c.passSpeaking=id=>{const progress=JSON.parse(values.get('speakquest.progress.v3')||'{}');progress[id]=true;progress._state={...(progress._state||{}),updatedAt:new Date().toISOString()};change('speakquest.progress.v3',JSON.stringify(progress));c.vault.queue(100000);};
 c.view=()=>view;return c;
}
try{
 const email=`sync-${randomBytes(8).toString('hex')}@example.invalid`,password=randomBytes(24).toString('base64url');
 const snapshot={schema:1,days:[],stats:{},errors:[],mistakes:[],logs:[],progress:{},customTopics:[]};
 const firstCookie=await account('register',email,password,snapshot);
 const secondCookie=await account('login',email,password);
 const a=client(firstCookie),b=client(secondCookie);await a.start();await b.start();
 a.add(lesson('mac-mini','coffee'));await a.vault.flush();assert.equal(a.vault.dirty,false);
 a.passSpeaking('skill:0-0');await a.vault.flush();assert.equal(a.vault.dirty,false);
 b.add(lesson('laptop','tea'));await b.vault.flush();assert.equal(b.vault.dirty,false);assert.equal(b.vault.conflict,false);
 b.passSpeaking('topic:0-0');await b.vault.flush();assert.equal(b.vault.dirty,false);assert.equal(b.vault.conflict,false);
 await a.vault.refresh();assert.equal(a.view().length,2);
 const tab=client(firstCookie,a.values);await tab.start();
 a.add(lesson('another-tab','bread'));await a.vault.flush();
 await new Promise(resolve=>setTimeout(resolve,250));
 await tab.vault.flush();
 assert.ok(tab.view().some(x=>x.id==='another-tab'));
 await b.vault.refresh();assert.equal(b.view().length,3);
 await a.vault.refresh();const speaking=JSON.parse(a.values.get('speakquest.progress.v3'));
 assert.equal(speaking['skill:0-0'],true);assert.equal(speaking['topic:0-0'],true);
 console.log('Passed: vocabulary and speaking progress merge across devices; another tab updates; both devices retain all lessons and speaking passes.');
}finally{
 for(const c of clients){if(c.vault.timer)clearTimeout(c.vault.timer);if(c.vault.storageTimer)clearTimeout(c.vault.storageTimer);}
}
