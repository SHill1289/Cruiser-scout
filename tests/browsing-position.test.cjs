const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const source = fs.readFileSync('web/app.js', 'utf8');
const logic = source.slice(source.indexOf('const browsingKey ='), source.indexOf('function vehicleName'));
function setup(saved, hash = '#inventory?model=LX570', blocked = false) {
  let stored;
  const card = { id: 'vehicle-123', getBoundingClientRect: () => ({top: 120, bottom: 600}) };
  const window = { scrollY: 500, innerWidth: 390, addEventListener() {}, scrollTo({top}) { this.scrollY = top; } };
  const context = vm.createContext({
    window, location: {hash}, history: {scrollRestoration:'auto', replaceState(a,b,value){context.location.hash=value;}},
    sessionStorage: {getItem(){if(blocked) throw Error('blocked'); return saved;},setItem(k,v){if(blocked) throw Error('blocked');stored=JSON.parse(v);}},
    document: {hidden:false, addEventListener(){}, querySelectorAll(){return [];}, querySelector(selector){
      if(selector === '#filter-drawer') return {open:false};
      if(selector === '.inventory-toolbar') return {getBoundingClientRect:()=>({bottom:123})};
      return {querySelectorAll:()=>[card]};
    }}, ui:{listings:{children:Array(48),scrollLeft:90}}, requestAnimationFrame: fn=>fn(), setTimeout, clearTimeout
  });
  vm.runInContext(logic,context);
  return {context,window,stored:()=>stored,run:code=>vm.runInContext(code,context)};
}
test('saves loaded cards, active filters, anchor and table offset',()=>{
  const s=setup(null);s.run('browsingReady=true; displayedView="inventory"; rememberBrowsing()');
  assert.equal(s.stored().shown,48);assert.equal(s.stored().hash,'#inventory?model=LX570');
  assert.equal(s.stored().positions.inventory.anchor,'vehicle-123');assert.equal(s.stored().positions.inventory.horizontal,90);
});
test('restores the anchor offset and loaded result count after reload',()=>{
  const s=setup(JSON.stringify({hash:'#inventory?model=LX570',shown:48,positions:{inventory:{anchor:'vehicle-123',offset:20,y:400,horizontal:80}}}));
  assert.equal(s.run('resumeBrowsing'),true);assert.equal(s.run('browsing.shown'),48);
  s.run('displayedView="inventory"; restoreBrowsingPosition("inventory")');assert.equal(s.window.scrollY,600);
  assert.equal(s.context.ui.listings.scrollLeft,80);
});
test('different explicit search does not resume the prior position',()=>{
  const s=setup(JSON.stringify({hash:'#inventory?model=LX470',shown:48,positions:{}}));
  assert.equal(s.run('resumeBrowsing'),false);
});
test('blocked or corrupt storage does not prevent browsing',()=>{
  for(const s of [setup('{broken'),setup(null,undefined,true)]) {
    assert.equal(s.run('browsing.shown'),24);
    assert.doesNotThrow(()=>s.run('browsingReady=true; displayedView="inventory"; rememberBrowsing()'));
  }
});
