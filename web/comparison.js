"use strict";

// Keep one selected listing per vehicle, even when filters change its card's source.
const comparisonSelection = new Map();
try {
  const saved = JSON.parse(sessionStorage.getItem("cruiser-scout-comparison") || "[]");
  if (Array.isArray(saved)) saved.slice(0, 4).forEach(entry => {
    if (Array.isArray(entry) && entry.length === 2 && entry.every(value => typeof value === "string"))
      comparisonSelection.set(...entry);
  });
} catch { /* Comparison still works when browser storage is unavailable. */ }

function comparisonVehicles() {
  return [...comparisonSelection].flatMap(([key, listingKey]) => {
    const group = vehicles.find(vehicle => vehicle.vehicleKey === key);
    if (!group) return [];
    const row = group.listings.find(listing => listing.listing_key === listingKey)
      || group.listings.find(listing => listing.status === "active") || group.listings[0];
    return [{ group, row }];
  });
}

function comparisonButton(row, group) {
  const button = text("button", "compare-select secondary-button", "Compare");
  button.type = "button";
  button.dataset.vehicleKey = group.vehicleKey;
  button.dataset.vehicleLabel = `${row.year} ${vehicleName(row)}`;
  button.addEventListener("click", () => {
    if (comparisonSelection.has(group.vehicleKey)) comparisonSelection.delete(group.vehicleKey);
    else if (comparisonSelection.size < 4) comparisonSelection.set(group.vehicleKey, row.listing_key);
    syncComparison();
  });
  return button;
}

function removeComparison(key) {
  comparisonSelection.delete(key);
  syncComparison();
  if (document.querySelector("#compare-dialog").open) renderComparison();
}

function syncComparison() {
  const selected = comparisonVehicles();
  const valid = new Set(selected.map(({ group }) => group.vehicleKey));
  for (const key of comparisonSelection.keys()) if (!valid.has(key)) comparisonSelection.delete(key);
  try { sessionStorage.setItem("cruiser-scout-comparison", JSON.stringify([...comparisonSelection])); }
  catch { /* Storage is optional. */ }
  const count = selected.length;
  document.querySelectorAll(".compare-select").forEach(button => {
    const checked = comparisonSelection.has(button.dataset.vehicleKey);
    button.textContent = checked ? "✓ In comparison" : "Compare";
    button.setAttribute("aria-pressed", String(checked));
    button.setAttribute("aria-label", `${checked ? "Remove from" : "Add to"} comparison: ${button.dataset.vehicleLabel}`);
    button.disabled = !checked && count === 4;
    button.title = !checked && count === 4 ? "Remove a truck from comparison to add another (maximum 4)." : "";
  });
  document.querySelector("#compare-tray").hidden = count === 0;
  document.body.classList.toggle("has-comparison", count > 0);
  document.querySelector("#compare-status").textContent = count === 4
    ? "4 of 4 trucks selected. Remove one to add another."
    : `${count} of 4 trucks selected${count === 1 ? " · Select one more to compare" : ""}`;
  const open = document.querySelector("#compare-open");
  open.disabled = count < 2;
  open.textContent = `Compare (${count})`;
  document.querySelector("#compare-selected").replaceChildren(...selected.map(({ group, row }) => {
    const chip = text("button", "filter-chip", `${row.year} ${vehicleName(row)} · ${row.vin ? row.vin.slice(-6) : row.source} ×`);
    chip.type = "button";
    chip.setAttribute("aria-label", `Remove ${row.year} ${vehicleName(row)} from comparison`);
    chip.addEventListener("click", () => removeComparison(group.vehicleKey));
    return chip;
  }));
}

function comparisonSource(row, label = row.source) {
  const link = text("a", "", label || "View listing");
  link.href = row.listing_url;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  return link;
}

function comparisonEvidence(group, describe) {
  const holder = text("div", "comparison-evidence", "");
  for (const listing of group.listings) {
    const description = describe(listing);
    if (!description) continue;
    const item = text("p", "", description + " · ");
    item.append(comparisonSource(listing));
    holder.append(item);
  }
  if (!holder.childElementCount) holder.textContent = "Unknown / not documented";
  return holder;
}

function renderComparison() {
  const selected = comparisonVehicles();
  const holder = document.querySelector("#compare-content");
  if (selected.length < 2) {
    holder.replaceChildren(text("p", "empty", "Select at least two trucks to compare. Close this window to add another truck."));
    return;
  }
  const table = document.createElement("table");
  table.className = "comparison-table";
  table.append(text("caption", "", "Vehicle comparison — scroll sideways to see every truck. Prices and basic details use the selected listing; history and maintenance include all tracked sources."));
  const head = document.createElement("thead");
  const header = document.createElement("tr");
  const label = text("th", "", "Details");
  label.scope = "col";
  header.append(label);
  selected.forEach(({ group, row }) => {
    const cell = document.createElement("th");
    cell.scope = "col";
    if (row.photo_url) {
      const photo = document.createElement("img");
      photo.src = row.photo_url;
      photo.alt = `${row.year} ${vehicleName(row)}`;
      photo.addEventListener("error", () => { photo.hidden = true; });
      cell.append(photo);
    }
    cell.append(text("strong", "", `${row.year} ${vehicleName(row)}`),
      text("small", "", row.vin || "VIN unavailable"), comparisonSource(row, `View on ${row.source}`));
    const remove = text("button", "secondary-button", "Remove");
    remove.type = "button";
    remove.setAttribute("aria-label", `Remove ${row.year} ${vehicleName(row)} from comparison`);
    remove.addEventListener("click", () => {
      removeComparison(group.vehicleKey);
      document.querySelector("#compare-close").focus();
    });
    cell.append(remove);
    header.append(cell);
  });
  head.append(header);
  table.append(head);
  const fields = [
    ["Status", ({ row }) => saleStateLabel(row)],
    ["Price", ({ row }) => priceLabel(row)],
    ["Mileage", ({ row }) => row.mileage == null ? "Unknown" : `${integer.format(row.mileage)} mi`],
    ["Exterior", ({ row }) => resolveFactoryColor("exterior", row.exterior_color, row.year, row.model).name],
    ["Interior", ({ row }) => resolveFactoryColor("interior", row.interior_color, row.year, row.model).name],
    ["Location", ({ row }) => [row.city, row.state].filter(Boolean).join(", ") || "Unknown"],
    ["Seller", ({ row }) => row.seller || "Unknown"],
    ["Ownership", ({ group }) => comparisonEvidence(group, listing => ownerLabel(listing))],
    ["Accident history", ({ group }) => comparisonEvidence(group, listing => listing.accident_history || "History unavailable")],
    ["Title", ({ group }) => comparisonEvidence(group, listing => listing.title_status || "Unknown")],
    ["Last seen", ({ row }) => formatMoment(row.last_seen)],
    ["Freshness", ({ row }) => freshnessLabel(row) || (row.status === "active" ? "Seen within the last 24 hours" : saleStateLabel(row))],
    ["Listed", ({ row }) => row.listed_at ? `${formatDay(row.listed_at)}${row.listed_at_is_estimated ? " (estimated)" : ""}` : "Unknown"],
    ["Tracked listings", ({ group }) => comparisonEvidence(group, listing => `${saleStateLabel(listing)} · ${priceLabel(listing)}`)],
  ];
  for (const [key, name] of [["timing_belt", "Timing belt"], ["ahc", "AHC"], ["rust", "Rust"],
    ["service_records", "Service records"], ["modifications", "Modifications"], ["navigation", "Navigation"]]) {
    fields.push([name, ({ group }) => comparisonEvidence(group, listing =>
      listing[`${key}_status`] && listing[`${key}_evidence`]
        ? `${listing[`${key}_status`]}: ${listing[`${key}_evidence`]}` : "")]);
  }
  const body = document.createElement("tbody");
  fields.forEach(([name, read]) => {
    const row = document.createElement("tr");
    const heading = text("th", "", name);
    heading.scope = "row";
    row.append(heading);
    selected.forEach(vehicle => {
      const cell = document.createElement("td");
      const value = read(vehicle);
      cell.append(typeof value === "string" ? document.createTextNode(value) : value);
      row.append(cell);
    });
    body.append(row);
  });
  table.append(body);
  holder.replaceChildren(table);
}

document.querySelector("#compare-open").addEventListener("click", () => {
  if (comparisonVehicles().length < 2) return;
  renderComparison();
  document.querySelector("#compare-dialog").showModal();
});
document.querySelector("#compare-clear").addEventListener("click", () => {
  comparisonSelection.clear();
  syncComparison();
});
document.querySelector("#compare-close").addEventListener("click", () => document.querySelector("#compare-dialog").close());
document.querySelector("#compare-dialog").addEventListener("click", event => {
  if (event.target.id === "compare-dialog") event.target.close();
});
