import test from 'node:test';
import assert from 'node:assert/strict';
import { createAccountHandler } from '../api/account.js';
import { createVaultHandler } from '../api/vault.js';

const sample={schema:1,days:[{id:'lesson-1',words:[{en:'coffee',vi:'cà phê'}]}],stats:{xp:10},errors:[],mistakes:[],logs:[],progress:{},customTopics:[]};
function fakeStorage(){
  const rows=new Map();let version=0;
  return {
    async get(path,options){const row=rows.get(path);return row?{blob:{etag:options?.headers?.['Accept-Encoding']==='identity'?row.etag:'W/'+row.etag,size:row.body.length},stream:new Response(row.body).body}:null;},
    async put(path,body,options){const row=rows.get(path);
      if(row&&!options.allowOverwrite){const error=new Error('Exists');error.name='BlobAlreadyExistsError';throw error;}
      if(row&&options.ifMatch!==row.etag){const error=new Error('Stale');error.name='BlobPreconditionFailedError';throw error;}
      const etag=`"version-${++version}"`;rows.set(path,{body,etag});return {etag};
    }
  };
}
function response(){return {statusCode:200,headers:{},setHeader(k,v){this.headers[k]=v;},status(v){this.statusCode=v;return this;},json(v){this.payload=v;return this;}};}
function request(handler,method,body,cookie='',origin='https://study.test'){
  const res=response();const headers={host:'study.test',cookie,...(method==='POST'||method==='PUT'?{origin}:{})};
  return handler({method,headers,body},res).then(()=>res);
}
test('account signup moves existing lessons into a private account shared across devices',async()=>{
  const previous=process.env.BLOB_STORE_ID;process.env.BLOB_STORE_ID='store-test';
  const storage=fakeStorage(),account=createAccountHandler(storage),vault=createVaultHandler(storage);
  try{
    const created=await request(account,'POST',{action:'register',email:' Learner@Example.com ',password:'a strong password',snapshot:sample});
    assert.equal(created.statusCode,201);
    assert.equal(created.payload.account.email,'learner@example.com');
    assert.match(created.headers['Set-Cookie'],/HttpOnly; Secure; SameSite=Lax/);
    const firstCookie=created.headers['Set-Cookie'].split(';')[0];
    const firstRead=await request(vault,'GET',undefined,firstCookie);
    assert.equal(firstRead.payload.snapshot.days[0].words[0].en,'coffee');
    assert.equal(firstRead.payload.account.id,created.payload.account.id);
    const wrongAccount=await request(vault,'PUT',{snapshot:sample,etag:firstRead.payload.etag,accountId:'a'.repeat(64)},firstCookie);
    assert.equal(wrongAccount.statusCode,401);
    const duplicate=await request(account,'POST',{action:'register',email:'learner@example.com',password:'different password',snapshot:sample});
    assert.equal(duplicate.statusCode,409);
    const login=await request(account,'POST',{action:'login',email:'learner@example.com',password:'a strong password'});
    assert.equal(login.statusCode,200);
    const secondCookie=login.headers['Set-Cookie'].split(';')[0];
    const updated={...sample,days:[...sample.days,{id:'lesson-2',words:[{en:'tea',vi:'trà'}]}]};
    const save=await request(vault,'PUT',{snapshot:updated,etag:firstRead.payload.etag},secondCookie);
    assert.equal(save.statusCode,200);
    const restored=await request(vault,'GET',undefined,firstCookie);
    assert.equal(restored.payload.snapshot.days.length,2);
    const tampered=await request(vault,'GET',undefined,firstCookie.slice(0,-1)+'x');
    assert.equal(tampered.statusCode,401);
    const other=await request(vault,'GET');assert.equal(other.statusCode,401);
  }finally{if(previous===undefined)delete process.env.BLOB_STORE_ID;else process.env.BLOB_STORE_ID=previous;}
});
test('account rejects cross-origin writes and locks repeated bad passwords',async()=>{
  const previous=process.env.BLOB_STORE_ID;process.env.BLOB_STORE_ID='store-test';
  const account=createAccountHandler(fakeStorage());
  try{
    const foreign=await request(account,'POST',{action:'register',email:'a@example.com',password:'password123',snapshot:sample},'','https://other.test');
    assert.equal(foreign.statusCode,403);
    const created=await request(account,'POST',{action:'register',email:'a@example.com',password:'password123',snapshot:sample});
    assert.equal(created.statusCode,201);
    for(let i=0;i<5;i++)assert.equal((await request(account,'POST',{action:'login',email:'a@example.com',password:'wrongpass'})).statusCode,401);
    assert.equal((await request(account,'POST',{action:'login',email:'a@example.com',password:'password123'})).statusCode,429);
  }finally{if(previous===undefined)delete process.env.BLOB_STORE_ID;else process.env.BLOB_STORE_ID=previous;}
});
