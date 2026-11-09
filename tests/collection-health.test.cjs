const test = require('node:test');
const assert = require('node:assert/strict');
const {state, photos, summarize} = require('../web/collection-health.js');
const now = Date.parse('2026-11-09T12:00:00Z');
const ago = hours => new Date(now-hours*3600000).toISOString();

test('health distinguishes stale, failed, inactive and daily collectors', () => {
  assert.equal(state({source:'cargurus',status:'ok',checked_at:ago(6)},now),'healthy');
  assert.equal(state({source:'cargurus',status:'ok',checked_at:ago(10)},now),'stale');
  assert.equal(state({source:'autodev',status:'ok',checked_at:ago(24)},now),'healthy');
  assert.equal(state({source:'autodev',status:'ok',checked_at:ago(31)},now),'stale');
  for (const status of ['error','partial','warning']) assert.equal(state({status,checked_at:ago(0)},now),'attention');
  for (const status of ['manual_only','not_applicable','disabled','paused']) assert.equal(state({status},now),'paused');
  assert.equal(state({status:'ok'},now),'stale');
  assert.equal(state({status:'ok',checked_at:ago(-1)},now),'stale');
});

test('email freshness is separate from inventory and no new alerts is healthy', () => {
  assert.equal(summarize([],[],{listings:[],checked_at:ago(.1)},now).counts.healthy,1);
  assert.equal(summarize([],[],{checked_at:ago(.5)},now).counts.stale,1);
  assert.equal(summarize([],[],{checked_at:ago(0),partial:true},now).counts.attention,1);
  assert.equal(summarize([],[],null,now).counts.attention,1);
});

test('coverage counts active listing records only and deduplicates photo URLs', () => {
  const base={source:'cargurus',status:'active',category:'retail'};
  const rows=[{...base,photo_url:'a',photo_urls:['a','a','',null],mileage:0,asking_price:100,city:'Miami'},
    {...base,photo_urls:['a','b'],mileage:1,asking_price:null},
    {...base,category:'auction',current_bid:100,mileage:null},
    {...base,status:'sold'}, {...base,status:'unknown'}];
  assert.equal(photos(rows[0]),1);
  assert.deepEqual(summarize(rows,[],null,now).sources[0],{
    source:'cargurus',total:5,active:3,unverified:1,noPhotos:1,onePhoto:1,gallery:1,noMileage:1,noPrice:1,noLocation:2
  });
});
