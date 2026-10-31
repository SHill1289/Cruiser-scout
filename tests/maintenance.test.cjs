const test = require("node:test");
const assert = require("node:assert/strict");
const { records } = require("../web/maintenance.js");
const base = { model: "LX470", year: 2007, status: "active", source: "cargurus",
  listing_url: "https://www.cargurus.com/listing/1" };
test("missing evidence is unknown, never a negative maintenance claim", () => {
  const result = records({ ...base, timing_belt_status: "Service reported" });
  assert.equal(result.find(item => item.key === "timing_belt").claims.length, 0);
});
test("documented topics come first with belt service ahead of other documented items", () => {
  const row = { ...base, timing_belt_status: "Service reported", timing_belt_evidence: "Replaced in 2022 at 90,000 miles.",
    rust_status: "Rust reported", rust_evidence: "Rust is visible on the frame." };
  const result = records(row);
  assert.deepEqual(result.slice(0, 2).map(item => item.key), ["timing_belt", "rust"]);
  assert.equal(result[0].claims[0].evidence, row.timing_belt_evidence);
  assert.equal(result[0].claims[0].url, base.listing_url);
});
test("other source claims retain attribution and disagreement, without duplicating the selected row", () => {
  const earlier = { ...base, status: "sold", source: "bringatrailer", listing_url: "https://bringatrailer.com/listing/example/",
    listed_at: "2024-01-01", timing_belt_status: "Service reported", timing_belt_evidence: "Belt replaced in 2020." };
  const current = { ...base, timing_belt_status: "Service due per listing", timing_belt_evidence: "Timing belt service is due." };
  const item = records(current, [current, earlier])[0];
  assert.equal(item.claims.length, 2);
  assert.equal(item.differs, true);
  assert.equal(item.claims[1].historical, true);
  assert.equal(item.claims[1].listedAt, "2024-01-01");
  assert.equal(item.claims[1].source, "bringatrailer");
});
test("wrong model/year evidence and unsafe links are excluded", () => {
  const claim = { ...base, timing_belt_status: "Service reported", timing_belt_evidence: "Replaced." };
  for (const other of [{ ...claim, model: "LX570" }, { ...claim, year: 2006 },
    { ...claim, listing_url: "javascript:alert(1)" }]) {
    assert.equal(records(base, [other])[0].claims.length, 0);
  }
});
test("LX570 does not imply missing timing-belt service", () => {
  assert.equal(records({ ...base, model: "LX570", year: 2014 }).some(item => item.key === "timing_belt"), false);
});
