/* One private owner watchlist; local saves remain usable when offline. */
(() => {
  const stateKey='cruiser-scout-watchlist-sync-v1', backupKey='cruiser-scout-watchlist-original-v1';
  const $=id=>document.getElementById(id);
  let state={migrated:false,pending:[]}, busy=false, lastCheck=0, timer;
  try { const stored=JSON.parse(localStorage.getItem(stateKey)); if(stored && Array.isArray(stored.pending))state=stored; } catch {}
  function persist(){try {localStorage.setItem(stateKey,JSON.stringify(state));return true;}catch{return false;}}
  function message(value){$('watch-sync-status').textContent=value;}
  function request(path, body) {return fetch(path,{method:body?'POST':'GET',credentials:'same-origin',cache:'no-store',
    ...(body?{headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{})});}
  function queue(key,saved){
    state.pending.push({key,saved});
    persist();
    message('Saved on this browser · waiting to sync');
    clearTimeout(timer);timer=setTimeout(()=>sync(),500);
  }
  async function sync(){
    if(busy)return;
    busy=true;lastCheck=Date.now();$('watch-sync-now').disabled=true;
    const pending=state.pending.slice();
    // Import only once per browser. Later server removals must not be resurrected.
    const importing=!state.migrated;
    const original=importing?[...savedVehicles]:[];
    const operations=[...original.map(key=>({key,saved:true})),...pending].slice(0,1000);
    try {
      const response=await request('/api/watchlist',operations.length?{operations}:null);
      const data=await response.json();
      $('watch-sync-login').hidden=response.status!==401;
      if(!response.ok){message(data.message||'Sync unavailable. Your saves remain on this browser.');return;}
      if(!Array.isArray(data.saved))throw new Error('Invalid response');
      if(importing){try{if(!localStorage.getItem(backupKey))localStorage.setItem(backupKey,JSON.stringify(original));}catch{}}
      // Only acknowledge the operations sent; edits made during this request stay queued.
      const importedCount=Math.min(original.length,1000);
      const sentPending=Math.max(0,operations.length-importedCount);
      state.pending.splice(0,importing?sentPending:operations.length);
      if(importing && importedCount<original.length)state.pending.unshift(...original.slice(importedCount).map(key=>({key,saved:true})));
      state.migrated=true;
      const saved=new Set(data.saved);
      state.pending.forEach(op=>op.saved?saved.add(op.key):saved.delete(op.key));
      savedVehicles=saved;
      try{localStorage.setItem(watchlistKey,JSON.stringify([...saved]));}catch{}
      const durable=persist();
      render(Math.max(24,ui.listings.children.length));renderWatchlist();
      message(durable?'Synced · '+data.saved.length+' saved vehicles · '+new Date().toLocaleTimeString([], {hour:'numeric',minute:'2-digit'}):'Synced. Browser storage is unavailable; offline changes may not survive closing this page.');
      if(state.pending.length)timer=setTimeout(()=>sync(),500);
    }catch{message('Offline or sync unavailable. Your saves are kept on this browser; try Sync now later.');}
    finally{busy=false;$('watch-sync-now').disabled=false;}
  }
  $('watch-sync-now').addEventListener('click',sync);
  $('watch-sync-unlock').addEventListener('click',async()=>{
    $('watch-sync-unlock').disabled=true;
    try{
      const response=await request('/api/refresh',{action:'login',key:$('watch-sync-key').value.trim()});
      $('watch-sync-key').value='';
      if(response.ok){await sync();window.CruiserFilterSync?.sync();}else message((await response.json()).message||'Could not unlock syncing.');
    }catch{message('Could not connect. Your local saves are unchanged.');}
    finally{$('watch-sync-unlock').disabled=false;}
  });
  $('watch-sync-key').addEventListener('keydown',e=>{if(e.key==='Enter')$('watch-sync-unlock').click();});
  function resume(){if(document.visibilityState==='visible'&&Date.now()-lastCheck>60000)sync();}
  document.addEventListener('visibilitychange',resume);
  window.addEventListener('online',()=>sync());
  window.addEventListener('hashchange',()=>{if(location.hash==='#watchlist')resume();});
  window.addEventListener('storage',event=>{
    if(event.key===stateKey){try{const next=JSON.parse(event.newValue);if(next&&Array.isArray(next.pending))state=next;}catch{}}
    if(event.key===watchlistKey){try{savedVehicles=new Set(JSON.parse(event.newValue||'[]'));renderWatchlist();}catch{}}
  });
  window.CruiserWatchlist={changed:queue,sync};
  sync();
})();
