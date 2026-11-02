// Publish only already-public inventory and its referenced photos to GitHub Pages.
const fs = require('node:fs');
const path = require('node:path');
const BASE_URL = 'https://shill1289.github.io/Cruiser-scout/';
const MAX_BYTES = 500 * 1024 * 1024;
function photoReferences(value, found = new Set()) {
  if (typeof value === 'string' && value.startsWith('photos/')) {
    if (!/^photos\/[a-f0-9]{20}\.(jpg|png|webp)$/.test(value)) throw new Error('Unsafe photo reference: ' + value);
    found.add(value);
  } else if (Array.isArray(value)) value.forEach(item => photoReferences(item, found));
  else if (value && typeof value === 'object') Object.values(value).forEach(item => photoReferences(item, found));
  return found;
}
function hostedPhotos(value) {
  if (typeof value === 'string' && value.startsWith('photos/')) return BASE_URL + value;
  if (Array.isArray(value)) return value.map(hostedPhotos);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, hostedPhotos(item)]));
  return value;
}
function build(root, maxBytes = MAX_BYTES) {
  root = path.resolve(root);
  const source = path.join(root, 'web'), output = path.join(root, 'inventory-output');
  const inventory = JSON.parse(fs.readFileSync(path.join(source, 'inventory.json'), 'utf8'));
  if (!Array.isArray(inventory.listings) || !inventory.listings.length || !Number.isFinite(Date.parse(inventory.generated_at))) {
    throw new Error('Refusing to replace the published feed with invalid or empty inventory.');
  }
  const refs = photoReferences(inventory);
  const files = [...refs].map(photo => {
    const file = path.join(source, photo), stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Invalid photo file: ' + photo);
    return {photo, file, bytes:stat.size};
  });
  const json = JSON.stringify(hostedPhotos(inventory));
  const index = '<!doctype html><meta charset="utf-8"><title>Cruiser Scout inventory</title><h1>Cruiser Scout inventory</h1><p>Public inventory and photos for <a href="https://cruiser-scout.vercel.app">Cruiser Scout</a>.</p>';
  const bytes = Buffer.byteLength(json) + Buffer.byteLength(index) + files.reduce((sum, file) => sum + file.bytes, 0);
  if (bytes > maxBytes) throw new Error('Inventory exceeds the 500 MiB publishing budget. The existing live feed remains available.');
  // Validate everything before replacing local output or attempting a deployment.
  if (path.dirname(output) !== root || path.basename(output) !== 'inventory-output') throw new Error('Unsafe output path');
  fs.rmSync(output, {recursive:true, force:true});
  fs.mkdirSync(path.join(output, 'photos'), {recursive:true});
  fs.writeFileSync(path.join(output, 'inventory.json'), json);
  fs.writeFileSync(path.join(output, 'index.html'), index);
  fs.writeFileSync(path.join(output, '.nojekyll'), '');
  for (const file of files) fs.copyFileSync(file.file, path.join(output, file.photo));
  const summary = `Published inventory prepared: ${inventory.listings.length} listings, ${files.length} photos, ${(bytes / 1048576).toFixed(1)} MiB / 500 MiB budget.`;
  console.log(summary);
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, '\n' + summary + '\n');
  return {photos:files.length, bytes};
}
if (require.main === module) build(path.resolve(__dirname, '..'));
module.exports = {build, photoReferences, hostedPhotos, BASE_URL};
