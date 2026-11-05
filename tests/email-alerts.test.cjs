const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'), vm=require('node:vm');
const api={}; vm.createContext(api); vm.runInContext(fs.readFileSync(require('node:path').join(__dirname,'../integrations/email-alerts/Code.js'),'utf8'),api);
const now='2026-11-05T20:07:00.000Z';
test('BaT alert publishes only whitelisted vehicle data, never email tracking or personal content',()=>{
 const html='<p>Hello private@example.com</p><a href="https://links.bringatrailer.com/a/sc/private">VIEW AUCTION</a><img src="https://bringatrailer.com/wp-content/uploads/2026/11/truck.jpg?w=940"><img src="https://tracker.example/pixel">';
 const row=api.parseAlert('2006 Lexus LX470 now live on BaT',html,'bringatrailer',now,()=> 'https://bringatrailer.com/listing/2006-lexus-lx470-123/?utm_source=private');
 assert.equal(row.listing_key,'bringatrailer:2006-lexus-lx470-123'); assert.equal(row.status,'unknown'); assert.equal(row.first_seen,now); assert.equal(row.photo_urls.length,1);
 assert.doesNotMatch(JSON.stringify(row),/private|tracker|utm_/); assert.equal(row.mileage,null);
});
test('Cars & Bids canonical link is accepted without importing unrelated private footer',()=>{
 const row=api.parseAlert('2013 Lexus LX 570 now live!','<a href="https://carsandbids.com/auctions/Ab12cd34/2013-lexus-lx-570?utm_campaign=button">Go to Auction</a>','carsandbids',now,api.canonicalAuction);
 assert.equal(row.model,'LX570'); assert.equal(row.listing_key,'carsandbids:Ab12cd34');
});
test('unsupported years, old-result subjects and unsafe destinations are rejected',()=>{
 for(const title of ['2003 Lexus LX470 now live on BaT','2013 BMW M5 now live!','2006 Lexus LX470 auction ended']) assert.equal(api.parseAlert(title,'','bringatrailer',now,api.canonicalAuction),null);
 for(const url of ['https://bringatrailer.com.evil/listing/a/','https://bringatrailer.com/account/','javascript:alert(1)','http://bringatrailer.com/listing/a/']) assert.equal(api.canonicalAuction(url,'bringatrailer'),null);
 assert.equal(api.parseAlert('2006 Lexus LX470 now live on BaT','<a href="https://evil.example">VIEW AUCTION</a>','bringatrailer',now,()=> 'https://evil.example'),null);
});
test('resolver never fetches arbitrary hosts, and stops before fetching a listing',()=>{
 let calls=0; api.UrlFetchApp={fetch:()=>{calls++;return {getResponseCode:()=>302,getAllHeaders:()=>({Location:'https://bringatrailer.com/listing/2006-lexus-lx470-123/'})}}};
 assert.equal(api.resolveAuction('https://evil.example','bringatrailer'),null); assert.equal(calls,0);
 assert.match(api.resolveAuction('https://links.bringatrailer.com/a/sc/abc','bringatrailer'),/\/listing\//); assert.equal(calls,1);
});
const publicFeed=require('../web/email-alerts');
const row={year:2006,model:'LX470',source:'bringatrailer',listing_url:'https://bringatrailer.com/listing/2006-lexus-lx470-89/',email_observed_at:now,photo_url:'https://bringatrailer.com/wp-content/uploads/2026/11/truck.jpg?w=940'};
test('public feed rejects stale/future data and removes unexpected private fields',()=>{
 const result=publicFeed.clean({...row,email:'private@example.com',status:'sold',sale_price:99999},Date.parse(now));
 assert.equal(result.status,'unknown'); assert.equal(result.sale_price,null); assert.equal(result.email,undefined);
 assert.equal(publicFeed.clean(row,Date.parse(now)+8*86400000),null);
 assert.equal(publicFeed.clean({...row,email_observed_at:'bad'},Date.parse(now)),null);
 assert.equal(publicFeed.clean({...row,photo_url:'https://evil.example/pixel'},Date.parse(now)).photo_url,'');
});
test('verified collector records win, duplicate alerts collapse, new groups remain visible',()=>{
 const verified={...publicFeed.clean(row,Date.parse(now)),status:'sold',sale_price:25000};
 const data={listings:[verified],vehicles:[{vehicle_key:'vin:123',listing_keys:[verified.listing_key]}]};
 const merged=publicFeed.merge(data,{listings:[row,row]},Date.parse(now));
 assert.equal(merged.listings.length,1); assert.equal(merged.listings[0].sale_price,25000);
 const other={...row,listing_url:'https://bringatrailer.com/listing/2006-lexus-lx470-90/'};
 const added=publicFeed.merge(data,{listings:[other,other]},Date.parse(now));
 assert.equal(added.listings.length,2); assert.equal(added.vehicles.length,2); assert.equal(data.vehicles.length,1);
});
test('Gmail HTML decoder accepts decoded service responses and unpadded base64url',()=>{
 api.Utilities={base64Decode:s=>[...Buffer.from(s,'base64')],newBlob:b=>({getDataAsString:()=>Buffer.from(b).toString('utf8')})};
 const html='<p>Vehicle</p>';
 for (const data of [html,[...Buffer.from(html)],Buffer.from(html).toString('base64url')]) assert.equal(api.emailHtml({mimeType:'text/html',body:{data}}),html);
});
test('API whitelists output and handles upstream failure without exposing response contents',async()=>{
 const handler=require('../api/email-alerts').createHandler;
 const res={headers:{},setHeader(k,v){this.headers[k]=v},status(code){this.code=code;return this},json(data){this.data=data;return this}};
 await handler(async()=>({ok:true,text:async()=>JSON.stringify({version:1,listings:[{...row,email_observed_at:new Date().toISOString(),email:'private@example.com'}],health:{checked_at:new Date().toISOString()}})}))({method:'GET'},res);
 assert.equal(res.code,200); assert.equal(res.data.listings.length,1); assert.doesNotMatch(JSON.stringify(res.data),/private@example/); assert.match(res.headers['Cache-Control'],/s-maxage=120/);
 await handler(async()=>({ok:false}))({method:'GET'},res); assert.equal(res.code,503); assert.equal(res.headers['Cache-Control'],'no-store');
});
