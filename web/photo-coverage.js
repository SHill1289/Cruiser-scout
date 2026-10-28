(function (root) {
  function entries(row, listings = []) {
    const valid = row.vehicle_key === "vin:" + row.vin && !(row.quality_flags || "").includes("vin_model_or_year_conflict") && /^vin:[A-HJ-NPR-Z0-9]{17}$/.test(row.vehicle_key || "");
    const donors = valid && row.status === "active" ? listings.filter(other =>
      other.listing_key !== row.listing_key && other.vehicle_key === row.vehicle_key &&
      other.vin === row.vin && other.year === row.year && other.model === row.model &&
      other.status === "active" && !(other.quality_flags || "").includes("vin_model_or_year_conflict")) : [];
    const seen = new Set();
    const candidates = [row, ...donors].flatMap(record => [record.photo_url, ...(record.photo_urls || [])]
      .filter(url => typeof url === "string" && (/^https:\/\//.test(url) || /^photos\/[a-f0-9]{20}\.jpg$/.test(url)))
      .map(url => ({ url, source: record.photo_source || record.source, listing_url: record.photo_source_url || record.listing_url,
        borrowed: record.listing_key !== row.listing_key || Boolean(record.photo_source && record.photo_source !== record.source) })))
      .sort((a, b) => Number(a.url.startsWith("https://retail.photos.vin/")) - Number(b.url.startsWith("https://retail.photos.vin/")))
      .filter(entry => { if (seen.has(entry.url)) return false; seen.add(entry.url); return true; });
    const unrestricted = candidates.filter(entry => !entry.url.startsWith("https://retail.photos.vin/"));
    // Keep a collected gallery even when another source supplies the cover image.
    const gallery = candidates.filter(entry => entry.url.startsWith("https://retail.photos.vin/"));
    return (unrestricted.length && gallery.length < 2 ? unrestricted : candidates).slice(0, 16);
  }
  const api = { entries };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.CruiserPhotoCoverage = api;
})(typeof window !== "undefined" ? window : globalThis);
