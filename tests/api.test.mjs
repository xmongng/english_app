import test from 'node:test';
import assert from 'node:assert/strict';
import handler from '../api/chat.js';
import ttsHandler from '../api/tts.js';
import { reserveNvidiaCall, resetLocalLimiterForTests } from '../api/rate-limit.js';
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
  const res=response();await handler({method:'POST',body:{task:'import',text:'**coffee** cà phê',resumeModel:1}},res);assert.equal(res.statusCode,200);assert.equal(calls.length,2);assert.equal(calls[0].model,'openai/gpt-oss-20b');assert.equal(calls[1].model,'nvidia/nemotron-3-super-120b-a12b');assert.ok(!JSON.stringify(res.payload).includes('test-only'));
 }
 finally{globalThis.fetch=original;Date.now=clock;if(previous===undefined)delete process.env.NVIDIA_API_KEY;else process.env.NVIDIA_API_KEY=previous;}
});
test('does not promote truncated output or reasoning-only response to a usable answer',async()=>{
 const original=globalThis.fetch,clock=Date.now,previous=process.env.NVIDIA_API_KEY;process.env.NVIDIA_API_KEY='test-only';resetLocalLimiterForTests();let calls=0;let now=2_000_000;Date.now=()=>now;
 globalThis.fetch=async()=>++calls===1?completion(valid,'length'):{ok:true,json:async()=>({choices:[{finish_reason:'stop',message:{reasoning_content:'not a final answer'}}]})};
 try{const first=response();await handler({method:'POST',body:{task:'import',text:'coffee'}},first);assert.equal(first.statusCode,429);now+=15_000;const res=response();await handler({method:'POST',body:{task:'import',text:'coffee',resumeModel:1}},res);assert.equal(res.statusCode,502);assert.equal(res.payload.code,'AI_UNAVAILABLE');}
 finally{globalThis.fetch=original;Date.now=clock;if(previous===undefined)delete process.env.NVIDIA_API_KEY;else process.env.NVIDIA_API_KEY=previous;}
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
  return requests.length===1?{status:429,headers:{get:name=>name==='Retry-After'?'15':name==='X-AI-Resume-Model'?'1':null}}:response;
 }});
 vm.runInContext(source,context);
 const result=await vm.runInContext('fetchAIRateLimited("/api/chat",{},JSON.stringify({task:"import",text:"**coffee** cà phê"}))',context);
 assert.equal(result,response);assert.equal(requests.length,2);assert.equal(requests[1].resumeModel,1);assert.equal(requests[1].text,'**coffee** cà phê');
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
