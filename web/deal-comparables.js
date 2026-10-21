"use strict";

const CruiserComparables = (() => {
  function mileageBand(miles) {
    if (!Number.isFinite(miles)) return null;
    return miles < 100000 ? 0 : miles < 150000 ? 1 : miles < 250000 ? 2 : 3;
  }
  // The exported sales are already restricted to the rating's 731-day window.
  // Keep this predicate aligned with deal_rating in src/finder.py.
  function salesFor(row, sales) {
    if (row.status !== "active" || row.category !== "retail"
      || !Number.isFinite(row.asking_price) || mileageBand(row.mileage) === null) return [];
    const model = value => value.model === undefined ? "LX470" : value.model;
    return sales.filter(sale => model(sale) === model(row)
      && mileageBand(sale.mileage) === mileageBand(row.mileage)
      && Number.isFinite(sale.sale_price))
      .sort((a, b) => String(b.sold_at || "").localeCompare(String(a.sold_at || "")));
  }
  return { mileageBand, salesFor };
})();

if (typeof module !== "undefined" && module.exports) module.exports = CruiserComparables;
