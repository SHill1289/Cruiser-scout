# Auction buyer fees

Completed Bring a Trailer vehicle sales display an estimated buyer total: recorded winning bid plus the 5% buyer fee, minimum $250 and maximum $7,500. Before and including January 29, 2024, the cap is $5,000; BaT announced the increase would apply after that evening’s auctions closed. The current two-year market window is entirely after this change. Missing sale dates use the current cap and totals are labeled estimates.

The original database, historical CSV/JSON and source sold prices remain unchanged. Browser-derived records retain hammer_price and buyer_fee alongside the fee-inclusive sold_price/sale_price, with auction_fee_included preventing double application. Collector deal ratings use the same buyer totals; the browser updates existing ratings immediately. Source observations continue through price-integrity checks before fees are added.

Market statistics, scatter plots, comparable sales, sold inventory prices and sorting use these buyer totals. Unsold/reserve-not-met bids get no fee; other sources remain unchanged. This is not an out-the-door price: taxes, shipping, registration and other fees are excluded.

The calculator is in Market Intelligence and supported auction detail pages. It uses current USD vehicle fees for BaT and Cars & Bids (5%, $250 minimum, $7,500 maximum); it does not automatically rewrite historical Cars & Bids results. Users may enter extra costs and a total budget. Maximum bids are calculated to cents and must be rounded down to an allowed auction increment. No bids are placed, inputs are not saved, and no network/AI services are called.

Policy sources checked November 16, 2026:
- https://bringatrailer.com/how-bat-works/
- https://bringatrailer.com/2024/01/26/bat-site-update-5-buyers-fee-cap-is-7500-as-of-1-29-24/
- https://carsandbids.com/what-is/
