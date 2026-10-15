# LX470 Finder

A private, automated US listing database for **2006–2007 Lexus LX470s and Toyota Land Cruisers, plus 2011–2016 Lexus LX570s**, continued from the LX470 Finder conversations.

## Start here

- **[Browse current inventory](INVENTORY.md)** — readable prices, mileage, sellers and listing links.
- **[Master vehicles](data/lx470_master.csv)** — one vehicle per valid VIN, with all source URLs.
- **[Active retail listings](data/retail_listings.csv)** — advertised retail inventory.
- **[Auctions and salvage](data/auction_salvage_listings.csv)** — separate from retail asking prices.
- **[Listing history](data/listing_history.csv)** — new listings, price/detail changes, removal and reappearance.
- **[Completed-sale history](data/historical_sales.csv)** ? auditable 2006?2007 auction results used for mileage-band pricing.
- **[Source health](data/source_health.json)** — shows errors and partial coverage.
- **[Run the refresh](https://github.com/SHill1289/Cruiser-scout/actions/workflows/lx470_search.yml)** — choose **Run workflow** on GitHub.

## Automatic updates

GitHub Actions runs every six hours at **00:17, 06:17, 12:17 and 18:17 UTC**. In Eastern time, those runs occur at 8:17 p.m., 2:17 a.m., 8:17 a.m. and 2:17 p.m. during daylight saving time, and one hour earlier during standard time. It also runs when collectors, configuration, imports or tests change on `main`. No paid service, API key or external database is required. The workflow tests the code, collects listings, renders public detail pages when needed to capture lead photos, and commits refreshed data back here. Source failures are saved and make the run visibly fail, while successful sources still update.

GitHub schedules can be delayed; this is a periodic research tool, not a real-time availability guarantee. See [GitHub's schedule documentation](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule).

## Web dashboard on Vercel

The responsive dashboard in `web/` reads `web/inventory.json`, a public-safe export containing current clean-title candidates and two years of completed-sale market history. Listing cards show up to eight source photos when available. Use the arrows to browse or click a photo to open the larger gallery. TrueCar gallery photos are cached in `web/photos/` during refresh so they load reliably on the site. CarGurus currently supplies a single lead photo to the automated collector; listings without a usable image show a neutral LX placeholder. Exterior labels are grouped using the model-year factory palettes in `web/factory-colors.json`, and LX470 interior labels are grouped where supported. Catalog codes identify reference colors, not verified paint codes for individual trucks; on-screen swatches approximate pearl and metallic paint. The market section reports average and median sale price for under 100k, 100k?150k, 150k?250k and 250k+ mileage bands, with 12/24-month and model-year filters. Every database refresh rebuilds that file. Once this repository is imported into Vercel, each GitHub commit automatically publishes the newest inventory.

Active retail listings receive a text-only deal label when at least three completed sales exist in the same mileage range. An asking price at least 15% below the two-year median is **Great deal**, a price within 15% is **Fair deal**, and a price more than 15% above is **Bad deal**. Listings without enough price, mileage or comparable-sale data are left unrated. These labels compare price only and do not account for condition, maintenance or modifications.

In Vercel, import this GitHub repository and click **Deploy**. The included `vercel.json` selects the `web` folder, so no framework, build command or environment variables are required. The repository can remain private; the deployed dashboard is public.

### Filter normalization

The dashboard builds model, marketplace, and exterior-color filters from the current inventory. `web/filter-normalization.js` applies the same canonical values when building options and matching listings, so spelling or spacing variants do not split a filter. Exterior names come from the model- and year-specific factory palette in `web/factory-colors.json`; a broad marketplace label such as “Silver” is grouped with a factory finish only when that model year has one silver option. Ambiguous, unsupported, and future colors stay under **Other / unverified** until the reference is extended. **Color not reported** is separate. A matched name or swatch does not verify the paint code on an individual truck. To add a future model year, add its documented palette, aliases, and source to `web/factory-colors.json`; do not edit generated inventory data.

## Coverage

| Source | Automatic coverage |
|---|---|
| CarGurus | Nationwide searches for each year, filtered to exclude reported salvage, lemon, frame-damage and theft history. A supplemental search identifies no-reported-accident candidates. Owner counts remain unverified because search-result data does not include the count. |
| TrueCar | Nationwide 2006-2007 LX 470 search. Only vehicles explicitly marked clean title are included. VIN, price, mileage, listing date, dealer, photos, exact color names, owner count and accident count are collected when supplied; vehicle-history fields are reported by TrueCar from Experian AutoCheck. |
| KSL Cars | Four regional Lexus LX listings were checked on 2026-10-14 and imported with explicit per-listing Clean Title claims. Automated collection is paused because repeat listing requests returned HTTP 403/503. These one-time observations become unknown after seven days without a fresh check, so they do not remain advertised as current indefinitely. No matching 2006–2007 Land Cruiser appeared in the regional search. |
| Bypex LLC | One 2007 LX 470 dealer listing was checked on 2026-10-14 and imported with its explicit clean-title, owner, and accident claims. It is a one-time observation and also expires from active inventory after seven days without a fresh check. |
| Bring a Trailer | Matching auctions exposed on the LX470 index, plus rechecks of previously tracked active/unknown auctions. Only listings that explicitly say the title is clean appear in current inventory. A seeded two-year set of completed 2006?2007 sales is retained for market statistics, and newly exposed completed auctions are added automatically. |
| CARFAX, Cars.com, Edmunds | Direct requests returned HTTP 403 during setup; manual imports supported. |
| Autotrader, iSeeCars, Copart | Manual imports supported; no validated automatic collector yet. Autotrader's public search rendered in a browser, but a direct automated request returned a block page during validation. |

This is not every LX470 for sale nationwide. CarGurus pagination is deliberately not crawled: multi-page or count-mismatched responses are reported as partial and cannot remove vehicles. Collectors respect robots.txt, use an identifiable user agent, wait between requests and do not bypass access blocks. A source can behave differently on GitHub's servers; check the first Actions run and source health.

## What the database means

- A checksum-valid VIN with matching LX470 prefix/year joins listings across sources. Missing/invalid VINs stay separate using source and listing ID; fuzzy matching never silently merges trucks.
- The public inventory groups source listings with that validated VIN into one truck card. Open its VIN-match panel to compare each source's price, seller location, owner and accident report, and original link. The underlying listings, history and CSV rows remain separate for audit; the public JSON also includes a `vehicles` index of listing keys. Conflicting accident reports are flagged on the card instead of being silently reconciled.
- VINs identify and join trucks across sources; they do not establish optional equipment. The site shows **Listing-reported extras** only when a source explicitly tags differentiating equipment such as rear-seat DVD, Night View, CarPlay or remote start. Lexus's [2006 U.S. brochure](https://directechs.blob.core.windows.net/directwirebrochures/brochure1946_0.pdf) lists rear-seat DVD and Night View as available options. Marketplace tags are not factory build records, and CarPlay or remote start may be aftermarket. A missing tag means unknown, not absent; confirm equipment in photos or with the seller. Standard LX 470 specifications and generic package labels are omitted.
- Each listing has six maintenance and condition fields: timing belt, AHC, rust, navigation, service records and modifications. They default to **Unknown**. The collector records a claim and a short excerpt only when the auction narrative or dealer's own description explicitly supports it. Generic vehicle specifications, comments and surrounding page content do not establish condition. "Navigation advertised" does not mean it works; "no rust reported" is a seller claim, not an inspection. Earlier sourced claims are retained when the same listing's detail page is temporarily unavailable. Open the source listing and verify every claim and service document before purchase.
- Every listing retains its own source, seller, asking price or auction bid, URL and dates. `database.json` is the authoritative state; CSVs and `INVENTORY.md` are generated views.
- `active` means advertised at `last_seen`, not seller-confirmed availability. `last_checked` may be later than `last_seen`.
- Current inventory contains only **clean-title candidates**. CarGurus must report no salvage, lemon, frame-damage or theft history; TrueCar must explicitly report a clean title; Bring a Trailer must explicitly describe a clean title. Because marketplace filters are not an official title record, confirm every candidate with NMVTIS/CARFAX and the physical title before purchase. Other active observations remain in `data/excluded_listings.csv` for audit.
- Exterior color, interior color, owner category and accident history appear in the readable inventory and CSV exports. CarGurus owner counts are recorded as `Unverified` because its search result does not provide a count and its single-owner filter produced a result whose detail page reported three owners. Accident history is `No reported accidents` only when the listing appears in the source's no-accident results. If it does not, the result is `History unavailable`, never an inferred accident. `Reported accident` requires an explicit source count or seller disclosure.
- Human-verified owner counts can be saved by VIN in `overrides/vehicle_history.json`. Each entry requires the count, evidence source, verification date and HTTPS evidence URL. These facts override the unverified search-result value on every refresh and remain auditable in Git.
- Three complete CarGurus searches without a listing mark it `removed`, **never sold**. Failed/partial searches do not count as absence. Only explicit source/import evidence sets `sold`; an auction ending without a sale is `ended` or `unknown`.
- `listed_at` is the marketplace listing date. When a source supplies only days on market, the Finder stores a stable estimated date and marks `listed_at_is_estimated` as true. `first_seen` is the separate timestamp when the Finder first discovered that listing.
- Cards show when a listing was last seen advertised (`last_seen`). Active listings older than 24 hours are marked stale; listings missing from a complete search are labeled separately. `last_checked` is the last source check and may be newer than `last_seen` when a listing was absent. The collector retries incomplete CarGurus and TrueCar searches once with fresh pages. The site and Actions summary identify partial refreshes, and incomplete searches never count as removal evidence.
- The map and ZIP-distance filter use [2026 Census Gazetteer places and ZIP Code Tabulation Areas](https://www.census.gov/geographies/reference-files/time-series/geo/gazetteer-files.html) and [2025 Census state boundaries](https://www.census.gov/geographies/mapping-files/2025/geo/carto-boundary-file.html). The map shows the contiguous US; listings elsewhere remain in the inventory. TrueCar dealer ZIP areas take precedence; other listings use the advertised city reference point. Distances are straight-line estimates, not routes or exact dealer locations. Some postal ZIP codes have no matching Census ZCTA; the UI reports those as unavailable. The map and lookups are hosted with the site and require no paid API. Regenerate the static assets with `python scripts/build_location_assets.py` after updating `sources/gazetteer/`.
- History records changes rather than duplicating identical daily observations. Current rows track daily last-seen times. Git commits preserve earlier database snapshots.
- Unknown title, accident, service, owner and rust information stays unknown. An accident report does not by itself mean salvage title. Retail does not mean verified clean title. Auction membership does not mean salvage.
- Auction bids and sold prices are separate from retail asking prices. Rounded auction mileage is flagged approximate. USD is used by these US collectors.
- Historical mileage-band figures use completed Bring a Trailer auction prices and exclude buyer fees, private-party sales and unsold auctions. They describe that auction sample, not a formal vehicle appraisal.
- A mileage decrease or conflicting active-source mileage is flagged for review. The master row selects the most recently seen active listing; use individual listings/history for comparisons rather than interpreting its price as a market valuation.
- The earlier conversation's leads are preserved in [prior leads](data/prior_leads.csv), separately from verified observations. Its duplicated VIN/mileage claims are not imported into current inventory.
- The underside-check marker covers MI, NY, OH, WI, PA, MN, MA, CT, RI, NH, VT, ME, IL, IN and IA. It distinguishes a current marketplace advertisement from a previous VIN-matched listing observation in one of these states. It does not establish registration history or actual rust, and an unmarked listing is not necessarily rust-free. Inspect the underside before purchase.
- No Finder Score or rust-condition inference is invented. Inspection/service evidence is needed to rank condition confidently.

## Add a listing from another source

Create a JSON file under `imports/` using GitHub's **Add file → Create new file**, then commit it. Use a stable source listing ID. The workflow will import it once; edit the file when you have a new observation. Replaying an unchanged file does not reset `last_seen`.

```json
[
  {
    "source": "manual-dealer",
    "source_listing_id": "REPLACE-WITH-STOCK-ID",
    "listing_url": "https://example.com/replace-with-real-listing",
    "year": 2007,
    "make": "Lexus",
    "model": "LX470",
    "vin": "",
    "status": "active",
    "category": "retail",
    "asking_price": null,
    "listed_at": "2026-09-19",
    "listed_at_is_estimated": false,
    "mileage": null,
    "seller": "",
    "city": "",
    "state": "",
    "title_status": "unknown",
    "notes": "Record the evidence and when you checked the listing."
  }
]
```

The example is not a real listing. Replace its values before importing. Allowed statuses: `active`, `sold`, `ended`, `removed`, `unknown`; categories: `retail`, `auction`, `salvage`. Mark auction/salvage correctly and use `current_bid`/`sold_price` instead of `asking_price` where appropriate. Imports are stamped when processed; use this for newly checked observations, not undated historical backfills.

## Local use and maintenance

Python 3.12+; no third-party packages.

```sh
python -m unittest discover -s tests -v
python src/finder.py
python src/finder.py --offline
```

Configuration: `sources/config.json`. Tests cover VIN validation, duplicate/history handling, removal/reappearance, incomplete-source protection, mileage conflicts, imports and parser fixtures. If a website changes, repair its parser against a new public-page sample before re-enabling it. Never replace source errors with an empty successful snapshot.

### Verify an owner count for free

When a listing page displays an owner count, open **Actions → Verify owner count (free) → Run workflow**. Enter the listing's VIN, displayed owner count, source name and listing URL. GitHub validates the values, records the evidence in `overrides/vehicle_history.json`, rebuilds the inventory and updates the Vercel data automatically.

This is intentionally evidence based. Free government VIN services provide specifications, recalls and limited theft/salvage checks, but do not provide an exact previous-owner count. Listings without visible owner-count evidence remain `Unverified` rather than receiving a guess.

This repository does not contact sellers, send messages, or place bids.

## Land Cruiser searches and AutoTempest

The finder also collects 2006–2007 Toyota Land Cruiser listings from nationwide CarGurus and TrueCar searches, plus matching Bring a Trailer auctions from the 100-Series archive. Both models appear by default; use the Model filter or search a model name to narrow the results. Photo labels, VIN validation, CSV exports, missing-listing checks, and auction-price comparisons distinguish the two models. Existing records without model fields are migrated as Lexus LX470 records. Land Cruiser colors are grouped with the documented Toyota factory palette when the marketplace description supports a match.

Manual Land Cruiser imports must include `"make": "Toyota"` and `"model": "Land Cruiser"`. The existing year and clean-title screening rules still apply. Auction history covers discovered or seeded auctions, not a complete archive; price badges require enough completed sales for the same model and mileage band.

Prefilled nationwide AutoTempest links for both models are available below the inventory filters. These open external searches and do not import results into the tracked database or apply our title screening. [AutoTempest's terms](https://www.autotempest.com/legal) require written authorization for automated extraction; an authorized feed is not configured.

## LX570 inventory

2011-2016 Lexus LX570s are collected from nationwide CarGurus and TrueCar searches and matching Bring a Trailer auctions. All result pages are checked, with stable price ordering and pagination state for CarGurus. Inconsistent or incomplete collections preserve existing listings. Model tags identify LX470, LX570, and Land Cruiser results. LX570 imports must include `"make": "Lexus"` and `"model": "LX570"`; the supported year range is validated per model. LX570 VINs use their own prefix and year codes. Color descriptions are grouped with the documented LX570 model-year palette when supported. Market-history comparisons stay within the same model. AutoTempest also has a prefilled 2011-2016 LX570 link.

The US model skipped 2012 (the 2013 model arrived in early 2012). CarGurus returns unrelated years for a 2012-only search, so that query is marked not applicable. TrueCar and AutoTempest retain the requested 2011-2016 range. See [Lexus's 2013 pricing announcement](https://pressroom.lexus.com/lexus-announces-pricing-2013-lx-570/) and [Cars.com model-year history](https://www.cars.com/research/lexus-lx_570/).

TrueCar LX570 collection is paused because GitHub-hosted requests returned HTTP 403 during end-to-end validation. A prefilled external TrueCar search is provided. CarGurus and BaT continue automatic LX570 collection; TrueCar collectors for the older models remain enabled.
