const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'), vm=require('node:vm');
const api={}; vm.createContext(api); vm.runInContext(fs.readFileSync(require('node:path').join(__dirname,'../integrations/email-alerts/Code.js'),'utf8'),api);
const now='2026-11-05T20:07:00.000Z';

test('AutoTrader digest keeps each card price/photo paired and strips tracking',()=>{
 const card=(year,price,id)=>`<a href="https://click.messages.autotrader.com/?qs=photo${id}"><img src="https://images.autotrader.com/hn/c/${id}.jpg" alt="See this car"></a><table><tr><td>Used ${year} Lexus LX 570 4WD</td></tr><tr><td>$${price}</td></tr></table><a href="https://click.messages.autotrader.com/?qs=${id}">See This Car</a>`;
 const parsed=api.parseAutotrader('My Autotrader Alerts: We found 3 more vehicles for you',card(2015,'30,966','793639540')+card(2013,'25,000','793639541')+card(2020,'55,000','793639542'),now,u=>'https://www.autotrader.com/cars-for-sale/vehicle/'+u.split('=').pop()+'?emid=private');
 assert.equal(parsed.failed,0); assert.equal(parsed.rows.length,2);
 const rows=parsed.rows.map(r=>publicFeed.clean(r,Date.parse(now)));
 assert.equal(rows[0].asking_price,30966); assert.equal(rows[1].asking_price,25000);
 assert.equal(rows[1].photo_url,'https://images.autotrader.com/hn/c/793639541.jpg');
 assert.equal(rows[0].category,'retail');assert.equal(rows[0].status,'unknown');
 assert.doesNotMatch(JSON.stringify(rows),/emid|click\.messages|private/);
});

test('AutoTrader resolves only observed redirect host and does not fetch vehicle pages',()=>{
 let calls=0; api.UrlFetchApp={fetch:()=>{calls++;return {getResponseCode:()=>302,getAllHeaders:()=>({Location:'https://www.autotrader.com/cars-for-sale/vehicle/793639540?emid=private'})}}};
 assert.equal(api.resolveAutotrader('https://click.messages.autotrader.com/?qs=abc'),'https://www.autotrader.com/cars-for-sale/vehicle/793639540');
 assert.equal(calls,1);assert.equal(api.resolveAutotrader('https://evil.example/?qs=abc'),null);assert.equal(calls,1);
 assert.equal(api.canonicalAutotrader('https://www.autotrader.com.evil/cars-for-sale/vehicle/793639540'),null);
});

test('Cars & Bids actual out-of-scope alert stays excluded; supported year with same markup parses',()=>{
 const html='<a href="https://carsandbids.com/auctions/9WDvZqgq/2005-lexus-lx-470?utm_campaign=button">Go to Auction</a><img src="https://media.carsandbids.com/cdn-cgi/image/width=900,quality=90/photos/application/photo.jpg?t=123">';
 assert.equal(api.parseAlert('2005 Lexus LX 470 now live!',html,'carsandbids',now,api.canonicalAuction),null);
 const supported=api.parseAlert('2006 Lexus LX 470 now live!',html.replaceAll('2005','2006'),'carsandbids',now,api.canonicalAuction);
 assert.equal(supported.photo_urls.length,1);assert.equal(supported.source,'carsandbids');
});
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

test('Cars.com cards preserve details and exclude similar out-of-scope vehicles',()=>{
 const card=(y,id,p,mi,city)=>`<a href="https://www.cars.com/vehicledetail/${id}/?private=1">${y} Lexus LX 570 Base</a><td>${mi} mi. $${p}</td><td>Exterior color: Black Onyx</td><td>Location: ${city}</td><a href="x">View details about this car</a>`;
 const id='12345678-1234-1234-1234-123456789012';
 const html=card(2014,id,'34,999','110,416','Slatington, PA')+card(2009,'22345678-1234-1234-1234-123456789012','12,000','250,000','Heath, OH');
 const parsed=api.parseRetailAlert('Inventory Alert: 6+ new listings matching your search',html,'cars.com',now,api.canonicalRetail);
 assert.equal(parsed.failed,0);assert.equal(parsed.rows.length,1);
 const r=publicFeed.clean(parsed.rows[0],Date.parse(now));
 assert.equal(r.asking_price,34999);assert.equal(r.mileage,110416);assert.equal(r.city,'Slatington');assert.equal(r.state,'PA');assert.equal(r.exterior_color,'Black Onyx');assert.equal(r.status,'unknown');assert.equal(r.category,'retail');assert.doesNotMatch(JSON.stringify(r),/private/);
 assert.equal(api.parseRetailAlert('Your Search is Saved!',html,'cars.com',now,api.canonicalRetail).rows.length,0);
});
test('CarGurus recommendations use each vehicle identity, price and mileage',()=>{
 const card=(title,id,p)=>`<a href="https://www.cargurus.com/Cars/listing/${id}?tracking=private"><img src="https://static.cargurus.com/images/forsale/${id}.jpeg"></a><a href="https://www.cargurus.com/Cars/listing/${id}?tracking=private">${title}</a><h2>$${p} <span>$99,999</span></h2><p>Mileage: 121,000 | Austin, TX</p>View details`;
 const html=card('2015 Lexus ES 350',123456789,'20,258')+card('2013 Lexus LX 570 4WD',123456790,'25,000')+'Your search criteria';
 const p=api.parseRetailAlert('Lexus from $8,125',html,'cargurus',now,api.canonicalRetail);
 assert.equal(p.rows.length,1);const r=publicFeed.clean(p.rows[0],Date.parse(now));
 assert.equal(r.asking_price,25000);assert.equal(r.mileage,121000);assert.equal(r.city,'Austin');assert.equal(r.photo_url,'https://static.cargurus.com/images/forsale/123456790.jpeg');
 assert.equal(r.listing_key,'cargurus:123456790');assert.equal(r.listing_url,'https://www.cargurus.com/details/123456790');
 const merged=publicFeed.merge({listings:[{listing_key:r.listing_key,status:'active'}]},{listings:[r]},Date.parse(now));assert.equal(merged.listings.length,1);
});
test('retail redirect allowlist stops at canonical listings and retries failed eligible cards',()=>{
 let calls=0;api.UrlFetchApp={fetch:()=>{calls++;return {getResponseCode:()=>302,getAllHeaders:()=>({Location:'https://www.cargurus.com/Cars/listing/123456789?tracking=secret'})}}};
 assert.equal(api.resolveRetail('https://emailclick.cargurus.com/a/click?_e=abc','cargurus'),'https://www.cargurus.com/details/123456789');assert.equal(calls,1);
 assert.equal(api.resolveRetail('https://emailclick.cargurus.com.evil/a/click?_e=abc','cargurus'),null);assert.equal(calls,1);
 const p=api.parseRetailAlert('Lexus from $10000','<a href="https://evil.example">2013 Lexus LX 570</a>$20000 Mileage: 120000 | Austin, TX View details Your search criteria','cargurus',now,()=>null);
 assert.equal(p.failed,1);assert.equal(p.rows.length,0);
 assert.equal(publicFeed.clean({...row,source:'cars.com',listing_url:'https://www.cars.com.evil/vehicledetail/x/'},Date.parse(now)),null);
});
