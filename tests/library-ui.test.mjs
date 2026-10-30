import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const html=fs.readFileSync(new URL('../ielts_vocab_master.html',import.meta.url),'utf8');

test('group lessons are ordered by creation time with virtual lesson last',()=>{
  const start=html.indexOf('function getGroupDays(groupId)');
  const end=html.indexOf('function renderGroup()',start);
  const source=html.slice(start,end);
  assert.match(source,/groupDays\.sort\(\(a,b\)/);
  assert.match(source,/Date\.parse\(a\.createdAt/);
  assert.match(source,/a\.isVirtual \? 1 : -1/);
});

test('add vocabulary tabs visibly follow the selected entry method',()=>{
  assert.match(html,/id="quickAddTab"[^>]+aria-selected="true"/);
  assert.match(html,/id="bulkImportTab"[^>]+aria-selected="false"/);
  assert.match(html,/function showQuickAdd\(\)\{\s*setImportTab\('quick'\)/);
  assert.match(html,/function showBulkImport\(\)\{\s*setImportTab\('bulk'\)/);
  assert.match(html,/classList\.toggle\('active',isQuick\)/);
  assert.match(html,/classList\.toggle\('active',!isQuick\)/);
});
