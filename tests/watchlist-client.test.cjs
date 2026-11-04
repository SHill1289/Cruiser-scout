const {test}=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const fs=require('node:fs');
const code=fs.readFileSync(require.resolve('../web/watchlist-sync.js'),'utf8');
test('browser imports once, preserves pending offline edits, and accepts remote removals',async()=>{
 const values=new Map(),nodes=new Map();let remote=['vin-remote'],fail=false;
 const node=id=>{if(!nodes.has(id))nodes.set(id,{addEventListener(){},children:[],value:''});return nodes.get(id);};
 const context={Set,Date,JSON,Math,console,savedVehicles:new Set(['vin-local']),watchlistKey:'saved',
 localStorage:{getItem:k=>values.get(k)||null,setItem:(k,v)=>values.set(k,v)},
 document:{getElementById:node,addEventListener(){},visibilityState:'visible'},
 window:{addEventListener(){}},location:{hash:'#watchlist'},setTimeout(){},clearTimeout(){},
 ui:{listings:node('listings')},render(){},renderWatchlist(){},
 fetch:async(url,options)=>{if(fail)throw new Error('offline');const saved=new Set(remote);
  if(options.body)JSON.parse(options.body).operations.forEach(op=>op.saved?saved.add(op.key):saved.delete(op.key));
  remote=[...saved];return {ok:true,status:200,json:async()=>({saved:remote.slice()})};}};
 vm.runInNewContext(code,context);await new Promise(setImmediate);
 assert.deepEqual([...context.savedVehicles].sort(),['vin-local','vin-remote']);
 assert.deepEqual(JSON.parse(values.get('cruiser-scout-watchlist-original-v1')),['vin-local']);
 remote=[];await context.window.CruiserWatchlist.sync();assert.equal(context.savedVehicles.size,0);
 context.savedVehicles.add('vin-offline');context.window.CruiserWatchlist.changed('vin-offline',true);
 fail=true;await context.window.CruiserWatchlist.sync();assert.equal(JSON.parse(values.get('cruiser-scout-watchlist-sync-v1')).pending.length,1);
 fail=false;remote=['vin-device2'];await context.window.CruiserWatchlist.sync();
 assert.deepEqual([...context.savedVehicles].sort(),['vin-device2','vin-offline']);
 assert.equal(JSON.parse(values.get('cruiser-scout-watchlist-sync-v1')).pending.length,0);
});
