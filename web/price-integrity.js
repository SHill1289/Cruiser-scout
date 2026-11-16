(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.CruiserPrices=api;})(typeof globalThis!=='undefined'?globalThis:this,function(){
  'use strict';
  // Conservative review thresholds for Scout's 2006–2016 trucks, not appraisals.
  const fields=['asking_price','sold_price','current_bid','sale_price'];
  const day=86400000;
  function reason(row,field,value,now=Date.now()) {
    if(value==null || value==='')return '';
    if(!Number.isFinite(value)||value<=0)return 'Invalid or placeholder amount';
    if(row.currency && !['USD','US$','$'].includes(String(row.currency).toUpperCase()))return 'Non-USD amount; no currency conversion verified';
    const bid=field==='current_bid'||(field==='sale_price'&&row.outcome==='unsold');
    if(!bid && value<2500)return 'Unusually low full-vehicle price; may be a payment or deposit';
    if(value>250000)return 'Unusually high amount; verify the full-vehicle price';
    if(!bid) {
      const description=String(row.source_description||'');
      const payments=description.matchAll(/\$\s*([\d,]+(?:\.\d{1,2})?)\s*(?:\/\s*(?:mo(?:nth)?|month)|per\s+month|a\s+month|monthly|down\b|deposit\b)/gi);
      for(const match of payments)if(Number(match[1].replaceAll(',',''))===value)return 'Amount described as a payment or deposit';
    }
    if(field==='current_bid' && row.status!=='ended' && row.status!=='sold') {
      const observed=Date.parse(row.bid_observed_at||''),end=Date.parse(row.auction_ends_at||'');
      if(row.status!=='active'||!Number.isFinite(observed)||observed>now+60000||now-observed>day||!Number.isFinite(end)||end<=now)
        return 'Auction bid is stale or its current status is unverified';
    }
    return '';
  }
  function fieldFor(row){return row.status==='sold'?'sold_price':row.category==='auction'?'current_bid':'asking_price';}
  function clean(row,now=Date.now()) {
    const result={...row,price_review:{...(row.price_review||{})},reported_prices:{...(row.reported_prices||{})}};
    for(const field of fields) {
      const why=reason(row,field,row[field],now);
      if(why){result.reported_prices[field]=row[field];result.price_review[field]=why;result[field]=null;}
    }
    // Keep gaps: a rejected observation must not create an apparent price drop.
    if(Array.isArray(row.price_history))result.price_history=row.price_history.map(point=>({...point,asking_price:reason(row,'asking_price',point.asking_price,now)?null:point.asking_price}));
    if(result.price_review[fieldFor(row)]) {
      for(const key of Object.keys(result))if(key.startsWith('deal_'))delete result[key];
      result.price_history=[];
    }
    return result;
  }
  function listings(rows,now=Date.now()) {
    const result=rows.map(row=>clean(row,now)),groups=new Map();
    for(const row of result) {
      const seen=Date.parse(row.last_seen||'');
      if(row.status!=='active'||row.category!=='retail'||!Number.isFinite(row.asking_price)||!/^vin:[A-HJ-NPR-Z0-9]{17}$/.test(row.vehicle_key||'')||!Number.isFinite(seen)||now-seen>7*day||seen>now+60000)continue;
      if(!groups.has(row.vehicle_key))groups.set(row.vehicle_key,[]);
      groups.get(row.vehicle_key).push(row);
    }
    const conflicts=new Set();
    for(const group of groups.values())for(let i=0;i<group.length;i++)for(let j=i+1;j<group.length;j++) {
      const a=group[i],b=group[j],low=Math.min(a.asking_price,b.asking_price),high=Math.max(a.asking_price,b.asking_price);
      if(a.source!==b.source && Math.abs(Date.parse(a.last_seen)-Date.parse(b.last_seen))<=2*day && high-low>=5000 && high/low>1.35){conflicts.add(a);conflicts.add(b);}
    }
    for(const row of conflicts){row.reported_prices.asking_price=row.asking_price;row.asking_price=null;row.price_review.asking_price='Recent sources disagree substantially for this VIN';row.price_history=[];for(const key of Object.keys(row))if(key.startsWith('deal_'))delete row[key];}
    return result;
  }
  function rate(row,sales) {
    // Preserve existing eligibility rules; never invent a rating for an unrated row.
    if(!row.deal_quality)return row;
    const result={...row};for(const key of Object.keys(result))if(key.startsWith('deal_'))delete result[key];
    const band=m=>!Number.isFinite(m)?null:m<100000?0:m<150000?1:m<250000?2:3;
    if(row.status!=='active'||row.category!=='retail'||!Number.isFinite(row.asking_price)||band(row.mileage)===null)return result;
    const prices=sales.filter(s=>(s.model||'LX470')===(row.model||'LX470')&&band(s.mileage)===band(row.mileage)&&Number.isFinite(s.sale_price)&&s.outcome!=='unsold').map(s=>s.sale_price).sort((a,b)=>a-b);
    if(prices.length<3)return result;
    const median=(prices[Math.floor((prices.length-1)/2)]+prices[Math.floor(prices.length/2)])/2;
    const difference=Math.round((row.asking_price-median)/median*100);
    return {...result,deal_quality:difference<=-15?'great':difference<=15?'fair':'bad',deal_percent_vs_median:difference,deal_comparable_count:prices.length,deal_median_price:median,deal_mileage_band:['Under 100k','100k-150k','150k-250k','250k+'][band(row.mileage)]};
  }
  function prepare(data,now=Date.now()) {
    const history=data.market_history||{},sales=(history.sales||[]).map(r=>clean(r,now));
    return {...data,listings:listings(data.listings||[],now).map(r=>rate(r,sales)),market_history:{...history,sales,results:(history.results||[]).map(r=>clean(r,now))}};
  }
  return {reason,fieldFor,clean,listings,rate,prepare};
});
