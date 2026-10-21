const test = require("node:test");
const assert = require("node:assert/strict");
const { salesFor, mileageBand } = require("../web/deal-comparables.js");
const inventory = require("../web/inventory.json");

test("every published rating exposes precisely its sale count and median", () => {
  const rated = inventory.listings.filter(row => row.deal_quality);
  assert.ok(rated.length > 0);
  for (const row of rated) {
    const sales = salesFor(row, inventory.market_history.sales);
    assert.equal(sales.length, row.deal_comparable_count, row.listing_key);
    const prices = sales.map(sale => sale.sale_price).sort((a, b) => a - b);
    const mid = Math.floor(prices.length / 2);
    const median = prices.length % 2 ? prices[mid] : (prices[mid - 1] + prices[mid]) / 2;
    assert.equal(median, row.deal_median_price, row.listing_key);
    assert.ok(sales.every(sale => /^https:\/\//.test(sale.listing_url)));
  }
});

test("mileage boundaries, missing values, model matching, and year scope match the rating", () => {
  assert.deepEqual([99999, 100000, 149999, 150000, 249999, 250000, null, undefined].map(mileageBand),
    [0, 1, 1, 2, 2, 3, null, null]);
  const row = { model: "LX470", status: "active", category: "retail", asking_price: 20000, mileage: 150000 };
  const sales = [
    { model: "LX470", year: 2007, mileage: 249999, sale_price: 19000, sold_at: "2026-02-01" },
    { year: 2006, mileage: 150000, sale_price: 21000, sold_at: "2026-03-01" },
    { model: "LX570", mileage: 150000, sale_price: 30000 },
    { model: "LX470", mileage: 250000, sale_price: 10000 },
    { model: "LX470", mileage: null, sale_price: 10000 },
    { model: "LX470", mileage: 180000, sale_price: null },
  ];
  assert.deepEqual(salesFor(row, sales).map(sale => sale.sale_price), [21000, 19000]);
  for (const change of [{ mileage: null }, { asking_price: null }, { status: "sold" }, { category: "auction" }])
    assert.deepEqual(salesFor({ ...row, ...change }, sales), []);
});
