import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const roadmap=fs.readFileSync(new URL('../SpeakQuest_English_Speaking_Roadmap_v3.html',import.meta.url),'utf8');
const app=fs.readFileSync(new URL('../ielts_vocab_master.html',import.meta.url),'utf8');

test('speaking roadmap opens as a dedicated full page from the main app',()=>{
  assert.match(app,/id="navSpeaking"[\s\S]*Speaking Roadmap/);
  assert.match(app,/id="navSpeaking"[^>]+onclick="openSpeakingRoadmap\(\)"/);
  assert.match(app,/function openSpeakingRoadmap\(\)[\s\S]*SpeakQuest_English_Speaking_Roadmap_v3\.html\?from=app/);
  assert.doesNotMatch(app,/id="pageSpeaking"|<iframe[^>]+SpeakQuest/);
  assert.match(roadmap,/id="backToVocabulary"[\s\S]*Back to Vocabulary/);
  assert.match(roadmap,/backToVocabulary'\)\.onclick=[^;]+ielts_vocab_master\.html/);
});

test('speaking progress queues account sync and retains checks, completion time, and last location',()=>{
  const script=[...roadmap.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].at(-1)[1];
  const source=script.slice(script.indexOf('function state()'),script.indexOf('function toast('));
  const values=new Map();let queued=0;
  const context=vm.createContext({
    progress:{},mode:'topic',selection:2,quest:1,STORE:'speakquest.progress.v3',Date,JSON,
    localStorage:{setItem:(key,value)=>values.set(key,String(value))},
    window:{parent:{CloudVault:{queue(){queued++;}}}}
  });
  vm.runInContext(source,context);
  vm.runInContext("state().checks['topic:2-1']=[true,true,false];state().checksUpdatedAt['topic:2-1']='2026-10-26T00:00:00.000Z';state().changedAt['skill:0-0']='2026-10-26T00:00:00.000Z';state().completedAt['skill:0-0']='2026-10-26T00:00:00.000Z';progress['skill:0-0']=true;saveLocation()",context);
  const saved=JSON.parse(values.get('speakquest.progress.v3'));
  assert.deepEqual(saved._state.checks['topic:2-1'],[true,true,false]);
  assert.equal(saved._state.completedAt['skill:0-0'],'2026-10-26T00:00:00.000Z');
  assert.deepEqual(saved._state.last,{mode:'topic',selection:2,quest:1});
  assert.equal(saved['skill:0-0'],true);assert.equal(queued,1);
});

test('speaking page reloads progress applied by account sync',()=>{
  assert.match(roadmap,/addEventListener\('storage',[\s\S]*event\.key===STORE[\s\S]*reloadSyncedProgress/);
  assert.match(roadmap,/const vault=window\.parent[\s\S]*vault\?\.queue\(\)/);
});

test('full-page speaking initializes the same account vault and shows sync status',()=>{
  assert.match(roadmap,/<script src="vault-sync\.js"><\/script>/);
  assert.match(roadmap,/CloudVault\.init\(\{create:true,onRestore:reloadSyncedProgress,onStatus:/);
  assert.match(roadmap,/id="speakingSyncStatus"/);
});
