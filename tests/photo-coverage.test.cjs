const test = require('node:test');
const assert = require('node:assert/strict');
const {entries} = require('../web/photo-coverage.js');
const row = {listing_key:'autodev:1',vehicle_key:'vin:JTJHT00W364008364',vin:'JTJHT00W364008364',year:2006,model:'LX470',status:'active',source:'autodev',photo_url:'https://retail.photos.vin/a.jpg'};
const donor = {...row,listing_key:'cargurus:1',source:'cargurus',photo_url:'https://static.cargurus.com/a.jpg',listing_url:'https://www.cargurus.com/details/1'};
test('same VIN fallback precedes restricted images and retains attribution',()=>{
 const result=entries(row,[row,donor]);assert.equal(result[0].url,donor.photo_url);assert.equal(result[0].borrowed,true);assert.equal(result[0].listing_url,donor.listing_url);assert.equal(result.length,1);
});
test('never borrow from sold, mismatched, invalid or conflicting vehicles',()=>{
 for(const patch of [{status:'sold'},{vin:'OTHER'},{vehicle_key:'vin:JTJHT00W364008365'},{year:2007},{model:'LX570'},{quality_flags:'vin_model_or_year_conflict'}])assert.equal(entries(row,[{...donor,...patch}]).length,1);
 assert.equal(entries({...row,vehicle_key:'listing:1'},[donor]).length,1);
 assert.equal(entries({...row,status:'sold'},[donor]).length,1);
});
test('deduplicate, accept cached photos, reject unsafe URLs and do not mutate records',()=>{
 const other={...donor,photo_urls:[donor.photo_url,'javascript:alert(1)','photos/12345678901234567890.jpg']};
 const before=JSON.stringify(other);const result=entries(row,[other]);assert.equal(result.length,2);assert.equal(JSON.stringify(other),before);
});
