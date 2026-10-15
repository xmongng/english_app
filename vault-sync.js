/* Private cloud backup shared by the learning and companion pages. */
(function(root){
  const K={days:'ivDays',stats:'ivStats',errors:'ivErrors',mistakes:'ivMistakePatterns',logs:'ivPracticeLogs',progress:'ivProgress',topics:'customTopics'};
  const KEY='ivVaultKey',ETAG='ivVaultEtag',DIRTY='ivVaultDirty';
  const ACCOUNT_ID='ivAccountId',ACCOUNT_ETAG='ivAccountEtag',ACCOUNT_DIRTY='ivAccountDirty';
  const parse=(key,fallback)=>{try{return JSON.parse(localStorage.getItem(key))??fallback;}catch{return fallback;}};
  const normal=code=>String(code||'').replace(/[\s-]/g,'').toLowerCase();
  const vocabKey=value=>String(value||'').normalize('NFC').toLowerCase().trim().replace(/[’‘]/g,"'").replace(/\s+/g,' ');
  function snapshot(){return {schema:1,days:parse(K.days,[]),stats:parse(K.stats,{}),errors:parse(K.errors,[]),mistakes:parse(K.mistakes,[]),logs:parse(K.logs,[]),progress:parse(K.progress,{}),customTopics:parse(K.topics,[])};}
  function apply(data){
    for(const [field,key] of Object.entries(K)){
      const value=field==='topics'?data.customTopics:data[field];
      localStorage.setItem(key,JSON.stringify(value));
    }
  }
  const equal=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
  const missingVocabulary=(local,remote)=>local.days.some(day=>{
    const cloudDay=remote.days.find(x=>x.id===day.id);
    return !cloudDay||(day.words||[]).some(word=>!(cloudDay.words||[]).some(x=>vocabKey(x.en)===vocabKey(word.en)));
  });
  // Recovery is additive: retain every lesson/word without replacing newer local edits.
  function addVocabulary(target,source){
    for(const localDay of source.days||[]){
      const day=target.days.find(x=>x.id===localDay.id);
      if(!day){target.days.push(localDay);continue;}
      const known=new Set((day.words||[]).map(x=>vocabKey(x.en)));
      day.words=day.words||[];
      for(const word of localDay.words||[])if(!known.has(vocabKey(word.en))){day.words.push(word);known.add(vocabKey(word.en));}
    }
    target.customTopics=[...new Set([...(target.customTopics||[]),...(source.customTopics||[])])];
    return target;
  }
  const object=value=>value&&typeof value==='object'&&!Array.isArray(value);
  function mergeSnapshots(base,local,remote){
    const conflicts=[];
    function merge(b,l,r,path=''){
      if(equal(l,r))return l;
      if(equal(l,b))return r;
      if(equal(r,b))return l;
      if(path==='progress')return l; // Derived locally from lessons and practice logs.
      if(/(?:^|\.)(?:updatedAt|lastUpdated|lastSeenAt)$/.test(path)&&typeof l==='string'&&typeof r==='string')return l>r?l:r;
      if(Array.isArray(l)&&Array.isArray(r)){
        const before=Array.isArray(b)?b:[];
        if([...before,...l,...r].every(x=>typeof x==='string')){
          return [...new Set([...r,...l])].filter(x=>merge(before.includes(x),l.includes(x),r.includes(x),`${path}.${x}`));
        }
        const id=x=>path.endsWith('.words')?vocabKey(x?.en):x?.id||x?.signature;
        if([...before,...l,...r].every(x=>object(x)&&id(x))){
          const maps=[before,l,r].map(rows=>new Map(rows.map(x=>[id(x),x])));
          return [...new Set([...r,...l,...before].map(id))].map(key=>merge(maps[0].get(key),maps[1].get(key),maps[2].get(key),`${path}.${key}`)).filter(x=>x!==undefined);
        }
      }
      if(object(l)&&object(r)&&(b===undefined||object(b))){
        return Object.fromEntries([...new Set([...Object.keys(b||{}),...Object.keys(r),...Object.keys(l)])]
          .map(key=>[key,merge(b?.[key],l[key],r[key],path?`${path}.${key}`:key)]).filter(([,value])=>value!==undefined));
      }
      conflicts.push(path);return l;
    }
    return {snapshot:merge(base,local,remote),conflicts};
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
    key:'',etag:null,dirty:false,revision:0,inFlight:null,timer:null,conflict:false,onRestore:null,onStatus:null,isNew:false,account:null,mode:'guest',base:null,refreshing:null,lastLocal:'',lastError:'',recovery:null,
    mergeSnapshots,
    format(code){return normal(code).match(/.{1,8}/g)?.join('-')||'';},
    status(kind,label){if(kind==='cloud')this.lastError='';this.lastStatus={kind,label};this.onStatus?.(kind,label);},
    hasKey(){return /^[a-f0-9]{64}$/.test(this.key);},
    canSync(){return this.mode==='account'||this.hasKey();},
    etagStorageKey(){return this.mode==='account'?ACCOUNT_ETAG:ETAG;},
    dirtyStorageKey(){return this.mode==='account'?ACCOUNT_DIRTY:DIRTY;},
    identity(){return this.mode==='account'?this.account?.id:this.key;},
    rememberBase(data){
      this.base=data;
      const saved=JSON.stringify({identity:this.identity(),etag:this.etag,snapshot:data});
      try{root.sessionStorage?.setItem('ivSyncBase',saved);}catch{}
      // A reopened tab must retain the common ancestor needed for a safe merge.
      try{localStorage.setItem('ivSyncBase:'+this.identity(),saved);}catch{}
    },
    restoreBase(){
      this.base=null;
      for(const read of [()=>root.sessionStorage?.getItem('ivSyncBase'),()=>localStorage.getItem('ivSyncBase:'+this.identity())]){
        try{const saved=JSON.parse(read()||'null');if(saved?.identity===this.identity()&&saved.etag===this.etag){this.base=saved.snapshot;return;}}catch{}
      }
    },
    rememberRecovery(data){
      if(this.mode!=='account'||!data.days?.length)return;
      const preserved=JSON.parse(JSON.stringify(data));
      if(this.recovery?.identity===this.identity())addVocabulary(preserved,this.recovery.snapshot);
      this.recovery={identity:this.identity(),snapshot:preserved};
      try{localStorage.setItem('ivSyncRecovery:'+this.identity(),JSON.stringify(this.recovery));}catch{}
      try{root.sessionStorage?.setItem('ivSyncRecovery',JSON.stringify(this.recovery));}catch{}
    },
    async combineVocabulary(){
      if(!this.account)throw new Error('Sign in before combining vocabulary.');
      const identity=this.identity();
      if(this.inFlight)await this.inFlight;
      const remote=await this.previewCurrent();
      if(this.identity()!==identity)throw new Error('Account changed. Please sync again.');
      // Read local data after the request: imports may finish while it is loading.
      const current=snapshot();this.rememberRecovery(current);
      const merged=addVocabulary(JSON.parse(JSON.stringify(current)),remote.snapshot);
      if(this.recovery)addVocabulary(merged,this.recovery.snapshot);
      this.etag=remote.etag;localStorage.setItem(this.etagStorageKey(),this.etag);this.rememberBase(remote.snapshot);
      apply(merged);this.conflict=false;this.restoreView();this.queue(0);await this.flush();
      if(this.dirty)throw new Error('The combined vocabulary is kept locally. '+(this.lastError||'Cloud saving is still pending.'));
      this.recovery=null;try{root.sessionStorage?.removeItem('ivSyncRecovery');localStorage.removeItem('ivSyncRecovery:'+this.identity());}catch{}
    },
    restoreView(){this.onRestore?.();this.lastLocal=JSON.stringify(snapshot());},
    startLive(){
      if(this.liveStarted)return;this.liveStarted=true;
      const active=()=>typeof document==='undefined'||!document.hidden;
      const sync=()=>{if(active())this.refresh();};
      root.addEventListener?.('focus',sync);
      root.addEventListener?.('storage',event=>{
        if(event.key!==null&&![...Object.values(K),KEY,ETAG,DIRTY,ACCOUNT_ID,ACCOUNT_ETAG,ACCOUNT_DIRTY].includes(event.key))return;
        if(this.storageTimer)clearTimeout(this.storageTimer);
        this.storageTimer=setTimeout(()=>{
          this.storageTimer=null;
          const storedId=localStorage.getItem(ACCOUNT_ID);
          if((this.mode==='account'&&storedId!==this.account?.id)||(this.mode!=='account'&&storedId)){
            this.restoreView();this.init({create:false});return;
          }
          this.etag=localStorage.getItem(this.etagStorageKey())||null;
          this.dirty=localStorage.getItem(this.dirtyStorageKey())==='1';this.restoreBase();
          if(this.lastLocal!==JSON.stringify(snapshot()))this.restoreView();
          this.status(this.dirty?'local':'cloud',this.dirty?'Saving…':'Cloud saved');
          if(this.dirty)this.flush();
        },60);
      });
      if(typeof root.setInterval==='function')this.pollTimer=root.setInterval(sync,15000);
    },
    syncConflictMessage(){return this.base?'Your changes are saved on this device but overlap with cloud changes. Combine vocabulary or review the conflict before uploading.':'Your changes are saved on this device. The previous synced version is unavailable, so automatic merging is paused. Use Combine vocabulary from this device to keep the vocabulary from both copies.';},
    mergeRemote(remote){
      if(!this.base||!remote.exists){this.rememberRecovery(snapshot());return false;}
      const result=mergeSnapshots(this.base,snapshot(),remote.snapshot);
      if(result.conflicts.length){this.rememberRecovery(snapshot());return false;}
      apply(result.snapshot);this.etag=remote.etag;localStorage.setItem(this.etagStorageKey(),this.etag);
      this.rememberBase(remote.snapshot);this.dirty=true;this.conflict=false;this.revision++;
      localStorage.setItem(this.dirtyStorageKey(),'1');this.restoreView();return true;
    },
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
      localStorage.removeItem('ivSyncRecovery:'+this.identity());
      localStorage.removeItem('ivSyncBase:'+this.identity());
      try{root.sessionStorage?.removeItem('ivSyncBase');}catch{}
      try{root.sessionStorage?.removeItem('ivSyncRecovery');}catch{}
      for(const key of [...Object.values(K),KEY,ETAG,DIRTY,ACCOUNT_ID,ACCOUNT_ETAG,ACCOUNT_DIRTY])localStorage.removeItem(key);
      location.reload();
    },
    async init({create=false,onRestore,onStatus,skipRefresh=false}={}){
      if(onRestore)this.onRestore=onRestore;
      if(onStatus)this.onStatus=onStatus;
      this.startLive();
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
        this.canRecoverLocal=sameAccount;this.recovery=null;
        try{const saved=JSON.parse(localStorage.getItem('ivSyncRecovery:'+session.id)||root.sessionStorage?.getItem('ivSyncRecovery')||'null');if(saved?.identity===session.id)this.recovery=saved;}catch{}
        this.etag=sameAccount?localStorage.getItem(ACCOUNT_ETAG)||null:null;
        this.dirty=sameAccount&&localStorage.getItem(ACCOUNT_DIRTY)==='1';
        if(!sameAccount){localStorage.removeItem(ACCOUNT_ETAG);localStorage.removeItem(ACCOUNT_DIRTY);}
        localStorage.setItem(ACCOUNT_ID,session.id);
        this.restoreBase();
        if(!skipRefresh)await this.refresh();return;
      }
      if(localStorage.getItem(ACCOUNT_ID)){
        this.mode='signedout';this.account=null;this.key='';this.etag=localStorage.getItem(ACCOUNT_ETAG)||null;
        this.dirty=localStorage.getItem(ACCOUNT_DIRTY)==='1';
        this.status('local','Sign in to sync');return;
      }
      this.mode='guest';this.account=null;
      this.key=normal(localStorage.getItem(KEY));this.etag=localStorage.getItem(ETAG)||null;this.dirty=localStorage.getItem(DIRTY)==='1';
      this.restoreBase();
      if(!this.hasKey()&&create){
        const bytes=new Uint8Array(32);crypto.getRandomValues(bytes);
        this.key=Array.from(bytes,b=>b.toString(16).padStart(2,'0')).join('');
        localStorage.setItem(KEY,this.key);localStorage.removeItem(ETAG);this.etag=null;this.isNew=true;
        this.queue(0);await this.flush();return;
      }
      if(!this.hasKey()){this.status('local','Local only');return;}
      if(!skipRefresh)await this.refresh();
    },
    async refresh(){
      if(this.refreshing)return this.refreshing;
      this.refreshing=this.refreshNow().finally(()=>{this.refreshing=null;});return this.refreshing;
    },
    async refreshNow(){
      if(!this.canSync()){
        if(this.mode==='signedout')await this.init({create:false,skipRefresh:true});
        if(!this.canSync())return;
      }
      if(this.inFlight)await this.inFlight;
      try{
        const sharedEtag=localStorage.getItem(this.etagStorageKey())||null;
        if(sharedEtag!==this.etag){this.etag=sharedEtag;this.dirty=localStorage.getItem(this.dirtyStorageKey())==='1';this.restoreBase();}
        if(this.lastLocal&&this.lastLocal!==JSON.stringify(snapshot()))this.restoreView();
        const read={identity:this.identity(),revision:this.revision,etag:this.etag,local:JSON.stringify(snapshot())};
        const remote=await request('GET',this.mode==='account'?null:this.key);
        // A completed save or a new import invalidates an older cloud response.
        if(read.identity!==this.identity()||read.revision!==this.revision||read.etag!==this.etag||read.local!==JSON.stringify(snapshot())||this.inFlight){
          if(this.dirty&&!this.conflict)await this.flush();
          return;
        }
        if(remote.account&&remote.account.id!==this.account?.id){await this.init({create:false,skipRefresh:true});return this.refreshNow();}
        if(!remote.exists){
          if(this.etag){this.conflict=true;this.status('error','Cloud issue');return;}
          this.queue(0);await this.flush();return;
        }
        if(this.dirty){
          if(this.etag!==remote.etag&&!this.mergeRemote(remote)){this.rememberRecovery(snapshot());this.conflict=true;this.lastError=this.syncConflictMessage();this.status('error','Sync conflict');return;}
          this.conflict=false;
          await this.flush();return;
        }
        if((this.etag!==remote.etag||!this.lastLocal)&&!equal(snapshot(),remote.snapshot)){
          if(this.canRecoverLocal&&!this.base&&missingVocabulary(snapshot(),remote.snapshot))this.rememberRecovery(snapshot());
          apply(remote.snapshot);this.restoreView();
        }
        this.etag=remote.etag;localStorage.setItem(this.etagStorageKey(),this.etag);
        this.rememberBase(remote.snapshot);this.lastLocal=JSON.stringify(snapshot());
        this.status('cloud','Cloud saved');
      }catch(error){this.lastError=error.message;if(error.status===401){this.mode='signedout';this.account=null;this.status('local','Sign in to sync');}else this.status('error','Cloud issue');}
    },
    queue(delay=750){
      this.lastLocal=JSON.stringify(snapshot());
      if(this.mode==='signedout'){
        this.dirty=true;localStorage.setItem(ACCOUNT_DIRTY,'1');this.status('local','Sign in to sync');return;
      }
      if(!this.canSync())return;
      this.revision++;this.dirty=true;localStorage.setItem(this.dirtyStorageKey(),'1');
      if(this.conflict){this.rememberRecovery(snapshot());this.status('error','Sync conflict');return;}
      this.status('local','Saving…');
      if(this.timer)clearTimeout(this.timer);
      this.timer=setTimeout(()=>{this.timer=null;this.flush();},delay);
    },
    async flush(){
      if(!this.canSync()||this.conflict||!this.dirty)return;
      if(this.inFlight)return this.inFlight;
      if(this.timer){clearTimeout(this.timer);this.timer=null;}
      let version=this.revision;
      const identity=this.identity();
      this.inFlight=(async()=>{
        try{
          let saved,body;
          for(let attempt=0;attempt<3;attempt++){
            if(this.identity()!==identity)return;
            const sharedEtag=localStorage.getItem(this.etagStorageKey())||null;
            if(sharedEtag!==this.etag)this.etag=sharedEtag;
            body={snapshot:snapshot(),etag:this.etag,...(this.account?{accountId:this.account.id}:{})};
            version=this.revision;
            try{saved=await request('PUT',this.mode==='account'?null:this.key,body);break;}
            catch(error){
              if(error.status!==409||attempt===2)throw error;
              const remote=await request('GET',this.mode==='account'?null:this.key);
              if(equal(snapshot(),remote.snapshot)){
                saved={etag:remote.etag};body.snapshot=remote.snapshot;break;
              }
              if(!this.mergeRemote(remote))throw error;
            }
          }
          if(this.identity()!==identity)return;
          this.etag=saved.etag;localStorage.setItem(this.etagStorageKey(),this.etag);
          this.rememberBase(body.snapshot);
          if(this.revision===version&&equal(snapshot(),body.snapshot)){this.dirty=false;localStorage.removeItem(this.dirtyStorageKey());this.status('cloud','Cloud saved');}
        }catch(error){
          this.lastError=error.message;
          if(error.status===409){this.rememberRecovery(snapshot());this.conflict=true;this.lastError=this.syncConflictMessage();this.status('error','Sync conflict');}
          else if(error.status===401){this.mode='signedout';this.account=null;this.status('local','Sign in to sync');}
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
      if(this.mode==='account'&&this.dirty)this.rememberRecovery(snapshot());
      if(this.mode!=='account')this.key=remote.key;
      this.etag=remote.etag;this.dirty=false;this.conflict=false;this.revision=0;
      if(this.timer)clearTimeout(this.timer);
      if(this.mode!=='account')localStorage.setItem(KEY,this.key);
      localStorage.setItem(this.etagStorageKey(),this.etag);localStorage.removeItem(this.dirtyStorageKey());
      this.rememberBase(remote.snapshot);apply(remote.snapshot);this.restoreView();this.status('cloud','Cloud saved');
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
