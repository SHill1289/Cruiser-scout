/* Runs in the owner's Google Apps Script account. No email content is exported.
 * doGet serves only the sanitized cache; public reads NEVER query Gmail.
 * Activate refreshAlerts on a five-minute trigger after owner authorization.
 */
function decodeHtml(s) {
  return String(s || '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&nbsp;/g, ' ');
}
function vehicleIdentity(subject) {
  const m = subject.match(/\b(20\d{2})\s+(Lexus\s+LX\s*(470|570)|Toyota\s+Land\s+Cruiser)\b/i);
  if (!m) return null;
  const year = Number(m[1]), model = m[3] ? 'LX' + m[3] : 'Land Cruiser';
  if (!(model === 'LX570' ? year >= 2011 && year <= 2016 : year >= 2006 && year <= 2007)) return null;
  return {year, make:model === 'Land Cruiser' ? 'Toyota' : 'Lexus', model};
}
function canonicalAuction(url, source) {
  const pattern = source === 'bringatrailer' ? /^https:\/\/(?:www\.)?bringatrailer\.com\/listing\/([a-z0-9-]+)\/?(?:[?#].*)?$/i : /^https:\/\/carsandbids\.com\/auctions\/([a-zA-Z0-9]+)\/([a-z0-9-]+)\/?(?:[?#].*)?$/i;
  const m = String(url).match(pattern);
  if (!m) return null;
  return source === 'bringatrailer' ? 'https://bringatrailer.com/listing/' + m[1] + '/' : 'https://carsandbids.com/auctions/' + m[1] + '/' + m[2];
}
function resolveAuction(url, source) {
  for (let i = 0; i < 4; i++) {
    const canonical = canonicalAuction(url, source);
    if (canonical) return canonical;
    // Only BaT's observed email redirect service. Never arbitrary email URLs.
    if (source !== 'bringatrailer' || !/^https:\/\/links\.bringatrailer\.com\/a\/sc\/[A-Za-z0-9_\/-]+$/.test(url)) { console.log('Unrecognized auction link shape'); return null; }
    const response = UrlFetchApp.fetch(url, {followRedirects:false, muteHttpExceptions:true});
    if (![301,302,303,307,308].includes(response.getResponseCode())) { console.log('Auction redirect returned HTTP ' + response.getResponseCode()); return null; }
    const h = response.getAllHeaders();
    url = String(h.Location || h.location || '');
    if (!canonicalAuction(url, source)) console.log('Auction redirect destination is not yet a canonical listing; host: ' + (url.match(/^https?:\/\/([^/]+)/) || [,'none'])[1]);
  }
  return null;
}
function parseAlert(subject, html, source, received, resolve) {
  if (!/now live(?: on BaT)?[!\s]*$/i.test(subject)) return null;
  const vehicle = vehicleIdentity(subject);
  if (!vehicle) return null;
  let url = null;
  for (const a of html.matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    const label = decodeHtml(a[2].replace(/<[^>]+>/g, ' ')).replace(/\s+/g,' ').trim();
    if (!/^(VIEW AUCTION|Go to Auction)$/i.test(label)) continue;
    url = resolve(decodeHtml(a[1]), source);
    if (url) break;
  }
  url = canonicalAuction(url, source);
  if (!url) return null;
  const photos = [];
  for (const img of html.matchAll(/<img\b[^>]*src=["']([^"']+)["']/gi)) {
    const p = decodeHtml(img[1]);
    if (p.length <= 1800 && (source === 'bringatrailer' ? /^https:\/\/bringatrailer\.com\/wp-content\/uploads\/[^?#]+\.(?:jpe?g|png|webp)(?:\?w=\d+)?$/i : /^https:\/\/media\.carsandbids\.com\/[^#\s"<>]+\.(?:jpe?g|png|webp)(?:\?t=\d+)?$/i).test(p)) photos.push(p);
  }
  const id = source === 'bringatrailer' ? url.split('/')[4] : url.split('/')[4];
  const key = source + ':' + id;
  return {...vehicle, source, source_listing_id:id, listing_key:key, vehicle_key:'listing:' + key,
    listing_url:url, status:'unknown', category:'auction', title_status:'unknown',
    listed_at:received, first_seen:received, vehicle_first_seen:received, last_seen:received,
    email_observed_at:received, quality_flags:'email_discovery',
    photo_url:photos[0] || '', photo_urls:photos.slice(0,1), photo_source:source, photo_source_url:url,
    mileage:null, price:null, asking_price:null, current_bid:null,
    owners:'Unknown', accident_history:'History unavailable', accident_category:'unknown',
    notes:'New-auction email received at the shown time. Current auction status, title history and price have not been verified.'};
}
function emailHtml(part) {
  if (part.mimeType === 'text/html' && part.body && part.body.data) {
    if (Array.isArray(part.body.data)) return Utilities.newBlob(part.body.data).getDataAsString('UTF-8');
    if (/^\s*</.test(String(part.body.data))) return String(part.body.data);
    const data = String(part.body.data).replace(/\s/g,'').replace(/-/g,'+').replace(/_/g,'/');
    console.log('Encoded HTML shape: length=' + data.length + ', base64=' + /^[A-Za-z0-9+/]*={0,2}$/.test(data));
    return Utilities.newBlob(Utilities.base64Decode(data + '='.repeat((4-data.length%4)%4))).getDataAsString('UTF-8');
  }
  for (const child of part.parts || []) { const html = emailHtml(child); if (html) return html; }
  return '';
}
function refreshAlerts() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) return;
  try {
    const props = PropertiesService.getScriptProperties(), all = props.getProperties();
    const now = Date.now(), cutoff = now - 7 * 86400000;
    for (const key of Object.keys(all)) if (key.startsWith('row:') && Date.parse(JSON.parse(all[key]).email_observed_at) < cutoff) props.deleteProperty(key);
    const query = 'newer_than:7d -in:spam -in:trash {from:updates@bringatrailer.com from:no-reply@carsandbids.com} subject:"now live" {Lexus "Land Cruiser"}';
    const result = Gmail.Users.Messages.list('me', {q:query, maxResults:100});
    let failures = 0;
    for (const item of result.messages || []) {
      // IDs stay private, used only to avoid rereading already handled messages.
      if (all['seen:' + item.id]) continue;
      try {
        const m = Gmail.Users.Messages.get('me', item.id, {format:'full'});
        const headers = m.payload.headers || [], header = n => (headers.find(h => h.name.toLowerCase() === n) || {}).value || '';
        const from = header('from');
        const source = /(?:^|<)updates@bringatrailer\.com>?$/i.test(from.trim()) ? 'bringatrailer' : /(?:^|<)no-reply@carsandbids\.com>?$/i.test(from.trim()) ? 'carsandbids' : null;
        const received = Number(m.internalDate);
        if (!source || received < cutoff || received > now + 60000) continue;
        const subject = header('subject');
        if (!vehicleIdentity(subject)) { props.setProperty('seen:' + item.id, String(now)); continue; }
        const html = emailHtml(m.payload);
        const row = parseAlert(subject, html, source, new Date(received).toISOString(), resolveAuction);
        if (!row) { console.log('Unparsed alert: HTML bytes=' + html.length + ', auction CTA=' + /VIEW AUCTION|Go to Auction/i.test(html)); failures++; continue; } // retry later, never silently mark malformed alerts done
        props.setProperty('row:' + row.listing_key, JSON.stringify(row));
        props.setProperty('seen:' + item.id, String(now));
      } catch (error) { console.log('Alert processing: ' + String(error.message).replace(/https?:\/\/\S+/g, '[URL]').replace(/[\w.+-]+@[\w.-]+/g, '[email]').slice(0,200)); failures++; }
    }
    for (const key of Object.keys(all)) if (key.startsWith('seen:') && Number(all[key]) < now - 8 * 86400000) props.deleteProperty(key);
    props.setProperty('health', JSON.stringify({checked_at:new Date(now).toISOString(),failed:failures,truncated:!!result.nextPageToken}));
    console.log('Alert refresh complete; failed messages: ' + failures);
  } finally { lock.releaseLock(); }
}
function installRefresh() {
  refreshAlerts();
  if (!ScriptApp.getProjectTriggers().some(t => t.getHandlerFunction() === 'refreshAlerts')) ScriptApp.newTrigger('refreshAlerts').timeBased().everyMinutes(5).create();
}
function doGet() {
  const all = PropertiesService.getScriptProperties().getProperties();
  const cutoff = Date.now() - 7 * 86400000;
  const listings = Object.keys(all).filter(k => k.startsWith('row:')).map(k => JSON.parse(all[k])).filter(r => Date.parse(r.email_observed_at) >= cutoff);
  return ContentService.createTextOutput(JSON.stringify({version:1,listings,health:JSON.parse(all.health || 'null')})).setMimeType(ContentService.MimeType.JSON);
}
