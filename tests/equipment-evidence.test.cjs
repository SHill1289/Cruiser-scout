const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const source = fs.readFileSync('web/app.js', 'utf8');
function node(tag, cls, value) { return { tag, cls, value, children: [], append(...children) { this.children.push(...children); }, setAttribute() {} }; }
const ctx = { text: node, document: { createElement: tag => node(tag) } };
vm.createContext(ctx);
vm.runInContext(source.slice(source.indexOf('function equipmentHighlights('), source.indexOf('function maintenanceClaim(')), ctx);
const base = { model:'LX470', year:2006, source:'test', status:'active', listing_url:'https://example.com/truck', reported_extras:'Night View' };
const render = rows => ctx.equipmentHighlights(base, { listings:rows });
let result = JSON.stringify(render([base]));
assert.match(result, /Marketplace tag/); assert.match(result, /factory origin unverified/);
assert.match(result, /https:\/\/example.com\/truck/);
const quote = 'Night View is not working.';
result = JSON.stringify(render([{...base, equipment_evidence:[{label:'Night View', quote, kind:'description'}]}]));
assert.match(result, /Night View is not working\./);
assert.match(JSON.stringify(render([{...base, reported_extras:''}])), /absence not confirmed/);
assert.doesNotMatch(JSON.stringify(render([{...base, listing_url:'javascript:alert(1)'}])), /javascript:/);
assert.match(JSON.stringify(render([{...base, status:'sold'}])), /Historical listing/);
assert.match(JSON.stringify(render([{...base, year:2013}])), /absence not confirmed/);
console.log('Equipment rendering checks passed: attribution, context, unknowns, safe URLs and historical/model safeguards.');

