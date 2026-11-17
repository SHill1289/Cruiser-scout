(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.CruiserAuctionFees=api;})(typeof globalThis!=='undefined'?globalThis:this,function(){
  'use strict';
  const cents=n=>Math.round((n+Number.EPSILON)*100);
  const sourceKey=s=>String(s||'').toLowerCase().replace(/[^a-z]/g,'');
  const valid=n=>Number.isFinite(n)&&n>0&&n<=100000000;
  function fee(bid,date='') {
    if(!valid(bid))return null;
    // BaT's higher cap took effect after the Jan 29, 2024 auctions closed.
    const cap=/^\d{4}-\d{2}-\d{2}/.test(date)&&date.slice(0,10)<='2024-01-29'?5000:7500;
    return Math.min(cap*100,Math.max(25000,Math.round(cents(bid)*.05)))/100;
  }
  function estimate(bid,extras=0,date='') {
    if(!valid(bid)||!Number.isFinite(extras)||extras<0||extras>100000000)return null;
    const premium=fee(bid,date);
    return {bid:cents(bid)/100,fee:premium,extras:cents(extras)/100,total:(cents(bid)+cents(premium)+cents(extras))/100};
  }
  function maxBid(budget,extras=0,date='') {
    if(!valid(budget)||!Number.isFinite(extras)||extras<0||extras>=budget||budget-extras<250.01)return null;
    let low=1,high=cents(budget-extras),best=null;
    while(low<=high){const mid=Math.floor((low+high)/2),total=estimate(mid/100,extras,date).total;if(cents(total)<=cents(budget)){best=mid;low=mid+1;}else high=mid-1;}
    return best===null?null:best/100;
  }
  function completed(row,field='sale_price') {
    if(sourceKey(row.source)!=='bringatrailer'||row.outcome==='unsold'||(row.status&&row.status!=='sold')||!valid(row[field])||row.price_review?.[field]||row.auction_fee_included)return row;
    if(row.currency&&!['USD','US$','$'].includes(row.currency.toUpperCase()))return row;
    const calculation=estimate(row[field],0,String(row.sold_at||row.auction_result_at||''));
    return {...row,[field]:calculation.total,hammer_price:row[field],buyer_fee:calculation.fee,auction_fee_included:true};
  }
  function prepare(data,prices) {
    const history=data.market_history||{},sales=(history.sales||[]).map(r=>completed(r));
    return {...data,market_history:{...history,sales,results:(history.results||[]).map(r=>completed(r))},listings:(data.listings||[]).map(r=>prices.rate(r.status==='sold'?completed(r,'sold_price'):r,sales))};
  }
  const format=new Intl.NumberFormat("en-US",{style:"currency",currency:"USD",minimumFractionDigits:2,maximumFractionDigits:2}).format;
  return {fee,estimate,maxBid,completed,prepare,sourceKey,format};
});
