import fs from 'node:fs';
process.loadEnvFile(new URL('../.env',import.meta.url).pathname);
const {default:handler}=await import('../api/chat.js');
const fixtures=[
 {name:'Markdown and arrows',text:'**coffee** cà phê\n- take a break → nghỉ giải lao\n### Work\n1. __resilient__ : kiên cường',expected:['coffee','take a break','resilient']},
 {name:'Table and supplied example',text:'| English | Vietnamese | Example |\n| --- | --- | --- |\n| well-being | sức khỏe và hạnh phúc | Regular exercise improves our well-being. |\n| look forward to | mong chờ | |',expected:['well-being','look forward to']},
 {name:'Unusual bilingual notes',text:'☕ coffee cà phê; 📚 lifelong learning = học tập suốt đời\nTừ tiếp theo: **meet a deadline** (v.) — hoàn thành đúng hạn',expected:['coffee','lifelong learning','meet a deadline']},
];
const results=[];
for(const fixture of fixtures){
 const start=Date.now();const headers={};let payload,status=200;
 const res={setHeader(k,v){headers[k]=v;},status(code){status=code;return this;},json(data){payload=data;},end(){}};
 await handler({method:'POST',headers:{},body:{task:'import',text:fixture.text,topic:'Daily life'}},res);
 let items=[];try{items=JSON.parse(payload.choices[0].message.content).items;}catch{}
 const valid=status===200&&fixture.expected.every(en=>items.some(x=>x.en.toLowerCase()===en&&x.vi&&x.example));
 const result={name:fixture.name,status,model:headers['X-AI-Model'],latencyMs:Date.now()-start,valid,items,error:payload?.error};results.push(result);console.log(JSON.stringify(result));
}
fs.writeFileSync(new URL('../tests/live-ai-results.json',import.meta.url),JSON.stringify({testedAt:new Date().toISOString(),results},null,2));
if(results.some(x=>!x.valid))process.exitCode=1;
