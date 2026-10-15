/* Shared deterministic rules; no credentials or network access. */
(function(root){
  const clean = value => String(value ?? '').normalize('NFC')
    .replace(/<[^>]*>/g,' ').replace(/\[([^\]]+)\]\([^)]*\)/g,'$1')
    .replace(/[*_`~]/g,'').replace(/[\u200B-\u200D\uFEFF]/g,'')
    .replace(/&nbsp;/gi,' ').replace(/&amp;/gi,'&').replace(/\s+/g,' ').trim();
  const cleanWord = value => clean(value)
    .replace(/^(?:\s*[-•●▪◦]+\s*|\s*\d+[.)]\s*)+/,'')
    .replace(/^(?:word|term|english|vocabulary|từ vựng)\s*[:=]\s*/i,'')
    .replace(/\s*\((?:n|v|adj|adv|noun|verb|adjective|adverb)\.?\)\s*$/i,'')
    .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N})]+$/gu,'').trim();
  const key = text => cleanWord(text).toLowerCase().replace(/[’‘]/g,"'").replace(/\s+/g,' ');
  const hasVi = text => /[àáạảãâầấậẩẫăằắặẳẵèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũưừứựửữỳýỵỷỹđ]/i.test(text);
  function csv(line) {
    const fields=[];let value='',quoted=false;
    for(let i=0;i<line.length;i++){
      const ch=line[i];
      if(ch==='"'&&line[i+1]==='"'&&quoted){value+='"';i++;}
      else if(ch==='"')quoted=!quoted;
      else if(ch===','&&!quoted){fields.push(value.trim());value='';}
      else value+=ch;
    }
    fields.push(value.trim());return fields;
  }
  function parseImport(text,topic='General') {
    const source=String(text||'').replace(/<\/tr\s*>|<\/p\s*>|<br\s*\/?>/gi,'\n').replace(/<\/t[dh]\s*>/gi,' | ');
    try {const j=JSON.parse(source);const items=Array.isArray(j)?j:j.items||j.words||j.vocabulary;if(Array.isArray(items))return items.map(x=>normalizeItem(x,topic)).filter(x=>x.en);} catch {}
    const items=[];
    for(const original of source.split(/\r?\n/)){
      let line=original.trim();if(!line||/^```|^\s*\|?\s*:?-{2,}/.test(line))continue;
      if(/^#{1,6}\s+/.test(line)){topic=clean(line.replace(/^#+\s*/,''));continue;}
      const ex=line.match(/^\s*(?:example|e\.g\.|eg|ví dụ|vd)\s*[:：-]\s*(.+)/i);
      if(ex&&items.length){items[items.length-1].example=clean(ex[1]);continue;}
      const meaning=line.match(/^\s*(?:meaning|nghĩa|translation|vietnamese)\s*[:：-]\s*(.+)/i);
      if(meaning&&items.length){items[items.length-1].vi=clean(meaning[1]);continue;}
      const marked=line.match(/(?:\*\*|__|`)(.+?)(?:\*\*|__|`)\s*[:：–—\-=→|]*\s*(.+)/);
      let parts;
      if(marked)parts=[cleanWord(marked[1]),...clean(marked[2]).split(/\s*\|\s*/)].filter(Boolean);
      else {
        line=clean(line).replace(/^\s*(?:[-•●▪◦]\s+|\d+[.)]\s*)/,'').replace(/^\|+|\|+$/g,'').trim();
        if(line.includes('|')||line.includes('→')||/\s[–—-]\s/.test(line)||line.includes(':'))parts=line.split(/\s*\|\s*|\s*→\s*|\s+[–—-]\s+|\s*[:：]\s*/).filter(Boolean);
        else if(original.includes('\t'))parts=original.split('\t').map(clean).filter(Boolean);
        else if(line.includes(','))parts=csv(line);
        else parts=[line];
      }
      if(/^(?:english|word|term|vocabulary|từ vựng|từ|stt|no\.?|#)$/i.test(cleanWord(parts[0])))continue;
      if(/^\d+$/.test(parts[0])&&parts.length>2)parts.shift();
      if(parts.length===1&&hasVi(parts[0])){
        // Boundary is ambiguous without markup/separators: leave it for AI.
        items.push({...normalizeItem({en:parts[0]},topic),needsReview:true});continue;
      }
      const item=normalizeItem({en:parts[0],vi:parts[1]||'',example:parts[2]||''},topic);
      if(!item.en)continue;
      if(parts.length===1&&hasVi(item.en))item.needsReview=true;
      items.push(item);
    }
    const seen=new Set();return items.map(item=>{item.duplicate=seen.has(key(item.en));seen.add(key(item.en));return item;});
  }
  function normalizeItem(item,topic='General'){
    return {en:cleanWord(item.en||item.word||item.term||item.english),vi:clean(item.vi||item.vietnamese||item.translation),meaning:clean(item.meaning||item.definition),example:clean(item.example||item.sentence),situation:clean(item.situation||item.context),topic:clean(item.topic)||topic};
  }
  function validateImport(payload,raw=''){
    const list=Array.isArray(payload)?payload:payload?.items;
    if(!Array.isArray(list)||!list.length)throw new Error('No vocabulary items returned.');
    const items=list.map(x=>normalizeItem(x));const seen=new Set();
    for(const item of items){
      if(!item.en||!/[a-z]/i.test(item.en)||hasVi(item.en)||item.en.length>160)throw new Error('English term is not clean.');
      if(!item.vi||!item.example||item.example.split(/\s+/).length<4)throw new Error('Each word needs its meaning and a complete example.');
      if(seen.has(key(item.en)))throw new Error('Duplicate vocabulary returned.');
      seen.add(key(item.en));
    }
    // Require known, unambiguous source entries to survive model extraction.
    const known=requiredImportEntries(raw);
    for(const item of known)if(!seen.has(key(item.en)))throw new Error('The response omitted a source term.');
    return items;
  }
  function requiredImportEntries(raw){
    return parseImport(raw).filter(x=>x.vi&&!x.needsReview&&!x.duplicate&&x.en&&/[a-z]/i.test(x.en)&&!hasVi(x.en)&&x.en.length<=160);
  }
  function dateKey(date=new Date()){
    if(!Number.isFinite(date.getTime()))return '';
    return `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`;
  }
  function dayNumber(date){return Math.floor(Date.UTC(date.getFullYear(),date.getMonth(),date.getDate())/86400000);}
  function studyHabit(ledger={},logs=[],now=new Date(),goal=5){
    const counts=new Map();const today=dateKey(now);
    for(const [day,entry] of Object.entries(ledger))if(/^\d{4}-\d{2}-\d{2}$/.test(day)&&day<=today)counts.set(day,Math.max(0,Number(entry.count)||0));
    const legacy=new Map();const ids=new Set();const credits=new Set();
    for(const log of logs){
      if(!log.createdAt||ids.has(log.id))continue;if(log.id)ids.add(log.id);
      const date=new Date(log.createdAt);const day=dateKey(date);
      if(!day||day>today)continue;
      const savedDay=log.studyDate||day;
      if(counts.has(savedDay))continue;
      const credit=log.creditKey||`${key(log.word||'')}:${log.activity||'practice'}`;
      if(!credit||credits.has(`${savedDay}:${credit}`))continue;
      credits.add(`${savedDay}:${credit}`);
      legacy.set(savedDay,(legacy.get(savedDay)||0)+1);
    }
    for(const [day,count] of legacy)counts.set(day,count);
    const active=[...counts].filter(([,count])=>count>=goal).map(([day])=>day).sort();
    const activeSet=new Set(active);const cursor=new Date(now);if(!activeSet.has(today))cursor.setDate(cursor.getDate()-1);
    let current=0;while(activeSet.has(dateKey(cursor))){current++;cursor.setDate(cursor.getDate()-1);}
    let longest=0,run=0,previous=null;
    for(const day of active){const number=dayNumber(new Date(day+'T12:00:00'));run=previous!==null&&number-previous===1?run+1:1;longest=Math.max(longest,run);previous=number;}
    const last7=Array.from({length:7},(_,i)=>{const date=new Date(now);date.setDate(date.getDate()-6+i);const day=dateKey(date);return {key:day,label:date.toLocaleDateString('en-US',{weekday:'short'}).slice(0,2),count:counts.get(day)||0,today:day===today,qualified:(counts.get(day)||0)>=goal};});
    return {current,longest,todayCount:counts.get(today)||0,activeDays:active.length,last7,counts:Object.fromEntries(counts)};
  }
  function mergeActivityDays(local={},remote={}){
    const result={};
    for(const day of new Set([...Object.keys(local),...Object.keys(remote)])){
      const a=local[day]||{},b=remote[day]||{};
      const credits=[...new Set([...(a.credits||[]),...(b.credits||[])])];
      result[day]={count:Math.max(a.count||0,b.count||0,credits.length),xp:Math.min(100,Math.max(a.xp||0,b.xp||0)),credits};
    }
    return result;
  }
  const api={mergeActivityDays,clean,cleanWord,key,parseImport,normalizeItem,validateImport,requiredImportEntries,dateKey,studyHabit};
  root.LearningCore=api;if(typeof module!=='undefined')module.exports=api;
})(globalThis);
