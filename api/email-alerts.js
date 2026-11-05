const {clean} = require('../web/email-alerts');
// Public vehicle data endpoint, not a credential.
const FEED = 'https://script.google.com/macros/s/AKfycbyw7PZ1MU6750mcmhqZRiD_AV24QmmEo8lm1hXDIkvENOgxxHeZQjRa4eu4uzngNyX-/exec';
function createHandler(fetchFeed = fetch) {
  return async (req,res) => {
    if (req.method !== 'GET') return res.status(405).json({message:'Method not allowed.'});
    try {
      const response = await fetchFeed(FEED,{signal:AbortSignal.timeout(8000)});
      if (!response.ok) throw new Error('Feed unavailable');
      const text = await response.text();
      if (text.length > 750000) throw new Error('Feed too large');
      const data = JSON.parse(text);
      if (data.version !== 1 || !Array.isArray(data.listings)) throw new Error('Unexpected feed');
      const listings = data.listings.slice(0,100).map(row=>clean(row)).filter(Boolean);
      const checked = Date.parse(data.health?.checked_at);
      res.setHeader('Cache-Control','public, max-age=60, s-maxage=120, stale-while-revalidate=120');
      return res.status(200).json({listings,checked_at:Number.isFinite(checked) ? new Date(checked).toISOString() : null,
        partial:!!data.health?.failed || !!data.health?.truncated});
    } catch {
      console.error('Auction email feed unavailable');
      res.setHeader('Cache-Control','no-store');
      return res.status(503).json({message:'Email discoveries temporarily unavailable.'});
    }
  };
}
module.exports = createHandler();
module.exports.createHandler = createHandler;
