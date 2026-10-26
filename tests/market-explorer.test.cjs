
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
