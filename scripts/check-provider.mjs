process.loadEnvFile(new URL('../.env', import.meta.url).pathname);
const key=process.env.NVIDIA_API_KEY;
for(const pathname of ['/models','/chat/completions']) {
 try {
  const response=await fetch('https://integrate.api.nvidia.com/v1'+pathname,{method:pathname==='/models'?'GET':'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${key}`},...(pathname==='/models'?{}:{body:JSON.stringify({model:'meta/llama-3.1-8b-instruct',messages:[{role:'user',content:'Say hello.'}],max_tokens:16})}),signal:AbortSignal.timeout(15000)});
  const text=await response.text();
  console.log(JSON.stringify({pathname,status:response.status,body:pathname==='/models'?JSON.parse(text).data.map(x=>x.id).filter(x=>/gemma|nemotron|qwen|llama|gpt-oss/i.test(x)):text.replaceAll(key,'[REDACTED]').slice(0,1800)}));
 }catch(error){console.log(JSON.stringify({pathname,error:error.name}));}
}
