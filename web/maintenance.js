/* Listing claims remain attributed to their original source, including older ads. */
(function (root) {
  const topics = [
    ["timing_belt", "Timing belt"], ["service_records", "Service records"],
    ["ahc", "AHC suspension"], ["rust", "Rust / underbody"],
    ["modifications", "Modifications"], ["navigation", "Navigation"],
  ];
  function applicable(row, key) {
    // The tracked LX570 uses a timing chain; do not imply missing belt service.
    return key !== "timing_belt" || row.model !== "LX570";
  }
  function records(row, listings = [row]) {
    return topics.filter(([key]) => applicable(row, key)).map(([key, label]) => {
      const seen = new Set();
      const claims = [row, ...listings].filter(source =>
        source.model === row.model && Number(source.year) === Number(row.year)
      ).flatMap(source => {
        const status = String(source[key + "_status"] || "").trim();
        const evidence = String(source[key + "_evidence"] || "").trim();
        let url;
        try { url = new URL(source.listing_url); } catch { return []; }
        if (!status || !evidence || !["https:", "http:"].includes(url.protocol)) return [];
        const identity = JSON.stringify([status, evidence, url.href]);
        if (seen.has(identity)) return [];
        seen.add(identity);
        return [{ status, evidence, url: url.href, source: source.source || "listing",
          listedAt: source.listed_at || "", lastSeen: source.last_seen || "",
          historical: source.status !== "active" }];
      });
      return { key, label, claims, differs: new Set(claims.map(claim => claim.status)).size > 1 };
    }).sort((a, b) => Number(Boolean(b.claims.length)) - Number(Boolean(a.claims.length)));
  }
  const api = { records, applicable };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.CruiserMaintenance = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
