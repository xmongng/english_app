import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const html=fs.readFileSync(new URL('../ielts_vocab_master.html',import.meta.url),'utf8');
const source=html.slice(html.indexOf('function bindRecallPractice()'),html.indexOf('\n/* Post-render event binding */'));

test('typing practice stays on a wrong answer and advances only after a correct retry',async()=>{
  const input={value:'tee',selected:0,focused:0,select(){this.selected++;},focus(){this.focused++;}};
  const button={_bound:false,disabled:false};
  const feedback={className:'',textContent:''};
  const marks=[],timers=[];
  const elements={'#recallCheck':button,'#recallIn':input,'#recallFb':feedback};
  const context=vm.createContext({
    $:selector=>elements[selector]||null,curWord:()=>({en:'tea'}),norm:value=>String(value).trim().toLowerCase(),
    markPractice:async(ok,extra={})=>{marks.push({ok,extra});return true;},console,
    currentDayId:'lesson',activity:'recall',wIdx:0,nextW:()=>{context.wIdx++;},
    setTimeout:fn=>{timers.push(fn);return 1;}
  });
  vm.runInContext(source,context);context.bindRecallPractice();

  await button.onclick();
  assert.equal(context.wIdx,0);assert.equal(timers.length,0);assert.equal(button.disabled,false);
  assert.equal(feedback.textContent,'Not quite. Check the spelling and try again.');
  assert.deepEqual(marks.map(x=>x.ok),[false]);assert.equal(marks[0].extra.grantsCredit,false);

  input.value='still wrong';await button.onclick();
  assert.deepEqual(marks.map(x=>x.ok),[false],'Repeated wrong retries must not inflate attempt totals');
  assert.equal(context.wIdx,0);

  input.value='tea';await button.onclick();
  assert.deepEqual(marks.map(x=>x.ok),[false,true]);assert.equal(button.disabled,true);
  assert.equal(timers.length,1);assert.equal(context.wIdx,0);
  timers[0]();assert.equal(context.wIdx,1);
});
