import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import { createVaultHandler, vaultPath } from '../api/vault.js';

const codeA='a'.repeat(64),codeB='b'.repeat(64);
const content={schema:1,days:[{id:'day-1',words:[{en:'coffee',vi:'cà phê'}]}],stats:{xp:10},errors:[],mistakes:[],logs:[],progress:{},customTopics:[]};
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
  assert.equal((await call('GET',codeB)).payload.exists,false);
  assert.equal((await call('PUT',codeA,{snapshot:content,etag:'"stale"'})).statusCode,409);
  assert.equal((await call('PUT',codeA,{snapshot:content,etag:read.payload.etag})).statusCode,200);
  assert.equal((await call('PUT',codeA,{snapshot:{days:[]},etag:null})).statusCode,400);
 }finally{if(old===undefined)delete process.env.BLOB_STORE_ID;else process.env.BLOB_STORE_ID=old;}
});
test('browser cloud sync keeps the recovery code local and restores saved vocabulary',async()=>{
 const source=fs.readFileSync(new URL('../vault-sync.js',import.meta.url),'utf8');
 const values=new Map([['ivDays',JSON.stringify(content.days)],['ivStats',JSON.stringify(content.stats)]]);
 const requests=[];let stored=null,etag='"first"';
 const localStorage={getItem:k=>values.get(k)||null,setItem:(k,v)=>values.set(k,String(v)),removeItem:k=>values.delete(k)};
 const fetch=async(_url,options)=>{
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
