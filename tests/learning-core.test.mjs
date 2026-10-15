import test from 'node:test';
import assert from 'node:assert/strict';
import '../learning-core.js';
const core = globalThis.LearningCore;
import fs from 'node:fs';
import vm from 'node:vm';

test('clean Markdown without losing apostrophes or hyphens',()=>{
 assert.equal(core.cleanWord('**coffee**'),'coffee');
 assert.equal(core.cleanWord('  12. **well-being**  '),'well-being');
 assert.equal(core.cleanWord("`change one's mind`"),"change one's mind");
 assert.equal(core.cleanWord('☕ **coffee** (n.)'),'coffee');
});
test('parse mixed Markdown, CSV, arrows and multiline examples',()=>{
 const words=core.parseImport('**coffee** cà phê\nExample: I drink coffee every morning.\n- take a break → nghỉ giải lao\n"resilient","kiên cường","She stayed resilient, even after the setback."');
 assert.equal(words.length,3);assert.equal(words[0].en,'coffee');assert.equal(words[0].vi,'cà phê');assert.match(words[0].example,/coffee/);
 assert.equal(words[1].en,'take a break');assert.match(words[2].example,/resilient, even/);
});
test('parse tables, JSON and duplicates',()=>{
 const words=core.parseImport('| English | Vietnamese | Example |\n| --- | --- | --- |\n| coffee | cà phê | I drink coffee every morning. |\n| coffee | cà phê | She drinks coffee at work. |');
 assert.equal(words.length,2);assert.equal(words[1].duplicate,true);
 assert.equal(core.parseImport('[{"word":"**coffee**","translation":"cà phê"}]')[0].en,'coffee');
});
test('reject incomplete AI response or omitted clear source term',()=>{
 assert.throws(()=>core.validateImport({items:[{en:'coffee',vi:'cà phê'}]}));
 assert.throws(()=>core.validateImport({items:[{en:'tea',vi:'trà',example:'I drink tea at work.'}]},'**coffee** cà phê'));
});
test('ambiguous bilingual notes do not become impossible source-term requirements',()=>{
 const source='coffee cà phê: a morning drink';
 const items=core.validateImport({items:[{en:'coffee',vi:'cà phê',example:'I drink coffee before work.'}]},source);
 assert.equal(items[0].en,'coffee');
 assert.equal(core.requiredImportEntries(source).length,0);
 assert.equal(core.requiredImportEntries('**coffee** cà phê').length,1);
});
test('streak requires daily goal, survives yesterday, breaks after missed day',()=>{
 const ledger={'2026-10-04':{count:5},'2026-10-05':{count:7},'2026-10-06':{count:5},'2026-10-07':{count:4}};
 assert.equal(core.studyHabit(ledger,[],new Date('2026-10-07T20:00:00')).current,3);
 ledger['2026-10-07'].count=5;
 assert.equal(core.studyHabit(ledger,[],new Date('2026-10-07T20:00:00')).current,4);
 assert.equal(core.studyHabit(ledger,[],new Date('2026-10-09T00:01:00')).current,0);
 assert.equal(core.studyHabit(ledger,[],new Date('2026-10-09T00:01:00')).longest,4);
});
test('ledger survives log truncation and ignores future/invalid timestamps',()=>{
 const habit=core.studyHabit({'2026-10-05':{count:5},'2026-10-06':{count:5}},[{id:'bad',createdAt:'bad'},{id:'future',createdAt:'2099-01-01'}],new Date('2026-10-07T00:01:00'));
 assert.equal(habit.current,2);assert.equal(habit.todayCount,0);
});
test('saved daily credits remain authoritative over duplicate legacy logs',()=>{
 const logs=Array.from({length:10},(_,i)=>({id:String(i),word:'coffee',activity:'recall',createdAt:'2026-10-07T10:00:00'}));
 assert.equal(core.studyHabit({'2026-10-07':{count:1}},logs,new Date('2026-10-07T20:00:00')).todayCount,1);
 assert.equal(core.studyHabit({},logs,new Date('2026-10-07T20:00:00')).todayCount,1);
});
test('calendar days stay consecutive across daylight saving changes',()=>{
 const ledger={'2026-03-07':{count:5},'2026-03-08':{count:5},'2026-03-09':{count:5}};
 assert.equal(core.studyHabit(ledger,[],new Date('2026-03-09T23:30:00')).current,3);
});
function scoringSandbox(){
 const html=fs.readFileSync(new URL('../ielts_vocab_master.html',import.meta.url),'utf8');
 const source=html.slice(html.indexOf('async function markPractice('),html.indexOf('\nfunction markMastered'));
 const context=vm.createContext({stats:{xp:0,total:0,correct:0,done:0},word:{en:'coffee'},activity:'recall',composeMode:'free',currentDayId:'lesson',norm:core.key,localDateKey:core.dateKey,console,logs:[]});
 vm.runInContext(`function curWord(){return word;} function awardXP(n){stats.xp+=n;} function updateWordReviewSchedule(){} function findWordInOriginalDays(){return {day:{id:'lesson'}};} function calculateStudyHabit(){return {current:0};} async function save(){} function updateTopStats(){} const dataService={async addPracticeLog(log){logs.push(log);}};`+source,context);
 return context;
}
test('repeated submit/reload credit never inflates points, accuracy or streak count',async()=>{
 const c=scoringSandbox();await vm.runInContext('markPractice(false)',c);await vm.runInContext('markPractice(true)',c);
 assert.equal(c.stats.xp,2);assert.equal(c.stats.total,1);assert.equal(c.stats.correct,0);assert.equal(c.logs.length,1);
 assert.equal(Object.values(c.stats.activityDays)[0].count,1);
});
test('daily XP cap and self-rated flashcards excluded from accuracy',async()=>{
 const c=scoringSandbox();
 for(let i=0;i<15;i++){c.word={en:'word '+i};await vm.runInContext('markPractice(true)',c);}
 assert.equal(c.stats.xp,100);assert.equal(c.stats.total,15);
 c.activity='flash';await vm.runInContext('markPractice(true)',c);
 assert.equal(c.stats.total,15);assert.equal(c.logs.at(-1).scored,false);
});
test('writing average does not treat unscored attempts as zero',()=>{
 const html=fs.readFileSync(new URL('../ielts_vocab_master.html',import.meta.url),'utf8');
 const source=html.match(/function writingAverage\(\)\{[^\n]+/)[0];
 const c=vm.createContext({practiceLogs:[{score:null},{score:8},{score:6},{}]});
 assert.equal(vm.runInContext(source+';writingAverage()',c),'7.0');
});
