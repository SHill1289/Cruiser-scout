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

const explicitFilterLink = location.hash.includes("?");
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
CruiserStrongFilters.prepare();
const controls = ["year", "interior", "age", "minPrice", "minMileage", "search", "model", "type", "status", "deal", "owners", "accidents", "price", "mileage", "zip", "radius", "source", "sort"]
  .reduce((all, id) => ({ ...all, [id]: document.querySelector(`#${id}`) }), {});
let sourceHealth = [];
let emailHealth = null;
let latestChanges = [];
let changesVisit = null;
const changesKey = "cruiser-scout-changes-v1";
let changesShown = 30;
function saveChangesVisit() { try { localStorage.setItem(changesKey, JSON.stringify(changesVisit)); } catch {} }

let viewMode = localStorage.getItem("cruiser-scout-view") === "table" ? "table" : "cards";
const watchlistKey = "cruiser-scout-watchlist-v1";
let savedVehicles = new Set();
try { savedVehicles = new Set(JSON.parse(localStorage.getItem(watchlistKey) || "[]")); } catch { savedVehicles = new Set(); }
let mobileFilterLayout = window.matchMedia("(max-width: 700px)").matches;
const browsingKey = "cruiser-scout-browsing-v1";
let browsing = { positions: {}, shown: 24, hash: "" };
try {
  const saved = JSON.parse(sessionStorage.getItem(browsingKey) || "null");
  if (saved && typeof saved.hash === "string" && saved.positions && typeof saved.positions === "object") {
    browsing = saved;
    browsing.shown = Math.max(24, Math.min(10000, Number(saved.shown) || 24));
  }
} catch { /* Session storage is optional. */ }
if (!location.hash && /^#(inventory|watchlist|market|alerts|sources)(\?|$)/.test(browsing.hash)) {
  history.replaceState(null, "", browsing.hash);
}
const resumeBrowsing = location.hash === browsing.hash;
let displayedView = null;
let browsingReady = false;
if ("scrollRestoration" in history) history.scrollRestoration = "manual";

function rememberBrowsing() {
  if (!browsingReady || !displayedView || document.querySelector("#filter-drawer").open) return;
  const holder = document.querySelector(`#${displayedView}-view`);
  const edge = displayedView === "inventory" && window.innerWidth <= 700
    ? document.querySelector(".inventory-toolbar").getBoundingClientRect().bottom : 0;
  const anchor = [...holder.querySelectorAll(".listing")].find(card => card.getBoundingClientRect().bottom > edge);
  browsing.positions[displayedView] = {
    y: window.scrollY, anchor: anchor?.id || null,
    offset: anchor ? anchor.getBoundingClientRect().top : 0,
    horizontal: displayedView === "inventory" ? ui.listings.scrollLeft : 0
  };
  browsing.shown = ui.listings.children.length;
  browsing.hash = location.hash;
  try { sessionStorage.setItem(browsingKey, JSON.stringify(browsing)); } catch { /* Optional. */ }
}
function restoreBrowsingPosition(view) {
  const position = browsing.positions[view];
  requestAnimationFrame(() => {
    if (displayedView !== view) return;
    const holder = document.querySelector(`#${view}-view`);
    const anchor = position?.anchor && [...holder.querySelectorAll(".listing")].find(card => card.id === position.anchor);
    const y = anchor ? window.scrollY + anchor.getBoundingClientRect().top - (Number(position.offset) || 0) : Number(position?.y) || 0;
    window.scrollTo({ top: Math.max(0, y), behavior: "instant" });
    if (view === "inventory") ui.listings.scrollLeft = Number(position?.horizontal) || 0;
  });
}
let browsingSaveTimer;
window.addEventListener("scroll", () => {
  clearTimeout(browsingSaveTimer);
  browsingSaveTimer = setTimeout(rememberBrowsing, 150);
}, { passive: true });
window.addEventListener("pagehide", rememberBrowsing);
document.addEventListener("visibilitychange", () => { if (document.hidden) rememberBrowsing(); });
document.addEventListener("click", event => {
  if (event.target.closest("a[target='_blank']")) rememberBrowsing();
});
document.querySelectorAll("[data-view-link]").forEach(link => link.addEventListener("click", () => {
  rememberBrowsing();
  const query = location.hash.split("?")[1];
  link.href = `#${link.dataset.viewLink}${query ? "?" + query : ""}`;
}));

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
  if (String(row.quality_flags || '').split(';').includes('email_discovery')) return row.category === 'retail' ? 'Availability unverified' : 'Auction status unverified';
  if (row.source === "carsandbids" && row.status === "unknown" && String(row.quality_flags || "").split(";").includes("rss_discovery")) return "Auction status unverified";
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
const unavailablePhotos = new Set();
function photoEntries(row) {
  return CruiserPhotoCoverage.entries(row, inventory).filter(entry => !unavailablePhotos.has(entry.url));
}
function galleryUrls(row) { return photoEntries(row).map(entry => entry.url); }
function photoCredit(row, url) {
  const entry = CruiserPhotoCoverage.entries(row, inventory).find(entry => entry.url === url);
  return entry?.borrowed ? `Photo from ${entry.source} · same VIN` : `Photo from ${entry?.source || row.source}`;
}
function renderPhotoThumbnails() {
  const thumbnails = document.querySelector("#photo-thumbnails");
  const urls = activeGallery?.gallery.urls || [];
  thumbnails.hidden = urls.length < 2;
  thumbnails.replaceChildren(...urls.map((url, position) => {
    const button = text("button", "photo-thumbnail", "");
    button.type = "button";
    button.setAttribute("aria-label", "Show photo " + (position + 1) + " of " + urls.length);
    const preview = document.createElement("img");
    preview.src = url; preview.alt = ""; preview.loading = "lazy"; preview.draggable = false; preview.referrerPolicy = "no-referrer";
    preview.addEventListener("error", () => { preview.hidden = true; });
    button.append(preview, text("span", "", String(position + 1)));
    button.addEventListener("click", () => { if (activeGallery) { activeGallery.gallery.select(url); showLargePhoto(); } });
    return button;
  }));
}
function showLargePhoto() {
  if (!activeGallery) return;
  const {row, gallery, onChange} = activeGallery;
  const urls = gallery.urls, index = gallery.index;
  ui.photoLarge.hidden = !urls.length;
  ui.photoError.hidden = !!urls.length;
  ui.photoPrevious.hidden = ui.photoNext.hidden = urls.length < 2;
  document.querySelector("#photo-hint").hidden = urls.length < 2;
  ui.photoCount.textContent = urls.length ? "Photo " + (index + 1) + " of " + urls.length : "Photos unavailable";
  ui.photoTitle.textContent = row.year + " " + vehicleName(row) + " · " + (row.seller || row.source);
  if (!urls.length) {
    ui.photoLarge.removeAttribute("src");
    ui.photoSource.href = row.listing_url; ui.photoSource.textContent = "Open original listing ↗";
    onChange?.(null); return;
  }
  ui.photoLarge.src = gallery.current;
  ui.photoLarge.alt = "Photo " + (index + 1) + " of " + urls.length + " for " + row.year + " " + vehicleName(row);
  const thumbnails = document.querySelectorAll("#photo-thumbnails button");
  thumbnails.forEach((button, position) => button.setAttribute("aria-pressed", String(position === index)));
  if (ui.photoDialog.open) thumbnails[index]?.scrollIntoView({block:"nearest", inline:"nearest", behavior:"instant"});
  const origin = CruiserPhotoCoverage.entries(row, inventory).find(entry => entry.url === gallery.current);
  ui.photoSource.href = origin?.listing_url || row.listing_url;
  ui.photoSource.textContent = photoCredit(row, gallery.current) + " ↗";
  rememberPhoto(row, gallery.current);
  onChange?.(gallery.current);
}
function stepLargePhoto(step) {
  if (activeGallery) { activeGallery.gallery.step(step); showLargePhoto(); }
}
let photoScrollY = 0;
function openGallery(row, urls, index, onChange) {
  const available = urls.filter(url => !unavailablePhotos.has(url));
  if (!available.length) return;
  activeGallery = {row, gallery:CruiserPhotos.createGallery(available, urls[index]), onChange};
  renderPhotoThumbnails();
  showLargePhoto();
  if (!ui.photoDialog.open) {
    photoScrollY = window.scrollY;
    document.body.style.setProperty("--photo-scroll-top", "-" + photoScrollY + "px");
    document.body.classList.add("photo-gallery-open");
    ui.photoDialog.showModal();
    document.querySelector("#photo-close").focus({preventScroll:true});
  }
}
CruiserPhotos.bindSwipe(document.querySelector(".photo-stage"), stepLargePhoto);
ui.photoPrevious.addEventListener("click", () => stepLargePhoto(-1));
ui.photoNext.addEventListener("click", () => stepLargePhoto(1));
document.querySelector("#photo-close").addEventListener("click", () => ui.photoDialog.close());
ui.photoDialog.addEventListener("close", () => {
  activeGallery = null;
  document.body.classList.remove("photo-gallery-open");
  document.body.style.removeProperty("--photo-scroll-top");
  window.scrollTo({top:photoScrollY, behavior:"instant"});
});
ui.photoDialog.addEventListener("keydown", event => {
  if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
    event.preventDefault(); stepLargePhoto(event.key === "ArrowLeft" ? -1 : 1);
  }
});
ui.photoLarge.addEventListener("error", () => {
  if (!activeGallery) return;
  unavailablePhotos.add(activeGallery.gallery.current);
  activeGallery.gallery.remove(activeGallery.gallery.current);
  renderPhotoThumbnails(); showLargePhoto();
});
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
  listed.append(text("span", "", row.email_observed_at ? "Listing alert received" : "Listed"), text("strong", "", formatDay(row.listed_at)));
  if (row.listed_at && row.listed_at_is_estimated) listed.append(text("small", "", "Estimated from days on market"));
  const added = text("p", "date-fact", "");
  added.append(text("span", "", "Truck added to Scout"), text("strong", "", formatDay(row.vehicle_first_seen || row.first_seen)));
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
  if (saleState(row) === "sold") return `Sold ${formatDay(row.auction_result_at || row.last_seen)}`;
  return row.email_observed_at ? `Listing alert received ${formatMoment(row.email_observed_at)}` : `Last seen for sale ${formatMoment(row.last_seen)}`;
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

function equipmentHighlights(row, group) {
  const reports = [];
  const seen = new Set();
  for (const listing of group.listings) {
    if (listing.model !== row.model || Number(listing.year) !== Number(row.year)) continue;
    const claims = Array.isArray(listing.equipment_evidence) ? listing.equipment_evidence : [];
    const tags = String(listing.reported_extras || "").split(";").filter(Boolean)
      .map(label => ({ label, quote: label, kind: "tag" }));
    for (const claim of [...claims, ...tags]) {
      if (typeof claim.label !== "string" || typeof claim.quote !== "string") continue;
      if (!/^https?:\/\//i.test(listing.listing_url || "")) continue;
      const key = JSON.stringify([claim.label, claim.quote, listing.listing_url]);
      if (!seen.has(key)) { seen.add(key); reports.push({ ...claim, listing }); }
    }
  }
  const panel = text("div", "equipment-highlights", "");
  panel.setAttribute("aria-label", "Equipment evidence");
  if (!reports.length) {
    panel.append(text("span", "equipment-unknown", "Special equipment not mentioned · absence not confirmed"));
    return panel;
  }
  const details = document.createElement("details");
  details.className = "equipment-evidence";
  const labels = [...new Set(reports.map(report => report.label))];
  details.append(text("summary", "", `Equipment evidence · ${labels.join(" · ")}`));
  details.append(text("p", "equipment-note", "Source mentions, not verified equipment. Quotes may describe missing, modified or nonworking equipment. Factory origin and operation need confirmation unless explicitly documented."));
  for (const report of reports) {
    const item = text("div", "equipment-claim", "");
    item.append(text("strong", "", report.label));
    item.append(text("span", "equipment-label", report.kind === "description" ? "Listing description" : "Marketplace tag · factory origin unverified"));
    item.append(text("blockquote", "", report.quote));
    const listing = report.listing;
    const link = text("a", "maintenance-source", `View evidence on ${listing.source} ↗`);
    link.href = listing.listing_url; link.target = "_blank"; link.rel = "noopener noreferrer";
    item.append(link);
    if (["sold", "ended", "removed"].includes(listing.status)) item.append(text("span", "equipment-label", "Historical listing · equipment may have changed"));
    details.append(item);
  }
  panel.append(details);
  return panel;
}

function maintenanceClaim(claim) {
  const item = text("div", "maintenance-claim", "");
  item.append(text("strong", "", claim.status), text("p", "condition-evidence", claim.evidence));
  const link = text("a", "maintenance-source", `View evidence on ${claim.source} ↗`);
  link.href = claim.url;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  item.append(link);
  const date = claim.listedAt || claim.lastSeen;
  if (date || claim.historical) item.append(text("small", "maintenance-date",
    [claim.historical ? "Earlier listing" : "", date ? `${claim.listedAt ? "Listed" : "Last seen"} ${formatDay(date)}` : ""].filter(Boolean).join(" · ")));
  return item;
}

function maintenanceHighlights(row, group) {
  const records = CruiserMaintenance.records(row, group.listings);
  const known = records.filter(record => record.claims.length);
  const panel = text("section", "maintenance-highlights", "");
  panel.setAttribute("aria-label", "Maintenance evidence");
  panel.append(text("h4", "", "Maintenance evidence"));
  if (!known.length) {
    const empty = text("p", "maintenance-compact-empty", "Maintenance: not mentioned — not the same as not done.");
    return empty;
  }
  for (const record of known.slice(0, 2)) {
    const item = text("div", "maintenance-highlight", "");
    item.append(text("span", "maintenance-topic", record.label));
    if (record.differs) item.append(text("span", "maintenance-differs", "Reports differ · review all evidence"));
    item.append(maintenanceClaim(record.claims[0]));
    if (record.claims.length > 1) item.append(text("small", "", `${record.claims.length - 1} more source report${record.claims.length === 2 ? "" : "s"} in full details`));
    panel.append(item);
  }
  panel.append(text("p", "maintenance-note", "Listing-reported. Confirm dates, mileage and receipts with the seller."));
  const button = text("button", "maintenance-more", "View all maintenance & condition evidence");
  button.type = "button";
  button.addEventListener("click", () => {
    openResearch(group, row);
    document.querySelector("#research-maintenance").scrollIntoView({ block: "start" });
    document.querySelector("#research-maintenance summary").focus();
  });
  panel.append(button);
  return panel;
}

function conditionRecords(row, group = { listings: [row] }, expanded = false) {
  const records = CruiserMaintenance.records(row, group.listings);
  const sourced = records.filter(record => record.claims.length).length;
  const panel = document.createElement("details");
  panel.className = "condition-records";
  panel.open = expanded;
  panel.append(text("summary", "", `Maintenance & condition · ${sourced} topics with evidence`));
  const content = text("div", "condition-records-content", "");
  for (const record of records) {
    const item = text("div", "condition-record", "");
    item.append(text("span", "condition-label", record.label));
    const reports = text("div", "", "");
    if (record.differs) reports.append(text("strong", "maintenance-differs", "Reports differ — compare the source dates and wording."));
    if (record.claims.length) reports.append(...record.claims.map(maintenanceClaim));
    else reports.append(text("span", "condition-unknown", "Not mentioned in collected evidence"));
    item.append(reports);
    content.append(item);
  }
  content.append(text("p", "condition-disclaimer", "Not mentioned does not mean not done. These are statements from collected listings, not independently verified service records or an inspection. Earlier listings describe the vehicle at that time. Confirm receipts, dates and mileage with the seller."));
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
  card.append(makePhotoMedia(row));

  const identity = text("div", "identity", "");
  const stateRow = text("div", "listing-state-row", "");
  stateRow.append(text("span", "model-tag", row.model || "LX470"));
  stateRow.append(text("span", `sale-state state-${saleState(row)}`, saleStateLabel(row)));
  if (row.title_status === "unknown") stateRow.append(text("span", "title-unverified-badge", "Title unverified"));
  const freshness = freshnessLabel(row);
  if (freshness) {
    const badge = text("span", "freshness-badge", freshness);
    badge.title = `Last verified for sale ${formatMoment(row.last_seen)}${row.last_checked ? `; source last checked ${formatMoment(row.last_checked)}` : ""}. Availability is not seller-confirmed.`;
    stateRow.append(badge);
  }
  if (group.listings.length > 1) stateRow.append(text("span", "duplicate-badge", `${group.listings.length} listings · same VIN`));
  if (String(row.quality_flags || "").split(";").includes("rss_discovery")) stateRow.append(text("span", "title-unverified-badge", "RSS discovery · details unverified"));
  if (String(row.quality_flags || '').split(';').includes('email_discovery')) stateRow.append(text('span', 'title-unverified-badge', 'Email alert · details unverified'));
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
  const showDetails = () => openResearch(group, row);
  const title = text("h3", "vehicle-title", "");
  const titleButton = text("button", "listing-details-title", `${row.year} ${vehicleName(row)}${row.trim ? ` ${row.trim}` : ""}`);
  titleButton.type = "button";
  titleButton.setAttribute("aria-haspopup", "dialog");
  titleButton.addEventListener("click", showDetails);
  title.append(titleButton);
  identity.append(title);
  const mileageButton = text("button", "listing-mileage-summary", row.mileage == null
    ? "Mileage unavailable" : `${integer.format(row.mileage)} mi`);
  mileageButton.type = "button";
  mileageButton.setAttribute("aria-label", `${mileageButton.textContent}. View details for ${row.year} ${vehicleName(row)}`);
  mileageButton.setAttribute("aria-haspopup", "dialog");
  mileageButton.addEventListener("click", showDetails);
  identity.append(mileageButton);
  const facts = text("div", "card-primary-facts", "");
  facts.append(makeMetric(priceLabel(row), row.status === "sold" ? "Recorded sale price" : row.category === "auction" ? "Auction price" : "Asking price"));
  const compactMileage = mileageButton.cloneNode(true);
  compactMileage.className = "card-mileage";
  compactMileage.addEventListener("click", showDetails);
  facts.append(compactMileage);
  identity.append(facts, equipmentHighlights(row, group));
  card.addEventListener("click", event => {
    if (!window.matchMedia("(max-width: 700px)").matches) return;
    if (event.target.closest("button, a, input, select, label, details, [role='button']")) return;
    if (window.getSelection()?.toString()) return;
    showDetails();
  });
  const place = [row.city, row.state].filter(Boolean).join(", ") || "Location unavailable";
  identity.append(text("p", "vehicle-meta", `${place} \u00b7 ${row.seller || "Seller unknown"} · ${row.source}`));
  const distance = distanceTo(row);
  if (distance != null) identity.append(text("p", "vehicle-meta location-distance", `About ${integer.format(Math.round(distance))} mi from your ZIP · straight line`));
  identity.append(text("p", "vehicle-meta timing", statusTiming(row)));
  const colors = text("div", "color-pair", "");
  colors.append(makeColorFact("exterior", row.exterior_color, row.year, row.model), makeColorFact("interior", row.interior_color, row.year, row.model));
  identity.append(colors);
  identity.append(maintenanceHighlights(row, group));
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
  link.append(text("span", "open-link-label", row.source === "carsandbids" && row.status === "unknown" ? "View auction / current bid" : "Source listing"), text("span", "open-link-arrow", "\u2197"));
  link.href = row.listing_url;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  link.setAttribute("aria-label", `Open ${row.year} ${vehicleName(row)} listing on ${row.source}`);
  const actions = text("div", "listing-actions", "");
  const research = text("button", "research-button", "View details");
  research.type = "button";
  research.setAttribute("aria-haspopup", "dialog");
  research.addEventListener("click", showDetails);
  const save = text("button", "save-button", savedVehicles.has(group.vehicleKey) ? "★ Saved" : "☆ Save");
  save.type = "button";
  save.setAttribute("aria-pressed", String(savedVehicles.has(group.vehicleKey)));
  save.setAttribute("aria-label", (savedVehicles.has(group.vehicleKey) ? "Remove from" : "Save to") + " watchlist: " + row.year + " " + vehicleName(row));
  save.addEventListener("click", () => toggleSaved(group.vehicleKey));
  actions.append(research, save, link, comparisonButton(row, group));
  card.append(actions);
  const others = otherListings(group);
  if (others) card.append(others);
  return card;
}

function renderColorOptions(selected = new Set(selectedColors().map(input => input.value))) {
  document.querySelector("#color-options").replaceChildren(...CruiserFilters.colorOptions(inventory.filter(row => CruiserStrongFilters.any(CruiserStrongFilters.values(controls.model), CruiserFilters.model(row.model || "LX470"))), colorReference)
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

function renderInteriorOptions() {
  const selected = new Set(CruiserStrongFilters.values(controls.interior)), options = new Map();
  for(const row of inventory) {
    if(!CruiserStrongFilters.any(CruiserStrongFilters.values(controls.model),CruiserFilters.model(row.model || "LX470"))) continue;
    const c = CruiserStrongFilters.interior(row.interior_color);
    options.set(c.key,c.label);
  }
  controls.interior.replaceChildren(...[...options].sort((a,b)=>a[1].localeCompare(b[1])).map(([key,label])=>new Option(label,key,false,selected.has(key))));
  CruiserStrongFilters.enhance();
}

function selectedColors() {
  return [...ui.color.querySelectorAll("input:checked")];
}

const searchIndex = new WeakMap();
let filterQuery = "";
let filterColors = new Set();
let strongFilterState = {};
function matches(row) {
  const query = filterQuery;
  let indexed = searchIndex.get(row);
  if (!indexed) {
  const factoryExterior = resolveFactoryColor("exterior", row.exterior_color, row.year, row.model);
  const factoryInterior = resolveFactoryColor("interior", row.interior_color, row.year, row.model);
  const haystack = [vehicleName(row), row.city, row.state, row.seller, row.vin, row.exterior_color, row.interior_color,
    factoryExterior.name, factoryInterior.name, row.source].join(" ").toLowerCase();
  indexed = { haystack, color: factoryExterior.key, interior: CruiserStrongFilters.interior(row.interior_color).key };
  searchIndex.set(row, indexed);
  }
  const amount = listingPrice(row);
  return (!query || indexed.haystack.includes(query))
    && CruiserStrongFilters.match(row, strongFilterState, {
      model:CruiserFilters.model(row.model || "LX470"),source:CruiserFilters.source(row.source),status:saleState(row),
      deal:['great','fair','bad'].includes(row.deal_quality)?row.deal_quality:'unrated',interior:indexed.interior,
      accidents:accidentGroup(row),price:amount
    })
    && (!filterColors.size || filterColors.has(indexed.color))
    && (!origin || !controls.radius.value || (distanceTo(row) != null && distanceTo(row) <= Number(controls.radius.value)));
}

function discoveryTime(row) {
  const time = Date.parse(row.vehicle_first_seen || row.first_seen || "");
  return Number.isFinite(time) ? time : -Infinity;
}
function compareDiscovery(a, b) {
  return discoveryTime(b) - discoveryTime(a)
    || String(a.vehicle_key || a.listing_key || "").localeCompare(String(b.vehicle_key || b.listing_key || ""))
    || String(a.listing_key || "").localeCompare(String(b.listing_key || ""));
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
    "listed-newest": (a, b) => listedTime(b) - listedTime(a) || compareDiscovery(a, b),
    "newest": compareDiscovery,
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
  strongFilterState = Object.fromEntries(Object.entries(controls).map(([k,c])=>[k,c.multiple?CruiserStrongFilters.values(c):c.value]));
  const groups = vehicles.map(group => ({ ...group, matched: group.listings.filter(matches) }))
    .filter(group => !(CruiserStrongFilters.values(controls.accidents).length === 1 && CruiserStrongFilters.values(controls.accidents)[0] === "none") || !group.listings.some(listing => accidentGroup(listing) === "reported"))
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
  const filteredResults = CruiserMarket.filter(marketRows, marketOptions(), generatedAt);
  const comparisonResults=document.getElementById("market-compare").checked?CruiserMarket.filter(marketRows,marketOptions("-b"),generatedAt):null;
  renderMarketComparison(filteredResults,comparisonResults);
  renderMarketChart(filteredResults,comparisonResults);
  const sales = filteredResults.filter(sale => sale.outcome !== "unsold" && Number.isFinite(sale.mileage) && Number.isFinite(sale.sale_price));
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
  ui.marketCount.textContent = `${CruiserMarket.stats(filteredResults).count} confirmed sales · mileage bands below describe Set A`;
}

function reset() {
  HTMLFormElement.prototype.reset.call(ui.form);
  renderColorOptions();
  renderInteriorOptions();
  origin = null;
  ui.distanceStatus.classList.remove("error");
  ui.distanceStatus.textContent = "Enter a ZIP to see approximate straight-line distances.";
  updateFilterToggle();
  render();
  syncFilters();
}

function updateFilterToggle() {
  CruiserStrongFilters.refresh();
  document.querySelector("#toolbar-sort").value = controls.sort.value;
  const active = Object.entries(controls).reduce((n,[id,c]) => n + (id === "sort" && c.value === "listed-newest" ? 0 : CruiserStrongFilters.values(c).length),0) + selectedColors().length;
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
    const emailLoad = fetch('/api/email-alerts', {credentials:'omit',signal:AbortSignal.timeout(9000)})
      .then(response => response.ok ? response.json() : null).catch(() => null);
    const response = await fetch(CruiserInventory.url, { cache: "no-cache", credentials: "omit" });
    if (!response.ok) throw new Error(`Inventory request returned ${response.status}`);
    let data = await response.json();
    const alerts = await emailLoad;
    emailHealth = alerts;
    if (alerts) data = CruiserEmailAlerts.merge(data, alerts);
    try {
      const colorResponse = await fetch("factory-colors.json", { cache: "no-cache" });
      if (colorResponse.ok) colorReference = await colorResponse.json();
    } catch (colorError) {
      console.warn("Factory color reference unavailable", colorError);
    }
    inventory = Array.isArray(data.listings) ? data.listings : [];
    vehicles = listingGroups(inventory, Array.isArray(data.vehicles) ? data.vehicles : []);
    marketSales = Array.isArray(data.market_history?.sales) ? data.market_history.sales : [];
    marketSales = CruiserMarket.unique([...marketSales, ...CruiserMarket.completed(inventory)]);
    marketRows = CruiserMarket.unique([...marketSales, ...(data.market_history?.results || [])]).map(row => {
      const color = resolveFactoryColor("exterior", row.exterior_color, row.year, row.model);
      return {...row, model:CruiserFilters.model(row.model || "LX470"), outcome:row.outcome || "sold",
        color_key:color.name || "unknown", color_name:color.name || "Color unavailable"};
    });
    marketSales = marketRows.filter(row => (row.outcome || "sold") === "sold" && Number.isFinite(row.sale_price) && row.sale_price > 0);
    sourceHealth = Array.isArray(data.source_health) ? data.source_health : [];
    generatedAt = new Date(data.generated_at || Date.now());
    let previousVisit = null;
    try { previousVisit = JSON.parse(localStorage.getItem(changesKey)); } catch {}
    changesVisit = CruiserChanges.visit(previousVisit, generatedAt.toISOString());
    saveChangesVisit();
    const incomplete = sourceHealth.filter(source => ["error", "partial"].includes(source.status));
    document.querySelector("#collection-label").textContent = incomplete.length ? "PARTIAL REFRESH" : "INVENTORY SNAPSHOT";
    ui.collectionIndicator.classList.toggle("partial", incomplete.length > 0);
    ui.collectionNotice.hidden = incomplete.length === 0;
    if (incomplete.length) document.querySelector("#collection-message").textContent = `Partial refresh: ${incomplete.length} source search${incomplete.length === 1 ? " was" : "es were"} incomplete (${incomplete.map(source => source.source).join(", ")}). Previously verified listings were preserved; check each listing's last verified time.`;
    window.CruiserRefresh.notice(data.generated_at, incomplete.length > 0);
    ui.marketSource.textContent = data.market_history?.source || "Completed sale results";
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
    document.getElementById("market-model-b").innerHTML=ui.marketModel.innerHTML;
    document.getElementById("market-model-b").value="LX570";
    renderMarketFacets("-b");
    renderMarketFacets();
    sourceHealth.forEach(source => {
      const row = text("div", "health-row", "");
      row.append(text("strong", "", source.source || "Source"),
        text("span", source.status || "", String(source.status || "Unknown").replaceAll("_", " ")),
        text("span", "", source.detail || "No details reported"),
        text("small", "", `Checked ${formatDay(source.checked_at)}`));
      ui.sourceHealth.append(row);
    });
    controls.year.replaceChildren(...[...new Set(inventory.map(r=>r.year))].sort((a,b)=>b-a).map(y=>new Option(String(y),String(y))));
    restoreFilters();
    window.CruiserFilterSync.start({
      explicit: explicitFilterLink,
      read: () => inventoryFilterQuery(),
      editing: () => document.querySelector('#filter-drawer').open,
      apply: query => {
        for(const [name,control] of Object.entries(controls)) CruiserStrongFilters.set(control,name==='sort'?'listed-newest':'');
        origin=null;
        restoreFilters(query);
        updateFilterToggle(); render();
        updateOrigin();
        return inventoryFilterQuery();
      }
    });
    if (controls.zip.value) await updateOrigin();
    syncFilterLayout(true);
    updateFilterToggle();
    render(resumeBrowsing ? browsing.shown : 24);
    renderMarket();
    renderMarketOverview();
    renderAlerts();
    renderSourceOverview();
    renderWatchlist();
    if (!resumeBrowsing) browsing.positions = {};
    browsingReady = true;
    routeView();
  } catch (error) {
    ui.listings.setAttribute("aria-busy", "false");
    ui.listings.replaceChildren(text("p", "loading", "The inventory could not be loaded. Please refresh in a moment."));
    ui.resultCount.textContent = "Inventory unavailable";
    ui.updated.textContent = "Inventory unavailable";
    ui.marketCount.textContent = "Market data unavailable";
    ui.marketBands.replaceChildren(text("p", "empty", "Completed sale data could not be loaded."));
    ui.sourceHealth.replaceChildren(text("p", "empty", "Source status is unavailable."));
    document.querySelector("#watchlist-content").replaceChildren(text("p", "empty", "Saved vehicles cannot be shown until inventory loads."));
    document.querySelector("#alerts-content").textContent = "Inventory unavailable.";
    console.error(error);
  }
}

ui.form.addEventListener("input", event => {
  if (event.target === controls.model) { renderColorOptions(); renderInteriorOptions(); }
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
ui.marketModel.addEventListener("input", () => { renderMarketFacets(); renderMarket(); });
ui.form.addEventListener("reset", event => {
  if (document.querySelector("#filter-drawer").open) {
    event.preventDefault();
    for (const [key, control] of Object.entries(controls)) CruiserStrongFilters.set(control,key === "sort" ? "listed-newest" : "");
    renderInteriorOptions();
    renderColorOptions(new Set());
    origin = null;
    ui.distanceStatus.classList.remove("error");
    ui.distanceStatus.textContent = "Enter a ZIP to see approximate straight-line distances.";
    updateFilterToggle();
    return;
  }
  setTimeout(() => {
  renderColorOptions();
  renderInteriorOptions();
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
  if (displayedView && displayedView !== active) {
    // The URL already changed, but the outgoing view is still on screen.
    rememberBrowsing();
  }
  for (const name of ["inventory", "market", "watchlist", "alerts", "sources"]) {
    document.querySelector(`#${name}-view`).hidden = name !== active;
    const link = document.querySelector(`[data-view-link="${name}"]`);
    if (name === active) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  }
  document.querySelector("#current-view-label").textContent =
    ({ inventory: "Inventory", market: "Market Intelligence", watchlist: "Watchlist", alerts: "What changed?", sources: "Sources & Coverage" })[active];
  document.querySelector("#app-sidebar").classList.remove("is-open");
  document.querySelector("#mobile-menu").setAttribute("aria-expanded", "false");
  syncNavigationLayout();
  if (active === "watchlist") renderWatchlist();
  displayedView = active;
  syncFilters();
  if (browsingReady) restoreBrowsingPosition(active);
}
function setViewMode(mode) {
  viewMode = mode;
  try { localStorage.setItem("cruiser-scout-view", mode); } catch { /* Private browsing can block storage. */ }
  ui.listings.classList.toggle("table-view", mode === "table");
  for (const name of ["card", "table"]) document.querySelector(`#${name}-view`).setAttribute("aria-pressed", String(name === mode));
}
function inventoryFilterQuery() {
  const params = new URLSearchParams();
  selectedColors().forEach(input => params.append("color", input.value));
  for (const [name, control] of Object.entries(controls)) {
    if (!(name === "sort" && control.value === "listed-newest")) CruiserStrongFilters.values(control).forEach(v=>params.append(name,v));
  }
  return params.toString();
}
function syncFilters() {
  if (document.querySelector('#filter-drawer').open) return;
  const query=inventoryFilterQuery();
  history.replaceState(null, '', `#${currentView()}${query?'?'+query:''}`);
  window.CruiserFilterSync?.changed(query);
}
function restoreFilters(query = location.hash.split("?")[1] || "") {
  const params = new URLSearchParams(query);
  const colors = new Set(params.getAll("color"));
  for (const [name, control] of Object.entries(controls)) {
    if(name==='interior')continue;
    const desired=params.getAll(name);
    if(control.multiple) CruiserStrongFilters.set(control,desired);
    else if(desired.length && (control.tagName==='INPUT' || [...control.options||[]].some(o=>o.value===desired[0]))) control.value=desired[0];
  }
  renderInteriorOptions();
  CruiserStrongFilters.set(controls.interior,params.getAll('interior'));
  CruiserStrongFilters.refresh();
  renderColorOptions(colors);
  syncFilters();
  setViewMode(viewMode);
}
function renderActiveFilters() {
  const holder = document.querySelector("#active-filters");
  const active = Object.entries(controls).flatMap(([name,control]) =>
    (name==='sort' && control.value==='listed-newest'?[]:CruiserStrongFilters.values(control)).map(value=>({name,control,value})));
  holder.replaceChildren(...active.map(({name,control,value}) => {
    const label = [...control.options||[]].find(o=>o.value===value)?.textContent || value;
    const filterName = ({type:'Listing type',deal:'Deal quality',minPrice:'Min price',price:'Max price',minMileage:'Min mileage',mileage:'Max mileage',year:'Year',interior:'Interior',age:'Listing age'})[name] || name;
    const chip = text("button", "filter-chip", `${filterName}: ${label} ×`);
    chip.type="button";chip.setAttribute("aria-label",`Remove ${filterName} filter: ${label}`);
    chip.addEventListener("click",()=>{
      CruiserStrongFilters.set(control,control.multiple?CruiserStrongFilters.values(control).filter(v=>v!==value):name==='sort'?'listed-newest':'');
      if(name==='zip')origin=null;
      if(name==='model'){renderColorOptions();renderInteriorOptions();}
      updateFilterToggle();render();syncFilters();
    });return chip;
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
  window.CruiserWatchlist?.changed(key, savedVehicles.has(key));
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
function openResearch(group, row = sortRows([...group.listings])[0]) {
  rememberBrowsing();
  const dialog = document.querySelector("#research-dialog");
  document.querySelector("#research-title").textContent = `${row.year} ${vehicleName(row)}`;
  const body = text("div", "research-body", "");
  const sourceLink = text("a", "details-source-link", `Open source listing on ${row.source} ↗`);
  sourceLink.href = row.listing_url;
  sourceLink.target = "_blank";
  sourceLink.rel = "noopener noreferrer";
  body.append(sourceLink);
  const rating = dealBadge(row);
  if (rating) body.append(rating);
  const layout = text("div", "research-layout", "");
  const media = text("div", "", "");
  const urls = galleryUrls(row);
  if (urls.length) {
    const photo = document.createElement("img");
    photo.src = urls[0]; photo.alt = `${row.year} ${vehicleName(row)}`; photo.className = "research-photo";
    photo.referrerPolicy = "no-referrer";
    let photoIndex = 0;
    const credit = text("p", "photo-credit-details", photoCredit(row, urls[0]));
    const gallery = text("button", "secondary-button", `Browse ${urls.length} photo${urls.length === 1 ? "" : "s"}`);
    photo.addEventListener("error", () => {
      unavailablePhotos.add(urls[photoIndex]);
      photoIndex++;
      if (photoIndex < urls.length) {
        photo.src = urls[photoIndex];
        credit.textContent = photoCredit(row, urls[photoIndex]);
        gallery.textContent = `Browse ${urls.length - photoIndex} photos`;
      } else {
        photo.replaceWith(text("div", "research-photo photo-placeholder", row.model || "Vehicle"));
        credit.textContent = "Photos unavailable";
        gallery.hidden = true;
      }
    });
    media.append(photo, credit);
    gallery.type = "button";
    gallery.addEventListener("click", () => { dialog.close(); openGallery(row, galleryUrls(row), 0); });
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
    researchFact("Truck added to Scout", formatDay(row.vehicle_first_seen || row.first_seen)),
    researchFact("This source first found", formatDay(row.first_seen)),
    researchFact("Title indicator", row.title_status === "unknown" ? "Title unverified — not provided by this source" : row.title_status || "Unknown"),
    researchFact("Ownership", ownerLabel(row)),
    researchFact("Accident history", accidentGroup(row) === "unavailable" ? "History unavailable" : row.accident_history),
    researchFact("Exterior", row.exterior_color || "Unknown"),
    researchFact("Interior", row.interior_color || "Unknown")
  );
  layout.append(media, facts); body.append(layout);
  if (row.source_description) {
    const description = text("section", "research-section", "");
    description.append(text("h3", "", "Source description"));
    const excerpt = text("p", "", row.source_description);
    excerpt.style.whiteSpace = "pre-line";
    description.append(excerpt);
    const source = text("a", "maintenance-source", "Read full auction and current bid on Cars & Bids ↗");
    source.href = row.listing_url; source.target = "_blank"; source.rel = "noopener noreferrer";
    description.append(source);
    body.append(description);
  }
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
  condition.id = "research-maintenance";
  condition.append(text("h3", "", "Maintenance & condition"), conditionRecords(row, group, true));
  const equipment = text("section", "research-section", "");
  equipment.append(text("h3", "", "Equipment evidence"), equipmentHighlights(row, group));
  body.insertBefore(equipment, layout);
  body.insertBefore(condition, layout);
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
    marketMetric("Completed sales", integer.format(marketSales.length), "Historical feed")
  );
  const bins = [[0,20000],[20000,30000],[30000,40000],[40000,50000],[50000,75000],[75000,Infinity]];
  const distribution = bins.map(([min,max]) => active.filter(row => row.asking_price >= min && row.asking_price < max).length);
  document.querySelector("#price-distribution").replaceChildren(...distribution.map((count,index) =>
    chartRow(index === 0 ? "<$20k" : index === 5 ? "$75k+" : `$${bins[index][0]/1000}–${bins[index][1]/1000}k`, count, Math.max(...distribution), String(count))));
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
function changeDate(value) { return formatDate(value).replace(/^Updated /, ""); }
function renderAlerts() {
  if (!changesVisit) return;
  const period = document.querySelector("#changes-window").value;
  const since = period === "visit" ? changesVisit.baseline : new Date(generatedAt.getTime() - Number(period)*864e5).toISOString();
  const events = CruiserChanges.events(inventory, since, generatedAt.toISOString());
  const kind = document.querySelector("#changes-type").value;
  const filtered = events.filter(event => !kind || event.type === kind);
  document.querySelector("#changes-period").textContent = `${period === "visit" && changesVisit.first ? "First visit — showing the last 7 days. " : ""}Changes after ${changeDate(since)} through ${changeDate(generatedAt.toISOString())}. Visit history is saved only in this browser. Reloading the same snapshot keeps this window.${sourceHealth.some(source => ["partial","error"].includes(source.status)) ? " Some source searches were incomplete; this feed may omit changes." : ""}`;
  document.querySelector("#alert-metrics").replaceChildren(...[["new","New trucks"],["drop","Price drops"],["returned","Back for sale"]].map(([type,label]) => marketMetric(label,events.filter(e=>e.type===type).length,"In this time period")));
  const holder = document.querySelector("#alerts-content");
  holder.replaceChildren();
  if (!filtered.length) holder.append(text("p","empty","No matching changes in this period. Try a longer time period or another change type."));
  for (const event of filtered.slice(0,changesShown)) {
    const item = text("article","change-event", "");
    const label = {new:"New truck",drop:"Price drop",returned:"Back for sale"}[event.type];
    item.append(text("span","model-tag",label),text("small","",changeDate(event.at)));
    const button = text("button","change-vehicle",`${event.row.year} ${vehicleName(event.row)}`);
    button.type="button";
    button.addEventListener("click",()=>{
      const group=vehicles.find(g=>g.listings.some(r=>r.listing_key===event.row.listing_key));
      if(group)openResearch(group,event.row);
    });
    item.append(button,text("p","",event.type === "drop" ? `${money.format(event.before)} → ${money.format(event.after)} · Down ${money.format(event.before-event.after)}` : priceLabel(event.row)),text("p","",`${event.row.mileage == null ? "Mileage unavailable" : integer.format(event.row.mileage)+" mi"} · ${[event.row.city,event.row.state].filter(Boolean).join(", ") || "Location unavailable"} · ${CruiserFilters.sourceLabel(event.row.source)}`));
    if(event.type === "drop")item.append(text("small","","Observed asking prices; current asking price may differ."));
    holder.append(item);
  }
  if(filtered.length > changesShown) {
    const more=text("button","secondary-button",`Show more changes (${filtered.length-changesShown} remaining)`);
    more.type="button";more.addEventListener("click",()=>{changesShown+=30;renderAlerts();});holder.append(more);
  }
}
for (const id of ["changes-window","changes-type"]) document.querySelector("#"+id).addEventListener("change",()=>{changesShown=30;renderAlerts();});
document.querySelector("#changes-reviewed").addEventListener("click",()=>{
  if(!changesVisit)return;
  changesVisit={lastSeen:generatedAt.toISOString(),baseline:generatedAt.toISOString(),first:false};saveChangesVisit();
  document.querySelector("#changes-window").value="visit";changesShown=30;renderAlerts();
});
function renderSourceOverview() {
  CruiserCollectionHealth.render(document.querySelector('#collection-health'), inventory, sourceHealth, emailHealth,
    generatedAt.toISOString(), source => CruiserFilters.sourceLabel(CruiserFilters.source(source)));
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
    values: Object.fromEntries(Object.entries(controls).map(([key, control]) => [key, control.multiple?CruiserStrongFilters.values(control):control.value])),
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
    for (const [key, value] of Object.entries(filterSnapshot.values)) CruiserStrongFilters.set(controls[key],value);
    renderInteriorOptions();
    CruiserStrongFilters.set(controls.interior,filterSnapshot.values.interior);
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
  render(); syncFilters();
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
