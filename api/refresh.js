const { createHmac, timingSafeEqual } = require('node:crypto');
const ROOT = 'https://api.github.com/repos/SHill1289/Cruiser-scout/actions/workflows/lx470_search.yml';
const COOKIE = '__Host-scout-owner';
function equal(a, b) {
  const left = Buffer.from(String(a || '')), right = Buffer.from(String(b || ''));
  return left.length === right.length && timingSafeEqual(left, right);
}
function signature(value, key) { return createHmac('sha256', key).update(value).digest('hex'); }
function session(req, key) {
  const cookie = (req.headers.cookie || '').split(';').map(v => v.trim()).find(v => v.startsWith(COOKIE + '='));
  if (!cookie) return false;
  const [expiry, sig] = cookie.slice(COOKIE.length + 1).split('.');
  return Number(expiry) > Date.now() && Number(expiry) <= Date.now() + 7 * 86400000 && equal(sig, signature(expiry, key));
}
async function github(path, token, options = {}) {
  const response = await fetch(ROOT + path, {
    ...options, redirect: 'error', signal: AbortSignal.timeout(10000),
    headers: { Accept: 'application/vnd.github+json', Authorization: 'Bearer ' + token, 'X-GitHub-Api-Version': '2022-11-28', 'Content-Type': 'application/json' }
  });
  if (!response.ok) throw new Error('GitHub request failed');
  return response.status === 204 ? null : response.json();
}
function summarize(runs, now = Date.now()) {
  const active = runs.find(r => r.status !== 'completed');
  const manual = runs.find(r => r.event === 'workflow_dispatch');
  const nextAllowedAt = manual ? new Date(Date.parse(manual.created_at) + 3600000).toISOString() : null;
  const latest = active || runs[0];
  return { active: !!active, cooldown: !!nextAllowedAt && Date.parse(nextAllowedAt) > now, nextAllowedAt,
    run: latest ? { id: latest.id, status: latest.status, conclusion: latest.conclusion, startedAt: latest.created_at,
      url: 'https://github.com/SHill1289/Cruiser-scout/actions/runs/' + latest.id } : null };
}
async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store'); res.setHeader('Vary', 'Cookie');
  const send = (status, value) => res.status(status).json(value);
  if (!['GET', 'POST'].includes(req.method)) { res.setHeader('Allow', 'GET, POST'); return send(405, { message: 'Method not allowed.' }); }
  const key = process.env.REFRESH_OWNER_KEY, token = process.env.GITHUB_REFRESH_TOKEN;
  if (!key || key.length < 32 || !token) return send(503, { configured: false, message: 'Owner refresh is awaiting its secure connection. Scheduled refreshes still run normally.' });
  if (req.method === 'POST') {
    const origins = ['https://cruiser-scout.vercel.app', process.env.VERCEL_URL && 'https://' + process.env.VERCEL_URL].filter(Boolean);
    if (!origins.includes(req.headers.origin) || !String(req.headers['content-type'] || '').startsWith('application/json')) return send(403, { message: 'Request rejected.' });
    if (Number(req.headers['content-length'] || 0) > 4096) return send(413, { message: 'Request too large.' });
  }
  let body = req.body || {};
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { return send(400, { message: 'Invalid request.' }); } }
  if (req.method === 'POST' && body.action === 'login') {
    if (!equal(body.key, key)) return send(401, { configured: true, message: 'That owner access code is not valid.' });
    const expiry = String(Date.now() + 7 * 86400000);
    res.setHeader('Set-Cookie', COOKIE + '=' + expiry + '.' + signature(expiry, key) + '; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=604800');
    return send(200, { authenticated: true });
  }
  if (!session(req, key)) return send(401, { configured: true, message: 'Unlock owner controls to refresh inventory.' });
  if (req.method === 'POST' && body.action === 'logout') {
    res.setHeader('Set-Cookie', COOKIE + '=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0');
    return send(200, { authenticated: false });
  }
  if (req.method === 'POST' && body.action !== 'start') return send(400, { message: 'Unknown action.' });
  try {
    const data = await github('/runs?branch=main&per_page=30', token);
    const state = summarize(data.workflow_runs || []);
    if (req.method === 'GET') return send(200, { authenticated: true, ...state });
    if (state.active || state.cooldown) return send(409, { ...state, message: state.active ? 'A refresh is already running.' : 'Manual refresh is limited to once an hour.' });
    await github('/dispatches', token, { method: 'POST', body: JSON.stringify({ ref: 'main' }) });
    return send(202, { accepted: true, message: 'Refresh requested. GitHub will start it shortly.' });
  } catch { return send(502, { message: 'The GitHub connection is unavailable. Check the connection or try again later. Scheduled refreshes are unaffected.' }); }
}
module.exports = handler;
module.exports.summarize = summarize;
module.exports.session = session;
