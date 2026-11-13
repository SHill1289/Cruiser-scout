/* Private inventory preferences. Changes stay local until an authenticated sync succeeds. */
(() => {
 const key='cruiser-scout-filter-preferences-v1';
 let state={query:null,revision:null,pending:false},ready=false,busy=false,timer,lastCheck=0,last='',generation=0,conflict=false,linked=false,adapter;
 try{const saved=JSON.parse(localStorage.getItem(key));if(saved&&typeof saved.query==='string'&&(saved.revision===null||typeof saved.revision==='string'))state=saved;}catch{}
 const $=id=>document.getElementById(id);
 function persist(){try{localStorage.setItem(key,JSON.stringify(state));}catch{message('Browser storage unavailable. Keep this page open until filters sync.');}}
 function message(value){$('filter-sync-status').textContent=value;}
 function buttons(){ $('filter-sync-keep').hidden=!(conflict||linked);$('filter-sync-load').hidden=!(conflict||linked); }
 function schedule(){clearTimeout(timer);timer=setTimeout(sync,1500);}
 function changed(query){
  if(!ready||query===last)return;
  last=query;generation++;linked=false;state.query=query;state.pending=true;persist();buttons();
  message('Filters saved on this device · waiting to sync');schedule();
 }
 function adopt(data){
  state={query:data.query,revision:data.revision,pending:false};conflict=false;linked=false;
  if(data.query!==null&&data.query!==last){ready=false;try{last=adapter.apply(data.query);state.query=last;}finally{ready=true;}}
  persist();buttons();message('Filters synced across devices');
 }
 async function request(body){const r=await fetch('/api/filter-preferences',{method:body?'POST':'GET',credentials:'same-origin',cache:'no-store',...(body?{headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{})});return {response:r,data:await r.json()};}
 async function sync(){
  if(!ready||busy||adapter.editing())return;
  busy=true;lastCheck=Date.now();$('filter-sync-now').disabled=true;const started=generation;
  try{
   let {response,data}=await request();
   $('filter-sync-unlock').hidden=response.status!==401;
   if(!response.ok){message(data.message||'Sync unavailable. Filters remain on this device.');return;}
   if(adapter.editing()||started!==generation){schedule();return;}
   if(linked){message('Opened a filtered link · your synced filters are unchanged');buttons();return;}
   if(data.query===null&&!state.pending&&!last){message('Choose filters to save and sync across devices');return;}
   // First device imports its existing filters only when no shared set exists.
   if(data.query===null&&!state.pending){state.query=last;state.pending=true;state.revision=null;persist();}
   if(state.pending){
    if(data.query===state.query){adopt(data);return;}
    if(state.revision!==data.revision){conflict=true;buttons();message('Filters changed on another device. Choose which set to keep.');return;}
    const sent=state.query;const result=await request({query:sent,revision:data.revision});
    if(result.response.status===409){conflict=true;buttons();message('Filters changed on another device. Choose which set to keep.');return;}
    if(!result.response.ok){message(result.data.message||'Sync unavailable. Your filters are saved locally.');return;}
    if(started!==generation){state.revision=result.data.revision;persist();schedule();return;}
    // Do not apply a server response over uncommitted drawer edits.
    state.revision=result.data.revision;state.pending=false;persist();conflict=false;buttons();message('Filters synced across devices');
   }else adopt(data);
  }catch{message('Offline or sync unavailable · filters saved on this device');}
  finally{busy=false;$('filter-sync-now').disabled=false;}
 }
 async function resolve(keep){
  if(busy||adapter.editing())return;
  busy=true;const started=generation;
  try{const {response,data}=await request();if(!response.ok)throw Error();if(started!==generation||adapter.editing())return;
   if(!keep){if(data.query===null){message('No synced filters yet. Save these filters to start.');return;}adopt(data);}
   else{linked=false;conflict=false;state={query:last,revision:data.revision,pending:true};persist();buttons();}
  }catch{message('Could not connect. Your filters are unchanged.');}finally{busy=false;}
  if(keep)sync();
 }
 function start(config){
  adapter=config;last=config.read();linked=!!config.explicit&&last!==state.query;
  if(!linked&&state.query!==null)last=config.apply(state.query);
  if(!linked&&state.query===null){state.query=last;persist();}
  ready=true;
  $('filter-sync-now').addEventListener('click',sync);
  $('filter-sync-keep').addEventListener('click',()=>resolve(true));
  $('filter-sync-load').addEventListener('click',()=>resolve(false));
  buttons();sync();
 }
 function resume(){if(document.visibilityState==='visible'&&Date.now()-lastCheck>60000)sync();}
 document.addEventListener('visibilitychange',resume);window.addEventListener('online',sync);
 window.addEventListener('focus',resume);setInterval(resume,60000);
 window.CruiserFilterSync={start,changed,sync};
})();
