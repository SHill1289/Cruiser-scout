const { session } = require('./refresh');
const PATH = 'watchlist/owner-v1.json';
const validKey = key => typeof key === 'string' && /^[a-zA-Z0-9:_-]{1,200}$/.test(key);
function apply(saved, operations) {
  const result = new Set(saved);
  for (const op of operations) op.saved ? result.add(op.key) : result.delete(op.key);
  return [...result].sort();
}
function createHandler(storage) {
  return async (req, res) => {
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('Vary', 'Cookie');
    const send = (code, data) => res.status(code).json(data);
    if (!['GET', 'POST'].includes(req.method)) return send(405, {message:'Method not allowed.'});
    const key = process.env.REFRESH_OWNER_KEY;
    if (!key || !session(req, key)) return send(401, {message:'Unlock syncing with your owner access code.'});
    let operations = [];
    if (req.method === 'POST') {
      const origins = ['https://cruiser-scout.vercel.app', process.env.VERCEL_URL && 'https://' + process.env.VERCEL_URL];
      if (!origins.includes(req.headers.origin) || !String(req.headers['content-type'] || '').startsWith('application/json')) return send(403, {message:'Request rejected.'});
      if (Number(req.headers['content-length'] || 0) > 150000) return send(413, {message:'Too many changes in one request.'});
      let body = req.body;
      try { if (typeof body === 'string') body = JSON.parse(body); } catch { return send(400, {message:'Invalid request.'}); }
      operations = body?.operations;
      if (!Array.isArray(operations) || operations.length > 1000 || operations.some(op => !op || !validKey(op.key) || typeof op.saved !== 'boolean')) return send(400, {message:'Invalid saved vehicles.'});
    }
    try {
      const blob = storage || require('@vercel/blob');
      const options = {access:'private', token:process.env.BLOB_READ_WRITE_TOKEN};
      for (let attempt = 0; attempt < 4; attempt++) {
        const current = await blob.get(PATH, {...options, useCache:false});
        const data = current ? await new Response(current.stream).json() : {saved:[]};
        if (!Array.isArray(data.saved) || data.saved.some(k => !validKey(k))) throw new Error('Invalid stored watchlist');
        const saved = apply(data.saved, operations);
        if (saved.length > 5000) return send(400, {message:'The watchlist is full. Remove some saved vehicles first.'});
        if (req.method === 'GET' || JSON.stringify(saved) === JSON.stringify([...data.saved].sort())) return send(200, {saved});
        try {
          await blob.put(PATH, JSON.stringify({saved}), {...options, addRandomSuffix:false, allowOverwrite:!!current,
            ...(current ? {ifMatch:current.blob.etag} : {}), contentType:'application/json'});
          return send(200, {saved});
        } catch (error) {
          if (current && !(blob.BlobPreconditionFailedError && error instanceof blob.BlobPreconditionFailedError)) throw error;
        }
      }
      return send(409, {message:'Another browser updated the watchlist. Your changes are kept locally; try Sync now.'});
    } catch { return send(503, {message:'Sync is temporarily unavailable. Your saves are kept on this browser; try again later.'}); }
  };
}
module.exports = createHandler();
module.exports.createHandler = createHandler;
module.exports.apply = apply;
