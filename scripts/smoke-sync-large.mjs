// Synthetic account only; never print credentials, cookies, or user data.
import {randomBytes,webcrypto} from 'node:crypto';
import vm from 'node:vm';
import fs from 'node:fs';
import assert from 'node:assert/strict';
const base=process.argv[2]||'https://ielts-vocab-master-pi.vercel.app';
const email=`sync-large-${randomBytes(8).toString('hex')}@example.invalid`,password=randomBytes(24).toString('base64url');
let cookie;
async function call(path,method='GET',body){
 const res=await fetch(base+path,{method,headers:{'Content-Type':'application/json',...(cookie?{Cookie:cookie}:{})},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(45000)});
 const session=res.headers.getSetCookie().find(x=>x.startsWith('iv_session='));if(session)cookie=session.split(';')[0];
 return {status:res.status,data:await res.json()};
}
const snapshot={schema:1,days:[{id:'large-lesson',name:'Synthetic vocabulary',words:Array.from({length:50},(_,i)=>({en:`sample word ${i}`,vi:`Nghĩa từ vựng mẫu ${i}`,meaning:'A sample term used to verify that a full vocabulary lesson can be saved and loaded across devices.',example:'We reviewed the vocabulary together and practised using each new expression in a natural conversation.',topic:'Test vocabulary'}))}],stats:{xp:0},errors:[],mistakes:[],logs:[],progress:{},customTopics:['Test vocabulary']};
const registered=await call('/api/account','POST',{action:'register',email,password,snapshot});assert.equal(registered.status,201);
const first=await call('/api/vault');assert.equal(first.status,200);
console.log(JSON.stringify({step:'read-large',bytes:Buffer.byteLength(JSON.stringify(snapshot)),weakEtag:first.data.etag?.startsWith('W/'),etagPresent:!!first.data.etag}));
snapshot.days.push({id:'new-import',name:'New import',words:[{en:'coffee',vi:'cà phê',example:'I drink coffee in the morning.'}]});
const saved=await call('/api/vault','PUT',{snapshot,etag:first.data.etag});
console.log(JSON.stringify({step:'save-after-read',status:saved.status,error:saved.data.error||null}));
assert.equal(saved.status,200,'A full lesson must accept a write based on its freshly read revision.');
const restored=await call('/api/vault');assert.equal(restored.status,200);assert.equal(restored.data.snapshot.days.length,2);
assert.equal(restored.data.etag,saved.data.etag,'Read and write must return the same revision.');
console.log('Passed: a full-size lesson saves, adds another import, and reads back the latest cloud revision.');

// Reproduce an existing browser stuck with the weak revision from the old API.
const values=new Map([
 ['ivAccountId',registered.data.account.id],['ivAccountEtag','W/'+saved.data.etag],['ivAccountDirty','1'],
 ['ivDays',JSON.stringify([...snapshot.days,{id:'pending-combine',name:'Pending local import',words:[{en:'tea',vi:'trà',example:'Would you like some tea?'}]}])],
 ['ivStats',JSON.stringify(snapshot.stats)]
]);
const session=new Map();
const context=vm.createContext({crypto:webcrypto,AbortSignal,Uint8Array,JSON,Response,setTimeout,clearTimeout,setInterval:()=>1,
 localStorage:{getItem:k=>values.get(k)||null,setItem:(k,v)=>values.set(k,String(v)),removeItem:k=>values.delete(k)},
 sessionStorage:{getItem:k=>session.get(k)||null,setItem:(k,v)=>session.set(k,String(v)),removeItem:k=>session.delete(k)},
 fetch:(path,options={})=>fetch(base+path,{...options,headers:{...options.headers,Cookie:cookie}})
});
vm.runInContext(fs.readFileSync(new URL('../vault-sync.js',import.meta.url),'utf8'),context);
const vault=context.CloudVault;
try{
 await vault.init({create:false});assert.equal(vault.conflict,true,'Old revision without a baseline must keep local changes for review');
 await vault.combineVocabulary();
 assert.equal(vault.dirty,false);assert.equal(vault.conflict,false);assert.equal(vault.lastStatus.label,'Cloud saved');
 const secondLogin=await call('/api/account','POST',{action:'login',email,password});assert.equal(secondLogin.status,200);
 const secondDevice=await call('/api/vault');assert.equal(secondDevice.status,200);
 assert.deepEqual(secondDevice.data.snapshot.days.map(day=>day.id),['large-lesson','new-import','pending-combine']);
 assert.equal(secondDevice.data.snapshot.days[0].words.length,50);
 console.log('Passed: Combine clears pending/conflict for an old weak revision; a new login sees all 3 lessons and 52 words.');
}finally{if(vault.timer)clearTimeout(vault.timer);}
