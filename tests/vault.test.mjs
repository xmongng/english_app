import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import { createVaultHandler, vaultPath } from '../api/vault.js';

const codeA='a'.repeat(64),codeB='b'.repeat(64);
const content={schema:1,days:[{id:'day-1',words:[{en:'coffee',vi:'cà phê'}]}],stats:{xp:10},errors:[],mistakes:[],logs:[],progress:{},customTopics:[],speaking:{'skill:0-0':true}};
function response(){return {statusCode:200,headers:{},setHeader(k,v){this.headers[k]=v;},status(v){this.statusCode=v;return this;},json(v){this.payload=v;return this;}};}
function fakeStorage(){
 const records=new Map();let version=0;
 return {
  async get(path){const row=records.get(path);return row?{blob:{etag:row.etag,size:row.data.length},stream:new Response(row.data).body}:null;},
  async put(path,data,options){const row=records.get(path);
   if((row&&!options.ifMatch)||(row&&options.ifMatch!==row.etag)){const error=new Error('Conflict');error.name='BlobPreconditionFailedError';throw error;}
   const etag=`"revision-${++version}"`;records.set(path,{data,etag});return {etag};
  }
 };
}
test('private vault requires a valid 256-bit code and configured storage',async()=>{
 const handler=createVaultHandler(fakeStorage());const old=process.env.BLOB_STORE_ID;delete process.env.BLOB_STORE_ID;
 try{
  let res=response();await handler({method:'GET',headers:{}},res);assert.equal(res.statusCode,401);
  res=response();await handler({method:'GET',headers:{authorization:`Vault ${codeA}`}},res);assert.equal(res.statusCode,503);
 }finally{if(old!==undefined)process.env.BLOB_STORE_ID=old;}
 assert.notEqual(vaultPath(`Vault ${codeA}`),vaultPath(`Vault ${codeB}`));
 assert.ok(!vaultPath('Vault short-code'));
});
test('vault persists data, isolates codes, and rejects stale writes',async()=>{
 const old=process.env.BLOB_STORE_ID;process.env.BLOB_STORE_ID='store-test';const handler=createVaultHandler(fakeStorage());
 const call=async(method,code,body)=>{const res=response();await handler({method,headers:{authorization:`Vault ${code}`},body},res);return res;};
 try{
  const saved=await call('PUT',codeA,{snapshot:content,etag:null});assert.equal(saved.statusCode,200);
  const read=await call('GET',codeA);assert.equal(read.statusCode,200);assert.equal(read.payload.snapshot.days[0].words[0].en,'coffee');
  assert.equal(read.payload.snapshot.speaking['skill:0-0'],true);
  assert.equal((await call('GET',codeB)).payload.exists,false);
  assert.equal((await call('PUT',codeA,{snapshot:content,etag:'"stale"'})).statusCode,409);
  assert.equal((await call('PUT',codeA,{snapshot:content,etag:read.payload.etag})).statusCode,200);
  assert.equal((await call('PUT',codeA,{snapshot:{days:[]},etag:null})).statusCode,400);
  assert.equal((await call('PUT',codeB,{snapshot:{...content,speaking:[]},etag:null})).statusCode,400);
 }finally{if(old===undefined)delete process.env.BLOB_STORE_ID;else process.env.BLOB_STORE_ID=old;}
});
test('browser cloud sync keeps the recovery code local and restores saved vocabulary',async()=>{
 const source=fs.readFileSync(new URL('../vault-sync.js',import.meta.url),'utf8');
 const values=new Map([['ivDays',JSON.stringify(content.days)],['ivStats',JSON.stringify(content.stats)]]);
 const requests=[];let stored=null,etag='"first"';
 const localStorage={getItem:k=>values.get(k)||null,setItem:(k,v)=>values.set(k,String(v)),removeItem:k=>values.delete(k)};
 const fetch=async(url,options)=>{
  if(url==='/api/account')return {ok:true,json:async()=>({account:null})};
  requests.push({method:options.method,authorization:options.headers.Authorization});
  if(options.method==='GET')return {ok:true,json:async()=>stored?{exists:true,snapshot:stored,etag}:{exists:false,snapshot:null,etag:null}};
  stored=JSON.parse(options.body).snapshot;etag='"saved"';return {ok:true,json:async()=>({saved:true,etag})};
 };
 const context=vm.createContext({globalThis:null,localStorage,crypto:webcrypto,fetch,AbortSignal,Uint8Array,Array,JSON,Response,clearTimeout:()=>{},setTimeout:()=>1});
 context.globalThis=context;
 vm.runInContext(source,context);
 await context.CloudVault.init({create:true});
 assert.equal(requests[0].method,'PUT');assert.equal(stored.days[0].words[0].en,'coffee');
 assert.equal(values.get('ivVaultKey').length,64);assert.equal(values.get('ivVaultDirty'),undefined);
 values.set('ivDays',JSON.stringify([]));
 const recovered=await context.CloudVault.preview(context.CloudVault.format(context.CloudVault.key));
 context.CloudVault.adopt(recovered);
 assert.equal(JSON.parse(values.get('ivDays'))[0].words[0].en,'coffee');
});
test('a stale browser copy can be saved under a separate recovery code',async()=>{
 const source=fs.readFileSync(new URL('../vault-sync.js',import.meta.url),'utf8');
 const values=new Map([['ivDays',JSON.stringify(content.days)],['ivStats',JSON.stringify(content.stats)],['ivVaultKey',codeA],['ivVaultEtag','"old"'],['ivVaultDirty','1']]);
 const writes=[];
 const localStorage={getItem:k=>values.get(k)||null,setItem:(k,v)=>values.set(k,String(v)),removeItem:k=>values.delete(k)};
 const fetch=async(url,options)=>{
  if(url==='/api/account')return {ok:true,json:async()=>({account:null})};
  if(options.method==='GET')return {ok:true,json:async()=>({exists:true,snapshot:content,etag:'"new"'})};
  writes.push({authorization:options.headers.Authorization,body:JSON.parse(options.body)});
  return {ok:true,json:async()=>({saved:true,etag:'"forked"'})};
 };
 const context=vm.createContext({globalThis:null,localStorage,crypto:webcrypto,fetch,AbortSignal,Uint8Array,Array,JSON,Response,clearTimeout:()=>{},setTimeout:()=>1});
 context.globalThis=context;vm.runInContext(source,context);
 await context.CloudVault.init({create:true});
 assert.equal(context.CloudVault.conflict,true);
 const replacement=await context.CloudVault.fork();
 assert.equal(replacement.replaceAll('-','').length,64);
 assert.notEqual(values.get('ivVaultKey'),codeA);
 assert.equal(writes.length,1);
 assert.equal(writes[0].body.snapshot.days[0].words[0].en,'coffee');
 assert.equal(values.get('ivVaultDirty'),undefined);
});
test('browser account sync restores lessons on a second device without a recovery code',async()=>{
 const source=fs.readFileSync(new URL('../vault-sync.js',import.meta.url),'utf8');
 let account=null,cloud=null,etag='"account-1"';
 const fetch=async(url,options={})=>{
  if(url==='/api/account'){
   if(!options.method)return {ok:true,json:async()=>({account})};
   const body=JSON.parse(options.body);
   if(body.action==='register'){
    cloud=body.snapshot;account={id:'c'.repeat(64),email:body.email};
   }
   return {ok:true,json:async()=>({account})};
  }
  if(options.method==='GET')return {ok:true,json:async()=>cloud?{exists:true,snapshot:cloud,etag}:{exists:false,snapshot:null,etag:null}};
  cloud=JSON.parse(options.body).snapshot;etag='"account-2"';
  return {ok:true,json:async()=>({saved:true,etag})};
 };
 const device=values=>{
  const localStorage={getItem:k=>values.get(k)||null,setItem:(k,v)=>values.set(k,String(v)),removeItem:k=>values.delete(k)};
  const context=vm.createContext({globalThis:null,localStorage,crypto:webcrypto,fetch,AbortSignal,Uint8Array,Array,JSON,Response,clearTimeout:()=>{},setTimeout:()=>1});
  context.globalThis=context;vm.runInContext(source,context);return context.CloudVault;
 };
 const firstValues=new Map([['ivDays',JSON.stringify(content.days)],['ivStats',JSON.stringify(content.stats)]]);
 const first=device(firstValues);
 await first.init({create:true});
 await first.signIn('register','learner@example.com','password123');
 assert.equal(first.mode,'account');
 const secondValues=new Map();
 const second=device(secondValues);
 await second.init({create:true});
 assert.equal(second.mode,'account');
 assert.equal(second.key,'');
 assert.equal(JSON.parse(secondValues.get('ivDays'))[0].words[0].en,'coffee');
 account=null;
 await second.init({create:true});
 assert.equal(second.mode,'signedout');
 secondValues.set('ivDays',JSON.stringify([{id:'day-2',words:[{en:'tea',vi:'trà'}]}]));
 second.queue();
 assert.equal(secondValues.get('ivAccountDirty'),'1');
 account={id:'c'.repeat(64),email:'learner@example.com'};
 await second.init({create:true});
 assert.equal(cloud.days[0].words[0].en,'tea');
 assert.equal(secondValues.get('ivAccountDirty'),undefined);
});

test('compressed downloads do not turn fresh vault revisions into false write conflicts',async()=>{
 const previous=process.env.BLOB_STORE_ID;process.env.BLOB_STORE_ID='store-test';
 const backing=fakeStorage();
 const storage={...backing,async get(path,options){
  const row=await backing.get(path);if(!row)return row;
  // HTTP compression weakens the download ETag; writes require the original tag.
  if(options?.headers?.['Accept-Encoding']!=='identity')row.blob.etag='W/'+row.blob.etag;
  return row;
 }};
 const handler=createVaultHandler(storage);
 const call=async(method,body)=>{const res=response();await handler({method,headers:{authorization:`Vault ${codeA}`},body},res);return res;};
 try{
  const created=await call('PUT',{snapshot:content,etag:null});assert.equal(created.statusCode,200);
  const loaded=await call('GET');assert.equal(loaded.statusCode,200);
  const updated={...content,days:[...content.days,{id:'imported',words:[{en:'tea',vi:'trà'}]}]};
  const saved=await call('PUT',{snapshot:updated,etag:loaded.payload.etag});
  assert.equal(saved.statusCode,200,'A freshly loaded revision must be usable for conditional saving');
  assert.equal((await call('GET')).payload.etag,saved.payload.etag);
  assert.equal((await call('PUT',{snapshot:content,etag:loaded.payload.etag})).statusCode,409,'Genuinely stale writes must still fail');
 }finally{if(previous===undefined)delete process.env.BLOB_STORE_ID;else process.env.BLOB_STORE_ID=previous;}
});
