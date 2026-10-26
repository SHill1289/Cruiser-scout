/* Auction explorer: explicit results, keyboard and touch selection. */
let marketRows = [];
function marketOptions() {
  const val=id=>document.getElementById(id).value;
  const checked=id=>[...document.querySelectorAll("#"+id+" input:checked")].map(input=>input.value);
  return {model:ui.marketModel.value,years:checked("market-year"),colors:checked("market-colors"),
    months:val("market-period"),minMiles:val("market-mileage-min"),maxMiles:val("market-mileage-max"),
    location:val("market-location"),city:val("market-city"),outcome:val("market-outcome")};
}
function renderMarketFacets() {
  const previous=marketOptions();
  const rows=marketRows.filter(row=>row.model===ui.marketModel.value);
  function picks(id,values,selected) {
    document.getElementById(id).replaceChildren(...values.map(([value,name])=>{
      const label=text("label","",""); const input=document.createElement("input");
      input.type="checkbox";input.value=value;input.checked=selected.includes(value);
      label.append(input,document.createTextNode(name));return label;
    }));
  }
  picks("market-year",[...new Set(rows.map(r=>String(r.year)))].sort().map(y=>[y,y]),previous.years);
  picks("market-colors",[...new Map(rows.map(r=>[r.color_key,r.color_name])).entries()].sort((a,b)=>a[1].localeCompare(b[1])),previous.colors);
  const locations=[...new Set(rows.map(r=>r.state||"unknown"))].sort();
  const select=document.getElementById("market-location");
  select.replaceChildren(new Option("All locations",""),...locations.map(s=>new Option(s==="unknown"?"Location unavailable":s,s)));
  if(locations.includes(previous.location))select.value=previous.location;
}
function marketResultLabel(row) {
  return row.year+" "+CruiserFilters.modelLabel(row.model)+" · "+(row.mileage==null?"Mileage unavailable":integer.format(row.mileage)+" mi")+" · "+
    (Number.isFinite(row.sale_price)?money.format(row.sale_price):"Price unavailable")+" · "+(row.outcome==="unsold"?"Reserve not met":"Sold");
}
function marketResultCard(row) {
  const card=text("article","market-result","");
  const link=text("a","",marketResultLabel(row));
  link.href=row.listing_url;link.target="_blank";link.rel="noopener noreferrer";
  card.append(link,text("p","",row.sold_at+" · "+row.color_name+" · "+([row.city,row.state].filter(Boolean).join(", ")||"Location unavailable")));
  return card;
}
function renderMarketChart(rows) {
  const options=marketOptions();
  document.getElementById("market-year-count").textContent=options.years.length?options.years.join(", "):"All";
  document.getElementById("market-color-count").textContent=options.colors.length?options.colors.length+" selected":"All";
  const holder=document.getElementById("market-plot");
  const detail=document.getElementById("market-point-detail");
  const mode=document.getElementById("market-axis").value;
  const points=rows.filter(r=>Number.isFinite(r.sale_price)&&r.sale_price>0&&(mode==="date"?Number.isFinite(Date.parse(r.sold_at)):Number.isFinite(r.mileage)));
  document.getElementById("market-chart-title").textContent=mode==="date"?"Auction price over time":"Auction price vs. mileage";
  document.getElementById("market-chart-count").textContent=rows.length+" matching results · "+points.length+" plotted"+(rows.length>points.length?" · "+(rows.length-points.length)+" missing "+(mode==="date"?"price or date":"price or mileage"):"");
  document.getElementById("market-results-list").replaceChildren(...rows.slice().sort((a,b)=>b.sold_at.localeCompare(a.sold_at)).map(marketResultCard));
  holder.replaceChildren();
  detail.textContent="Select a point to see its year, mileage, color, location, and auction result.";
  if(!points.length){holder.append(text("p","empty","No auction results match these filters. Try another year, a wider mileage range, or reset the filters."));return;}
  const width=Math.max(300,holder.clientWidth||700),height=350;
  const left=60,right=18,top=22,bottom=48;
  const ns="http://www.w3.org/2000/svg";
  function svgNode(tag,attrs={},content=""){const e=document.createElementNS(ns,tag);Object.entries(attrs).forEach(([k,v])=>e.setAttribute(k,v));e.textContent=content;return e;}
  const svg=svgNode("svg",{viewBox:"0 0 "+width+" "+height,role:"group","aria-label":mode==="date"?"Auction dates and prices":"Auction mileage and prices"});
  const prices=CruiserMarket.ticks(Math.max(...points.map(r=>r.sale_price)));
  const yMax=prices.at(-1);
  const xValues=points.map(r=>mode==="date"?Date.parse(r.sold_at):r.mileage);
  let xMin=0,xMax;
  if(mode==="date"){const cutoff=new Date(generatedAt);cutoff.setUTCMonth(cutoff.getUTCMonth()-Number(options.months));xMin=cutoff.getTime();xMax=generatedAt.getTime();}
  else xMax=CruiserMarket.ticks(Math.max(...xValues,1)).at(-1);
  const x=value=>left+(value-xMin)/(xMax-xMin)*(width-left-right);
  const y=value=>height-bottom-value/yMax*(height-top-bottom);
  for(const price of prices){
    svg.append(svgNode("line",{x1:left,y1:y(price),x2:width-right,y2:y(price),class:"market-gridline"}),
      svgNode("text",{x:left-8,y:y(price)+4,"text-anchor":"end",class:"market-tick"},price?"$"+(price/1000)+"k":"$0"));
  }
  const steps=width<500?3:5;
  for(let i=0;i<=steps;i++){
    const value=xMin+(xMax-xMin)*i/steps;
    const label=mode==="date"?new Date(value).toLocaleDateString("en-US",{month:"short",year:"2-digit",timeZone:"UTC"}):Math.round(value/1000)+"k";
    svg.append(svgNode("line",{x1:x(value),y1:top,x2:x(value),y2:height-bottom,class:"market-gridline"}),
      svgNode("text",{x:x(value),y:height-bottom+23,"text-anchor":i===0?"start":i===steps?"end":"middle",class:"market-tick"},label));
  }
  svg.append(svgNode("text",{x:left+(width-left-right)/2,y:height-3,"text-anchor":"middle",class:"market-tick"},mode==="date"?"Auction date":"Reported mileage (mi)"));
  points.forEach(row=>{
    const group=svgNode("g",{tabindex:"0",role:"button","aria-label":marketResultLabel(row)+" · "+row.sold_at,class:"market-dot"});
    const cx=x(mode==="date"?Date.parse(row.sold_at):row.mileage),cy=y(row.sale_price);
    group.append(svgNode("title",{},marketResultLabel(row)),svgNode("circle",{cx,cy,r:13,fill:"transparent"}),
      svgNode("circle",{cx,cy,r:5,class:row.outcome==="unsold"?"market-dot-core unsold":"market-dot-core"}));
    const select=()=>{
      svg.querySelectorAll(".selected").forEach(n=>n.classList.remove("selected"));group.classList.add("selected");
      detail.replaceChildren(marketResultCard(row));
    };
    group.addEventListener("click",select);
    group.addEventListener("keydown",event=>{if(event.key==="Enter"||event.key===" "){event.preventDefault();select();}});
    svg.append(group);
  });
  holder.append(svg);
}
function resetMarketFilters(){
  for(const id of ["market-mileage-min","market-mileage-max","market-city","market-location"])document.getElementById(id).value="";
  document.getElementById("market-period").value="24";document.getElementById("market-outcome").value="all";
  document.querySelectorAll("#market-controls input[type=checkbox]").forEach(input=>input.checked=false);
  renderMarket();
}
document.getElementById("market-reset").addEventListener("click",resetMarketFilters);
for(const id of ["market-colors","market-mileage-min","market-mileage-max","market-location","market-city","market-outcome","market-axis"])
  document.getElementById(id).addEventListener("input",()=>renderMarket());
let marketWidth=0;
new ResizeObserver(entries=>{
  const width=entries[0].contentRect.width;
  if(width>0&&Math.abs(width-marketWidth)>1){marketWidth=width;if(marketRows.length)renderMarket();}
}).observe(document.getElementById("market-plot"));
