const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const {build} = require('../scripts/build_site.cjs');
const {needsBuild,shouldSkip} = require('../scripts/ignore_vercel_build.cjs');
test('Vercel output contains application files but no inventory or photo library', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(),'scout-app-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  fs.mkdirSync(path.join(root,'web/photos'),{recursive:true});
  fs.writeFileSync(path.join(root,'web/photos/photo.jpg'),'image');
  fs.writeFileSync(path.join(root,'web/inventory.json'),'{}');
  fs.writeFileSync(path.join(root,'web/index.html'),'site');
  fs.writeFileSync(path.join(root,'web/zip-centroids.json'),'{}');
  assert.equal(build(root).files,2);
  assert.deepEqual(fs.readdirSync(path.join(root,'site-output')).sort(),['index.html','zip-centroids.json']);
  assert.equal(fs.readFileSync(path.join(root,'web/photos/photo.jpg'),'utf8'),'image');
  fs.writeFileSync(path.join(root,'web/oversized.bin'),Buffer.alloc(11*1024*1024));
  assert.throws(()=>build(root),/budget/);
  assert.equal(fs.readFileSync(path.join(root,'site-output/index.html'),'utf8'),'site');
});
test('data-only changes skip builds but mixed application changes and unknown baselines build',()=>{
  assert.equal(needsBuild(['data/listings.json','web/inventory.json','web/photos/a.jpg','INVENTORY.md']),false);
  for(const file of ['web/app.js','web/inventory-source.js','api/refresh.js','vercel.json','scripts/build_site.cjs'])
    assert.equal(needsBuild(['web/inventory.json',file]),true);
  assert.equal(shouldSkip({VERCEL_GIT_COMMIT_REF:'raptor-finder'}),true);
  assert.equal(shouldSkip({VERCEL_GIT_COMMIT_REF:'main'}),false);
  const sha = 'a'.repeat(40);
  assert.equal(shouldSkip({VERCEL_GIT_COMMIT_REF:'main', VERCEL_GIT_PREVIOUS_SHA:sha, VERCEL_GIT_COMMIT_SHA:sha}),false);
});
