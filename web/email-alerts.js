(function(root) {
  'use strict';
  function clean(row, now = Date.now()) {
    if (!row || !['bringatrailer','carsandbids','autotrader','cars.com','cargurus'].includes(row.source)) return null;
    const year = Number(row.year), model = row.model;
    if (!(model === 'LX570' ? year >= 2011 && year <= 2016 : ['LX470','Land Cruiser'].includes(model) && year >= 2006 && year <= 2007)) return null;
    const source = row.source, retail = ['autotrader','cars.com','cargurus'].includes(source);
    const safeText = (v,max) => typeof v==='string' && v.length<=max && !/[<>@\r\n]/.test(v) && !/https?:|www\./i.test(v) ? v : ''; 
    const match = String(row.listing_url || '').match(source === 'cars.com' ? /^https:\/\/www\.cars\.com\/vehicledetail\/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})\/$/ : source === 'cargurus' ? /^https:\/\/www\.cargurus\.com\/details\/(\d{6,12})$/ : source === 'autotrader' ? /^https:\/\/www\.autotrader\.com\/cars-for-sale\/vehicle\/(\d{6,12})$/ : source === 'bringatrailer' ? /^https:\/\/bringatrailer\.com\/listing\/([a-z0-9-]+)\/$/ : /^https:\/\/carsandbids\.com\/auctions\/([a-zA-Z0-9]+)\/[a-z0-9-]+$/);
    const timestamp = Date.parse(row.email_observed_at);
    if (!match || !Number.isFinite(timestamp) || timestamp > now + 60000 || timestamp < now - 7*86400000) return null;
    const received = new Date(timestamp).toISOString(), key = source + ':' + match[1], url = row.listing_url;
    const photo = String(row.photo_url || '');
    const photoOK = photo.length <= 1800 && source!=='cars.com' && (source === 'cargurus' ? /^https:\/\/static\.cargurus\.com\/images\/forsale\/[^?#\s"<>]+\.(?:jpe?g|png|webp)$/i : source === 'autotrader' ? /^https:\/\/images\.autotrader\.com\/[a-z0-9/_-]+\.(?:jpg|jpeg|png|webp)$/i : source === 'bringatrailer' ? /^https:\/\/bringatrailer\.com\/wp-content\/uploads\/[^?#]+\.(?:jpe?g|png|webp)(?:\?w=\d+)?$/i : /^https:\/\/media\.carsandbids\.com\/[^#\s"<>]+\.(?:jpe?g|png|webp)(?:\?t=\d+)?$/i).test(photo);
    return {year,model,make:model === 'Land Cruiser' ? 'Toyota' : 'Lexus', source,
      listing_key:key, vehicle_key:'listing:' + key, source_listing_id:match[1], listing_url:url,
      status:'unknown',category:retail?'retail':'auction',title_status:'unknown',quality_flags:'email_discovery',
      listed_at:received,first_seen:received,vehicle_first_seen:received,last_seen:received,email_observed_at:received,
      photo_url:photoOK ? photo : '',photo_urls:photoOK ? [photo] : [],photo_source:source,photo_source_url:url,
      city:retail?safeText(row.city,80):'',state:retail && /^[A-Z]{2}$/.test(row.state || '')?row.state:'',exterior_color:retail?safeText(row.exterior_color,80):'',
      mileage:retail && Number.isFinite(row.mileage) && row.mileage>=0 && row.mileage<2000000?row.mileage:null,asking_price:retail && Number.isFinite(row.asking_price) && row.asking_price>0 && row.asking_price<1000000 ? row.asking_price : null,current_bid:null,sale_price:null,owners:'Unknown',
      accident_history:'History unavailable',accident_category:'unknown',
      notes:retail?'Saved-search email discovery. Details are as reported in the email; availability and title history are unverified.':'New-auction email received at the shown time. Current auction status, title history and price have not been verified.'};
  }
  function merge(data, feed, now = Date.now()) {
    const rows = [...(data.listings || [])], keys = new Set(rows.map(r=>r.listing_key));
    const urls = new Set(rows.map(r=>String(r.listing_url || '').split(/[?#]/)[0].replace(/\/$/,'')));
    const groups = (data.vehicles || []).map(g=>({...g,listing_keys:[...g.listing_keys]}));
    for (const raw of (Array.isArray(feed?.listings) ? feed.listings : []).slice(0,100)) {
      const row = clean(raw,now);
      if (!row || keys.has(row.listing_key) || urls.has(row.listing_url.replace(/\/$/,''))) continue;
      keys.add(row.listing_key); urls.add(row.listing_url.replace(/\/$/,'')); rows.push(row);
      if (groups.length) groups.push({vehicle_key:row.vehicle_key,listing_keys:[row.listing_key]});
    }
    return {...data,listings:rows,vehicles:groups};
  }
  const api = {clean,merge};
  if (typeof module !== 'undefined') module.exports = api;
  else root.CruiserEmailAlerts = api;
})(typeof window !== 'undefined' ? window : globalThis);
