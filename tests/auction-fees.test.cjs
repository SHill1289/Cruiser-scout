const test=require('node:test'),assert=require('node:assert/strict');
const Fees=require('../web/auction-fees.js'),Prices=require('../web/price-integrity.js'),Market=require('../web/market-explorer.js');
test('5% fee respects minimum, cap and cents',()=>{
  assert.equal(Fees.fee(1000),250);assert.equal(Fees.fee(5000),250);
  assert.equal(Fees.fee(34250),1712.5);assert.equal(Fees.fee(150000),7500);assert.equal(Fees.fee(200000),7500);
  assert.equal(Fees.fee(120000,'2024-01-29'),5000);assert.equal(Fees.fee(120000,'2024-01-30'),6000);
  for(const value of [null,undefined,0,-1,NaN,Infinity,'20000'])assert.equal(Fees.fee(value),null);
});
test('budget inverse never exceeds budget, including fee boundaries',()=>{
  for(const [budget,extra] of [[30000,1000],[5250,0],[250.01,0],[157500,0],[200000,3000],[35000.17,650.39]]) {
    const bid=Fees.maxBid(budget,extra);assert.notEqual(bid,null);
    assert.ok(Fees.estimate(bid,extra).total<=budget);
    assert.ok(Fees.estimate(bid+.01,extra).total>budget);
  }
  assert.equal(Fees.maxBid(30000,1000),27619.05);
  for(const [budget,extra] of [[0,0],[250,0],[300,100],[1000,-1],[1000,Infinity],[null,0]])assert.equal(Fees.maxBid(budget,extra),null);
});
test('only confirmed BaT sales receive automatic fees; source records are preserved and conversion is idempotent',()=>{
  const raw={source:'Bring a Trailer',sale_price:34250,sold_at:'2026-11-14',listing_url:'bat'};
  const result=Fees.completed(raw);assert.equal(result.sale_price,35962.5);assert.equal(result.hammer_price,34250);assert.equal(raw.sale_price,34250);
  assert.deepEqual(Fees.completed(result),result);
  for(const change of [{outcome:'unsold'},{source:'cargurus'},{source:'carsandbids'},{status:'active'},{currency:'CAD'},{sale_price:null},{price_review:{sale_price:'Needs review'}}]) {
    const row={...raw,...change};assert.deepEqual(Fees.completed(row),row);
  }
});
test('existing listings, sorting amounts, medians and deal ratings use the same fee-inclusive sales',()=>{
  const raw={listings:[{listing_key:'sold',source:'bringatrailer',status:'sold',category:'auction',sold_price:30000},{source:'cargurus',status:'active',category:'retail',asking_price:30000,model:'LX470',mileage:120000,deal_quality:'fair'}],market_history:{sales:[20000,30000,40000].map((price,i)=>({source:'Bring a Trailer',sale_price:price,sold_at:'2026-11-01',listing_url:String(i),model:'LX470',mileage:120000}))}};
  const data=Fees.prepare(Prices.prepare(raw),Prices);
  assert.equal(data.listings[0].sold_price,31500);assert.equal(data.listings[1].deal_median_price,31500);
  assert.equal(Market.stats(data.market_history.sales).median,31500);
  assert.deepEqual(Fees.prepare(data,Prices),data);
  const flagged=Fees.prepare(Prices.prepare({...raw,listings:[{source:'bringatrailer',status:'sold',category:'auction',sold_price:349}]}),Prices);
  assert.equal(flagged.listings[0].sold_price,null);assert.equal(flagged.listings[0].auction_fee_included,undefined);
});
