(function(root){
'use strict';
const multi=['model','year','type','status','deal','owners','accidents','source','interior','age'];
const values=c=>c.multiple?[...c.selectedOptions].map(o=>o.value).filter(Boolean):c.value?[c.value]:[];
function set(c,v){if(c.multiple){const wanted=new Set(Array.isArray(v)?v:[v]);for(const o of c.options)o.selected=!!o.value&&wanted.has(o.value);}else c.value=Array.isArray(v)?v[0]||'':v;}
const any=(wanted,value)=>!wanted.length||wanted.includes(String(value));
function age(row,now=Date.now()){
 if(String(row.quality_flags||'').split(';').includes('email_discovery'))return 'unknown';
 const date=Date.parse(row.listed_at||'');if(!Number.isFinite(date)||date>now)return 'unknown';
 const days=Math.floor((now-date)/86400000);return days<=7?'week':days<=30?'month':days<=90?'quarter':'older';
}
function owner(row){const n=Number(row.owners);return Number.isInteger(n)&&n>0?(n>=4?'4+':String(n)):/multiple/i.test(String(row.owners))?'multiple':'unknown';}
function numeric(value,min,max){if(!min&&!max)return true;return value!==null&&value!==''&&Number.isFinite(Number(value))&&(!min||Number(value)>=Number(min))&&(!max||Number(value)<=Number(max));}
function match(row,f,derived,now=Date.now()){
 const status=derived.status,owners=owner(row);
 return any(f.model,derived.model)&&any(f.year,row.year)&&any(f.type,row.category)&&any(f.source,derived.source)
 &&(!f.status.length||f.status.includes(status)||(f.status.includes('auction-ended')&&status==='bid-not-met'))
 &&any(f.deal,derived.deal)&&any(f.interior,derived.interior)&&any(f.age,age(row,now))
 &&(!f.owners.length||f.owners.includes(owners)||(f.owners.includes('multiple')&&['2','3','4+'].includes(owners)))
 &&any(f.accidents,derived.accidents)&&numeric(derived.price,f.minPrice,f.price)&&numeric(row.mileage,f.minMileage,f.mileage);
}
function interior(raw){
 const value=String(raw??'').trim().toLowerCase();
 if(!value||/^(unknown|not specified|not reported|n[ /]?a|none)$/.test(value))return {key:'unknown',label:'Color not reported'};
 const families=[['black',/black/],['gray',/gr[ae]y|stone|charcoal/],['beige',/beige|tan|ivory|ecru|cashmere|parchment/],['brown',/brown|saddle|sepia/],['red',/red|burgundy/],['white',/white|cream/],['blue',/blue/]];
 const found=families.find(([,pattern])=>pattern.test(value));
 return found?{key:found[0],label:({beige:'Beige / tan / ivory',gray:'Gray / stone'})[found[0]]||found[0][0].toUpperCase()+found[0].slice(1)}:{key:'other',label:'Other reported color'};
}
function node(tag,cls,label){const e=document.createElement(tag);if(cls)e.className=cls;if(label)e.textContent=label;return e;}
function prepare(){
 const form=document.getElementById('filters');
 for(const [id,label,options]of [
 ['year','Model year',[]],['interior','Interior color',[]],
 ['age','Listing age',[['week','0–7 days'],['month','8–30 days'],['quarter','31–90 days'],['older','Over 90 days'],['unknown','Date unavailable']]]]){
 const wrap=node('label');wrap.append(node('span','',label));const select=node('select');select.id=id;select.append(new Option('Any',''));for(const [v,l]of options)select.append(new Option(l,v));wrap.append(select);
 form.insertBefore(wrap,id==='interior'?document.getElementById('color').nextSibling:document.getElementById(id==='year'?'type':'owners').closest('label'));
 }
 const status=document.getElementById('status');status.querySelector('[value="for-sale"]').textContent='Retail — available';status.querySelector('[value="live-auction"]').textContent='Active auction';status.querySelector('[value="auction-ended"]').textContent='Ended auction (including reserve not met)';status.append(new Option('Status unverified','other'));
 const owners=document.getElementById('owners');owners.options[1].textContent='1 reported owner';owners.options[2].textContent='2+ reported owners';owners.append(new Option('Exactly 2 owners','2'),new Option('Exactly 3 owners','3'),new Option('4+ owners','4+'));
 for(const [id,title,step,cap]of [['price','Price',1000,150000],['mileage','Mileage',5000,500000]]){
 const old=document.getElementById(id),wrap=node('fieldset','range-filter');wrap.dataset.range=id;const legend=node('legend','',title);wrap.append(legend);
 const numbers=node('div','range-numbers');for(const side of ['min','max']){const label=node('label');label.append(node('span','',side==='min'?'Minimum':'Maximum'));const input=node('input');input.type='number';input.min='0';input.step='1';input.id=side==='min'?(id==='price'?'minPrice':'minMileage'):id;input.placeholder=side==='min'?'0':'No max';input.setAttribute('aria-label',`${side==='min'?'Minimum':'Maximum'} ${id}`);label.append(input);numbers.append(label);}wrap.append(numbers);
 for(const side of ['min','max']){const label=node('label','range-slider-label',`${side==='min'?'Minimum':'Maximum'} ${title.toLowerCase()}`);const slider=node('input');slider.type='range';slider.min='0';slider.max=String(cap);slider.step=String(step);slider.dataset.side=side;slider.defaultValue=side==='min'?'0':String(cap);slider.setAttribute('aria-label',`${side==='min'?'Minimum':'Maximum'} ${id} slider`);label.append(slider);wrap.append(label);}
 wrap.append(node('small','filter-help',id==='price'?'Asking price, current bid, or sale price. Move maximum fully right for no limit.':'Move maximum fully right for no limit. Missing mileage is excluded only when a range is set.'));
 old.closest('label').replaceWith(wrap);
 wrap.addEventListener('input',e=>{const inputs=wrap.querySelectorAll('input[type=number]'),sliders=wrap.querySelectorAll('input[type=range]');const index=e.target===inputs[0]||e.target===sliders[0]?0:1;
 if(e.target.type==='range')inputs[index].value=index===1&&e.target.value===e.target.max?'':e.target.value==='0'?'':e.target.value;
 if(inputs[index].value!==''&&Number(inputs[index].value)<0)inputs[index].value='0';
 if(inputs[0].value&&inputs[1].value&&Number(inputs[0].value)>Number(inputs[1].value))inputs[1-index].value=inputs[index].value;
 refreshRange(wrap);
 });
 }
 for(const id of multi){const select=document.getElementById(id);select.multiple=true;set(select,[]);}
 form.querySelector('#age').parentElement.append(node('small','filter-help','Uses the listing date, including source estimates—not last seen. Email discoveries without a listing date are unavailable.'));
}
function refreshRange(wrap){const inputs=wrap.querySelectorAll('input[type=number]'),sliders=wrap.querySelectorAll('input[type=range]');const cap=Math.max(Number(sliders[0].max),Number(inputs[0].value)||0,Number(inputs[1].value)||0);sliders.forEach((s,i)=>{s.max=cap;s.value=inputs[i].value|| (i?cap:0);s.setAttribute('aria-valuetext',i&&!inputs[i].value?'No maximum':Number(s.value).toLocaleString('en-US'));});}
function enhance(){for(const id of multi){const select=document.getElementById(id);let wrap=document.querySelector(`[data-multi="${id}"]`);if(!wrap){const old=select.closest('label');wrap=node('fieldset','multi-filter');wrap.dataset.multi=id;wrap.append(node('legend','',old.querySelector('span').textContent));const details=node('details'),summary=node('summary','', 'Any');summary.id=`${id}-summary`;details.append(summary,node('div','multi-options'));wrap.append(details);const help=old.querySelector('small');if(help)wrap.append(help);old.replaceWith(wrap);select.hidden=true;wrap.append(select);}
 if(wrap._firstOption===select.options[0] && wrap.querySelector('.multi-options').children.length)continue;
 wrap._firstOption=select.options[0];
 const options=wrap.querySelector('.multi-options');options.replaceChildren();const clear=node('button','facet-clear','Clear selection');clear.type='button';clear.addEventListener('click',()=>{set(select,[]);select.dispatchEvent(new Event('input',{bubbles:true}));});options.append(clear);
 for(const option of select.options){if(!option.value)continue;const label=node('label','color-option'),input=node('input');input.type='checkbox';input.value=option.value;input.checked=option.selected;input.addEventListener('input',e=>{e.stopPropagation();option.selected=input.checked;select.dispatchEvent(new Event('input',{bubbles:true}));});label.append(input,node('span','',option.text));options.append(label);}
 }refresh();}
function refresh(){for(const id of multi){const select=document.getElementById(id),wrap=document.querySelector(`[data-multi="${id}"]`);if(!wrap)continue;const selected=[...select.selectedOptions].filter(o=>o.value);wrap.querySelector('summary').textContent=selected.length===1?selected[0].text:selected.length?`${selected.length} selected`:'Any';const chosen=new Set(values(select));wrap.querySelectorAll('input[type=checkbox]').forEach(i=>i.checked=chosen.has(i.value));}document.querySelectorAll('[data-range]').forEach(refreshRange);}
const api={interior,multi,values,set,any,age,owner,numeric,match,prepare,enhance,refresh};if(typeof module!=='undefined')module.exports=api;else root.CruiserStrongFilters=api;
})(typeof window!=='undefined'?window:globalThis);
