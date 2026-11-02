const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const {build, BASE_URL} = require('../scripts/build_inventory_feed.cjs');
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scout-feed-'));
  t.after(() => fs.rmSync(root, {recursive:true, force:true}));
  fs.mkdirSync(path.join(root, 'web/photos'), {recursive:true});
  const photo = 'photos/' + 'a'.repeat(20) + '.jpg';
  const data = {generated_at:'2026-11-02T06:00:00Z', listings:[{photo_url:photo, photo_urls:[photo], listing_url:'https://example.com/listing'}], vehicles:[{photos:[{url:photo}]}]};
  fs.writeFileSync(path.join(root, 'web', photo), 'image');
  fs.writeFileSync(path.join(root, 'web/photos', 'b'.repeat(20) + '.jpg'), 'unused');
  fs.writeFileSync(path.join(root, 'web/inventory.json'), JSON.stringify(data));
  fs.writeFileSync(path.join(root, 'web/private.txt'), 'must not publish');
  return {root, photo, data};
}
test('feed preserves nested galleries with hosted URLs and publishes only referenced public assets', t => {
  const {root,photo} = fixture(t);
  assert.equal(build(root).photos,1);
  const feed = JSON.parse(fs.readFileSync(path.join(root,'inventory-output/inventory.json')));
  assert.equal(feed.listings[0].photo_url, BASE_URL + photo);
  assert.equal(feed.vehicles[0].photos[0].url, BASE_URL + photo);
  assert.equal(feed.listings[0].listing_url,'https://example.com/listing');
  assert.deepEqual(fs.readdirSync(path.join(root,'inventory-output')).sort(), ['.nojekyll','index.html','inventory.json','photos']);
  assert.equal(fs.readdirSync(path.join(root,'inventory-output/photos')).length,1);
  assert.equal(JSON.parse(fs.readFileSync(path.join(root,'web/inventory.json'))).listings[0].photo_url, photo);
});
test('oversize, missing photos, empty inventory and unsafe paths cannot replace last valid output', t => {
  const {root,photo,data} = fixture(t); build(root);
  const prior = fs.readFileSync(path.join(root,'inventory-output/inventory.json'),'utf8');
  assert.throws(()=>build(root,1),/budget/);
  fs.unlinkSync(path.join(root,'web',photo));
  assert.throws(()=>build(root));
  fs.writeFileSync(path.join(root,'web/inventory.json'), JSON.stringify({...data,listings:[]}));
  assert.throws(()=>build(root),/invalid or empty/);
  data.listings[0].photo_url = 'photos/../../secret';
  fs.writeFileSync(path.join(root,'web/inventory.json'), JSON.stringify(data));
  assert.throws(()=>build(root),/Unsafe photo/);
  assert.equal(fs.readFileSync(path.join(root,'inventory-output/inventory.json'),'utf8'),prior);
});
