const test=require('node:test'),assert=require('node:assert/strict');
const {events,visit}=require('../web/changes.js');
const end='2026-10-26T12:00:00Z',start='2026-10-20T12:00:00Z';
const row={listing_key:'a',vehicle_key:'vin:1',status:'active',category:'retail',first_seen:'2026-10-25T12:00:00Z'};
test('new sources do not count as new trucks; duplicate VINs count once',()=>{
 assert.equal(events([row,{...row,listing_key:'b'}],start,end).length,1);
 assert.equal(events([{...row,vehicle_first_seen:'2026-10-01T00:00:00Z'}],start,end).length,0);
});
test('price drops compare the same listing and respect observation boundaries',()=>{
 const r={...row,first_seen:start,price_history:[{observed_at:start,asking_price:22000},{observed_at:'2026-10-25T00:00:00Z',asking_price:20000},{observed_at:'2026-10-27T00:00:00Z',asking_price:19000}]};
 const e=events([r,{...row,listing_key:'b',first_seen:start,asking_price:10000}],start,end);
 assert.equal(e.length,1);assert.equal(e[0].before,22000);assert.equal(e[0].after,20000);
});
test('returns require explicit evidence and inactive listings are excluded',()=>{
 assert.equal(events([{...row,first_seen:start,reappeared_at:['2026-10-25T00:00:00Z']}],start,end)[0].type,'returned');
 assert.equal(events([{...row,status:'sold'}],start,end).length,0);
 assert.deepEqual(events([{...row,first_seen:null}],start,end),[]);
});
test('first visit, reload, later snapshot and review retain deterministic cutoffs',()=>{
 const first=visit(null,end);assert.equal(first.first,true);
 assert.deepEqual(visit(first,end),first);
 const later=visit(first,'2026-10-27T12:00:00Z');assert.equal(Date.parse(later.baseline),Date.parse(end));
 const reviewed={lastSeen:end,baseline:end,first:false};assert.equal(visit(reviewed,end).baseline,new Date(end).toISOString());
 assert.equal(visit({lastSeen:'bad'},end).first,true);
});
