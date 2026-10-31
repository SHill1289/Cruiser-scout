// Deploy only photos referenced by the public inventory. Keep originals in Git.
const fs = require("node:fs");
const path = require("node:path");
function photoReferences(value, found = new Set()) {
  if (typeof value === "string" && value.startsWith("photos/")) {
    if (!/^photos[/][a-f0-9]{20}\.(?:jpg|png|webp)$/.test(value)) throw new Error("Unsafe photo reference: " + value);
    found.add(value);
  } else if (Array.isArray(value)) value.forEach(item => photoReferences(item, found));
  else if (value && typeof value === "object") Object.values(value).forEach(item => photoReferences(item, found));
  return found;
}
function build(root) {
  root = path.resolve(root);
  const source = path.join(root, "web"), output = path.join(root, "site-output");
  const refs = photoReferences(JSON.parse(fs.readFileSync(path.join(source, "inventory.json"), "utf8")));
  // Fail before changing output if any required gallery file is missing.
  for (const photo of refs) {
    if (!fs.statSync(path.join(source, photo)).isFile()) throw new Error("Missing photo: " + photo);
  }
  if (path.dirname(output) !== root || path.basename(output) !== "site-output") throw new Error("Unsafe output path");
  fs.rmSync(output, { recursive: true, force: true });
  fs.mkdirSync(output, { recursive: true });
  for (const entry of fs.readdirSync(source)) {
    if (entry !== "photos") fs.cpSync(path.join(source, entry), path.join(output, entry), { recursive: true });
  }
  fs.mkdirSync(path.join(output, "photos"), { recursive: true });
  let bytes = 0;
  for (const photo of refs) {
    fs.copyFileSync(path.join(source, photo), path.join(output, photo));
    bytes += fs.statSync(path.join(source, photo)).size;
  }
  console.log("Published " + refs.size + " referenced photos (" + (bytes / 1048576).toFixed(1) + " MiB). Unused cached photos stay in Git.");
  return { photos: refs.size, bytes };
}
if (require.main === module) build(path.resolve(__dirname, ".."));
module.exports = { build, photoReferences };
