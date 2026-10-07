/* Private cloud backup shared by the learning and companion pages. */
(function(root){
  const K={days:'ivDays',stats:'ivStats',errors:'ivErrors',mistakes:'ivMistakePatterns',logs:'ivPracticeLogs',progress:'ivProgress',topics:'customTopics'};
  const KEY='ivVaultKey',ETAG='ivVaultEtag',DIRTY='ivVaultDirty';
  const parse=(key,fallback)=>{try{return JSON.parse(localStorage.getItem(key))??fallback;}catch{return fallback;}};
  const normal=code=>String(code||'').replace(/[\s-]/g,'').toLowerCase();
  function snapshot(){return {schema:1,days:parse(K.days,[]),stats:parse(K.stats,{}),errors:parse(K.errors,[]),mistakes:parse(K.mistakes,[]),logs:parse(K.logs,[]),progress:parse(K.progress,{}),customTopics:parse(K.topics,[])};}
  function apply(data){
    for(const [field,key] of Object.entries(K)){
      const value=field==='topics'?data.customTopics:data[field];
      localStorage.setItem(key,JSON.stringify(value));
    }
  }
  async function request(method,key,body){
    const response=await fetch('/api/vault',{method,headers:{'Content-Type':'application/json',Authorization:`Vault ${key}`},body:body?JSON.stringify(body):undefined,cache:'no-store',signal:AbortSignal.timeout(20000)});
    const data=await response.json().catch(()=>({}));
    if(!response.ok){const error=new Error(data.error||`Cloud request failed (${response.status})`);error.status=response.status;throw error;}
    return data;
  }
  const vault={
    key:'',etag:null,dirty:false,revision:0,inFlight:null,timer:null,conflict:false,onRestore:null,onStatus:null,isNew:false,
    format(code){return normal(code).match(/.{1,8}/g)?.join('-')||'';},
    status(kind,label){this.onStatus?.(kind,label);},
    hasKey(){return /^[a-f0-9]{64}$/.test(this.key);},
    async init({create=false,onRestore,onStatus}={}){
      this.onRestore=onRestore;this.onStatus=onStatus;
      this.key=normal(localStorage.getItem(KEY));this.etag=localStorage.getItem(ETAG)||null;this.dirty=localStorage.getItem(DIRTY)==='1';
      if(!this.hasKey()&&create){
        const bytes=new Uint8Array(32);crypto.getRandomValues(bytes);
        this.key=Array.from(bytes,b=>b.toString(16).padStart(2,'0')).join('');
        localStorage.setItem(KEY,this.key);localStorage.removeItem(ETAG);this.etag=null;this.isNew=true;
        this.queue(0);await this.flush();return;
      }
      if(!this.hasKey()){this.status('local','Local only');return;}
      try{
        const remote=await request('GET',this.key);
        if(!remote.exists){
          if(this.etag){this.conflict=true;this.status('error','Cloud issue');return;}
          this.queue(0);await this.flush();return;
        }
        if(this.dirty){
          if(this.etag!==remote.etag){this.conflict=true;this.status('error','Sync conflict');return;}
          await this.flush();return;
        }
        this.etag=remote.etag;localStorage.setItem(ETAG,this.etag);
        apply(remote.snapshot);this.onRestore?.();this.status('cloud','Cloud saved');
      }catch(error){this.status('error','Cloud issue');}
    },
    queue(delay=3500){
      if(!this.hasKey()||this.conflict)return;
      this.revision++;this.dirty=true;localStorage.setItem(DIRTY,'1');this.status('local','Saving…');
      if(this.timer)clearTimeout(this.timer);
      this.timer=setTimeout(()=>{this.timer=null;this.flush();},delay);
    },
    async flush(){
      if(!this.hasKey()||this.conflict||!this.dirty)return;
      if(this.inFlight)return this.inFlight;
      if(this.timer){clearTimeout(this.timer);this.timer=null;}
      const version=this.revision;
      const body={snapshot:snapshot(),etag:this.etag};
      this.inFlight=(async()=>{
        try{
          const saved=await request('PUT',this.key,body);
          this.etag=saved.etag;localStorage.setItem(ETAG,this.etag);
          if(this.revision===version){this.dirty=false;localStorage.removeItem(DIRTY);this.status('cloud','Cloud saved');}
        }catch(error){
          if(error.status===409){this.conflict=true;this.status('error','Sync conflict');}
          else {this.status('error','Cloud issue');this.timer=setTimeout(()=>{this.timer=null;this.flush();},30000);}
        }finally{
          this.inFlight=null;
          if(this.dirty&&!this.conflict&&!this.timer)this.queue(0);
        }
      })();
      return this.inFlight;
    },
    async preview(code){
      const candidate=normal(code);
      if(!/^[a-f0-9]{64}$/.test(candidate))throw new Error('Recovery code must contain 64 hexadecimal characters.');
      const remote=await request('GET',candidate);
      if(!remote.exists)throw new Error('No saved data was found for this code.');
      return {key:candidate,...remote};
    },
    adopt(remote){
      this.key=remote.key;this.etag=remote.etag;this.dirty=false;this.conflict=false;this.revision=0;
      if(this.timer)clearTimeout(this.timer);
      localStorage.setItem(KEY,this.key);localStorage.setItem(ETAG,this.etag);localStorage.removeItem(DIRTY);
      apply(remote.snapshot);this.onRestore?.();this.status('cloud','Cloud saved');
    },
    async fork(){
      const bytes=new Uint8Array(32);crypto.getRandomValues(bytes);
      this.key=Array.from(bytes,b=>b.toString(16).padStart(2,'0')).join('');
      this.etag=null;this.conflict=false;this.dirty=false;this.revision=0;
      if(this.timer)clearTimeout(this.timer);
      localStorage.setItem(KEY,this.key);localStorage.removeItem(ETAG);
      this.queue(0);await this.flush();
      return this.format(this.key);
    }
  };
  root.CloudVault=vault;
})(globalThis);
