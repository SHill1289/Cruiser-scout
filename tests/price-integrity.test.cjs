const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const prices=require('../web/price-integrity.js'),market=require('../web/market-explorer.js'),changes=require('../web/changes.js');
const now=Date.parse('2026-11-16T12:00:00Z');
for(const fixture of require('./fixtures/price-integrity.json'))test(fixture.name,()=>assert.equal(Boolean(prices.reason(fixture.row,fixture.field,fixture.row[fixture.field],now)),fixture.flag));
const base={status:'active',category:'retail',model:'LX570',mileage:120000,last_seen:'2026-11-16T10:00:00Z',vehicle_key:'vin:JTJHY7AX6G4215236',source:'cargurus',asking_price:35000,deal_quality:'great'};
test('only contemporaneous valid same-VIN prices conflict; invalid low price does not discredit valid price',()=>{
  const rows=prices.listings([base,{...base,source:'autodev',asking_price:349}],now);
  assert.equal(rows[0].asking_price,35000);assert.equal(rows[1].asking_price,null);assert.equal(rows[1].deal_quality,undefined);
  const conflict=prices.listings([base,{...base,source:'autodev',asking_price:50000}],now);
  assert.ok(conflict.every(r=>r.asking_price===null&&r.price_review.asking_price.includes('disagree')));
  for(const change of [{last_seen:'2026-10-01T12:00:00Z'},{vehicle_key:'listing:other'},{status:'sold',sold_price:50000}])
    assert.equal(prices.listings([base,{...base,source:'autodev',asking_price:50000,...change}],now)[0].asking_price,35000);
});
test('raw amounts survive; flagged prices cannot affect sorting, range filtering, ratings, or market medians',()=>{
  const raw={listings:[{...base,asking_price:349},{...base,vehicle_key:'listing:good',listing_key:'good'}],market_history:{sales:[{sale_price:349},{sale_price:35000},{sale_price:36000},{sale_price:37000}].map(r=>({...r,model:'LX570',mileage:120000,listing_url:String(r.sale_price)}))}};
  const data=prices.prepare(raw,now);assert.equal(raw.listings[0].asking_price,349);
  assert.equal(data.listings[0].reported_prices.asking_price,349);assert.equal(data.listings[0].deal_quality,undefined);
  assert.equal(data.listings[1].deal_comparable_count,3);assert.equal(data.listings[1].deal_median_price,36000);
  assert.equal(market.stats(data.market_history.sales).median,36000);
  const source=fs.readFileSync('web/app.js','utf8');
  const context=vm.createContext({CruiserPrices:prices,controls:{sort:{value:'price-asc'}},origin:null,rows:data.listings});
  vm.runInContext(source.slice(source.indexOf('function listingPrice('),source.indexOf('function priceLabel('))+source.slice(source.indexOf('function discoveryTime('),source.indexOf('function renderMap(')),context);
  for(const mode of ['price-asc','price-desc']){context.controls.sort.value=mode;assert.equal(vm.runInContext('sortRows([...rows])[0].listing_key',context),'good');}
  assert.equal(vm.runInContext('listingPrice(rows[0])',context),null);
  assert.equal(prices.fieldFor({status:'sold',asking_price:35000}), 'sold_price');
});
test('rejected history does not manufacture a price-drop alert',()=>{
  const row=prices.clean({...base,listing_key:'a',price_history:[{asking_price:35000,observed_at:'2026-11-14'},{asking_price:349,observed_at:'2026-11-15'},{asking_price:34000,observed_at:'2026-11-16'}]},now);
  assert.equal(changes.events([row],'2026-11-13','2026-11-17').filter(e=>e.type==='drop').length,0);
});
