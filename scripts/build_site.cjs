// Vercel serves the application only. Inventory and galleries live on GitHub Pages.
const fs = require('node:fs');
const path = require('node:path');
function build(root) {
  root = path.resolve(root);
  const source = path.join(root, 'web'), output = path.join(root, 'site-output');
  const entries = fs.readdirSync(source).filter(name => !['photos', 'inventory.json'].includes(name));
  let bytes = 0;
  for (const name of entries) {
    const stat = fs.lstatSync(path.join(source, name));
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Unexpected application asset: ' + name);
    bytes += stat.size;
  }
  if (bytes > 10 * 1024 * 1024) throw new Error('Application exceeds the 10 MiB deployment budget.');
  if (path.dirname(output) !== root || path.basename(output) !== 'site-output') throw new Error('Unsafe output path');
  fs.rmSync(output, {recursive:true, force:true});
  fs.mkdirSync(output, {recursive:true});
  for (const name of entries) fs.copyFileSync(path.join(source, name), path.join(output, name));
  console.log('Application only: ' + entries.length + ' files, ' + (bytes / 1048576).toFixed(2) + ' MiB. Inventory and photos are hosted separately.');
  return {files:entries.length, bytes};
}
if (require.main === module) build(path.resolve(__dirname, '..'));
module.exports = {build};
