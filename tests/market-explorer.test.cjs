
const {test}=require("node:test");
const assert=require("node:assert/strict");
const market=require("../web/market-explorer.js");
const now="2026-10-26T16:00:00Z";
const rows=[
 {listing_url:"a",model:"LX470",year:2006,mileage:120000,color_key:"Black",city:"Miami",state:"FL",sold_at:"2026-09-08",sale_price:17000,outcome:"sold"},
 {listing_url:"b",model:"LX470",year:2007,mileage:210000,color_key:"White",city:"Denver",state:"CO",sold_at:"2026-05-01",sale_price:22000,outcome:"unsold"},
 {listing_url:"c",model:"LX470",year:2007,mileage:null,sold_at:"2026-06-01",sale_price:25000,outcome:"sold"},
 {listing_url:"d",model:"LX570",year:2014,mileage:80000,color_key:"Black",state:"FL",sold_at:"2026-01-01",sale_price:35000,outcome:"sold"},
 {listing_url:"e",model:"LX470",year:2006,mileage:100000,sold_at:"2023-01-01",sale_price:20000,outcome:"sold"}];
test("multi-year and multi-color filters combine with model, mileage and location",()=>{
 assert.deepEqual(market.filter(rows,{model:"LX470",years:["2006","2007"],colors:["Black","White"],minMiles:100000,maxMiles:220000},now).map(r=>r.listing_url),["a","b"]);
 assert.deepEqual(market.filter(rows,{years:["2006","2007"],location:"FL",city:"MIA"},now).map(r=>r.listing_url),["a"]);
});
test("unknown values remain until corresponding constraints apply",()=>{
 assert.equal(market.filter(rows,{model:"LX470"},now).length,3);
 assert.equal(market.filter(rows,{model:"LX470",minMiles:0},now).length,2);
 assert.deepEqual(market.filter(rows,{location:"unknown"},now).map(r=>r.listing_url),["c"]);
});
test("reserve not met is separately filterable and outside sold statistics",()=>{
 assert.deepEqual(market.filter(rows,{outcome:"unsold"},now).map(r=>r.listing_url),["b"]);
 assert.equal(market.filter(rows,{model:"LX470",outcome:"sold"},now).length,2);
});
test("deduplicate by auction URL without merging repeat auctions of a VIN",()=>{
 const result=market.unique([{listing_url:"a",vin:"same",sale_price:1},{listing_url:"b",vin:"same"},{listing_url:"a",vin:"same",sale_price:2}]);
 assert.equal(result.length,2);assert.equal(result[0].sale_price,2);
});
test("axis bounds include maximum price",()=>{const ticks=market.ticks(121001);assert.equal(ticks[0],0);assert.ok(ticks.at(-1)>=121001);});

test("two comparison sets retain independent year and mileage filters",()=>{
 const data=[...rows,{listing_url:"f",model:"LX570",year:2012,mileage:99000,sale_price:30000,sold_at:"2026-06-01"}];
 const a=market.filter(data,{model:"LX470",years:["2006","2007"],maxMiles:149999,outcome:"sold"},now);
 const b=market.filter(data,{model:"LX570",years:["2011","2012","2013"],maxMiles:99999,outcome:"sold"},now);
 assert.deepEqual(a.map(r=>r.listing_url),["a"]);
 assert.deepEqual(b.map(r=>r.listing_url),["f"]);
 assert.equal(market.stats(a).median,17000);
 assert.equal(market.stats(b).median,30000);
});
test("sale statistics exclude unsold bids and deduplicate each set",()=>{
 assert.deepEqual(market.stats([rows[0],rows[0],rows[1],rows[2]]),{count:2,median:21000,average:21000,min:17000,max:25000});
 assert.equal(market.stats([]).median,null);
});
test("any source can supply confirmed sales, never asking prices or last-seen dates",()=>{
 const base={source:"dealer",status:"sold",sold_price:20000,auction_result_at:"2026-05-01"};
 const result=market.completed([base,{...base,status:"removed"},{...base,sold_price:null,asking_price:20000},{...base,auction_result_at:null,last_seen:"2026-05-01"}]);
 assert.equal(result.length,1);assert.equal(result[0].sale_price,20000);
});
