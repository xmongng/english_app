import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const html=fs.readFileSync(new URL('../ielts_vocab_master.html',import.meta.url),'utf8');
const source=html.slice(html.indexOf('async function submitAccount('),html.indexOf('async function signOutAccount('));
test('login paints the newly loaded account after the focused form closes',async()=>{
 const calls=[],button={disabled:false};
 const context=vm.createContext({
  $:selector=>({value:selector==='#accountEmail'?'test@example.invalid':'password'}),
  CloudVault:{account:null,dirty:false,lastStatus:{kind:'cloud'},async signIn(){this.account={id:'test'};calls.push('loaded');}},
  closeModal:()=>calls.push('closed'),updateTopStats:()=>calls.push('stats'),switchMainTab:tab=>calls.push(tab),toast:()=>{},
  currentDayId:'previous-account-lesson',currentGroupId:'previous-group',activity:'flash',currentMainTab:'learn'
 });
 vm.runInContext(source,context);
 await context.submitAccount({preventDefault(){},submitter:button},'login');
 assert.deepEqual(calls,['loaded','closed','stats','learn']);
 assert.equal(context.currentDayId,null);assert.equal(context.currentGroupId,null);assert.equal(context.activity,null);
 assert.equal(button.disabled,false);
});
