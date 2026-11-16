# Price review

Scout preserves raw source observations in the database. Exported and browser-loaded records replace questionable numeric values with null, retaining reported_prices and a price_review explanation. A flag means review is needed, not that a source is proven wrong.

Rules (USD, current Scout model/year scope):
- Non-numeric, non-finite, zero and negative amounts are excluded.
- Non-USD currencies are excluded until a verified conversion exists.
- Asking/completed-sale amounts below $2,500 or above $250,000 need review. These are broad error checks, not valuations. High-end $120,000 sales remain valid.
- An amount explicitly described as a monthly payment or deposit is excluded; merely mentioning financing does not reject a full cash price.
- Active retail sources for the same validated VIN, seen within seven days and within 48 hours of each other, conflict if the difference is at least $5,000 and over 35% of the lower price. Both valid-looking amounts need review. Already rejected values do not discredit a valid source.
- A current auction bid needs an active status, an observation within 24 hours and a future auction end. Low opening bids and confirmed ended-auction high bids are not treated as monthly payments.

Flagged amounts cannot enter price sorting, price ranges, deal ratings, price-drop alerts, market summaries or plots. Listings remain visible without a price range, after priced listings in both price sort directions. Detail pages retain the original amount and source link. Sold vehicles never fall back to asking prices or bids as confirmed sale prices.

The collector reevaluates each fresh export; the browser also checks existing inventory and newly merged email discoveries. A later valid observation automatically replaces an old flag. Existing stored prices are never rewritten. No additional requests, AI calls or paid service are required.

Shared fixtures in tests/fixtures/price-integrity.json keep browser and Python checks aligned. Cross-source conflicts are tested separately in both languages.
