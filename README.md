# LX470 Finder

A private, automated US listing database for **2006–2007 Lexus LX470s**, continued from the LX470 Finder conversations.

## Start here

- **[Browse current inventory](INVENTORY.md)** — readable prices, mileage, sellers and listing links.
- **[Master vehicles](data/lx470_master.csv)** — one vehicle per valid VIN, with all source URLs.
- **[Active retail listings](data/retail_listings.csv)** — advertised retail inventory.
- **[Auctions and salvage](data/auction_salvage_listings.csv)** — separate from retail asking prices.
- **[Listing history](data/listing_history.csv)** — new listings, price/detail changes, removal and reappearance.
- **[Completed-sale history](data/historical_sales.csv)** ? auditable 2006?2007 auction results used for mileage-band pricing.
- **[Source health](data/source_health.json)** — shows errors and partial coverage.
- **[Run the refresh](https://github.com/SHill1289/lx470-finder/actions/workflows/lx470_search.yml)** — choose **Run workflow** on GitHub.

## Automatic updates

GitHub Actions runs every six hours at **00:17, 06:17, 12:17 and 18:17 UTC**. In Eastern time, those runs occur at 8:17 p.m., 2:17 a.m., 8:17 a.m. and 2:17 p.m. during daylight saving time, and one hour earlier during standard time. It also runs when collectors, configuration, imports or tests change on `main`. No paid service, API key or external database is required. The workflow tests the code, collects listings, renders public detail pages when needed to capture lead photos, and commits refreshed data back here. Source failures are saved and make the run visibly fail, while successful sources still update.

GitHub schedules can be delayed; this is a periodic research tool, not a real-time availability guarantee. See [GitHub's schedule documentation](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule).

## Web dashboard on Vercel

The responsive dashboard in `web/` reads `web/inventory.json`, a public-safe export containing current clean-title candidates and two years of completed-sale market history. Listing cards show up to eight source photos when available. Use the arrows to browse or click a photo to open the larger gallery. TrueCar gallery photos are cached in `web/photos/` during refresh so they load reliably on the site. CarGurus currently supplies a single lead photo to the automated collector; listings without a usable image show a neutral LX placeholder. Exterior and interior labels are normalized against the factory 2006?2007 Lexus palette in `web/factory-colors.json`; the exact Lexus paint code is shown when known, while the on-screen swatch remains an approximation of pearl or metallic paint. The market section reports average and median sale price for under 100k, 100k?150k, 150k?250k and 250k+ mileage bands, with 12/24-month and model-year filters. Every database refresh rebuilds that file. Once this repository is imported into Vercel, each GitHub commit automatically publishes the newest inventory.

Active retail listings receive a text-only deal label when at least three completed sales exist in the same mileage range. An asking price at least 15% below the two-year median is **Great deal**, a price within 15% is **Fair deal**, and a price more than 15% above is **Bad deal**. Listings without enough price, mileage or comparable-sale data are left unrated. These labels compare price only and do not account for condition, maintenance or modifications.

In Vercel, import this GitHub repository and click **Deploy**. The included `vercel.json` selects the `web` folder, so no framework, build command or environment variables are required. The repository can remain private; the deployed dashboard is public.

## Coverage

| Source | Automatic coverage |
|---|---|
| CarGurus | Nationwide searches for each year, filtered to exclude reported salvage, lemon, frame-damage and theft history. A supplemental search identifies no-reported-accident candidates. Owner counts remain unverified because search-result data does not include the count. |
| TrueCar | Nationwide 2006-2007 LX 470 search. Only vehicles explicitly marked clean title are included. VIN, price, mileage, listing date, dealer, photos, exact color names, owner count and accident count are collected when supplied; vehicle-history fields are reported by TrueCar from Experian AutoCheck. |
| Bring a Trailer | Matching auctions exposed on the LX470 index, plus rechecks of previously tracked active/unknown auctions. Only listings that explicitly say the title is clean appear in current inventory. A seeded two-year set of completed 2006?2007 sales is retained for market statistics, and newly exposed completed auctions are added automatically. |
| CARFAX, Cars.com, Edmunds | Direct requests returned HTTP 403 during setup; manual imports supported. |
| Autotrader, iSeeCars, Copart | Manual imports supported; no validated automatic collector yet. |

This is not every LX470 for sale nationwide. CarGurus pagination is deliberately not crawled: multi-page or count-mismatched responses are reported as partial and cannot remove vehicles. Collectors respect robots.txt, use an identifiable user agent, wait between requests and do not bypass access blocks. A source can behave differently on GitHub's servers; check the first Actions run and source health.

## What the database means

- A checksum-valid VIN with matching LX470 prefix/year joins listings across sources. Missing/invalid VINs stay separate using source and listing ID; fuzzy matching never silently merges trucks.
- VINs identify and join trucks across sources; they do not establish optional equipment. The site shows **Listing-reported extras** only when a source explicitly tags differentiating equipment such as rear-seat DVD, Night View, CarPlay or remote start. Lexus's [2006 U.S. brochure](https://directechs.blob.core.windows.net/directwirebrochures/brochure1946_0.pdf) lists rear-seat DVD and Night View as available options. Marketplace tags are not factory build records, and CarPlay or remote start may be aftermarket. A missing tag means unknown, not absent; confirm equipment in photos or with the seller. Standard LX 470 specifications and generic package labels are omitted.
- Every listing retains its own source, seller, asking price or auction bid, URL and dates. `database.json` is the authoritative state; CSVs and `INVENTORY.md` are generated views.
- `active` means advertised at `last_seen`, not seller-confirmed availability. `last_checked` may be later than `last_seen`.
- Current inventory contains only **clean-title candidates**. CarGurus must report no salvage, lemon, frame-damage or theft history; TrueCar must explicitly report a clean title; Bring a Trailer must explicitly describe a clean title. Because marketplace filters are not an official title record, confirm every candidate with NMVTIS/CARFAX and the physical title before purchase. Other active observations remain in `data/excluded_listings.csv` for audit.
- Exterior color, interior color, owner category and accident history appear in the readable inventory and CSV exports. CarGurus owner counts are recorded as `Unverified` because its search result does not provide a count and its single-owner filter produced a result whose detail page reported three owners. Accident history is `No reported accidents` only when the listing appears in the source's no-accident results. If it does not, the result is `History unavailable`, never an inferred accident. `Reported accident` requires an explicit source count or seller disclosure.
- Human-verified owner counts can be saved by VIN in `overrides/vehicle_history.json`. Each entry requires the count, evidence source, verification date and HTTPS evidence URL. These facts override the unverified search-result value on every refresh and remain auditable in Git.
- Three complete CarGurus searches without a listing mark it `removed`, **never sold**. Failed/partial searches do not count as absence. Only explicit source/import evidence sets `sold`; an auction ending without a sale is `ended` or `unknown`.
- `listed_at` is the marketplace listing date. When a source supplies only days on market, the Finder stores a stable estimated date and marks `listed_at_is_estimated` as true. `first_seen` is the separate timestamp when the Finder first discovered that listing.
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
