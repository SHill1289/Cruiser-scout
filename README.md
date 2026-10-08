# Raptor Finder

A clone of SHill1289/lx470-finder for nationwide Ford F-150 Raptors with asking prices **strictly below $30,000**, clean-title evidence and **no reported accidents**.

## Vercel preview and deployment

The existing Vercel integration automatically publishes preview deployments for this branch. The LX production app remains on its current production branch. A separate Vercel project is optional if you want a dedicated production URL for the Raptor app.

The app is isolated on the `raptor-finder` branch of `SHill1289/lx470-finder`; the original LX app remains on `main`. Deploy it as a separate Vercel project, using `raptor-finder` as the production branch. Do not merge this standalone app branch into the LX app. Import the repository at https://vercel.com/new, then choose the `raptor-finder` Git branch in the project configuration. Keep the framework as **Other** and leave the root directory at the repository root. The included `vercel.json` sets the output directory to `web`; no build command, API keys or external database are required. The GitHub repository may stay private. Choose your Vercel deployment access settings before sharing the app.

GitHub Actions refreshes every six hours (00:17, 06:17, 12:17 and 18:17 UTC), commits the new inventory and triggers Vercel's normal Git deployment after the project is imported. You can also run **Raptor scheduled refresh → Run workflow** from the default branch; it checks out and updates only `raptor-finder`. GitHub only schedules workflows defined on the default branch, so `.github/workflows/raptor_refresh.yml` on `main` supplies the schedule while the app and inventory remain isolated on `raptor-finder`. Schedules may be delayed. The workflow visibly fails on incomplete collection while preserving source status and successful observations.

## What qualifies

- The source identifies the make as Ford, model as F-150 and trim as Raptor, SVT Raptor or Raptor R. Appearance conversions and other F-150 trims do not qualify.
- The listing is active retail inventory, has clean-title evidence, and supplies a finite USD asking price greater than zero and strictly below $30,000. Exactly $30,000, missing prices and auction bids do not qualify.
- Accident history explicitly says **No reported accidents**. Missing history is excluded. A conflicting explicit accident report on the same validated VIN blocks the truck, including retained earlier evidence.
- All F-150 Raptor model years are covered. There were no 2015–2016 F-150 Raptors.

These are source-reported facts. No report can rule out an unreported accident. Check availability, the physical title and a current history report, inspect the frame and shocks, and review service history. Dealer fees, taxes and shipping may be additional.

## Coverage

TrueCar's public nationwide Raptor search is the validated automatic source. Its Raptor filter includes first-generation trucks; the unsupported `svt-raptor` URL returned fallback ordinary F-150s and is deliberately unused. The collector verifies applied Ford/F-150/Raptor and price filters, checks pagination offsets, and follows up to ten public result pages. Count changes, repeated entire pages and incomplete coverage cannot remove missing trucks.

CarGurus, CARFAX, Cars.com and Autotrader do not currently have validated Raptor collectors here. Checked manual imports are supported. Source status is visible in the dashboard. This is not a claim of exhaustive nationwide marketplace coverage.

The dashboard preserves photos, seller/source links, VIN matching, color/owner/price/mileage filters, sorting, ZIP distances, source status and a US map. Photos depend on availability from the source; current searches supply a lead photograph. Colors are source-reported and have no invented Ford paint codes. ZIP distances are straight-line estimates from Census ZIP areas, not routes or exact dealer addresses. Lexus inventory, overrides, paint codes, photos, service claims and historical sale comparables were not copied. Market/deal ratings are disabled until appropriate Raptor sales evidence is available.

## Structure

`src/finder.py` collects, normalizes, validates VINs, tracks changes, and exports `data/` and `web/inventory.json`. Source-specific rows and changes remain in `data/database.json`; the public dashboard exports only qualifying active matches. CSVs and `INVENTORY.md` are generated views. Three complete missing searches mark a listing removed, never sold. Partial/failed searches do not count as missing. The browser independently enforces eligibility so resetting filters cannot broaden these rules.

VINs are joined only after checksum, Ford truck prefix and model-year checks. VIN matching alone does not prove Raptor trim. Unknown condition facts stay unknown. Verified owner counts require source evidence.

## Local use

Python 3.12+ and Node for JavaScript syntax checks; no application dependencies to install.

```sh
python -m unittest discover -s tests -v
node --check web/app.js
python src/finder.py
python src/finder.py --offline
python -m http.server 8000 --directory web
```

Census geographic assets are committed. To rebuild them:

```sh
python scripts/download_location_sources.py
python scripts/build_location_assets.py
```

## Manual observations

Create a JSON array under `imports/` with checked listing evidence. Unchanged import files do not refresh last-seen dates. Use an HTTPS listing URL and a stable source listing ID. Do not invent history evidence.

```json
[
  {
    "source": "manual-dealer",
    "source_listing_id": "REPLACE_WITH_STOCK_ID",
    "listing_url": "https://example.com/replace-with-checked-listing",
    "make": "Ford",
    "model": "F-150",
    "trim": "Raptor",
    "year": 2018,
    "vin": "",
    "status": "active",
    "category": "retail",
    "asking_price": null,
    "title_status": "unknown",
    "accident_history": "History unavailable",
    "notes": "Record the actual source evidence and date checked."
  }
]
```

This example is not inventory and cannot qualify without real price/title/history evidence.

Brand assets: the Raptor image is the user-supplied artwork, displayed with CSS cropping of its white margin. The standard Ford oval comes from Wikimedia Commons (`Ford_logo_flat.svg`). Neither logo implies dealer affiliation.
