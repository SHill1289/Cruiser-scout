(function(root,factory){const api=factory();if(typeof module==="object"&&module.exports)module.exports=api;else root.CruiserMarket=api;})(typeof globalThis!=="undefined"?globalThis:this,function(){
  function filter(rows, options, now) {
    const cutoff=new Date(now); cutoff.setUTCMonth(cutoff.getUTCMonth()-Number(options.months||24));
    return rows.filter(row=>{
      if(options.model && row.model!==options.model)return false;
      if(options.years?.length && !options.years.includes(String(row.year)))return false;
      if(options.colors?.length && !options.colors.includes(row.color_key||"unknown"))return false;
      if(options.location && (row.state||"unknown")!==options.location)return false;
      if(options.city && !String(row.city||"").toLowerCase().includes(options.city.toLowerCase().trim()))return false;
      if(options.minMiles!=="" && options.minMiles!=null && (!Number.isFinite(row.mileage)||row.mileage<Number(options.minMiles)))return false;
      if(options.maxMiles!=="" && options.maxMiles!=null && (!Number.isFinite(row.mileage)||row.mileage>Number(options.maxMiles)))return false;
      if(options.period!==false) {
        const date=Date.parse(String(row.sold_at||"").slice(0,10)+"T23:59:59Z");
        if(!Number.isFinite(date)||date<cutoff.getTime()||date>new Date(now).getTime()+86400000)return false;
      }
      if(options.outcome && options.outcome!=="all" && (row.outcome||"sold")!==options.outcome)return false;
      return true;
    });
  }
  function unique(rows){return [...new Map(rows.map(r=>[r.listing_url,r])).values()];}
  function ticks(max,count=4){const power=10**Math.floor(Math.log10(Math.max(max/count,1)));const step=Math.ceil(max/count/power)*power;return Array.from({length:count+1},(_,i)=>i*step);}
  function completed(rows) {
    return rows.filter(r=>r.status==="sold" && Number.isFinite(r.sold_price) && r.sold_price>0 && Number.isFinite(Date.parse(r.sold_at||r.auction_result_at||"")))
      .map(r=>({...r,sale_price:r.sold_price,sold_at:r.sold_at||r.auction_result_at,outcome:"sold"}));
  }
  function stats(rows) {
    const prices=unique(rows).filter(r=>(r.outcome||"sold")==="sold" && Number.isFinite(r.sale_price) && r.sale_price>0).map(r=>r.sale_price).sort((a,b)=>a-b);
    const n=prices.length;
    return {count:n,median:n?(prices[Math.floor((n-1)/2)]+prices[Math.floor(n/2)])/2:null,
      average:n?prices.reduce((a,b)=>a+b,0)/n:null,min:n?prices[0]:null,max:n?prices[n-1]:null};
  }
  return {filter,unique,ticks,completed,stats};
});
