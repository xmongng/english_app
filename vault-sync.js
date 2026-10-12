/* Private cloud backup shared by the learning and companion pages. */
(function(root){
  const K={days:'ivDays',stats:'ivStats',errors:'ivErrors',mistakes:'ivMistakePatterns',logs:'ivPracticeLogs',progress:'ivProgress',topics:'customTopics'};
  const KEY='ivVaultKey',ETAG='ivVaultEtag',DIRTY='ivVaultDirty';
  const ACCOUNT_ID='ivAccountId',ACCOUNT_ETAG='ivAccountEtag',ACCOUNT_DIRTY='ivAccountDirty';
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
    const headers={'Content-Type':'application/json'};
    if(key)headers.Authorization=`Vault ${key}`;
    const response=await fetch('/api/vault',{method,headers,body:body?JSON.stringify(body):undefined,cache:'no-store',credentials:'same-origin',signal:AbortSignal.timeout(20000)});
    const data=await response.json().catch(()=>({}));
    if(!response.ok){const error=new Error(data.error||`Cloud request failed (${response.status})`);error.status=response.status;throw error;}
    return data;
  }
  async function accountRequest(action,email,password){
    const response=await fetch('/api/account',{method:'POST',headers:{'Content-Type':'application/json'},credentials:'same-origin',cache:'no-store',body:JSON.stringify({action,email,password,...(action==='register'?{snapshot:snapshot()}:{})}),signal:AbortSignal.timeout(30000)});
    const data=await response.json().catch(()=>({}));
    if(!response.ok)throw new Error(data.error||`Account request failed (${response.status})`);
    return data;
  }
  const vault={
    key:'',etag:null,dirty:false,revision:0,inFlight:null,timer:null,conflict:false,onRestore:null,onStatus:null,isNew:false,account:null,mode:'guest',
    format(code){return normal(code).match(/.{1,8}/g)?.join('-')||'';},
    status(kind,label){this.onStatus?.(kind,label);},
    hasKey(){return /^[a-f0-9]{64}$/.test(this.key);},
    canSync(){return this.mode==='account'||this.hasKey();},
    etagStorageKey(){return this.mode==='account'?ACCOUNT_ETAG:ETAG;},
    dirtyStorageKey(){return this.mode==='account'?ACCOUNT_DIRTY:DIRTY;},
    async signIn(action,email,password){
      await this.flush();
      if(this.inFlight)await this.inFlight;
      await accountRequest(action,email,password);
      if(this.timer)clearTimeout(this.timer);
      await this.init({create:false});
      return this.account;
    },
    async signOut(){
      await this.flush();
      if(this.dirty)throw new Error('Wait until your changes are saved before signing out.');
      await accountRequest('logout');
      for(const key of [...Object.values(K),KEY,ETAG,DIRTY,ACCOUNT_ID,ACCOUNT_ETAG,ACCOUNT_DIRTY])localStorage.removeItem(key);
      location.reload();
    },
    async init({create=false,onRestore,onStatus}={}){
      if(onRestore)this.onRestore=onRestore;
      if(onStatus)this.onStatus=onStatus;
      this.conflict=false;this.isNew=false;
      let session;
      try{
        const response=await fetch('/api/account',{cache:'no-store',credentials:'same-origin',signal:AbortSignal.timeout(20000)});
        if(!response.ok)throw new Error('Account service unavailable');
        session=(await response.json()).account;
      }catch{
        if(localStorage.getItem(ACCOUNT_ID)){
          this.mode='signedout';this.account=null;this.key='';this.etag=localStorage.getItem(ACCOUNT_ETAG)||null;
          this.dirty=localStorage.getItem(ACCOUNT_DIRTY)==='1';
        }
        this.status('error','Cloud issue');return;
      }
      if(session){
        this.mode='account';this.account=session;this.key='';
        const sameAccount=localStorage.getItem(ACCOUNT_ID)===session.id;
        this.etag=sameAccount?localStorage.getItem(ACCOUNT_ETAG)||null:null;
        this.dirty=sameAccount&&localStorage.getItem(ACCOUNT_DIRTY)==='1';
        localStorage.setItem(ACCOUNT_ID,session.id);
        await this.refresh();return;
      }
      if(localStorage.getItem(ACCOUNT_ID)){
        this.mode='signedout';this.account=null;this.key='';this.etag=localStorage.getItem(ACCOUNT_ETAG)||null;
        this.dirty=localStorage.getItem(ACCOUNT_DIRTY)==='1';
        this.status('local','Sign in to sync');return;
      }
      this.mode='guest';this.account=null;
      this.key=normal(localStorage.getItem(KEY));this.etag=localStorage.getItem(ETAG)||null;this.dirty=localStorage.getItem(DIRTY)==='1';
      if(!this.hasKey()&&create){
        const bytes=new Uint8Array(32);crypto.getRandomValues(bytes);
        this.key=Array.from(bytes,b=>b.toString(16).padStart(2,'0')).join('');
        localStorage.setItem(KEY,this.key);localStorage.removeItem(ETAG);this.etag=null;this.isNew=true;
        this.queue(0);await this.flush();return;
      }
      if(!this.hasKey()){this.status('local','Local only');return;}
      await this.refresh();
    },
    async refresh(){
      if(!this.canSync())return;
      if(this.inFlight)await this.inFlight;
      try{
        const remote=await request('GET',this.mode==='account'?null:this.key);
        if(!remote.exists){
          if(this.etag){this.conflict=true;this.status('error','Cloud issue');return;}
          this.queue(0);await this.flush();return;
        }
        if(this.dirty){
          if(this.etag!==remote.etag){this.conflict=true;this.status('error','Sync conflict');return;}
          await this.flush();return;
        }
        if(this.etag!==remote.etag){apply(remote.snapshot);this.onRestore?.();}
        this.etag=remote.etag;localStorage.setItem(this.etagStorageKey(),this.etag);
        this.status('cloud','Cloud saved');
      }catch(error){this.status('error','Cloud issue');}
    },
    queue(delay=3500){
      if(this.mode==='signedout'){
        this.dirty=true;localStorage.setItem(ACCOUNT_DIRTY,'1');this.status('local','Sign in to sync');return;
      }
      if(!this.canSync()||this.conflict)return;
      this.revision++;this.dirty=true;localStorage.setItem(this.dirtyStorageKey(),'1');this.status('local','Saving…');
      if(this.timer)clearTimeout(this.timer);
      this.timer=setTimeout(()=>{this.timer=null;this.flush();},delay);
    },
    async flush(){
      if(!this.canSync()||this.conflict||!this.dirty)return;
      if(this.inFlight)return this.inFlight;
      if(this.timer){clearTimeout(this.timer);this.timer=null;}
      const version=this.revision;
      const body={snapshot:snapshot(),etag:this.etag};
      this.inFlight=(async()=>{
        try{
          const saved=await request('PUT',this.mode==='account'?null:this.key,body);
          this.etag=saved.etag;localStorage.setItem(this.etagStorageKey(),this.etag);
          if(this.revision===version){this.dirty=false;localStorage.removeItem(this.dirtyStorageKey());this.status('cloud','Cloud saved');}
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
    async previewCurrent(){
      const remote=await request('GET',this.mode==='account'?null:this.key);
      if(!remote.exists)throw new Error('No cloud data was found.');
      return {key:this.key,...remote};
    },
    adopt(remote){
      if(this.mode!=='account')this.key=remote.key;
      this.etag=remote.etag;this.dirty=false;this.conflict=false;this.revision=0;
      if(this.timer)clearTimeout(this.timer);
      if(this.mode!=='account')localStorage.setItem(KEY,this.key);
      localStorage.setItem(this.etagStorageKey(),this.etag);localStorage.removeItem(this.dirtyStorageKey());
      apply(remote.snapshot);this.onRestore?.();this.status('cloud','Cloud saved');
    },
    async keepLocal(remote){
      this.etag=remote.etag;this.conflict=false;
      localStorage.setItem(this.etagStorageKey(),this.etag);
      this.queue(0);await this.flush();
    },
    async fork(){
      if(this.mode==='account')throw new Error('Use your account to resolve this conflict.');
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
