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
  marketSource: document.querySelector("#market-source"),
  form: document.querySelector("#filters")
};

let inventory = [];
let marketSales = [];
let generatedAt = new Date();
const money = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
const integer = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
const controls = ["search", "status", "year", "color", "owners", "accidents", "price", "mileage", "sort"]
  .reduce((all, id) => ({ ...all, [id]: document.querySelector(`#${id}`) }), {});

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
function text(tag, className, content) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  node.textContent = content;
  return node;
}
function makeMetric(main, label) {
  const node = text("div", "metric", "");
  node.append(text("strong", "", main), text("span", "", label));
  return node;
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

function renderCard(row) {
  const card = document.createElement("article");
  card.className = "listing";
  const media = text("div", row.photo_url ? "listing-media" : "listing-media photo-missing", "");
  if (row.photo_url) {
    const photo = document.createElement("img");
    photo.src = row.photo_url;
    photo.alt = `${row.year} ${row.exterior_color || ""} Lexus LX470`.replace(/\s+/g, " ").trim();
    photo.loading = "lazy";
    photo.decoding = "async";
    photo.referrerPolicy = "no-referrer";
    photo.addEventListener("error", () => {
      photo.remove();
      media.classList.add("photo-missing");
      media.prepend(text("span", "photo-placeholder", "LX"));
    }, { once: true });
    media.append(photo);
  } else {
    media.append(text("span", "photo-placeholder", "LX"));
  }
  media.append(text("span", "year-badge", String(row.year)));
  card.append(media);

  const identity = text("div", "identity", "");
  identity.append(text("span", `sale-state state-${saleState(row)}`, saleStateLabel(row)));
  const title = text("h3", "vehicle-title", `${row.exterior_color || "Color unknown"} Lexus `);
  const wordmark = text("span", "model-wordmark", "");
  wordmark.setAttribute("role", "img");
  wordmark.setAttribute("aria-label", "LX470");
  title.append(wordmark);
  identity.append(title);
  const place = [row.city, row.state].filter(Boolean).join(", ") || "Location unavailable";
  identity.append(text("p", "vehicle-meta", `${place} \u00b7 ${row.seller || row.source}`));
  identity.append(text("p", "vehicle-meta timing", statusTiming(row)));
  card.append(identity);

  card.append(makeMetric(priceLabel(row), row.status === "sold" ? "Final recorded price" : row.category === "auction" ? "Auction price" : "Asking price"));
  card.append(makeMetric(row.mileage == null ? "Mileage unavailable" : `${integer.format(row.mileage)} mi`, row.interior_color || "Interior unknown"));
  card.append(listingDates(row));

  const history = text("div", "history", "");
  const ownerTag = text("span", ownerGroup(row) === "1" ? "tag good" : "tag", ownerLabel(row));
  if (ownerGroup(row) !== "unknown" && row.owners_verified_at) {
    ownerTag.title = `Verified ${row.owners_verified_at}${row.owners_source ? ` via ${row.owners_source}` : ""}`;
  }
  history.append(ownerTag);
  history.append(text("span", row.accident_history === "No reported accidents" ? "tag good" : "tag", row.accident_history || "History unknown"));
  card.append(history);

  const link = text("a", "open-link", "\u2197");
  link.href = row.listing_url;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  link.setAttribute("aria-label", `Open ${row.year} LX470 listing on ${row.source}`);
  card.append(link);
  return card;
}

function matches(row) {
  const query = controls.search.value.trim().toLowerCase();
  const haystack = [row.city, row.state, row.seller, row.vin, row.exterior_color, row.interior_color, row.source].join(" ").toLowerCase();
  const amount = listingPrice(row);
  return (!query || haystack.includes(query))
    && (!controls.year.value || String(row.year) === controls.year.value)
    && (!controls.status.value || saleState(row) === controls.status.value)
    && (!controls.color.value || row.exterior_color === controls.color.value)
    && (!controls.owners.value || ownerGroup(row) === controls.owners.value)
    && (!controls.accidents.value || (controls.accidents.value === "none" ? row.accident_history === "No reported accidents" : row.accident_history !== "No reported accidents"))
    && (!controls.price.value || (amount != null && amount <= Number(controls.price.value)))
    && (!controls.mileage.value || (row.mileage != null && row.mileage <= Number(controls.mileage.value)));
}

function sortRows(rows) {
  const missing = Number.MAX_SAFE_INTEGER;
  const strategies = {
    "price-asc": (a, b) => (listingPrice(a) ?? missing) - (listingPrice(b) ?? missing),
    "mileage-asc": (a, b) => (a.mileage ?? missing) - (b.mileage ?? missing),
    "newest": (a, b) => String(b.first_seen).localeCompare(String(a.first_seen)),
    "year-desc": (a, b) => b.year - a.year || (listingPrice(a) ?? missing) - (listingPrice(b) ?? missing)
  };
  return rows.sort(strategies[controls.sort.value]);
}

function render() {
  const rows = sortRows(inventory.filter(matches));
  ui.listings.replaceChildren(...rows.map(renderCard));
  ui.listings.setAttribute("aria-busy", "false");
  ui.listings.hidden = rows.length === 0;
  ui.empty.hidden = rows.length !== 0;
  ui.resultCount.textContent = `${rows.length} of ${inventory.length} listing${inventory.length === 1 ? "" : "s"}`;
  ui.summary.hidden = rows.length === 0;
  const price = median(rows.map(listingPrice));
  const mileage = median(rows.map(row => row.mileage));
  ui.medianPrice.textContent = price == null ? "\u2014" : money.format(price);
  ui.medianMileage.textContent = mileage == null ? "\u2014" : `${integer.format(mileage)} mi`;
  ui.cleanCount.textContent = String(rows.filter(row => row.accident_history === "No reported accidents").length);
}

function renderMarket() {
  const months = Number(ui.marketPeriod.value || 24);
  const cutoff = new Date(generatedAt);
  cutoff.setUTCMonth(cutoff.getUTCMonth() - months);
  const year = ui.marketYear.value;
  const sales = marketSales.filter(sale => (!year || String(sale.year) === year)
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
  render();
}

async function load() {
  try {
    const response = await fetch("inventory.json", { cache: "no-store" });
    if (!response.ok) throw new Error(`Inventory request returned ${response.status}`);
    const data = await response.json();
    inventory = Array.isArray(data.listings) ? data.listings : [];
    marketSales = Array.isArray(data.market_history?.sales) ? data.market_history.sales : [];
    generatedAt = new Date(data.generated_at || Date.now());
    ui.marketSource.textContent = data.market_history?.source || "Completed auction results";
    ui.updated.textContent = formatDate(data.generated_at);
    ui.disclaimer.textContent = data.disclaimer;
    ui.total.textContent = integer.format(inventory.length);
    ui.years.textContent = new Set(inventory.map(row => row.year)).size;
    ui.sources.textContent = new Set(inventory.map(row => row.source)).size;

    [...new Set(inventory.map(row => row.exterior_color).filter(Boolean))].sort()
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

ui.form.addEventListener("input", render);
ui.marketPeriod.addEventListener("input", renderMarket);
ui.marketYear.addEventListener("input", renderMarket);
ui.form.addEventListener("reset", () => setTimeout(render, 0));
document.querySelector("#empty-reset").addEventListener("click", reset);
load();
