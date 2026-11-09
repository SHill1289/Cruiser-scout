(function(root) {
  'use strict';
  const paused = new Set(['disabled','not_applicable','paused','manual_only']);
  function state(job, now) {
    if (paused.has(job.status)) return 'paused';
    if (['error','partial','warning'].includes(job.status)) return 'attention';
    const checked = Date.parse(job.checked_at), limit = job.email ? 20*60000 : /^autodev/.test(job.source || '') || job.source==='Collection watchdog' ? 30*3600000 : 9*3600000;
    if (!Number.isFinite(checked) || now-checked>limit || checked>now+300000) return 'stale';
    return job.status === 'ok' ? 'healthy' : 'unknown';
  }
  function photos(row) {
    const urls = Array.isArray(row.photo_urls) ? row.photo_urls : [];
    return new Set([...urls,row.photo_url].filter(u=>typeof u==='string' && u.trim())).size;
  }
  function summarize(rows, jobs, email, now=Date.now()) {
    const searches = jobs.map(j=>({...j,health:state(j,now)}));
    const mail = email ? {source:'Auction email alerts',status:email.partial?'partial':'ok',checked_at:email.checked_at,email:true,
      detail:'BaT and Cars & Bids alerts. A successful check does not mean a new matching email arrived.'} :
      {source:'Auction email alerts',status:'error',email:true,detail:'The email feed could not be loaded. Main inventory remains available.'};
    searches.push({...mail,health:state(mail,now)});
    const counts = {healthy:0,attention:0,stale:0,paused:0,unknown:0};
    searches.forEach(j=>counts[j.health]++);
    const sources = new Map();
    for (const row of rows) {
      const name=String(row.source || 'Unknown');
      if (!sources.has(name)) sources.set(name,{source:name,total:0,active:0,unverified:0,noPhotos:0,onePhoto:0,gallery:0,noMileage:0,noPrice:0,noLocation:0});
      const s=sources.get(name); s.total++;
      if (row.status!=='active') {if(row.status==='unknown')s.unverified++;continue;}
      s.active++;
      const count=photos(row); s[count===0?'noPhotos':count===1?'onePhoto':'gallery']++;
      if (!Number.isFinite(row.mileage)) s.noMileage++;
      const price=row.category==='auction'?row.current_bid:row.asking_price;
      if (!Number.isFinite(price) || price<=0) s.noPrice++;
      if (![row.city,row.state,row.country].some(v=>typeof v==='string' && v.trim())) s.noLocation++;
    }
    return {searches,counts,sources:[...sources.values()].sort((a,b)=>a.source.localeCompare(b.source))};
  }
  function render(holder, rows, jobs, email, generated, labels, now=Date.now()) {
    const data=summarize(rows,jobs,email,now);
    const el=(tag,cls,value)=>{const e=document.createElement(tag);e.className=cls||'';if(value!=null)e.textContent=value;return e;};
    const date=v=>Number.isFinite(Date.parse(v))?new Date(v).toLocaleString(undefined,{dateStyle:'medium',timeStyle:'short'}):'Time unavailable';
    const metric=(label,value,note)=>{const box=el('div','metric-card');box.append(el('span','',label),el('strong','',String(value)),el('small','',note));return box;};
    holder.replaceChildren();
    holder.append(el('p','health-caption',`Inventory snapshot: ${date(generated)}. Health evaluated when this page loaded: ${date(new Date(now).toISOString())}. Reload to check again.`));
    const metrics=el('div','metric-grid');
    metrics.append(metric('Up to date',data.counts.healthy,'Collection jobs, including email checks'),metric('Needs attention',data.counts.attention+data.counts.stale+data.counts.unknown,'Errors, warnings, overdue or unknown checks'),metric('Paused / not enabled',data.counts.paused,'Not counted as failed checks'),metric('Active listings missing photos',data.sources.reduce((n,s)=>n+s.noPhotos,0),'Listing records, not unique trucks'));
    holder.append(metrics);
    const jobsPanel=el('section','panel'); jobsPanel.append(el('h2','','Collection jobs'),el('p','health-caption','Most jobs run every 6 hours; Auto.dev runs daily; auction emails are checked every 5 minutes. Overdue means more than 9 hours, 30 hours, or 20 minutes respectively. Last check is an attempt, not proof of a successful refresh.'));
    const list=el('div','health-jobs');
    const rank={attention:0,stale:1,unknown:2,healthy:3,paused:4};
    for(const job of [...data.searches].sort((a,b)=>rank[a.health]-rank[b.health] || a.source.localeCompare(b.source))) {
      const item=el('details','health-job');
      const summary=el('summary'); const title=el('span','health-job-name',job.source);
      summary.append(title,el('span','health-badge health-'+job.health,({healthy:'Up to date',attention:'Needs attention',stale:'Overdue / no timestamp',paused:'Paused / not enabled',unknown:'Unknown'})[job.health]),el('small','',`${job.health==='paused'?'Report updated':'Last check'}: ${date(job.checked_at)}`));
      item.append(summary,el('p','',`Reported status: ${String(job.status || 'unknown').replaceAll('_',' ')}. ${job.detail || 'No collection details reported.'}`));list.append(item);
    }
    jobsPanel.append(list);holder.append(jobsPanel);
    const coverage=el('section','panel');coverage.append(el('h2','','Photos and listing details'),el('p','health-caption','Gaps below count active listings only. Closed listings are excluded; discoveries with unverified status are shown separately. Photo counts are stored image URLs, not a new image availability test. Missing details mean not supplied, not a vehicle defect.'));
    const grid=el('div','health-coverage');
    for(const s of data.sources) {
      const card=el('article','health-source');card.append(el('h3','',labels(s.source)),el('p','',`${s.active} active · ${s.unverified} status unverified · ${s.total} total records`));
      const dl=el('dl','health-facts');
      for(const [label,count] of [['No photos',s.noPhotos],['Only one photo',s.onePhoto],['Two or more photos',s.gallery],['Mileage missing',s.noMileage],['Price / bid missing',s.noPrice],['Location missing',s.noLocation]])dl.append(el('dt','',label),el('dd','',String(count)));
      const link=el('a','health-source-link','Browse this source →');link.href='#inventory?source='+encodeURIComponent(s.source);card.append(dl,link);grid.append(card);
    }
    coverage.append(grid);holder.append(coverage);
  }
  const api={state,photos,summarize,render};if(typeof module!=='undefined')module.exports=api;else root.CruiserCollectionHealth=api;
})(typeof window!=='undefined'?window:globalThis);
