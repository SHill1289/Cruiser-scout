# Bring a Trailer auction coverage

The collector reads the full public chart history embedded in each tracked model archive, including sold and reserve-not-met outcomes. Discovery uses the auction title rather than the URL slug, because some BaT slugs identify the wrong model. Detail pages verify each vehicle, price, mileage, color, and explicit Location field.

Scope remains 2006–2007 LX470, 2006–2007 Land Cruiser, and 2011–2016 LX570. Market history covers two years. Each completed auction is keyed by its URL; repeat sales of a VIN stay separate market observations. The inventory still groups listings for the same vehicle.

Completed detail pages are hydrated once (version 2); active auctions are refreshed. Failed details are retried on subsequent runs. At most 100 new or outdated details are fetched per model per run; any remaining backlog reports partial coverage. Archive format failures preserve previous data and report an error.

Locations come from the explicit listing Location link, never past registration narratives. US states normalize to postal abbreviations; international regions retain the source wording. Unknown colors and mileage are not invented.

The Market Intelligence explorer supports multiple years and colors, mileage bounds, state/region, city, period, and result. The horizontal axis switches between auction date and mileage. Filled dots represent sold prices; hollow dots represent unsuccessful bids. Only completed sales with reported mileage enter mileage-band averages. Prices exclude buyer fees.

October 26, 2026 backfill: 59 LX470, 22 LX570, and 40 Land Cruiser completed results discovered in the two-year archives, plus one additional active Land Cruiser detail. All 122 detail pages supplied location metadata. Added 23 previously missing LX470 sales from the preceding year.
