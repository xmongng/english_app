import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import '../import-flow.js';
const {chunks,createRunner}=globalThis.ImportFlow;
const fixture=JSON.parse(fs.readFileSync(new URL('./fixtures/import-twenty.json',import.meta.url),'utf8'));

test('twenty entries fit one call in JSON, Markdown, and table formats',()=>{
 const sources=[JSON.stringify(fixture),fixture.map(x=>`**${x.en}** ${x.vi}`).join('\n'),
  '| English | Vietnamese | Example |\n| --- | --- | --- |\n'+fixture.map(x=>`| ${x.en} | ${x.vi} | ${x.example||''} |`).join('\n')];
 for(const source of sources)assert.equal(chunks(source).length,1);
});
test('larger tables preserve headers, topics, and examples across batches',()=>{
 const rows=Array.from({length:42},(_,i)=>`| word${i} | nghĩa ${i} | Example sentence number ${i}. |`);
 const source='# Daily life\n| English | Vietnamese | Example |\n| --- | --- | --- |\n'+rows.join('\n');
 const result=chunks(source);assert.equal(result.length,3);
 for(const part of result){assert.ok(part.includes('# Daily life'));assert.ok(part.includes('| English | Vietnamese | Example |'));}
 for(const row of rows)assert.equal(result.filter(x=>x.includes(row)).length,1);
 const multiline=fixture.map(x=>`${x.en} → ${x.vi}\nExample: I often use ${x.en} in conversation.`).join('\n');
 assert.equal(chunks(multiline).length,1);
});
test('adaptive splitting keeps successful groups and retries only failed groups',async()=>{
 let failed=true;const sizes=[];
 const runner=createRunner(async source=>{
  const items=JSON.parse(source);sizes.push(items.length);
  if(items.length>10||(failed&&items.some(x=>x.en==='overcome'))){const error=new Error('Needs smaller batch');error.code='AI_SPLIT_BATCH';throw error;}
  return items;
 });
 const first=await runner.run(JSON.stringify(fixture),'General');
 assert.equal(first.items.length,15);assert.equal(first.failed.length,1);
 assert.deepEqual(sizes,[20,10,10,5,5]);
 failed=false;
 const second=await runner.run(JSON.stringify(fixture),'General');
 assert.equal(second.items.length,20);assert.equal(second.failed.length,0);
 assert.deepEqual(sizes,[20,10,10,5,5,5]);
});
test('credential failures do not fan out into smaller paid requests',async()=>{
 let calls=0;
 const runner=createRunner(async()=>{calls++;const error=new Error('Invalid credentials');error.code='PROVIDER_AUTH';throw error;});
 const result=await runner.run(JSON.stringify(fixture),'General');
 assert.equal(calls,1);assert.equal(result.failed.length,1);assert.equal(result.items.length,0);
});
test('API error codes survive the browser wrapper for adaptive import',async()=>{
 const html=fs.readFileSync(new URL('../ielts_vocab_master.html',import.meta.url),'utf8');
 const source=html.slice(html.indexOf('async function aiResponseError('),html.indexOf('async function fetchAI('));
 const context=vm.createContext({response:{status:422,text:async()=>JSON.stringify({error:'Split this batch',code:'AI_SPLIT_BATCH'})}});
 vm.runInContext(source,context);
 const error=await vm.runInContext('aiResponseError(response)',context);
 assert.equal(error.code,'AI_SPLIT_BATCH');assert.ok(error.message.includes('Split this batch'));
});
