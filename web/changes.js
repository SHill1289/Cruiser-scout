(function(root) {
  const day = 86400000;
  const time = value => Date.parse(value);
  function visit(previous, snapshot) {
    const end = time(snapshot);
    const last = time(previous?.lastSeen);
    const baseline = time(previous?.baseline);
    if (!Number.isFinite(end)) return null;
    if (!Number.isFinite(last) || last > end || !Number.isFinite(baseline) || baseline > last)
      return {lastSeen:snapshot, baseline:new Date(end-7*day).toISOString(), first:true};
    return {lastSeen:snapshot, baseline:new Date(Math.max(end-90*day, end > last ? last : baseline)).toISOString(), first:previous.first && end === last};
  }
  function events(rows, since, until) {
    const start = time(since), end = time(until), found = [], groups = new Map();
    const inside = date => Number.isFinite(time(date)) && time(date) > start && time(date) <= end;
    for (const row of rows) {
      const key = row.vehicle_key || row.listing_key;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(row);
    }
    for (const [key, listings] of groups) {
      const first = Math.min(...listings.map(r=>time(r.vehicle_first_seen || r.first_seen)).filter(Number.isFinite));
      const active = listings.filter(r=>r.status === "active");
      if (!active.length) continue;
      if (Number.isFinite(first) && inside(new Date(first).toISOString())) found.push({type:"new", at:new Date(first).toISOString(),row:active[0],key});
      for (const row of active) {
        for (const at of row.reappeared_at || []) if (inside(at)) found.push({type:"returned",at,row,key});
        if (row.category !== "retail") continue;
        const prices = (row.price_history || []).filter(p=>Number.isFinite(p.asking_price) && p.asking_price>0 && Number.isFinite(time(p.observed_at))).slice().sort((a,b)=>time(a.observed_at)-time(b.observed_at));
        for (let i=1;i<prices.length;i++) if (prices[i].asking_price < prices[i-1].asking_price && inside(prices[i].observed_at))
          found.push({type:"drop",at:prices[i].observed_at,row,key,before:prices[i-1].asking_price,after:prices[i].asking_price});
      }
    }
    const seen = new Set();
    return found.sort((a,b)=>time(b.at)-time(a.at)).filter(e=>{
      const id = [e.type,e.key,e.at,e.before,e.after].join("|");
      if(seen.has(id))return false;seen.add(id);return true;
    });
  }
  const api={visit,events};
  if(typeof module !== "undefined" && module.exports)module.exports=api;else root.CruiserChanges=api;
})(typeof window !== "undefined" ? window : globalThis);
