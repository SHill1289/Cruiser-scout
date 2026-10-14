"use strict";

const ui = {
  listings: document.querySelector("#listings"), empty: document.querySelector("#empty"),
  resultCount: document.querySelector("#result-count"), updated: document.querySelector("#updated"),
  total: document.querySelector("#total-count"), years: document.querySelector("#year-count"),
  sources: document.querySelector("#source-count"), disclaimer: document.querySelector("#disclaimer"),
  color: document.querySelector("#color"), summary: document.querySelector("#summary-strip"),
  medianPrice: document.querySelector("#median-price"), medianMileage: document.querySelector("#median-mileage"),
  cleanCount: document.querySelector("#clean-count"), sourceHealth: document.querySelector("#source-health"),
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
const controls = ["search", "model", "status", "color", "owners", "accidents", "price", "mileage", "zip", "radius", "sort"]
  .reduce((all, id) => ({ ...all, [id]: document.querySelector(`#${id}`) }), {});

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
  ui.photoCount.textContent = (index + 1) + " of " + urls.length;
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
  activeGallery = { row, urls, index };
  showLargePhoto();
  ui.photoDialog.showModal();
}
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
function normalizedColorName(raw) {
  return String(raw || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}
function resolveFactoryColor(kind, raw, year, model = "LX470") {
  const reported = normalizedColorName(raw);
  const entries = model === "Land Cruiser" ? [] : kind === "exterior"
    ? colorReference.exterior || []
    : colorReference.interior_by_year?.[String(year)] || [];
  if (!reported) return { name: "Unknown", swatch: "", code: "", factory: false, reported: "" };
  const match = entries.find(entry => [entry.name, ...(entry.aliases || [])]
    .map(normalizedColorName).includes(reported));
  return match ? { ...match, factory: true, reported: raw }
    : { name: raw, swatch: "", code: "", factory: false, reported: raw };
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
    ? `Lexus factory color${color.code ? `, paint code ${color.code}` : ""}. Swatch is a screen approximation.${color.reported && normalizedColorName(color.reported) !== normalizedColorName(color.name) ? ` Listing reported ${color.reported}.` : ""}`
    : color.reported ? `Marketplace color: ${color.reported}. Exact factory color is not verified.` : `${label} color unavailable.`;
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
  dates.append(listed, added);
  return dates;
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
  const badge = text("span", `deal-rating deal-${row.deal_quality}`, labels[row.deal_quality]);
  const difference = Number(row.deal_percent_vs_median);
  const comparison = difference === 0 ? "matches" : `${Math.abs(difference)}% ${difference < 0 ? "below" : "above"}`;
  badge.title = `Asking price ${comparison} the ${money.format(row.deal_median_price)} median of ${row.deal_comparable_count} completed sales in the ${row.deal_mileage_band} mileage range. Price comparison does not account for condition, maintenance or modifications.`;
  badge.setAttribute("aria-label", `${labels[row.deal_quality]}. ${badge.title}`);
  return badge;
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
      counter.textContent = (index + 1) + " / " + photos.length;
    };
    photo.addEventListener("error", () => {
      failed.add(Number(photo.dataset.index));
      const next = photos.findIndex((_, position) => !failed.has(position));
      if (next >= 0) show(next);
      else {
        trigger.remove();
        media.classList.add("photo-missing");
        media.prepend(text("span", "photo-placeholder", row.model === "Land Cruiser" ? "LC" : "LX"));
        counter.remove();
        media.querySelectorAll(".photo-step").forEach(button => button.remove());
      }
    });
    trigger.addEventListener("click", () => {
      const available = photos.filter((_, position) => !failed.has(position));
      openGallery(row, available, Math.max(0, available.indexOf(photos[index])));
    });
    trigger.append(photo);
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
    media.append(text("span", "photo-placeholder", row.model === "Land Cruiser" ? "LC" : "LX"));
  }
  media.append(text("span", "year-badge", String(row.year)));
  card.append(media);

  const identity = text("div", "identity", "");
  const stateRow = text("div", "listing-state-row", "");
  stateRow.append(text("span", `sale-state state-${saleState(row)}`, saleStateLabel(row)));
  if (group.listings.length > 1) stateRow.append(text("span", "duplicate-badge", `${group.listings.length} listings · same VIN`));
  const accidentReports = new Set(group.listings.map(accidentGroup));
  if (accidentReports.has("reported") && accidentReports.has("none"))
    stateRow.append(text("span", "duplicate-conflict-badge", "History differs by source"));
  else if (accidentReports.has("reported") && accidentGroup(row) !== "reported")
    stateRow.append(text("span", "duplicate-conflict-badge", "Accident reported on another source"));
  const rating = dealBadge(row);
  if (rating) stateRow.append(rating);
  const rustLocation = rustLocationBadge(row);
  if (rustLocation) stateRow.append(rustLocation);
  identity.append(stateRow);
  const exterior = resolveFactoryColor("exterior", row.exterior_color, row.year, row.model);
  const title = text("h3", "vehicle-title", vehicleName(row));
  identity.append(title);
  const place = [row.city, row.state].filter(Boolean).join(", ") || "Location unavailable";
  identity.append(text("p", "vehicle-meta", `${place} \u00b7 ${row.seller || row.source}`));
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
  card.append(link);
  const others = otherListings(group);
  if (others) card.append(others);
  return card;
}

function matches(row) {
  const query = controls.search.value.trim().toLowerCase();
  const factoryExterior = resolveFactoryColor("exterior", row.exterior_color, row.year, row.model);
  const factoryInterior = resolveFactoryColor("interior", row.interior_color, row.year, row.model);
  const haystack = [vehicleName(row), row.city, row.state, row.seller, row.vin, row.exterior_color, row.interior_color,
    factoryExterior.name, factoryInterior.name, row.source].join(" ").toLowerCase();
  const amount = listingPrice(row);
  return (!query || haystack.includes(query))
    && (!controls.model.value || (row.model || "LX470") === controls.model.value)
    && (!controls.status.value || saleState(row) === controls.status.value)
    && (!controls.color.value || factoryExterior.name === controls.color.value)
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
    "mileage-asc": (a, b) => (a.mileage ?? missing) - (b.mileage ?? missing),
    "listed-newest": (a, b) => listedTime(b) - listedTime(a) || String(b.first_seen || "").localeCompare(String(a.first_seen || "")),
    "newest": (a, b) => String(b.first_seen).localeCompare(String(a.first_seen)),
    "distance-asc": (a, b) => (distanceTo(a) ?? missing) - (distanceTo(b) ?? missing)
  };
  return rows.sort(strategies[controls.sort.value === "distance-asc" && !origin ? "price-asc" : controls.sort.value]);
}

function renderMap(rows, cards) {
  const locations = [];
  rows.forEach((row, index) => {
    const point = rowPoint(row);
    if (!point) return;
    const xy = mapPoint(...point, row.state);
    if (!xy) return;
    let location = locations.find(item => Math.hypot(item.xy[0] - xy[0], item.xy[1] - xy[1]) < 21);
    if (!location) { location = { xy, rows: [], firstCard: cards[index] }; locations.push(location); }
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
    const jump = () => location.firstCard.scrollIntoView({ behavior: "smooth", block: "center" });
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

function render() {
  const groups = vehicles.map(group => ({ ...group, matched: group.listings.filter(matches) }))
    .filter(group => controls.accidents.value !== "none" || !group.listings.some(listing => accidentGroup(listing) === "reported"))
    .filter(group => group.matched.length);
  for (const group of groups) group.primary = sortRows(group.matched)[0];
  const rows = sortRows(groups.map(group => group.primary));
  const byPrimary = new Map(groups.map(group => [group.primary.listing_key, group]));
  const cards = rows.map(row => renderCard(row, byPrimary.get(row.listing_key)));
  ui.listings.replaceChildren(...cards);
  renderMap(rows, cards);
  ui.listings.setAttribute("aria-busy", "false");
  ui.listings.hidden = rows.length === 0;
  ui.empty.hidden = rows.length !== 0;
  const matchedListings = groups.reduce((count, group) => count + group.matched.length, 0);
  ui.resultCount.textContent = `${rows.length} of ${vehicles.length} truck${vehicles.length === 1 ? "" : "s"} · ${matchedListings} listing${matchedListings === 1 ? "" : "s"}`;
  ui.summary.hidden = rows.length === 0;
  const price = median(rows.map(listingPrice));
  const mileage = median(rows.map(row => row.mileage));
  ui.medianPrice.textContent = price == null ? "\u2014" : money.format(price);
  ui.medianMileage.textContent = mileage == null ? "\u2014" : `${integer.format(mileage)} mi`;
  ui.cleanCount.textContent = String(rows.filter(row => accidentGroup(row) === "none" &&
    !byPrimary.get(row.listing_key).listings.some(listing => accidentGroup(listing) === "reported")).length);
}

function renderMarket() {
  const months = Number(ui.marketPeriod.value || 24);
  const cutoff = new Date(generatedAt);
  cutoff.setUTCMonth(cutoff.getUTCMonth() - months);
  const year = ui.marketYear.value;
  const model = ui.marketModel.value;
  const sales = marketSales.filter(sale => (!model || (sale.model || "LX470") === model) && (!year || String(sale.year) === year)
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
  ui.form.reset();
  origin = null;
  ui.distanceStatus.classList.remove("error");
  ui.distanceStatus.textContent = "Enter a ZIP to see approximate straight-line distances.";
  updateFilterToggle();
  render();
}

function updateFilterToggle() {
  const active = ["color", "owners", "accidents", "price", "mileage"]
    .filter(id => controls[id].value).length;
  const expanded = ui.form.classList.contains("filters-expanded");
  ui.filterToggle.textContent = `${expanded ? "Hide" : "More"} filters${active ? ` (${active})` : ""}`;
  ui.filterToggle.setAttribute("aria-expanded", String(expanded));
}

async function load() {
  try {
    const response = await fetch("inventory.json", { cache: "no-store" });
    if (!response.ok) throw new Error(`Inventory request returned ${response.status}`);
    const data = await response.json();
    try {
      const colorResponse = await fetch("factory-colors.json", { cache: "no-store" });
      if (colorResponse.ok) colorReference = await colorResponse.json();
    } catch (colorError) {
      console.warn("Factory color reference unavailable", colorError);
    }
    inventory = Array.isArray(data.listings) ? data.listings : [];
    vehicles = listingGroups(inventory, Array.isArray(data.vehicles) ? data.vehicles : []);
    marketSales = Array.isArray(data.market_history?.sales) ? data.market_history.sales : [];
    generatedAt = new Date(data.generated_at || Date.now());
    ui.marketSource.textContent = data.market_history?.source || "Completed auction results";
    ui.updated.textContent = formatDate(data.generated_at);
    ui.disclaimer.textContent = data.disclaimer;
    ui.total.textContent = integer.format(inventory.length);
    ui.years.textContent = new Set(inventory.map(row => row.year)).size;
    ui.sources.textContent = new Set(inventory.map(row => row.source)).size;

    [...new Set(inventory.map(row => resolveFactoryColor("exterior", row.exterior_color, row.year, row.model).name)
      .filter(name => name && name !== "Unknown"))].sort()
      .forEach(color => ui.color.add(new Option(color, color)));
    (data.source_health || []).forEach(source => {
      const row = text("div", "health-row", "");
      row.append(text("strong", "", source.source || "Source"), text("span", "", source.status || "Unknown"));
      ui.sourceHealth.append(row);
    });
    render();
    renderMarket();
  } catch (error) {
    ui.listings.setAttribute("aria-busy", "false");
    ui.listings.replaceChildren(text("p", "loading", "The inventory could not be loaded. Please refresh in a moment."));
    ui.resultCount.textContent = "Inventory unavailable";
    console.error(error);
  }
}

ui.form.addEventListener("input", () => { updateFilterToggle(); render(); });
controls.zip.addEventListener("input", updateOrigin);
ui.filterToggle.addEventListener("click", () => {
  ui.form.classList.toggle("filters-expanded");
  updateFilterToggle();
});
ui.marketPeriod.addEventListener("input", renderMarket);
ui.marketYear.addEventListener("input", renderMarket);
ui.marketModel.addEventListener("input", renderMarket);
ui.form.addEventListener("reset", () => setTimeout(() => {
  origin = null;
  ui.distanceStatus.classList.remove("error");
  ui.distanceStatus.textContent = "Enter a ZIP to see approximate straight-line distances.";
  updateFilterToggle(); render();
}, 0));
document.querySelector("#empty-reset").addEventListener("click", reset);
load();
