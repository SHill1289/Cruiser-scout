const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const source = fs.readFileSync(require.resolve("../web/comparison.js"), "utf8");

function load(saved, vehicles, storageFails = false) {
  const context = vm.createContext({
    vehicles,
    sessionStorage: { getItem() { if (storageFails) throw Error("Storage blocked"); return saved; } },
    document: { querySelector() { return { addEventListener() {} }; } },
  });
  vm.runInContext(source, context);
  return expression => JSON.parse(vm.runInContext(`JSON.stringify(${expression})`, context));
}

test("comparison keeps the chosen source for a vehicle with duplicate listings", () => {
  const read = load(JSON.stringify([["vin:one", "source:b"]]), [{ vehicleKey: "vin:one", listings: [
    { listing_key: "source:a", asking_price: 10000, status: "active" },
    { listing_key: "source:b", asking_price: 12000, status: "active" },
  ] }]);
  assert.equal(read("comparisonVehicles().length"), 1);
  assert.equal(read("comparisonVehicles()[0].row.asking_price"), 12000);
});

test("expired source falls back to an active listing while missing vehicles are omitted", () => {
  const read = load(JSON.stringify([["vin:one", "old"], ["vin:gone", "gone"]]), [
    { vehicleKey: "vin:one", listings: [
      { listing_key: "sold", status: "sold" }, { listing_key: "active", status: "active" },
    ] },
  ]);
  assert.deepEqual(read("comparisonVehicles().map(vehicle => vehicle.row.listing_key)"), ["active"]);
});

test("saved comparison is limited to four and tolerates invalid or blocked storage", () => {
  const read = load(JSON.stringify(Array.from({ length: 6 }, (_, i) => [`vehicle:${i}`, `listing:${i}`])), []);
  assert.equal(read("comparisonSelection.size"), 4);
  for (const saved of ["bad json", "null", "{}", '[null, 1, ["key"], ["key", 3]]']) {
    assert.equal(load(saved, [])("comparisonSelection.size"), 0);
  }
  assert.equal(load("[]", [], true)("comparisonSelection.size"), 0);
});
