"use strict";

// Marketplace labels are not factory evidence. Keep normalization in one place so
// every dynamic facet and its matching predicate use the same canonical value.
const CruiserFilters = (() => {
  const OTHER_COLOR = "__other_color__";
  const MISSING_COLOR = "__missing_color__";

  function token(value) {
    return String(value ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  }

  function model(value) {
    const name = token(value).replace(/^(lexus|toyota) /, "").replace(/ /g, "");
    if (name === "lx470") return "LX470";
    if (name === "lx570") return "LX570";
    if (name === "landcruiser") return "Land Cruiser";
    return token(value);
  }

  function modelLabel(value) {
    if (value === "LX470" || value === "LX570") return `Lexus ${value}`;
    if (value === "Land Cruiser") return "Toyota Land Cruiser";
    return value;
  }

  function source(value) {
    const name = token(value).replace(/ /g, "");
    if (name === "cargurus" || name === "truecar" || name === "bringatrailer") return name;
    return token(value);
  }

  function sourceLabel(value) {
    return ({ cargurus: "CarGurus", truecar: "TrueCar", bringatrailer: "Bring a Trailer" })[value] || value;
  }

  function facetOptions(values, canonical, label) {
    const options = new Map();
    for (const raw of values) {
      const value = canonical(raw);
      if (value && !options.has(value)) options.set(value, label(value));
    }
    return [...options].sort((a, b) => a[1].localeCompare(b[1], "en-US"));
  }

  function colorFamily(value) {
    const name = token(value);
    if (["black", "white", "silver", "gray", "grey", "gold", "beige", "tan", "green", "blue", "red"].includes(name)) {
      return ({ grey: "gray", beige: "gold", tan: "gold" })[name] || name;
    }
    return "";
  }

  function colorEntries(reference, kind, year, modelValue) {
    const catalogue = reference?.models?.[model(modelValue)];
    if (kind === "exterior") {
      const entries = catalogue?.exterior || (model(modelValue) === "LX470" ? reference?.exterior : []);
      return (entries || []).filter(entry => !entry.years || entry.years.includes(Number(year)));
    }
    const entries = catalogue?.interior_by_year?.[String(year)]
      || (model(modelValue) === "LX470" ? reference?.interior_by_year?.[String(year)] : []);
    return entries || [];
  }

  function color(reference, kind, raw, year, modelValue) {
    const reported = String(raw ?? "").trim();
    if (!reported || ["unknown", "not specified", "not reported", "n a", "none"].includes(token(reported)))
      return { key: MISSING_COLOR, name: "Unknown", swatch: "", code: "", factory: false, confidence: "missing", reported };
    const entries = colorEntries(reference, kind, year, modelValue);
    const codeMatch = reported.match(/^\[([0-9][a-z0-9]{2})\]\s*/i) || reported.match(/\s*\(([0-9][a-z0-9]{2})\)$/i);
    const paintCode = codeMatch?.[1]?.toUpperCase();
    const description = token(reported.replace(/^\[[0-9][a-z0-9]{2}\]\s*/i, "").replace(/\s*\([0-9][a-z0-9]{2}\)$/i, ""));
    let entry = paintCode && entries.find(item => item.code?.toUpperCase() === paintCode);
    let confidence = entry ? "code" : "";
    if (paintCode && !entry) return { key: OTHER_COLOR, name: reported, swatch: "", code: "", factory: false, confidence: "unverified", reported };
    const family = colorFamily(description);
    if (!entry && family) {
      const candidates = entries.filter(item => item.family === family);
      if (candidates.length === 1) {
        entry = candidates[0];
        confidence = "family";
      } else {
        return { key: OTHER_COLOR, name: reported, swatch: "", code: "", factory: false, confidence: "unverified", reported };
      }
    }
    if (!entry) {
      entry = entries.find(item => [item.name, ...(item.aliases || [])].some(alias => token(alias) === description));
      if (entry) confidence = "name";
    }
    if (!entry) return { key: OTHER_COLOR, name: reported, swatch: "", code: "", factory: false, confidence: "unverified", reported };
    return { ...entry, key: entry.filter_key || entry.name, filterLabel: entry.filter_label || entry.name,
      code: confidence === "family" ? "" : entry.code || "", factory: true, confidence, reported };
  }

  function colorOptions(rows, reference) {
    const names = new Map();
    let other = false;
    let missing = false;
    for (const row of rows) {
      const result = color(reference, "exterior", row.exterior_color, row.year, row.model);
      if (result.key === OTHER_COLOR) other = true;
      else if (result.key === MISSING_COLOR) missing = true;
      else names.set(result.key, result.filterLabel);
    }
    const options = [...names].sort((a, b) => a[1].localeCompare(b[1], "en-US"));
    if (other) options.push([OTHER_COLOR, "Other / unverified"]);
    if (missing) options.push([MISSING_COLOR, "Color not reported"]);
    return options;
  }

  return { OTHER_COLOR, MISSING_COLOR, token, model, modelLabel, source, sourceLabel, facetOptions, color, colorOptions };
})();

if (typeof module !== "undefined" && module.exports) module.exports = CruiserFilters;
