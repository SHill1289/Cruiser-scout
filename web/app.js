"use strict";

const ui = {
  listings: document.querySelector("#listings"), empty: document.querySelector("#empty"),
  resultCount: document.querySelector("#result-count"), updated: document.querySelector("#updated"),
  total: document.querySelector("#total-count"), years: document.querySelector("#year-count"),
  sources: document.querySelector("#source-count"), disclaimer: document.querySelector("#disclaimer"),
  color: document.querySelector("#color"), summary: document.querySelector("#summary-strip"),
  medianPrice: document.querySelector("#median-price"), medianMileage: document.querySelector("#median-mileage"),
  sourceHealth: document.querySelector("#source-health"),
  collectionIndicator: document.querySelector("#collection-indicator"),
  collectionNotice: document.querySelector("#collection-notice"),
  marketBands: document.querySelector("#market-bands"), marketCount: document.querySelector("#market-count"),
  marketPeriod: document.querySelector("#market-period"), marketYear: document.querySelector("#market-year"),
  marketModel: document.querySelector("#market-model"),
  marketSource: document.querySelector("#market-source"),
  form: document.querySelector("#filters"), filterToggle: document.querySelector("#filter-toggle"),
  photoDialog: document.querySelector("#photo-dialog"), photoLarge: document.querySelector("#photo-large"),
  photoError: document.querySelector("#photo-error"), photoCount: document.querySelector("#photo-count"),
  photoTitle: document.querySelector("#photo-title"), photoSource: document.querySelector("#photo-source"),
  photoPrevious: document.querySelector("#photo-previous"), photoNext: document.querySelector("#photo-next"),
  distanceStatus: document.querySelector("#distance-status"), mapMarkers: document.querySelector("#map-markers"),
  mapStatus: document.querySelector("#map-status"), mapViewport: document.querySelector(".map-viewport")
};

let inventory = [];
let vehicles = [];
let marketSales = [];
let colorReference = { exterior: [], interior_by_year: {} };
let generatedAt = new Date();
let activeGallery = null;
let zipPoints = null;
let zipLoad = null;
let origin = null;
const money = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
const integer = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
const controls = ["search", "model", "status", "owners", "accidents", "price", "mileage", "zip", "radius", "source", "sort"]
  .reduce((all, id) => ({ ...all, [id]: document.querySelector(`#${id}`) }), {});
let sourceHealth = [];
let latestChanges = [];
let viewMode = localStorage.getItem("cruiser-scout-view") === "table" ? "table" : "cards";
const watchlistKey = "cruiser-scout-watchlist-v1";
let savedVehicles = new Set();
try { savedVehicles = new Set(JSON.parse(localStorage.getItem(watchlistKey) || "[]")); } catch { savedVehicles = new Set(); }
let mobileFilterLayout = window.matchMedia("(max-width: 700px)").matches;

function vehicleName(row) { return `${row.make || "Lexus"} ${row.model || "LX470"}`; }
function value(row, key) { return row[key] ?? ""; }
function saleState(row) {
  if (row.status === "sold") return "sold";
  if (row.category === "auction" && row.status === "active") return "live-auction";
  if (row.category === "auction" && row.status === "ended" && row.current_bid != null) return "bid-not-met";
  if (row.category === "auction" && row.status === "ended") return "auction-ended";
  if (row.status === "active") return "for-sale";
  return "other";
}
function saleStateLabel(row) {
  return ({ "for-sale": "For sale", "live-auction": "Live auction", sold: "Sold",
    "bid-not-met": "Bid not met", "auction-ended": "Auction ended", other: "Status unknown" })[saleState(row)];
}
function listingPrice(row) { return row.sold_price ?? row.asking_price ?? row.current_bid ?? null; }
function priceLabel(row) {
  const amount = listingPrice(row);
  if (amount == null) return "Price unavailable";
  if (row.status === "sold") return `${money.format(amount)} sold`;
  if (row.category === "auction" && row.status === "ended") return `${money.format(amount)} high bid`;
  if (row.category === "auction") return `${money.format(amount)} current bid`;
  return money.format(amount);
}
function priceObservations(row) {
  if (row.category !== "retail" || !Array.isArray(row.price_history)) return [];
  return row.price_history.filter(point => Number.isFinite(point.asking_price) && Number.isFinite(Date.parse(point.observed_at)));
}
function priceDrops(row) {
  const points = priceObservations(row);
  return points.slice(1).flatMap((point, index) => point.asking_price < points[index].asking_price
    ? [{ observedAt: point.observed_at, previous: points[index].asking_price, current: point.asking_price,
      amount: points[index].asking_price - point.asking_price }] : []);
}
function latestReduction(row) {
  if (row.status !== "active" || row.category !== "retail") return null;
  const points = priceObservations(row);
  const drops = priceDrops(row);
  const latest = drops.at(-1);
  return latest && points.at(-1).observed_at === latest.observedAt && row.asking_price === latest.current ? latest : null;
}
function median(numbers) {
  const values = numbers.filter(Number.isFinite).sort((a, b) => a - b);
  if (!values.length) return null;
  const middle = Math.floor(values.length / 2);
  return values.length % 2 ? values[middle] : (values[middle - 1] + values[middle]) / 2;
}
function average(numbers) { return numbers.length ? numbers.reduce((total, number) => total + number, 0) / numbers.length : null; }
function milesBetween(a, b) {
  const radians = degrees => degrees * Math.PI / 180;
  const dLat = radians(b[0] - a[0]);
  const dLon = radians(b[1] - a[1]);
  const term = Math.sin(dLat / 2) ** 2 + Math.cos(radians(a[0])) * Math.cos(radians(b[0])) * Math.sin(dLon / 2) ** 2;
  return 3958.8 * 2 * Math.asin(Math.min(1, Math.sqrt(term)));
}
function rowPoint(row) {
  return Number.isFinite(Number(row.latitude)) && Number.isFinite(Number(row.longitude)) &&
    row.latitude != null && row.longitude != null ? [Number(row.latitude), Number(row.longitude)] : null;
}
function distanceTo(row) { const point = rowPoint(row); return origin && point ? milesBetween(origin, point) : null; }
function mapPoint(lat, lon, state = "") {
  if (state === "AK" || state === "HI") return null;
  const point = [38 + (lon + 125) * (924 / 59), 32 + (50 - lat) * (510 / 26)];
  return point[0] >= 0 && point[0] <= 1000 && point[1] >= 0 && point[1] <= 550 ? point : null;
}
function svgNode(tag, attributes = {}) {
  const node = document.createElementNS("http://www.w3.org/2000/svg", tag);
  for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, String(value));
  return node;
}
async function updateOrigin() {
  const zip = controls.zip.value.replace(/\D/g, "").slice(0, 5);
  if (zip !== controls.zip.value) controls.zip.value = zip;
  origin = null;
  ui.distanceStatus.classList.remove("error");
  if (!zip) { ui.distanceStatus.textContent = "Enter a ZIP to see approximate straight-line distances."; render(); return; }
  if (zip.length < 5) { ui.distanceStatus.textContent = "Enter all five digits to calculate distances."; render(); return; }
  ui.distanceStatus.textContent = "Looking up ZIP area…";
  try {
    if (!zipLoad) zipLoad = fetch("zip-centroids.json").then(response => {
      if (!response.ok) throw new Error(`ZIP reference returned ${response.status}`);
      return response.json();
    });
    zipPoints = await zipLoad;
    if (controls.zip.value !== zip) return;
    origin = zipPoints[zip] || null;
    if (origin) ui.distanceStatus.textContent = `Approximate straight-line distance from ZIP ${zip}.`;
    else { ui.distanceStatus.textContent = "That ZIP is not in the Census ZIP-area reference. Try a nearby ZIP."; ui.distanceStatus.classList.add("error"); }
  } catch (error) {
    if (controls.zip.value !== zip) return;
    zipLoad = null;
    ui.distanceStatus.textContent = "Distance lookup is unavailable right now. Listings remain visible.";
    ui.distanceStatus.classList.add("error");
    console.error(error);
  }
  render();
}
function text(tag, className, content) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  node.textContent = content;
  return node;
}
function galleryUrls(row) {
  return [...new Set([row.photo_url, ...(Array.isArray(row.photo_urls) ? row.photo_urls : [])]
    .filter(url => typeof url === "string" && (/^https:\/\//.test(url) || /^photos\/[a-f0-9]{20}\.jpg$/.test(url))))].slice(0, 8);
}
function showLargePhoto() {
  if (!activeGallery) return;
  const { row, urls, index } = activeGallery;
  ui.photoLarge.hidden = false;
  ui.photoError.hidden = true;
  ui.photoLarge.src = urls[index];
  ui.photoLarge.alt = "Photo " + (index + 1) + " of " + urls.length + " for " + row.year + " " + vehicleName(row);
  ui.photoCount.textContent = "Photo " + (index + 1) + " of " + urls.length;
  document.querySelector("#photo-hint").hidden = urls.length < 2;
  document.querySelectorAll("#photo-thumbnails button").forEach((button, position) => {
    button.setAttribute("aria-pressed", String(position === index));
  });
  ui.photoTitle.textContent = row.year + " " + vehicleName(row) + " · " + (row.seller || row.source);
  ui.photoSource.href = row.listing_url;
  ui.photoPrevious.hidden = ui.photoNext.hidden = urls.length < 2;
}
function stepLargePhoto(step) {
  if (!activeGallery) return;
  activeGallery.index = (activeGallery.index + step + activeGallery.urls.length) % activeGallery.urls.length;
  showLargePhoto();
}
function openGallery(row, urls, index) {
  if (!urls.length) return;
  activeGallery = { row, urls, index };
  const thumbnails = document.querySelector("#photo-thumbnails");
  thumbnails.hidden = urls.length < 2;
  thumbnails.replaceChildren(...urls.map((url, position) => {
    const button = text("button", "photo-thumbnail", "");
    button.type = "button";
    button.setAttribute("aria-label", `Show photo ${position + 1} of ${urls.length}`);
    const preview = document.createElement("img");
    preview.src = url;
    preview.alt = "";
    preview.loading = "lazy";
    preview.draggable = false;
    preview.addEventListener("error", () => { preview.hidden = true; });
    button.append(preview, text("span", "", String(position + 1)));
    button.addEventListener("click", () => {
      if (!activeGallery) return;
      activeGallery.index = position;
      showLargePhoto();
    });
    return button;
  }));
  showLargePhoto();
  ui.photoDialog.showModal();
}
CruiserPhotos.bindSwipe(document.querySelector(".photo-stage"), stepLargePhoto);
ui.photoPrevious.addEventListener("click", () => stepLargePhoto(-1));
ui.photoNext.addEventListener("click", () => stepLargePhoto(1));
document.querySelector("#photo-close").addEventListener("click", () => ui.photoDialog.close());
ui.photoDialog.addEventListener("close", () => { activeGallery = null; });
ui.photoDialog.addEventListener("click", event => { if (event.target === ui.photoDialog) ui.photoDialog.close(); });
ui.photoDialog.addEventListener("keydown", event => {
  if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
    event.preventDefault();
    stepLargePhoto(event.key === "ArrowLeft" ? -1 : 1);
  }
});
ui.photoLarge.addEventListener("error", () => { ui.photoLarge.hidden = true; ui.photoError.hidden = false; });
function makeMetric(main, label) {
  const node = text("div", "metric", "");
  node.append(text("strong", "", main), text("span", "", label));
  return node;
}
function resolveFactoryColor(kind, raw, year, model = "LX470") {
  return CruiserFilters.color(colorReference, kind, raw, year, model);
}
function makeColorFact(kind, raw, year, model = "LX470") {
  const color = resolveFactoryColor(kind, raw, year, model);
  const fact = text("span", "color-fact", "");
  const swatch = text("span", color.swatch ? "color-swatch" : "color-swatch color-unknown", "");
  if (color.swatch) swatch.style.background = color.swatch;
  swatch.setAttribute("aria-hidden", "true");
  const label = kind === "exterior" ? "Exterior" : "Interior";
  const detail = text("span", "color-detail", "");
  detail.append(text("small", "", label), text("strong", "", color.name));
  if (color.code) detail.append(text("em", "", color.code));
  fact.append(swatch, detail);
  fact.title = color.factory
    ? color.confidence === "family"
      ? `Marketplace reported ${color.reported}. Grouped with ${color.name} using the ${model} ${year} factory palette; the truck's exact paint is unverified. Swatch is approximate.`
      : `Marketplace reported ${color.reported}. ${color.name} is a ${model} ${year} factory color${color.code ? ` (catalog code ${color.code})` : ""}; the truck's ${kind === "exterior" ? "paint code" : "interior color"} is unverified. Swatch is approximate.`
    : color.reported ? `Marketplace color: ${color.reported}. No supported factory match; exact paint is unverified.` : `${label} color unavailable.`;
  return fact;
}
function ownerGroup(row) {
  const owners = String(row.owners || "").trim();
  if (owners === "1") return "1";
  if (/^[2-9]\d*$/.test(owners) || /multiple/i.test(owners)) return "multiple";
  return "unknown";
}
function ownerLabel(row) {
  const owners = String(row.owners || "").trim();
  if (owners === "1") return "1 owner";
  if (/^[2-9]\d*$/.test(owners)) return `${owners} owners`;
  if (/multiple/i.test(owners)) return "Multiple owners";
  return "Owners unverified";
}
function accidentGroup(row) {
  if (["none", "reported", "unavailable"].includes(row.accident_category)) return row.accident_category;
  const label = String(row.accident_history || "").trim().toLowerCase();
  if (label === "no reported accidents") return "none";
  if (/\b\d+ reported accidents?\b/.test(label) || label.includes("seller discloses prior accident") || label === "accident reported") return "reported";
  return "unavailable";
}
function formatDate(raw) {
  if (!raw) return "Update time unavailable";
  const date = new Date(raw);
  return `Updated ${date.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })} at ${date.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZoneName: "short" })}`;
}
function formatMoment(raw) {
  if (!raw) return "time unavailable";
  const date = new Date(raw);
  return `${date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}, ${date.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZoneName: "short" })}`;
}
function formatDay(raw) {
  if (!raw) return "Unavailable";
  const date = new Date(/^\d{4}-\d{2}-\d{2}$/.test(raw) ? `${raw}T12:00:00` : raw);
  if (Number.isNaN(date.getTime())) return "Unavailable";
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}
function listingDates(row) {
  const dates = text("div", "listing-dates", "");
  const listed = text("p", "date-fact", "");
  listed.append(text("span", "", "Listed"), text("strong", "", formatDay(row.listed_at)));
  if (row.listed_at && row.listed_at_is_estimated) listed.append(text("small", "", "Estimated from days on market"));
  const added = text("p", "date-fact", "");
  added.append(text("span", "", "Added to Finder"), text("strong", "", formatDay(row.first_seen)));
  const verified = text("p", "date-fact", "");
  verified.append(text("span", "", row.status === "active" ? "Last verified for sale" : "Last observed"),
    text("strong", "", formatMoment(row.last_seen)));
  dates.append(listed, added, verified);
  return dates;
}
function freshnessLabel(row) {
  if (row.status !== "active") return "";
  if (Number(row.missing_checks || 0) > 0) return "Not found in latest search";
  const seen = Date.parse(row.last_seen || "");
  if (!Number.isFinite(seen)) return "Verification unknown";
  if (Date.now() - seen > 24 * 60 * 60 * 1000) return "Stale listing";
  return "";
}
function statusTiming(row) {
  if (saleState(row) === "live-auction") return `Ends ${formatMoment(row.auction_ends_at)} · bid observed ${formatMoment(row.bid_observed_at)}`;
  if (saleState(row) === "bid-not-met") return `Auction ended ${formatMoment(row.auction_ends_at)} · high bid observed ${formatMoment(row.bid_observed_at)}`;
  if (saleState(row) === "auction-ended") return `Auction ended ${formatMoment(row.auction_ends_at)}`;
  if (saleState(row) === "sold") return `Sale recorded ${formatMoment(row.last_seen)}`;
  return `Last seen for sale ${formatMoment(row.last_seen)}`;
}
function dealBadge(row) {
  const labels = { great: "Great deal", fair: "Fair deal", bad: "Bad deal" };
  if (!labels[row.deal_quality]) return null;
  const badge = text("button", `deal-rating deal-${row.deal_quality} deal-comparables-button`, `${labels[row.deal_quality]} · View ${row.deal_comparable_count} sales`);
  badge.type = "button";
  badge.setAttribute("aria-haspopup", "dialog");
  badge.addEventListener("click", () => openDealComparables(row));
  const difference = Number(row.deal_percent_vs_median);
  const comparison = difference === 0 ? "matches" : `${Math.abs(difference)}% ${difference < 0 ? "below" : "above"}`;
  badge.title = `Asking price ${comparison} the ${money.format(row.deal_median_price)} median of ${row.deal_comparable_count} completed sales in the ${row.deal_mileage_band} mileage range. Price comparison does not account for condition, maintenance or modifications.`;
  badge.setAttribute("aria-label", `View comparable sales for ${row.year} ${vehicleName(row)}. ${labels[row.deal_quality]}. ${badge.title}`);
  return badge;
}

function openDealComparables(row) {
  const dialog = document.querySelector("#comparables-dialog");
  const holder = document.querySelector("#comparables-content");
  const sales = CruiserComparables.salesFor(row, marketSales);
  document.querySelector("#comparables-title").textContent = `Comparable sales · ${row.year} ${vehicleName(row)}`;
  const summary = text("div", "comparables-summary", "");
  summary.append(researchFact("Asking price", money.format(row.asking_price)),
    researchFact("Median sale price", money.format(row.deal_median_price)),
    researchFact("Comparable sales", String(row.deal_comparable_count)),
    researchFact("Mileage band", row.deal_mileage_band));
  const difference = Number(row.deal_percent_vs_median);
  const comparison = difference === 0 ? "matches the median" : `is ${Math.abs(difference)}% ${difference < 0 ? "below" : "above"} the median`;
  const explanation = text("p", "", `This asking price ${comparison}. The rating uses completed ${row.model || "LX470"} sales in this mileage band from the two-year inventory snapshot, updated ${formatMoment(generatedAt)}. All tracked model years are included.`);
  const method = text("p", "comparables-method", "Great: at least 15% below the median. Fair: less than 15% below through 15% above. Bad: more than 15% above. Percentages are rounded to whole numbers. At least three sales are required. This price comparison does not adjust for model year, condition, maintenance, modifications, or fees.");
  holder.replaceChildren(summary, explanation, method);
  if (sales.length !== row.deal_comparable_count || median(sales.map(sale => sale.sale_price)) !== row.deal_median_price) {
    holder.append(text("p", "empty", "The sales data does not match this rating. Refresh the page to load a consistent inventory snapshot."));
  } else {
    const scroll = text("div", "comparables-scroll", "");
    scroll.tabIndex = 0;
    scroll.setAttribute("role", "region");
    scroll.setAttribute("aria-label", "Comparable completed sales");
    const table = document.createElement("table");
    table.className = "comparables-table";
    table.append(text("caption", "", "Sales used in this rating, newest first"));
    const head = document.createElement("thead");
    const headings = document.createElement("tr");
    for (const label of ["Vehicle", "Sold", "Mileage", "Sale price", "Source"]) {
      const cell = text("th", "", label);
      cell.scope = "col";
      headings.append(cell);
    }
    head.append(headings);
    const body = document.createElement("tbody");
    for (const sale of sales) {
      const line = document.createElement("tr");
      line.append(text("td", "", `${sale.year || "Year unknown"} ${vehicleName(sale)}`),
        text("td", "", formatDay(sale.sold_at)),
        text("td", "", `${sale.mileage_is_approximate ? "≈ " : ""}${integer.format(sale.mileage)} mi`),
        text("td", "", money.format(sale.sale_price)));
      const source = document.createElement("td");
      const link = text("a", "", `View sale · ${sale.source || "Source"} ↗`);
      link.href = sale.listing_url;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.setAttribute("aria-label", `View ${sale.year} ${vehicleName(sale)} sale on ${sale.source || "source"}, ${formatDay(sale.sold_at)}`);
      source.append(link);
      line.append(source);
      body.append(line);
    }
    table.append(head, body);
    scroll.append(table);
    holder.append(scroll);
  }
  dialog.showModal();
}

function rustLocationBadge(row) {
  const evidence = row.rust_location || {};
  const current = evidence.current_state;
  const also = evidence.also_listed_states || [];
  const previous = evidence.previously_listed_states || [];
  if (!current && !also.length && !previous.length) return null;
  const parts = [];
  if (current) parts.push(`Currently advertised in ${current}`);
  if (also.length) parts.push(`Also advertised in ${also.join(", ")}`);
  if (previous.length) parts.push(`Previously advertised in ${previous.join(", ")}`);
  const labels = [];
  if (current) labels.push(`Listed ${current}`);
  if (also.length) labels.push(`Also listed ${also.join(", ")}`);
  if (previous.length) labels.push(`Previously listed ${previous.join(", ")}`);
  const badge = text("span", "rust-location", `Rust check · ${labels.join(" · ")}`);
  badge.title = `${parts.join("; ")}. Based on marketplace listing locations only; this does not establish registration history or the presence of rust. Inspect the underside before purchase.`;
  badge.setAttribute("aria-label", badge.title);
  badge.tabIndex = 0;
  return badge;
}

function reportedExtras(row) {
  const extras = String(row.reported_extras || "").split(";").filter(Boolean);
  if (!extras.length) return null;
  const panel = document.createElement("details");
  panel.className = "reported-extras";
  panel.append(text("summary", "", `Listing-reported extras (${extras.length})`));
  const content = text("div", "reported-extras-content", "");
  const tags = text("div", "reported-extras-tags", "");
  tags.append(...extras.map(extra => text("span", "reported-extra", extra)));
  content.append(tags);
  const source = text("p", "reported-extras-source", "Marketplace tags can be wrong or describe aftermarket additions. Confirm equipment in photos or with the seller. ");
  const link = text("a", "", `View on ${row.source}`);
  link.href = row.listing_url;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  source.append(link);
  content.append(source);
  panel.append(content);
  return panel;
}

function conditionRecords(row) {
  const topics = [
    ["timing_belt", "Timing belt"], ["ahc", "AHC"], ["rust", "Rust"],
    ["navigation", "Navigation"], ["service_records", "Service records"],
    ["modifications", "Modifications"],
  ];
  const sourced = topics.filter(([key]) => row[`${key}_status`] && row[`${key}_evidence`]).length;
  const panel = document.createElement("details");
  panel.className = "condition-records";
  panel.append(text("summary", "", `Maintenance & condition · ${sourced} of 6 sourced`));
  const content = text("div", "condition-records-content", "");
  for (const [key, label] of topics) {
    const status = row[`${key}_status`] && row[`${key}_evidence`] ? row[`${key}_status`] : "Unknown";
    const item = text("div", "condition-record", "");
    item.append(text("span", "condition-label", label), text("strong", status === "Unknown" ? "condition-unknown" : "", status));
    if (status !== "Unknown") item.append(text("p", "condition-evidence", row[`${key}_evidence`]));
    content.append(item);
  }
  const source = text("p", "condition-disclaimer", "Statements from the listing, not an inspection. Confirm records and condition with the seller. ");
  const link = text("a", "", "View source");
  link.href = row.listing_url;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  source.append(link);
  content.append(source);
  panel.append(content);
  return panel;
}

function listingGroups(rows, indexed = []) {
  const byKey = new Map(rows.map(row => [row.listing_key, row]));
  if (indexed.length) return indexed.map(group => ({
    vehicleKey: group.vehicle_key,
    listings: group.listing_keys.map(key => byKey.get(key)).filter(Boolean),
  })).filter(group => group.listings.length);
  const groups = new Map();
  for (const row of rows) {
    const key = row.vehicle_key || `listing:${row.listing_key}`;
    if (!groups.has(key)) groups.set(key, { vehicleKey: key, listings: [] });
    groups.get(key).listings.push(row);
  }
  return [...groups.values()];
}

function otherListings(group) {
  if (group.listings.length < 2) return null;
  const panel = document.createElement("details");
  panel.className = "duplicate-listings";
  panel.append(text("summary", "", `${group.listings.length} listings for this truck · VIN match`));
  const content = text("div", "duplicate-listings-content", "");
  const categories = new Set(group.listings.map(accidentGroup));
  if (categories.has("reported") && categories.has("none"))
    content.append(text("p", "duplicate-conflict", "Accident history differs between sources. Check both reports."));
  else if (categories.has("reported"))
    content.append(text("p", "duplicate-conflict", "An accident is reported by one source. Check its history report."));
  for (const listing of group.listings) {
    const offer = text("div", "duplicate-offer", "");
    const facts = text("div", "duplicate-offer-facts", "");
    facts.append(text("strong", "", `${listing.source} · ${saleStateLabel(listing)}`),
      text("span", "", `${priceLabel(listing)} · ${listing.mileage == null ? "Mileage unknown" : `${integer.format(listing.mileage)} mi`}`),
      text("small", "", `${[listing.city, listing.state].filter(Boolean).join(", ") || "Location unknown"} · ${ownerLabel(listing)} · ${listing.accident_history || "History unavailable"}`));
    const link = text("a", "", "View source ↗");
    link.href = listing.listing_url;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    offer.append(facts, link);
    content.append(offer);
  }
  panel.append(content);
  return panel;
}

function renderCard(row, group) {
  const card = document.createElement("article");
  card.className = "listing";
  card.id = "vehicle-" + String(group.vehicleKey).replace(/[^a-zA-Z0-9_-]/g, "-");
  const photos = galleryUrls(row);
  const media = text("div", photos.length ? "listing-media" : "listing-media photo-missing", "");
  if (photos.length) {
    let index = 0;
    const failed = new Set();
    const trigger = text("button", "photo-viewer", "");
    trigger.type = "button";
    trigger.setAttribute("aria-label", "View photos for " + row.year + " " + vehicleName(row) + " on " + row.source);
    const photo = document.createElement("img");
    photo.alt = `${row.year} ${row.exterior_color || ""} ${vehicleName(row)}`.replace(/\s+/g, " ").trim();
    photo.loading = "lazy";
    photo.decoding = "async";
    photo.referrerPolicy = "no-referrer";
    const counter = text("span", "photo-counter", "");
    const show = next => {
      index = (next + photos.length) % photos.length;
      photo.dataset.index = String(index);
      photo.src = photos[index];
      counter.textContent = "Photo " + (index + 1) + " of " + photos.length;
    };
    photo.addEventListener("error", () => {
      failed.add(Number(photo.dataset.index));
      const next = photos.findIndex((_, position) => !failed.has(position));
      if (next >= 0) show(next);
      else {
        trigger.remove();
        media.classList.add("photo-missing");
        media.prepend(text("span", "photo-placeholder", row.model || "LX470"));
        counter.remove();
        media.querySelectorAll(".photo-step").forEach(button => button.remove());
      }
    });
    trigger.addEventListener("click", () => {
      const available = photos.filter((_, position) => !failed.has(position));
      openGallery(row, available, Math.max(0, available.indexOf(photos[index])));
    });
    trigger.append(photo);
    photo.draggable = false;
    if (photos.length > 1) CruiserPhotos.bindSwipe(trigger, direction => show(index + direction));
    media.append(trigger);
    if (photos.length > 1) {
      const step = (direction, label) => {
        const button = text("button", "photo-step photo-" + label, direction < 0 ? "‹" : "›");
        button.type = "button";
        button.setAttribute("aria-label", (direction < 0 ? "Previous" : "Next") + " photo for " + row.year + " " + vehicleName(row));
        button.addEventListener("click", () => show(index + direction));
        media.append(button);
      };
      step(-1, "previous");
      step(1, "next");
      media.append(counter);
    }
    show(0);
  } else {
    media.append(text("span", "photo-placeholder", row.model || "LX470"));
  }
  media.append(text("span", "year-badge", String(row.year)));
  card.append(media);

  const identity = text("div", "identity", "");
  const stateRow = text("div", "listing-state-row", "");
  stateRow.append(text("span", "model-tag", row.model || "LX470"));
  stateRow.append(text("span", `sale-state state-${saleState(row)}`, saleStateLabel(row)));
  const freshness = freshnessLabel(row);
  if (freshness) {
    const badge = text("span", "freshness-badge", freshness);
    badge.title = `Last verified for sale ${formatMoment(row.last_seen)}${row.last_checked ? `; source last checked ${formatMoment(row.last_checked)}` : ""}. Availability is not seller-confirmed.`;
    stateRow.append(badge);
  }
  if (group.listings.length > 1) stateRow.append(text("span", "duplicate-badge", `${group.listings.length} listings · same VIN`));
  const accidentReports = new Set(group.listings.map(accidentGroup));
  if (accidentReports.has("reported") && accidentReports.has("none"))
    stateRow.append(text("span", "duplicate-conflict-badge", "History differs by source"));
  else if (accidentReports.has("reported") && accidentGroup(row) !== "reported")
    stateRow.append(text("span", "duplicate-conflict-badge", "Accident reported on another source"));
  const rating = dealBadge(row);
  if (rating) stateRow.append(rating);
  const reduction = latestReduction(row);
  if (reduction) {
    const badge = text("span", "price-drop-badge", `Price down ${money.format(reduction.amount)}`);
    badge.title = `Asking price observed at ${money.format(reduction.previous)} before ${money.format(reduction.current)} on ${formatMoment(reduction.observedAt)}. Change date is when Scout observed it.`;
    stateRow.append(badge);
  }
  const rustLocation = rustLocationBadge(row);
  if (rustLocation) stateRow.append(rustLocation);
  identity.append(stateRow);
  const exterior = resolveFactoryColor("exterior", row.exterior_color, row.year, row.model);
  const title = text("h3", "vehicle-title", `${row.year} ${vehicleName(row)}${row.trim ? ` ${row.trim}` : ""}`);
  identity.append(title);
  identity.append(text("p", "listing-mileage-summary", row.mileage == null
    ? "Mileage unavailable" : `${integer.format(row.mileage)} mi`));
  const place = [row.city, row.state].filter(Boolean).join(", ") || "Location unavailable";
  identity.append(text("p", "vehicle-meta", `${place} \u00b7 ${row.seller || "Seller unknown"} · ${row.source}`));
  const distance = distanceTo(row);
  if (distance != null) identity.append(text("p", "vehicle-meta location-distance", `About ${integer.format(Math.round(distance))} mi from your ZIP · straight line`));
  identity.append(text("p", "vehicle-meta timing", statusTiming(row)));
  const colors = text("div", "color-pair", "");
  colors.append(makeColorFact("exterior", row.exterior_color, row.year, row.model), makeColorFact("interior", row.interior_color, row.year, row.model));
  identity.append(colors);
  const extras = reportedExtras(row);
  if (extras) identity.append(extras);
  identity.append(conditionRecords(row));
  card.append(identity);

  const price = makeMetric(priceLabel(row), row.status === "sold" ? "Final recorded price" : row.category === "auction" ? "Auction price" : "Asking price");
  price.classList.add("price-metric");
  const mileage = makeMetric(row.mileage == null ? "Mileage unavailable" : `${integer.format(row.mileage)} mi`, "Mileage");
  mileage.classList.add("mileage-metric");
  card.append(price, mileage);
  card.append(listingDates(row));

  const history = text("div", "history", "");
  const ownerRow = group.listings.find(listing => ownerGroup(listing) !== "unknown" && listing.owners_verified_at) || row;
  const ownerTag = text("span", ownerGroup(ownerRow) === "1" ? "tag good" : "tag", ownerLabel(ownerRow));
  if (ownerGroup(ownerRow) !== "unknown" && ownerRow.owners_verified_at) {
    ownerTag.title = `Verified ${ownerRow.owners_verified_at}${ownerRow.owners_source ? ` via ${ownerRow.owners_source}` : ""}`;
  }
  history.append(ownerTag);
  const accidentRow = group.listings.find(listing => accidentGroup(listing) === "reported") || row;
  const accident = accidentGroup(accidentRow);
  const accidentTag = text("span", accident === "none" ? "tag good" : accident === "reported" ? "tag alert" : "tag",
    accident === "unavailable" ? "History unavailable" : accidentRow.accident_history);
  if (accident === "reported" && accidentRow.accident_history)
    accidentTag.title = `${accidentRow.accident_history} · ${accidentRow.source}`;
  history.append(accidentTag);
  card.append(history);

  const link = text("a", "open-link", "");
  link.append(text("span", "open-link-label", "View listing"), text("span", "open-link-arrow", "\u2197"));
  link.href = row.listing_url;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  link.setAttribute("aria-label", `Open ${row.year} ${vehicleName(row)} listing on ${row.source}`);
  const actions = text("div", "listing-actions", "");
  const research = text("button", "research-button", "Research");
  research.type = "button";
  research.addEventListener("click", () => openResearch(group));
  const save = text("button", "save-button", savedVehicles.has(group.vehicleKey) ? "★ Saved" : "☆ Save");
  save.type = "button";
  save.setAttribute("aria-pressed", String(savedVehicles.has(group.vehicleKey)));
  save.setAttribute("aria-label", (savedVehicles.has(group.vehicleKey) ? "Remove from" : "Save to") + " watchlist: " + row.year + " " + vehicleName(row));
  save.addEventListener("click", () => toggleSaved(group.vehicleKey));
  actions.append(research, save, link);
  card.append(actions);
  card.append(comparisonButton(row, group));
  const others = otherListings(group);
  if (others) card.append(others);
  return card;
}

function renderColorOptions(selected = new Set(selectedColors().map(input => input.value))) {
  document.querySelector("#color-options").replaceChildren(...CruiserFilters.colorOptions(inventory, colorReference, controls.model.value)
    .map(([key, label]) => {
      const option = text("label", "color-option", "");
      const input = document.createElement("input");
      input.type = "checkbox";
      input.name = "color";
      input.value = key;
      input.checked = selected.has(key);
      option.append(input, text("span", "", label));
      return option;
    }));
}

function selectedColors() {
  return [...ui.color.querySelectorAll("input:checked")];
}

const searchIndex = new WeakMap();
let filterQuery = "";
let filterColors = new Set();
function matches(row) {
  const query = filterQuery;
  let indexed = searchIndex.get(row);
  if (!indexed) {
  const factoryExterior = resolveFactoryColor("exterior", row.exterior_color, row.year, row.model);
  const factoryInterior = resolveFactoryColor("interior", row.interior_color, row.year, row.model);
  const haystack = [vehicleName(row), row.city, row.state, row.seller, row.vin, row.exterior_color, row.interior_color,
    factoryExterior.name, factoryInterior.name, row.source].join(" ").toLowerCase();
  indexed = { haystack, color: factoryExterior.key };
  searchIndex.set(row, indexed);
  }
  const amount = listingPrice(row);
  return (!query || indexed.haystack.includes(query))
    && (!controls.model.value || CruiserFilters.model(row.model || "LX470") === controls.model.value)
    && (!controls.source.value || CruiserFilters.source(row.source) === controls.source.value)
    && (!controls.status.value || saleState(row) === controls.status.value)
    && (!filterColors.size || filterColors.has(indexed.color))
    && (!controls.owners.value || ownerGroup(row) === controls.owners.value)
    && (!controls.accidents.value || accidentGroup(row) === controls.accidents.value)
    && (!controls.price.value || (amount != null && amount <= Number(controls.price.value)))
    && (!controls.mileage.value || (row.mileage != null && row.mileage <= Number(controls.mileage.value)))
    && (!origin || !controls.radius.value || (distanceTo(row) != null && distanceTo(row) <= Number(controls.radius.value)));
}

function sortRows(rows) {
  const missing = Number.MAX_SAFE_INTEGER;
  const listedTime = row => {
    const time = Date.parse(String(row.listed_at || ""));
    return Number.isFinite(time) ? time : -Infinity;
  };
  const strategies = {
    "price-asc": (a, b) => (listingPrice(a) ?? missing) - (listingPrice(b) ?? missing),
    "price-desc": (a, b) => (listingPrice(b) ?? -1) - (listingPrice(a) ?? -1),
    "mileage-asc": (a, b) => (a.mileage ?? missing) - (b.mileage ?? missing),
    "listed-newest": (a, b) => listedTime(b) - listedTime(a) || String(b.first_seen || "").localeCompare(String(a.first_seen || "")),
    "newest": (a, b) => String(b.first_seen).localeCompare(String(a.first_seen)),
    "price-drop-newest": (a, b) => (Date.parse(latestReduction(b)?.observedAt || "") || 0) - (Date.parse(latestReduction(a)?.observedAt || "") || 0)
      || listedTime(b) - listedTime(a),
    "distance-asc": (a, b) => (distanceTo(a) ?? missing) - (distanceTo(b) ?? missing)
  };
  return rows.sort(strategies[controls.sort.value === "distance-asc" && !origin ? "price-asc" : controls.sort.value]);
}

function renderMap(rows, revealCard) {
  const locations = [];
  rows.forEach((row, index) => {
    const point = rowPoint(row);
    if (!point) return;
    const xy = mapPoint(...point, row.state);
    if (!xy) return;
    let location = locations.find(item => Math.hypot(item.xy[0] - xy[0], item.xy[1] - xy[1]) < 21);
    if (!location) { location = { xy, rows: [], firstIndex: index }; locations.push(location); }
    location.rows.push(row);
  });
  const markers = [];
  for (const location of locations) {
    const [x, y] = location.xy;
    const label = `${location.rows.length} truck${location.rows.length === 1 ? "" : "s"} near ${location.rows[0].city || "unknown city"}, ${location.rows[0].state || "unknown state"}. Jump to first truck.`;
    const group = svgNode("g", { class: "map-marker", role: "button", tabindex: "0", "aria-label": label });
    group.append(svgNode("circle", { cx: x, cy: y, r: location.rows.length > 1 ? 14 : 10 }));
    if (location.rows.length > 1) {
      const count = svgNode("text", { x, y });
      count.textContent = location.rows.length;
      group.append(count);
    }
    const title = svgNode("title"); title.textContent = label; group.append(title);
    const jump = () => revealCard(location.firstIndex).scrollIntoView({ behavior: "smooth", block: "center" });
    group.addEventListener("click", jump);
    group.addEventListener("keydown", event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); jump(); } });
    markers.push(group);
  }
  const originPoint = origin && mapPoint(...origin);
  if (originPoint) {
    const [x, y] = originPoint;
    markers.push(svgNode("circle", { class: "map-origin", cx: x, cy: y, r: 10 }),
      svgNode("circle", { class: "map-origin-core", cx: x, cy: y, r: 3 }));
  }
  ui.mapMarkers.replaceChildren(...markers);
  const mappedCount = locations.reduce((total, location) => total + location.rows.length, 0);
  ui.mapStatus.textContent = `${mappedCount} of ${rows.length} filtered truck${rows.length === 1 ? "" : "s"} mapped${originPoint ? " · tan pin: your ZIP" : ""}`;
  if (window.innerWidth < 760 && locations.length) {
    const meanX = locations.reduce((total, location) => total + location.xy[0], 0) / locations.length;
    const width = ui.mapViewport.scrollWidth;
    ui.mapViewport.scrollLeft = Math.max(0, meanX / 1000 * width - ui.mapViewport.clientWidth / 2);
  }
}

let searchTimer;
function render(visibleCount = 24) {
  clearTimeout(searchTimer);
  if (document.querySelector("#filter-drawer").open) return;
  filterQuery = controls.search.value.trim().toLowerCase();
  filterColors = new Set(selectedColors().map(input => input.value));
  const groups = vehicles.map(group => ({ ...group, matched: group.listings.filter(matches) }))
    .filter(group => controls.accidents.value !== "none" || !group.listings.some(listing => accidentGroup(listing) === "reported"))
    .filter(group => group.matched.length);
  for (const group of groups) group.primary = sortRows(group.matched)[0];
  const rows = sortRows(groups.map(group => group.primary));
  const byPrimary = new Map(groups.map(group => [group.primary.listing_key, group]));
  const cards = [];
  ui.listings.replaceChildren();
  const more = document.querySelector("#load-more");
  const progress = document.querySelector("#browse-progress");
  function appendCards(limit, focusNew = false) {
    const start = cards.length;
    const fragment = document.createDocumentFragment();
    for (const row of rows.slice(start, limit)) {
      const card = renderCard(row, byPrimary.get(row.listing_key));
      cards.push(card);
      fragment.append(card);
    }
    ui.listings.append(fragment);
    more.hidden = cards.length >= rows.length;
    more.textContent = `Show ${Math.min(24, rows.length - cards.length)} more vehicles`;
    progress.textContent = rows.length ? `Showing ${cards.length} of ${rows.length} matching vehicles` : "";
    if (focusNew && cards[start]) {
      cards[start].tabIndex = -1;
      cards[start].focus({ preventScroll: true });
    }
    syncComparison();
  }
  appendCards(visibleCount);
  more.onclick = () => appendCards(cards.length + 24, true);
  ui.listings.classList.toggle("table-view", viewMode === "table");
  renderMap(rows, index => {
    if (!cards[index]) appendCards(index + 1);
    return cards[index];
  });
  ui.listings.setAttribute("aria-busy", "false");
  ui.listings.hidden = rows.length === 0;
  ui.empty.hidden = rows.length !== 0;
  const matchedListings = groups.reduce((count, group) => count + group.matched.length, 0);
  ui.resultCount.textContent = `${rows.length} of ${vehicles.length} truck${vehicles.length === 1 ? "" : "s"} · ${matchedListings} listing${matchedListings === 1 ? "" : "s"}`;
  ui.summary.hidden = false;
  const price = median(rows.filter(row => row.status === "active" && row.category !== "auction").map(row => row.asking_price));
  const mileage = median(rows.map(row => row.mileage));
  ui.medianPrice.textContent = price == null ? "\u2014" : money.format(price);
  ui.medianMileage.textContent = mileage == null ? "\u2014" : `${integer.format(mileage)} mi`;
  renderActiveFilters();
  if (currentView() === "watchlist") renderWatchlist();
  syncComparison();
}

function renderMarket() {
  const months = Number(ui.marketPeriod.value || 24);
  const cutoff = new Date(generatedAt);
  cutoff.setUTCMonth(cutoff.getUTCMonth() - months);
  const year = ui.marketYear.value;
  const model = ui.marketModel.value;
  const sales = marketSales.filter(sale => (!model || CruiserFilters.model(sale.model || "LX470") === model) && (!year || String(sale.year) === year)
    && new Date(`${sale.sold_at}T23:59:59Z`) >= cutoff
    && Number.isFinite(sale.mileage) && Number.isFinite(sale.sale_price));
  const bands = [
    { label: "Under 100k", detail: "0–99,999 miles", includes: miles => miles < 100000 },
    { label: "100k–150k", detail: "100,000–149,999 miles", includes: miles => miles >= 100000 && miles < 150000 },
    { label: "150k–250k", detail: "150,000–249,999 miles", includes: miles => miles >= 150000 && miles < 250000 },
    { label: "250k+", detail: "250,000 miles and above", includes: miles => miles >= 250000 },
  ];
  const results = bands.map(band => ({ ...band, sales: sales.filter(sale => band.includes(sale.mileage)) }));
  const highest = Math.max(...results.map(result => average(result.sales.map(sale => sale.sale_price)) || 0), 1);
  ui.marketBands.replaceChildren(...results.map(result => {
    const prices = result.sales.map(sale => sale.sale_price);
    const mean = average(prices);
    const card = text("article", "market-band", "");
    card.append(text("p", "band-label", result.label), text("p", "band-detail", result.detail));
    card.append(text("strong", "band-average", mean == null ? "—" : money.format(mean)));
    card.append(text("span", "band-caption", "Average sale price"));
    const bar = text("div", "band-bar", "");
    const fill = text("span", "", "");
    fill.style.width = `${mean == null ? 0 : Math.max(4, (mean / highest) * 100)}%`;
    bar.append(fill);
    card.append(bar);
    const facts = text("div", "band-facts", "");
    facts.append(text("span", "", `${prices.length} sale${prices.length === 1 ? "" : "s"}`),
      text("span", "", prices.length ? `Median ${money.format(median(prices))}` : "No completed sales"));
    card.append(facts);
    return card;
  }));
  ui.marketCount.textContent = `${sales.length} completed sale${sales.length === 1 ? "" : "s"} in this view`;
}

function reset() {
  HTMLFormElement.prototype.reset.call(ui.form);
  renderColorOptions();
  origin = null;
  ui.distanceStatus.classList.remove("error");
  ui.distanceStatus.textContent = "Enter a ZIP to see approximate straight-line distances.";
  updateFilterToggle();
  render();
  syncFilters();
}

function updateFilterToggle() {
  document.querySelector("#toolbar-sort").value = controls.sort.value;
  const active = Object.entries(controls).filter(([id, control]) =>
    control.value && !(id === "sort" && control.value === "listed-newest")).length + selectedColors().length;
  const colors = selectedColors();
  document.querySelector("#color-summary").textContent = colors.length
    ? `${colors.length} color${colors.length === 1 ? "" : "s"} selected` : "All colors";
  const expanded = !ui.form.classList.contains("is-hidden");
  ui.filterToggle.textContent = `Filters${active ? ` (${active})` : ""}`;
  document.querySelector("#filter-apply").textContent = active ? `Apply filters (${active})` : "Show all vehicles";
  ui.filterToggle.setAttribute("aria-expanded", String(expanded));
}

async function load() {
  try {
    const response = await fetch("inventory.json", { cache: "no-cache" });
    if (!response.ok) throw new Error(`Inventory request returned ${response.status}`);
    const data = await response.json();
    try {
      const colorResponse = await fetch("factory-colors.json", { cache: "no-cache" });
      if (colorResponse.ok) colorReference = await colorResponse.json();
    } catch (colorError) {
      console.warn("Factory color reference unavailable", colorError);
    }
    inventory = Array.isArray(data.listings) ? data.listings : [];
    vehicles = listingGroups(inventory, Array.isArray(data.vehicles) ? data.vehicles : []);
    marketSales = Array.isArray(data.market_history?.sales) ? data.market_history.sales : [];
    sourceHealth = Array.isArray(data.source_health) ? data.source_health : [];
    generatedAt = new Date(data.generated_at || Date.now());
    const incomplete = sourceHealth.filter(source => ["error", "partial"].includes(source.status));
    document.querySelector("#collection-label").textContent = incomplete.length ? "PARTIAL REFRESH" : "INVENTORY SNAPSHOT";
    ui.collectionIndicator.classList.toggle("partial", incomplete.length > 0);
    ui.collectionNotice.hidden = incomplete.length === 0;
    if (incomplete.length) ui.collectionNotice.textContent = `Partial refresh: ${incomplete.length} source search${incomplete.length === 1 ? " was" : "es were"} incomplete (${incomplete.map(source => source.source).join(", ")}). Previously verified listings were preserved; check each listing's last verified time.`;
    ui.marketSource.textContent = data.market_history?.source || "Completed auction results";
    ui.updated.textContent = formatDate(data.generated_at);
    document.querySelector("#sidebar-updated").textContent = formatDate(data.generated_at);
    ui.disclaimer.textContent = data.disclaimer || ui.disclaimer.textContent;
    ui.total.textContent = integer.format(inventory.length);
    ui.years.textContent = new Set(inventory.map(row => row.year)).size;
    ui.sources.textContent = new Set(inventory.map(row => CruiserFilters.source(row.source)).filter(Boolean)).size;
    document.querySelector("#vehicle-count").textContent = `${integer.format(vehicles.length)} unique vehicles`;
    controls.model.replaceChildren(new Option("All models", ""), ...CruiserFilters.facetOptions(
      inventory.map(row => row.model || "LX470"), CruiserFilters.model, CruiserFilters.modelLabel)
      .map(([key, label]) => new Option(label, key)));
    controls.source.replaceChildren(new Option("All sources", ""), ...CruiserFilters.facetOptions(
      inventory.map(row => row.source), CruiserFilters.source, CruiserFilters.sourceLabel)
      .map(([key, label]) => new Option(label, key)));
    const selectedMarketModel = ui.marketModel.value;
    ui.marketModel.replaceChildren(...CruiserFilters.facetOptions(
      [...inventory.map(row => row.model || "LX470"), ...marketSales.map(sale => sale.model || "LX470")],
      CruiserFilters.model, CruiserFilters.modelLabel)
      .map(([key, label]) => new Option(label, key)));
    if ([...ui.marketModel.options].some(option => option.value === selectedMarketModel)) ui.marketModel.value = selectedMarketModel;
    ui.marketYear.replaceChildren(new Option("All tracked years", ""), ...[...new Set(
      [...inventory.map(row => row.year), ...marketSales.map(sale => sale.year)].filter(Boolean).map(String))]
      .sort().map(year => new Option(year, year)));
    sourceHealth.forEach(source => {
      const row = text("div", "health-row", "");
      row.append(text("strong", "", source.source || "Source"),
        text("span", source.status || "", String(source.status || "Unknown").replaceAll("_", " ")),
        text("span", "", source.detail || "No details reported"),
        text("small", "", `Checked ${formatDay(source.checked_at)}`));
      ui.sourceHealth.append(row);
    });
    restoreFilters();
    syncFilterLayout(true);
    updateFilterToggle();
    render();
    renderMarket();
    renderMarketOverview();
    renderAlerts();
    renderSourceOverview();
    renderWatchlist();
    routeView();
  } catch (error) {
    ui.listings.setAttribute("aria-busy", "false");
    ui.listings.replaceChildren(text("p", "loading", "The inventory could not be loaded. Please refresh in a moment."));
    ui.resultCount.textContent = "Inventory unavailable";
    ui.updated.textContent = "Inventory unavailable";
    ui.marketCount.textContent = "Market data unavailable";
    ui.marketBands.replaceChildren(text("p", "empty", "Completed auction data could not be loaded."));
    ui.sourceHealth.replaceChildren(text("p", "empty", "Source status is unavailable."));
    document.querySelector("#watchlist-content").replaceChildren(text("p", "empty", "Saved vehicles cannot be shown until inventory loads."));
    document.querySelector("#alerts-content").textContent = "Inventory unavailable.";
    console.error(error);
  }
}

ui.form.addEventListener("input", event => {
  if (event.target === controls.model) renderColorOptions();
  clearTimeout(searchTimer);
  if (event.target === controls.search) {
    searchTimer = setTimeout(() => { updateFilterToggle(); render(); syncFilters(); }, 150);
  } else { updateFilterToggle(); render(); syncFilters(); }
});
controls.zip.addEventListener("input", updateOrigin);
ui.filterToggle.addEventListener("click", () => {
  if (window.matchMedia("(max-width: 700px)").matches) { openFilterDrawer(); return; }
  const hidden = ui.form.classList.toggle("is-hidden");
  document.querySelector("#explorer-layout").classList.toggle("filters-collapsed", hidden);
  ui.filterToggle.setAttribute("aria-expanded", String(!hidden));
});
const toolbarSort = document.querySelector("#toolbar-sort");
toolbarSort.replaceChildren(...[...controls.sort.options].map(option => new Option(option.text, option.value)));
toolbarSort.addEventListener("change", () => {
  controls.sort.value = toolbarSort.value;
  updateFilterToggle(); render(); syncFilters();
  document.querySelector(".inventory-toolbar").scrollIntoView({ block: "start" });
});
ui.marketPeriod.addEventListener("input", renderMarket);
ui.marketYear.addEventListener("input", renderMarket);
ui.marketModel.addEventListener("input", renderMarket);
ui.form.addEventListener("reset", event => {
  if (document.querySelector("#filter-drawer").open) {
    event.preventDefault();
    for (const [key, control] of Object.entries(controls)) control.value = key === "sort" ? "listed-newest" : "";
    renderColorOptions(new Set());
    origin = null;
    ui.distanceStatus.classList.remove("error");
    ui.distanceStatus.textContent = "Enter a ZIP to see approximate straight-line distances.";
    updateFilterToggle();
    return;
  }
  setTimeout(() => {
  renderColorOptions();
  origin = null;
  ui.distanceStatus.classList.remove("error");
  ui.distanceStatus.textContent = "Enter a ZIP to see approximate straight-line distances.";
  updateFilterToggle(); render(); syncFilters();
  }, 0);
});
document.querySelector("#empty-reset").addEventListener("click", reset);
document.querySelector("#card-view").addEventListener("click", () => setViewMode("cards"));
document.querySelector("#table-view").addEventListener("click", () => setViewMode("table"));
document.querySelector("#mobile-menu").addEventListener("click", () => {
  const open = document.querySelector("#app-sidebar").classList.toggle("is-open");
  document.querySelector("#mobile-menu").setAttribute("aria-expanded", String(open));
  syncNavigationLayout();
});
window.addEventListener("hashchange", routeView);
window.addEventListener("resize", () => { syncFilterLayout(); syncNavigationLayout(); });
document.addEventListener("keydown", event => {
  if (event.key === "Escape" && document.querySelector("#app-sidebar").classList.contains("is-open")) {
    document.querySelector("#app-sidebar").classList.remove("is-open");
    document.querySelector("#mobile-menu").setAttribute("aria-expanded", "false");
    syncNavigationLayout();
    document.querySelector("#mobile-menu").focus();
  }
});
document.querySelector("#research-close").addEventListener("click", () => document.querySelector("#research-dialog").close());
document.querySelector("#research-dialog").addEventListener("click", event => {
  if (event.target.id === "research-dialog") event.target.close();
});
function currentView() {
  const name = location.hash.slice(1).split("?")[0];
  return ["inventory", "market", "watchlist", "alerts", "sources"].includes(name) ? name : "inventory";
}
function syncNavigationLayout() {
  const sidebar = document.querySelector("#app-sidebar");
  sidebar.inert = window.matchMedia("(max-width: 700px)").matches && !sidebar.classList.contains("is-open");
}
function syncFilterLayout(force = false) {
  const mobile = window.matchMedia("(max-width: 700px)").matches;
  if (!mobile && document.querySelector("#filter-drawer").open) closeFilterDrawer(false);
  if (!force && mobile === mobileFilterLayout) return;
  mobileFilterLayout = mobile;
  ui.form.classList.toggle("is-hidden", mobile);
  document.querySelector("#explorer-layout").classList.toggle("filters-collapsed", mobile);
  ui.filterToggle.setAttribute("aria-controls", mobile ? "filter-drawer" : "filters");
  if (mobile) ui.filterToggle.setAttribute("aria-haspopup", "dialog");
  else ui.filterToggle.removeAttribute("aria-haspopup");
  updateFilterToggle();
}
function routeView() {
  if (document.querySelector("#filter-drawer").open) closeFilterDrawer(false);
  const active = currentView();
  for (const name of ["inventory", "market", "watchlist", "alerts", "sources"]) {
    document.querySelector(`#${name}-view`).hidden = name !== active;
    const link = document.querySelector(`[data-view-link="${name}"]`);
    if (name === active) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  }
  document.querySelector("#current-view-label").textContent =
    ({ inventory: "Inventory", market: "Market Intelligence", watchlist: "Watchlist", alerts: "Alerts", sources: "Sources & Coverage" })[active];
  document.querySelector("#app-sidebar").classList.remove("is-open");
  document.querySelector("#mobile-menu").setAttribute("aria-expanded", "false");
  syncNavigationLayout();
  if (active === "watchlist") renderWatchlist();
  window.scrollTo(0, 0);
}
function setViewMode(mode) {
  viewMode = mode;
  try { localStorage.setItem("cruiser-scout-view", mode); } catch { /* Private browsing can block storage. */ }
  ui.listings.classList.toggle("table-view", mode === "table");
  for (const name of ["card", "table"]) document.querySelector(`#${name}-view`).setAttribute("aria-pressed", String(name === mode));
}
function syncFilters() {
  if (document.querySelector("#filter-drawer").open) return;
  const params = new URLSearchParams();
  selectedColors().forEach(input => params.append("color", input.value));
  for (const [name, control] of Object.entries(controls)) {
    if (control.value && !(name === "sort" && control.value === "listed-newest")) params.set(name, control.value);
  }
  const path = currentView();
  history.replaceState(null, "", `#${path}${params.size ? "?" + params : ""}`);
}
function restoreFilters() {
  const params = new URLSearchParams(location.hash.split("?")[1] || "");
  const colors = new Set(params.getAll("color"));
  for (const [name, control] of Object.entries(controls)) {
    const desired = params.get(name);
    if (desired != null && [...control.options || []].some(option => option.value === desired) || (control.tagName === "INPUT" && desired != null)) control.value = desired;
  }
  renderColorOptions(colors);
  syncFilters();
  if (controls.zip.value) updateOrigin();
  setViewMode(viewMode);
}
function renderActiveFilters() {
  const holder = document.querySelector("#active-filters");
  const active = Object.entries(controls).filter(([name, control]) =>
    control.value && !(name === "sort" && control.value === "listed-newest"));
  holder.replaceChildren(...active.map(([name, control]) => {
    const label = control.selectedOptions?.[0]?.textContent || control.value;
    const chip = text("button", "filter-chip", `${name}: ${label} ×`);
    chip.type = "button";
    chip.setAttribute("aria-label", `Remove ${name} filter`);
    chip.addEventListener("click", () => {
      control.value = name === "sort" ? "listed-newest" : "";
      if (name === "zip") origin = null;
      if (name === "model") renderColorOptions();
      updateFilterToggle(); render(); syncFilters();
    });
    return chip;
  }));
  holder.append(...selectedColors().map(input => {
    const label = input.parentElement.textContent;
    const chip = text("button", "filter-chip", `color: ${label} ×`);
    chip.type = "button";
    chip.setAttribute("aria-label", `Remove color filter: ${label}`);
    chip.addEventListener("click", () => {
      input.checked = false;
      updateFilterToggle(); render(); syncFilters();
    });
    return chip;
  }));
}
function toggleSaved(key) {
  if (savedVehicles.has(key)) savedVehicles.delete(key);
  else savedVehicles.add(key);
  try { localStorage.setItem(watchlistKey, JSON.stringify([...savedVehicles])); }
  catch { /* Browser storage is optional. */ }
  document.querySelector("#watchlist-nav-count").textContent = savedVehicles.size || "";
  render(Math.max(24, ui.listings.children.length));
  renderWatchlist();
}
function renderWatchlist() {
  const holder = document.querySelector("#watchlist-content");
  document.querySelector("#watchlist-nav-count").textContent = savedVehicles.size || "";
  if (!vehicles.length) return;
  const groups = vehicles.filter(group => savedVehicles.has(group.vehicleKey));
  if (!groups.length) {
    holder.replaceChildren(text("div", "empty", "No saved vehicles yet. Save a truck from Inventory to compare it here."));
    return;
  }
  const grid = text("div", "watchlist-grid", "");
  grid.append(...groups.map(group => renderCard(sortRows([...group.listings])[0], group)));
  holder.replaceChildren(grid);
  syncComparison();
}
function researchFact(label, content) {
  const fact = text("div", "research-fact", "");
  fact.append(text("small", "", label), text("strong", "", String(content || "Unknown")));
  return fact;
}
function openResearch(group) {
  const row = sortRows([...group.listings])[0];
  const dialog = document.querySelector("#research-dialog");
  document.querySelector("#research-title").textContent = `${row.year} ${vehicleName(row)}`;
  const body = text("div", "research-body", "");
  const rating = dealBadge(row);
  if (rating) body.append(rating);
  const layout = text("div", "research-layout", "");
  const media = text("div", "", "");
  const urls = galleryUrls(row);
  if (urls.length) {
    const photo = document.createElement("img");
    photo.src = urls[0]; photo.alt = `${row.year} ${vehicleName(row)}`; photo.className = "research-photo";
    photo.referrerPolicy = "no-referrer";
    photo.addEventListener("error", () => photo.replaceWith(text("div", "research-photo photo-placeholder", row.model || "Vehicle")));
    media.append(photo);
    const gallery = text("button", "secondary-button", `Browse ${urls.length} photo${urls.length === 1 ? "" : "s"}`);
    gallery.type = "button";
    gallery.addEventListener("click", () => { dialog.close(); openGallery(row, urls, 0); });
    media.append(gallery);
  } else media.append(text("div", "research-photo photo-placeholder", row.model || "Vehicle"));
  const facts = text("div", "research-facts", "");
  facts.append(
    researchFact(row.status === "sold" ? "Recorded sale" : row.category === "auction" ? "Auction bid" : "Asking price", priceLabel(row)),
    researchFact("Mileage", row.mileage == null ? "Unknown" : `${integer.format(row.mileage)} mi`),
    researchFact("VIN", row.vin || "Unavailable"),
    researchFact("Location", [row.city, row.state].filter(Boolean).join(", ") || "Unknown"),
    researchFact("Seller", row.seller || "Unknown"),
    researchFact("Listing date", row.listed_at ? formatDay(row.listed_at) + (row.listed_at_is_estimated ? " (estimated)" : "") : "Unknown"),
    researchFact("Added to Scout", formatDay(row.first_seen)),
    researchFact("Title indicator", row.title_status || "Unknown"),
    researchFact("Ownership", ownerLabel(row)),
    researchFact("Accident history", accidentGroup(row) === "unavailable" ? "History unavailable" : row.accident_history),
    researchFact("Exterior", row.exterior_color || "Unknown"),
    researchFact("Interior", row.interior_color || "Unknown")
  );
  layout.append(media, facts); body.append(layout);
  const more = text("section", "research-section", "");
  more.append(text("h3", "", "Source records"));
  const sources = otherListings(group);
  if (sources) more.append(sources);
  else {
    const link = text("a", "", `Open original listing on ${row.source} ↗`);
    link.href = row.listing_url; link.target = "_blank"; link.rel = "noopener noreferrer"; more.append(link);
  }
  body.append(more);
  const condition = text("section", "research-section", "");
  condition.append(text("h3", "", "Maintenance & condition"), conditionRecords(row));
  const extras = reportedExtras(row);
  if (extras) condition.append(extras);
  body.append(condition);
  const history = text("section", "research-section", "");
  history.append(text("h3", "", "Price & auction context"));
  history.append(text("p", "", row.deal_quality && row.deal_median_price
    ? `${row.deal_quality} deal against ${row.deal_comparable_count} completed sales in the ${row.deal_mileage_band} mileage band; median ${money.format(row.deal_median_price)}. Condition is not accounted for.`
    : "No supported auction comparison for this listing."));
  const prices = priceObservations(row);
  history.append(text("h4", "", "Observed asking prices"));
  if (prices.length) {
    history.append(text("p", "price-history-note", "Dates show when Scout observed each asking price. The seller may have changed it earlier. Auction bids and sold prices are separate."));
    const timeline = text("ol", "price-timeline", "");
    prices.forEach((point, index) => {
      const item = text("li", "", "");
      item.append(text("span", "", formatMoment(point.observed_at)), text("strong", "", money.format(point.asking_price)));
      if (index) {
        const difference = point.asking_price - prices[index - 1].asking_price;
        item.append(text("small", difference < 0 ? "price-down" : "price-up",
          `${difference < 0 ? "Down" : "Up"} ${money.format(Math.abs(difference))} from prior observation`));
      } else item.append(text("small", "", "First recorded asking price"));
      timeline.prepend(item);
    });
    history.append(timeline);
  } else history.append(text("p", "", "No asking price observations are available for this listing."));
  body.append(history);
  document.querySelector("#research-content").replaceChildren(body);
  dialog.showModal();
}
function marketMetric(label, value, note) {
  const node = text("div", "metric-card", "");
  node.append(text("span", "", label), text("strong", "", value), text("small", "", note));
  return node;
}
function chartRow(label, amount, max, valueLabel) {
  const row = text("div", "chart-row", "");
  const track = text("div", "chart-track", "");
  const fill = text("div", "chart-fill", "");
  fill.style.width = `${max ? Math.max(2, amount / max * 100) : 0}%`;
  track.append(fill);
  row.append(text("span", "", label), track, text("strong", "", valueLabel));
  return row;
}
function renderMarketOverview() {
  const active = inventory.filter(row => row.status === "active" && row.category !== "auction" && Number.isFinite(row.asking_price));
  const newCount = inventory.filter(row => Date.parse(row.first_seen) >= generatedAt.getTime() - 7 * 864e5).length;
  const metrics = document.querySelector("#market-metrics");
  metrics.replaceChildren(
    marketMetric("Active retail listings", integer.format(active.length), "Asking prices, not sales"),
    marketMetric("Median asking price", active.length ? money.format(median(active.map(row => row.asking_price))) : "—", "Active retail listings"),
    marketMetric("Added in 7 days", integer.format(newCount), "Based on first seen"),
    marketMetric("Completed auction sales", integer.format(marketSales.length), "Historical feed")
  );
  const bins = [[0,20000],[20000,30000],[30000,40000],[40000,50000],[50000,75000],[75000,Infinity]];
  const distribution = bins.map(([min,max]) => active.filter(row => row.asking_price >= min && row.asking_price < max).length);
  document.querySelector("#price-distribution").replaceChildren(...distribution.map((count,index) =>
    chartRow(index === 0 ? "<$20k" : index === 5 ? "$75k+" : `$${bins[index][0]/1000}–${bins[index][1]/1000}k`, count, Math.max(...distribution), String(count))));
  const scatter = document.querySelector("#price-mileage-chart");
  scatter.replaceChildren();
  const withMiles = active.filter(row => Number.isFinite(row.mileage));
  const maxPrice = Math.max(...withMiles.map(row => row.asking_price), 1);
  const maxMiles = Math.max(...withMiles.map(row => row.mileage), 1);
  withMiles.forEach(row => {
    const dot = text("span", "scatter-point", "");
    dot.style.left = `${row.mileage / maxMiles * 100}%`;
    dot.style.bottom = `${row.asking_price / maxPrice * 100}%`;
    dot.title = `${row.year} ${vehicleName(row)} · ${integer.format(row.mileage)} mi · ${money.format(row.asking_price)}`;
    scatter.append(dot);
  });
  scatter.append(text("span", "chart-axis x", `0–${integer.format(maxMiles)} mi`), text("span", "chart-axis y", `0–${money.format(maxPrice)}`));
  const years = [...new Set(active.map(row => row.year))].sort();
  const values = years.map(year => median(active.filter(row => row.year === year).map(row => row.asking_price)));
  document.querySelector("#year-comparison").replaceChildren(...years.map((year,index) =>
    chartRow(String(year), values[index], Math.max(...values), money.format(values[index]))));
  const sources = document.querySelector("#market-sources");
  sources.replaceChildren(...sourceHealth.filter(source => source.status !== "not_applicable").slice(0, 8).map(source => {
    const item = text("div", "event-row", "");
    item.append(text("strong", "", source.source), text("span", "", source.status.replaceAll("_", " ")),
      text("small", "", formatDay(source.checked_at)));
    return item;
  }));
}
function renderAlerts() {
  const cutoff = generatedAt.getTime() - 7 * 864e5;
  const recent = inventory.filter(row => Date.parse(row.first_seen) >= cutoff)
    .sort((a,b) => String(b.first_seen).localeCompare(String(a.first_seen)));
  const reductions = inventory.filter(row => row.status === "active").flatMap(row => priceDrops(row)
    .filter(drop => Date.parse(drop.observedAt) >= cutoff).map(drop => ({ row, ...drop })))
    .sort((a, b) => Date.parse(b.observedAt) - Date.parse(a.observedAt));
  document.querySelector("#alert-metrics").replaceChildren(
    marketMetric("New source listings", integer.format(recent.length), "Added in the last 7 days"),
    marketMetric("Observed price reductions", integer.format(reductions.length), "Active retail listings · last 7 days"),
    marketMetric("Last collection", formatDay(generatedAt.toISOString()), "Inventory snapshot")
  );
  const holder = document.querySelector("#alerts-content");
  holder.replaceChildren(text("h2", "", "Recent asking-price reductions"));
  if (!reductions.length) holder.append(text("p", "", "No asking-price reductions were observed on active listings in the last 7 days."));
  else holder.append(...reductions.slice(0, 30).map(change => {
    const item = text("div", "event-row", "");
    item.append(text("strong", "", formatDay(change.observedAt)));
    const link = text("a", "", `${change.row.year} ${vehicleName(change.row)} · ${money.format(change.previous)} → ${money.format(change.current)} · ${change.row.source}`);
    link.href = change.row.listing_url; link.target = "_blank"; link.rel = "noopener noreferrer";
    item.append(link, text("small", "", `Down ${money.format(change.amount)} · observed by Scout`));
    return item;
  }));
  holder.append(text("h2", "alerts-subheading", "Recently discovered"));
  if (!recent.length) holder.append(text("p", "", "No listings were first seen in the last 7 days."));
  else holder.append(...recent.slice(0, 50).map(row => {
    const item = text("div", "event-row", "");
    item.append(text("strong", "", formatDay(row.first_seen)));
    const link = text("a", "", `${row.year} ${vehicleName(row)} · ${priceLabel(row)} · ${row.source}`);
    link.href = row.listing_url; link.target = "_blank"; link.rel = "noopener noreferrer";
    item.append(link, text("small", "", row.state || "Location unknown"));
    return item;
  }));
}
function renderSourceOverview() {
  const counts = [...new Set(inventory.map(row => CruiserFilters.source(row.source)).filter(Boolean))].sort();
  const grid = text("div", "metric-grid", "");
  grid.append(...counts.map(source => marketMetric(CruiserFilters.sourceLabel(source),
    integer.format(inventory.filter(row => CruiserFilters.source(row.source) === source).length), "Current source listings")));
  ui.sourceHealth.parentElement.before(grid);
}
syncNavigationLayout();
load();

// Move the existing controls into a native modal so focus and field IDs stay consistent.
const filterDrawer = document.querySelector("#filter-drawer");
const filterHome = ui.form.parentElement;
const filterNextSibling = ui.form.nextSibling;
let filterSnapshot = null;
let filterScrollY = 0;
function openFilterDrawer() {
  clearTimeout(searchTimer);
  render(Math.max(24, ui.listings.children.length)); syncFilters();
  filterSnapshot = {
    values: Object.fromEntries(Object.entries(controls).map(([key, control]) => [key, control.value])),
    colors: new Set(selectedColors().map(input => input.value)),
    origin, status: ui.distanceStatus.textContent, error: ui.distanceStatus.classList.contains("error")
  };
  filterScrollY = window.scrollY;
  document.querySelector("#filter-drawer-body").append(ui.form);
  ui.form.classList.remove("is-hidden");
  document.body.style.top = `-${filterScrollY}px`;
  document.body.classList.add("filter-drawer-open");
  filterDrawer.showModal();
  ui.filterToggle.setAttribute("aria-expanded", "true");
}
function closeFilterDrawer(apply) {
  if (!filterSnapshot) return;
  clearTimeout(searchTimer);
  if (!apply) {
    for (const [key, value] of Object.entries(filterSnapshot.values)) controls[key].value = value;
    renderColorOptions(filterSnapshot.colors);
    origin = filterSnapshot.origin;
    ui.distanceStatus.textContent = filterSnapshot.status;
    ui.distanceStatus.classList.toggle("error", filterSnapshot.error);
  }
  filterSnapshot = null;
  filterDrawer.close();
  filterHome.insertBefore(ui.form, filterNextSibling);
  const mobile = window.matchMedia("(max-width: 700px)").matches;
  ui.form.classList.toggle("is-hidden", mobile);
  document.body.classList.remove("filter-drawer-open");
  document.body.style.top = "";
  window.scrollTo(0, filterScrollY);
  updateFilterToggle();
  if (apply) { render(); syncFilters(); }
  ui.filterToggle.focus({ preventScroll: true });
}
document.querySelector("#filter-cancel").addEventListener("click", () => closeFilterDrawer(false));
document.querySelector("#filter-apply").addEventListener("click", () => closeFilterDrawer(true));
document.querySelector("#filter-drawer-reset").addEventListener("click", () => HTMLFormElement.prototype.reset.call(ui.form));
filterDrawer.addEventListener("cancel", event => { event.preventDefault(); closeFilterDrawer(false); });
filterDrawer.addEventListener("click", event => { if (event.target === filterDrawer) closeFilterDrawer(false); });
ui.form.addEventListener("submit", event => {
  event.preventDefault();
  if (filterDrawer.open) closeFilterDrawer(true);
  else { render(); syncFilters(); }
});
