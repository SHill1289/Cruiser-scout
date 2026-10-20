const test = require("node:test");
const assert = require("node:assert/strict");
const filters = require("../web/filter-normalization.js");
const catalogue = require("../web/factory-colors.json");
const inventory = require("../web/inventory.json").listings;

const exterior = (raw, year, model) => filters.color(catalogue, "exterior", raw, year, model);

test("model color options exclude other palettes and retain unknown categories", () => {
  const keys = model => filters.colorOptions(inventory, catalogue, model).map(([key]) => key);
  const lx470 = keys("Lexus LX 470");
  assert.ok(lx470.includes("Crystal White"));
  assert.ok(!lx470.includes("Starfire Pearl"));
  assert.ok(!lx470.includes("Natural White"));
  const lx570 = keys("LX570");
  assert.ok(lx570.includes("Starfire Pearl"));
  assert.ok(!lx570.includes("Crystal White"));
  const toyota = keys("Land Cruiser");
  assert.ok(toyota.includes("Natural White"));
  assert.ok(toyota.includes("Black Onyx"));
  assert.ok(!toyota.includes("Crystal White"));
  for (const choices of [lx470, lx570, toyota]) {
    assert.ok(choices.includes(filters.OTHER_COLOR));
    assert.ok(choices.includes(filters.MISSING_COLOR));
  }
  assert.deepEqual(keys(""), filters.colorOptions(inventory, catalogue).map(([key]) => key));
});

test("model color choices respect tracked years rather than colors of matching listings", () => {
  const rows = [
    { model: "LX570", year: 2011, exterior_color: "Black Onyx" },
    { model: "LX570", year: 2016, exterior_color: "Atomic Silver" },
    { model: "LX470", year: 2006, exterior_color: "Classic Silver Metallic" }
  ];
  assert.deepEqual(filters.colorOptions(rows, catalogue, "LX570").map(([key]) => key),
    ["Atomic Silver", "Black Onyx"]);
  const reference = { models: { Test: { exterior: [] }, test: { exterior: [
    { name: "Shared", years: [2006] }, { name: "Future", years: [2007] }
  ] } }, exterior: [{ name: "Shared" }, { name: "Future" }] };
  const sample = [{ model: "test", year: 2006, exterior_color: "" },
    { model: "LX470", year: 2006, exterior_color: "Shared" },
    { model: "LX470", year: 2006, exterior_color: "Future" }];
  assert.deepEqual(filters.colorOptions(sample, reference, "test").map(([key]) => key),
    ["Shared", filters.MISSING_COLOR]);
});

test("factory names and marketplace aliases share one model-year facet", () => {
  assert.equal(exterior("WHITE", 2007, "LX470").key, "Crystal White");
  assert.equal(exterior("[077] Starfire Pearl", 2013, "LX 570").key, "Starfire Pearl");
  assert.equal(exterior("Pearl White", 2013, "LX570").key, "Starfire Pearl");
  assert.equal(exterior("Onyx Black", 2015, "LX570").key, "Black Onyx");
  assert.equal(exterior("Black", 2007, "Land Cruiser").key, "Black Onyx");
  assert.equal(exterior("Black", 2007, "Land Cruiser").name, "Black");
  assert.equal(exterior("Silver", 2006, "Land Cruiser").key, "Classic Silver Metallic");
});

test("year-specific factory palettes do not collapse distinct finishes", () => {
  assert.equal(exterior("Silver", 2011, "LX570").key, "Mercury Metallic");
  assert.equal(exterior("Silver", 2015, "LX570").key, "Silver Lining Metallic");
  assert.equal(exterior("Silver", 2016, "LX570").key, "Atomic Silver");
  assert.equal(exterior("Gray", 2011, "LX570").key, "Twilight Gray Metallic");
  assert.equal(exterior("Gray", 2015, "LX570").key, "Nebula Gray Pearl");
  assert.equal(exterior("Gray", 2006, "Land Cruiser").key, filters.OTHER_COLOR);
  assert.equal(exterior("Mercury Metallic", 2015, "LX570").key, filters.OTHER_COLOR);
});

test("unsupported and missing colors remain unverified", () => {
  assert.equal(filters.color(catalogue, "interior", "Brown (Tan)", 2006, "LX470").name, "Ivory");
  assert.equal(filters.color(catalogue, "interior", "White (Ivory)", 2007, "LX470").name, "Ivory");
  assert.equal(exterior("Corris Gray", 2015, "LX570").key, filters.OTHER_COLOR);
  assert.equal(exterior("[999] Starfire Pearl", 2015, "LX570").key, filters.OTHER_COLOR);
  assert.equal(exterior("", 2015, "LX570").key, filters.MISSING_COLOR);
  assert.equal(exterior("Unknown", 2015, "LX570").key, filters.MISSING_COLOR);
  assert.equal(exterior("New Future Color", 2028, "LX570").key, filters.OTHER_COLOR);
  assert.equal(exterior("Silver", 2028, "LX570").factory, false);
});

test("current inventory yields unique canonical color and marketplace options", () => {
  const options = filters.colorOptions(inventory, catalogue);
  const keys = options.map(([key]) => key);
  assert.equal(keys.length, new Set(keys).size);
  for (const duplicate of ["Silver", "White", "Gray", "Grey", "Onyx Black", "Pearl White", "[077] Starfire Pearl"]) {
    assert.equal(keys.includes(duplicate), false, duplicate);
  }
  assert.ok(options.some(([key, label]) => key === "Black Onyx" && label === "Black Onyx / Black"));
  assert.ok(options.some(([key]) => key === filters.OTHER_COLOR));
  assert.ok(options.some(([key]) => key === filters.MISSING_COLOR));
  const sources = filters.facetOptions(["Car Gurus", "cargurus", "CarGurus", "True Car", "truecar"], filters.source, filters.sourceLabel);
  assert.deepEqual(sources, [["cargurus", "CarGurus"], ["truecar", "TrueCar"]]);
  const models = filters.facetOptions(["LX 470", "Lexus LX470", "Land Cruiser", "Toyota Land Cruiser"], filters.model, filters.modelLabel);
  assert.deepEqual(models, [["LX470", "Lexus LX470"], ["Land Cruiser", "Toyota Land Cruiser"]]);
});
