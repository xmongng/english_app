import test from 'node:test';
import assert from 'node:assert/strict';
import handler from '../api/chat.js';
import ttsHandler from '../api/tts.js';
import { reserveNvidiaCall, reserveBlobCall, resetLocalLimiterForTests } from '../api/rate-limit.js';
import fs from 'node:fs';
import vm from 'node:vm';
function response(){return {statusCode:200,headers:{},setHeader(k,v){this.headers[k]=v;},status(s){this.statusCode=s;return this;},json(p){this.payload=p;},end(){}};}
const valid={items:[{en:'coffee',vi:'cà phê',example:'I drink coffee before work.'}]};
const completion=(value,finish_reason='stop')=>({ok:true,json:async()=>({choices:[{finish_reason,message:{content:JSON.stringify(value)}}]})});
test('escalates invalid small-model import and sends server key only upstream',async()=>{
 const original=globalThis.fetch,clock=Date.now,previous=process.env.NVIDIA_API_KEY;process.env.NVIDIA_API_KEY='test-only';resetLocalLimiterForTests();let calls=[];let now=1_000_000;Date.now=()=>now;
 globalThis.fetch=async(url,options)=>{calls.push(JSON.parse(options.body));assert.equal(options.headers.Authorization,'Bearer test-only');return completion(calls.length===1?{items:[{en:'coffee',vi:'cà phê'}]}:valid);};
 try{
  const first=response();await handler({method:'POST',body:{task:'import',text:'**coffee** cà phê'}},first);
  assert.equal(first.statusCode,429);assert.equal(first.headers['Retry-After'],'15');assert.equal(first.headers['X-AI-Resume-Model'],'1');assert.equal(calls.length,1);
  now+=15_000;
  const res=response();await handler({method:'POST',body:{task:'import',text:'**coffee** cà phê',resumeModel:1}},res);assert.equal(res.statusCode,200);assert.equal(calls.length,2);assert.equal(calls[0].model,'openai/gpt-oss-20b');assert.equal(calls[1].model,'nvidia/nemotron-3.5-lightning-30b-a3b');assert.equal(calls[1].chat_template_kwargs.enable_thinking,false);assert.ok(!JSON.stringify(res.payload).includes('test-only'));
 }
 finally{globalThis.fetch=original;Date.now=clock;if(previous===undefined)delete process.env.NVIDIA_API_KEY;else process.env.NVIDIA_API_KEY=previous;}
});
test('does not promote truncated output or reasoning-only response to a usable answer',async()=>{
 const original=globalThis.fetch,clock=Date.now,previous=process.env.NVIDIA_API_KEY;process.env.NVIDIA_API_KEY='test-only';resetLocalLimiterForTests();let calls=0;let now=2_000_000;Date.now=()=>now;
 globalThis.fetch=async()=>++calls===1?completion(valid,'length'):{ok:true,json:async()=>({choices:[{finish_reason:'stop',message:{reasoning_content:'not a final answer'}}]})};
 try{const first=response();await handler({method:'POST',body:{task:'import',text:'coffee'}},first);assert.equal(first.statusCode,429);now+=15_000;const res=response();await handler({method:'POST',body:{task:'import',text:'coffee',resumeModel:3,routingFailures:first.payload.routingFailures}},res);assert.equal(res.statusCode,502);assert.equal(res.payload.code,'AI_UNAVAILABLE');assert.equal(res.payload.attemptedModels.length,2);assert.equal(res.payload.routingFailures[0].reason,'truncated');assert.equal(res.payload.routingFailures[1].reason,'empty_answer');}
 finally{globalThis.fetch=original;Date.now=clock;if(previous===undefined)delete process.env.NVIDIA_API_KEY;else process.env.NVIDIA_API_KEY=previous;}
});
test('import falls through all four routes across rate-limit continuations',async()=>{
 const original=globalThis.fetch,clock=Date.now,previous=process.env.NVIDIA_API_KEY;
 process.env.NVIDIA_API_KEY='test-only';resetLocalLimiterForTests();let now=4_000_000,calls=0;Date.now=()=>now;
 globalThis.fetch=async()=>{
  calls++;
  if(calls===1)return completion({items:[]});
  if(calls===2){const error=new Error('Timeout');error.name='TimeoutError';throw error;}
  if(calls===3)return {ok:false,status:503};
  return completion(valid);
 };
 try{
  let body={task:'import',text:'**coffee** cà phê'},res;
  for(let i=0;i<4;i++){
   res=response();await handler({method:'POST',body},res);
   if(res.statusCode===200)break;
   assert.equal(res.statusCode,429);
   body={...body,resumeModel:Number(res.headers['X-AI-Resume-Model']),routingFailures:res.payload.routingFailures};now+=15_000;
  }
  assert.equal(res.statusCode,200);assert.equal(calls,4);
  assert.equal(res.headers['X-AI-Model'],'nvidia/nemotron-3-ultra-550b-a55b');
  assert.deepEqual(body.routingFailures.map(x=>x.reason),['invalid_output','timeout','provider_error']);
 }finally{globalThis.fetch=original;Date.now=clock;if(previous===undefined)delete process.env.NVIDIA_API_KEY;else process.env.NVIDIA_API_KEY=previous;}
});
test('a slow failure gives the next model a fresh serverless time budget',async()=>{
 const original=globalThis.fetch,clock=Date.now,previous=process.env.NVIDIA_API_KEY;
 process.env.NVIDIA_API_KEY='test-only';resetLocalLimiterForTests();let now=5_000_000,calls=0;Date.now=()=>now;
 globalThis.fetch=async()=>{calls++;now+=23_000;const error=new Error('Timeout');error.name='TimeoutError';throw error;};
 try{
  const res=response();await handler({method:'POST',body:{task:'import',text:'coffee'}},res);
  assert.equal(calls,1);assert.equal(res.statusCode,429);assert.equal(res.payload.code,'AI_CONTINUE');
  assert.equal(res.headers['X-AI-Resume-Model'],'1');assert.equal(res.payload.routingFailures[0].reason,'timeout');
 }finally{globalThis.fetch=original;Date.now=clock;if(previous===undefined)delete process.env.NVIDIA_API_KEY;else process.env.NVIDIA_API_KEY=previous;}
});
test('missing server key cannot be replaced by a browser credential',async()=>{
 const a=process.env.NVIDIA_API_KEY,b=process.env.AI_API_KEY;delete process.env.NVIDIA_API_KEY;delete process.env.AI_API_KEY;
 try{const res=response();await handler({method:'POST',headers:{authorization:'Bearer client-key'},body:{messages:[]}},res);assert.equal(res.statusCode,503);}
 finally{if(a!==undefined)process.env.NVIDIA_API_KEY=a;if(b!==undefined)process.env.AI_API_KEY=b;}
});
test('one NVIDIA call every 15 seconds, including across separate handler requests',async()=>{
 resetLocalLimiterForTests();
 assert.deepEqual(await reserveNvidiaCall('test-only',1_000_000),{allowed:true,retryAfter:0});
 assert.deepEqual(await reserveNvidiaCall('test-only',1_001_000),{allowed:false,retryAfter:14});
 assert.deepEqual(await reserveNvidiaCall('test-only',1_015_000),{allowed:true,retryAfter:0});
});
test('private storage gate coordinates concurrent serverless instances',async()=>{
 let row=null,version=0;
 const storage={
  async get(_key,options){assert.equal(options.useCache,false);return row?{stream:new Response(row.body).body,blob:{etag:row.etag}}:null;},
  async put(key,body,options){
   assert.ok(!key.includes('private-key'));
   if(row&&(!options.ifMatch||options.ifMatch!==row.etag)){const error=new Error('Conflict');error.name=options.ifMatch?'BlobPreconditionFailedError':'BlobError';throw error;}
   row={body,etag:String(++version)};
  }
 };
 const results=await Promise.all([reserveBlobCall('private-key',100_000,storage),reserveBlobCall('private-key',100_000,storage)]);
 assert.equal(results.filter(x=>x.allowed).length,1);
 assert.equal(results.find(x=>!x.allowed).retryAfter,15);
 assert.equal((await reserveBlobCall('private-key',115_000,storage)).allowed,true);
});
test('shared Redis gate refuses a second instance without exposing the API key',async()=>{
 const previousUrl=process.env.UPSTASH_REDIS_REST_URL,previousToken=process.env.UPSTASH_REDIS_REST_TOKEN,original=globalThis.fetch;
 process.env.UPSTASH_REDIS_REST_URL='https://rate.example.test';process.env.UPSTASH_REDIS_REST_TOKEN='redis-test';let calls=[];
 globalThis.fetch=async(url,options)=>{calls.push(JSON.parse(options.body));return {ok:true,json:async()=>({result:calls.length===1?'OK':calls.length===2?null:12_000})};};
 try{
  assert.equal((await reserveNvidiaCall('private-key')).allowed,true);
  assert.deepEqual(await reserveNvidiaCall('private-key'),{allowed:false,retryAfter:12});
  assert.equal(calls[0][0],'SET');assert.equal(calls[0][3],'NX');assert.equal(calls[2][0],'PTTL');
  assert.ok(!JSON.stringify(calls).includes('private-key'));
 }finally{globalThis.fetch=original;if(previousUrl===undefined)delete process.env.UPSTASH_REDIS_REST_URL;else process.env.UPSTASH_REDIS_REST_URL=previousUrl;if(previousToken===undefined)delete process.env.UPSTASH_REDIS_REST_TOKEN;else process.env.UPSTASH_REDIS_REST_TOKEN=previousToken;}
});
test('inconsistent grading cannot be returned as a scored review',async()=>{
 const original=globalThis.fetch,clock=Date.now,previous=process.env.NVIDIA_API_KEY;
 process.env.NVIDIA_API_KEY='test-only';resetLocalLimiterForTests();Date.now=()=>3_000_000;
 globalThis.fetch=async()=>completion({analysis:{hasError:true,score:8,isNatural:true,errorExcerpt:'drinks',feedback:'Wrong verb.',correctedSentence:'I drink coffee.'}});
 try{
  const res=response();await handler({method:'POST',body:{task:'review',messages:[{role:'user',content:'I drinks coffee.'}]}},res);
  assert.equal(res.statusCode,429);assert.equal(res.headers['X-AI-Resume-Model'],'1');
 }finally{globalThis.fetch=original;Date.now=clock;if(previous===undefined)delete process.env.NVIDIA_API_KEY;else process.env.NVIDIA_API_KEY=previous;}
});
test('browser resumes the same model after Retry-After without losing import data',async()=>{
 const html=fs.readFileSync(new URL('../ielts_vocab_master.html',import.meta.url),'utf8');
 const source=html.slice(html.indexOf('async function fetchAIRateLimited('),html.indexOf('// Robust AI fetch:'));
 const requests=[];const response={status:200};
 const context=vm.createContext({importBusy:false,Number,Promise,setTimeout:fn=>fn(),fetch:async(_url,options)=>{
  requests.push(JSON.parse(options.body));
  return requests.length===1?{status:429,headers:{get:name=>name==='Retry-After'?'15':name==='X-AI-Resume-Model'?'1':null},clone:()=>({json:async()=>({routingFailures:[{model:'openai/gpt-oss-20b',reason:'timeout'}]})})}:response;
 }});
 vm.runInContext(source,context);
 const result=await vm.runInContext('fetchAIRateLimited("/api/chat",{},JSON.stringify({task:"import",text:"**coffee** cà phê"}))',context);
 assert.equal(result,response);assert.equal(requests.length,2);assert.equal(requests[1].resumeModel,1);assert.equal(requests[1].text,'**coffee** cà phê');
 assert.equal(requests[1].routingFailures[0].reason,'timeout');
});
test('public bundle has no shared Firebase profile or provider credential',()=>{
 for(const name of ['ielts_vocab_master.html','chat_companion.html']){
  const html=fs.readFileSync(new URL(`../${name}`,import.meta.url),'utf8');
  assert.ok(!/CLOUD_PROFILE_ID\s*=\s*window|AIza[0-9A-Za-z_-]{30,}|nvapi-[A-Za-z0-9_-]{16,}/.test(html));
 }
});
test('TTS cannot accept a browser-supplied provider key',async()=>{
 const oldTts=process.env.NVIDIA_TTS_API_KEY,oldNvidia=process.env.NVIDIA_API_KEY;
 delete process.env.NVIDIA_TTS_API_KEY;delete process.env.NVIDIA_API_KEY;
 try{const res=response();await ttsHandler({method:'POST',headers:{authorization:'Bearer client-key'},body:{text:'Hello'}},res);assert.equal(res.statusCode,503);}
 finally{if(oldTts!==undefined)process.env.NVIDIA_TTS_API_KEY=oldTts;if(oldNvidia!==undefined)process.env.NVIDIA_API_KEY=oldNvidia;}
});
