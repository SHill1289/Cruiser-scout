const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const source = fs.readFileSync('web/app.js','utf8');
function sort(rows, mode) {
  const context = vm.createContext({controls:{sort:{value:mode}},origin:null,rows});
  vm.runInContext(source.slice(source.indexOf('function discoveryTime('),source.indexOf('function renderMap(')),context);
  return vm.runInContext('sortRows(rows)',context).map(row=>row.listing_key);
}
test('another source and newer verification do not make an old truck recently added',()=>{
  const rows=[{listing_key:'old',first_seen:'2026-11-03T10:00:00Z',vehicle_first_seen:'2026-10-04T10:00:00Z',last_seen:'2026-11-03T12:00:00Z'},
    {listing_key:'new',first_seen:'2026-11-02T10:00:00Z',vehicle_first_seen:'2026-11-02T10:00:00Z',last_seen:'2026-11-02T10:00:00Z'}];
  assert.deepEqual(sort(rows,'newest'),['new','old']);
});
test('discovery ordering compares actual instants across timezone offsets and puts missing dates last',()=>{
  assert.deepEqual(sort([{listing_key:'earlier',first_seen:'2026-11-01T01:50:00-04:00'},
    {listing_key:'later',first_seen:'2026-11-01T01:10:00-05:00'}, {listing_key:'unknown'}],'newest'),['later','earlier','unknown']);
});
test('newest listed uses listing date, including labeled estimates, never verification; unknown dates stay last',()=>{
  assert.deepEqual(sort([{listing_key:'old',listed_at:'2026-09-01',first_seen:'2026-11-03',last_seen:'2026-11-03'},
    {listing_key:'unknown',first_seen:'2026-11-03'},
    {listing_key:'new',listed_at:'2026-11-01',listed_at_is_estimated:true,first_seen:'2026-11-01'}],'listed-newest'),['new','old','unknown']);
});
test('ties have a stable order independent of input order',()=>{
  const rows=[{listing_key:'b',first_seen:'2026-11-01'},{listing_key:'a',first_seen:'2026-11-01'}];
  assert.deepEqual(sort(rows,'newest'),['a','b']);
  assert.deepEqual(sort(rows.reverse(),'listed-newest'),['a','b']);
});
