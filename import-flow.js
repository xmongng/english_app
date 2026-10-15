/* Lossless import batching and resumable AI preparation. */
(function(root){
  function chunks(raw,limit=20,maxChars=12000){
    try{
      const parsed=JSON.parse(raw),list=Array.isArray(parsed)?parsed:parsed.items||parsed.words||parsed.vocabulary;
      if(Array.isArray(list)){
        const result=[];let group=[];
        for(const item of list){
          if(group.length&&(group.length>=limit||JSON.stringify([...group,item]).length>maxChars)){result.push(JSON.stringify(group));group=[];}
          group.push(item);
        }
        if(group.length)result.push(JSON.stringify(group));return result;
      }
    }catch{}
    const lines=String(raw).replace(/<\/tr\s*>/gi,'</tr>\n').split(/\r?\n/);
    const result=[];let group=[],count=0,heading='',table=[];
    const flush=()=>{if(group.some(x=>x.trim()))result.push([heading,...table,...group].filter(Boolean).join('\n'));group=[];count=0;};
    for(const line of lines){
      if(/^\s*#{1,6}\s/.test(line)){flush();heading=line;table=[];continue;}
      if(/^\s*\|?\s*(?:english|word|term|vocabulary)\s*\|/i.test(line)){flush();table=[line];continue;}
      if(/^\s*\|?\s*:?-{2,}/.test(line)){if(table.length)table.push(line);continue;}
      const continuation=/^\s*(?:example|e\.g\.|eg|ví dụ|vd|meaning|nghĩa|translation|vietnamese)\s*[:：-]/i.test(line)||!line.trim();
      if(!continuation&&group.length&&(count>=limit||[heading,...table,...group,line].join('\n').length>maxChars))flush();
      group.push(line);if(!continuation)count++;
    }
    flush();return result;
  }
  function createRunner(request){
    const cache=new Map(),splits=new Map();
    async function run(raw,topic,onProgress){
      const failed=[];let completed=0;
      const initial=chunks(raw);
      async function visit(source,depth=0){
        const key=JSON.stringify([topic,source]);
        if(cache.has(key)){completed+=cache.get(key).length;return cache.get(key);}
        if(splits.has(key)){const items=[];for(const part of splits.get(key))items.push(...await visit(part,depth+1));return items;}
        onProgress?.({completed,batches:initial.length,depth});
        try{
          const items=await request(source,topic);
          cache.set(key,items);completed+=items.length;
          if(cache.size>128)cache.delete(cache.keys().next().value);
          return items;
        }catch(error){
          const size=chunks(source,1).length;
          const providerOutage=error.routingFailures?.length&&error.routingFailures.every(x=>x.reason==='provider_error');
          const recoverable=error.code==='AI_SPLIT_BATCH'||(error.code==='AI_UNAVAILABLE'&&!providerOutage)||error.name==='SyntaxError';
          if(recoverable&&depth<2&&size>1){
            const smaller=chunks(source,Math.ceil(size/2));
            if(smaller.length>1){splits.set(key,smaller);const items=[];for(const part of smaller)items.push(...await visit(part,depth+1));return items;}
          }
          failed.push({source,message:error.message,code:error.code});return [];
        }
      }
      const items=[];for(const source of initial)items.push(...await visit(source));
      return {items,failed};
    }
    return {run};
  }
  root.ImportFlow={chunks,createRunner};
})(globalThis);
