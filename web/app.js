"use strict";

const ui = {
  listings: document.querySelector("#listings"), empty: document.querySelector("#empty"),
  resultCount: document.querySelector("#result-count"), updated: document.querySelector("#updated"),
  total: document.querySelector("#total-count"), years: document.querySelector("#year-count"),
  sources: document.querySelector("#source-count"), disclaimer: document.querySelector("#disclaimer"),
  color: document.querySelector("#color"), summary: document.querySelector("#summary-strip"),
  medianPrice: document.querySelector("#median-price"), medianMileage: document.querySelector("#median-mileage"),
  cleanCount: document.querySelector("#clean-count"), sourceHealth: document.querySelector("#source-health"),
  form: document.querySelector("#filters")
};

let inventory = [];
const money = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
const integer = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
const controls = ["search", "year", "color", "owners", "accidents", "price", "mileage", "sort"]
  .reduce((all, id) => ({ ...all, [id]: document.querySelector(`#${id}`) }), {});

function value(row, key) { return row[key] ?? ""; }
function listingPrice(row) { return row.asking_price ?? row.current_bid ?? null; }
function priceLabel(row) {
  const amount = listingPrice(row);
  if (amount == null) return "Price unavailable";
  return `${money.format(amount)}${row.current_bid != null && row.asking_price == null ? " current bid" : ""}`;
}
function median(numbers) {
  const values = numbers.filter(Number.isFinite).sort((a, b) => a - b);
  if (!values.length) return null;
  const middle = Math.floor(values.length / 2);
  return values.length % 2 ? values[middle] : (values[middle - 1] + values[middle]) / 2;
}
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
function formatDate(raw) {
  if (!raw) return "Update time unavailable";
  const date = new Date(raw);
  return `Updated ${date.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })} at ${date.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZoneName: "short" })}`;
}

function renderCard(row) {
  const card = document.createElement("article");
  card.className = "listing";
  card.append(text("div", "year-badge", String(row.year)));

  const identity = text("div", "identity", "");
  identity.append(text("h3", "vehicle-title", `${row.exterior_color || "Color unknown"} Lexus LX470`));
  const place = [row.city, row.state].filter(Boolean).join(", ") || "Location unavailable";
  identity.append(text("p", "vehicle-meta", `${place} Â· ${row.seller || row.source}`));
  card.append(identity);

  card.append(makeMetric(priceLabel(row), row.category === "auction" ? "Auction" : "Asking price"));
  card.append(makeMetric(row.mileage == null ? "Mileage unavailable" : `${integer.format(row.mileage)} mi`, row.interior_color || "Interior unknown"));

  const history = text("div", "history", "");
  const owner = row.owners === "1" ? "1 owner" : (row.owners || "Owners unknown");
  history.append(text("span", row.owners === "1" ? "tag good" : "tag", owner));
  history.append(text("span", row.accident_history === "No reported accidents" ? "tag good" : "tag", row.accident_history || "History unknown"));
  card.append(history);

  const link = text("a", "open-link", "â†—");
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
    && (!controls.color.value || row.exterior_color === controls.color.value)
    && (!controls.owners.value || (controls.owners.value === "1" ? row.owners === "1" : row.owners !== "1"))
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
  ui.medianPrice.textContent = price == null ? "â€”" : money.format(price);
  ui.medianMileage.textContent = mileage == null ? "â€”" : `${integer.format(mileage)} mi`;
  ui.cleanCount.textContent = String(rows.filter(row => row.accident_history === "No reported accidents").length);
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
  } catch (error) {
    ui.listings.setAttribute("aria-busy", "false");
    ui.listings.replaceChildren(text("p", "loading", "The inventory could not be loaded. Please refresh in a moment."));
    ui.resultCount.textContent = "Inventory unavailable";
    console.error(error);
  }
}

ui.form.addEventListener("input", render);
ui.form.addEventListener("reset", () => setTimeout(render, 0));
document.querySelector("#empty-reset").addEventListener("click", reset);
load();

