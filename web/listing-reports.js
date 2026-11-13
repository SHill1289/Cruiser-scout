/* Owner reports target one source listing, even when inventory groups duplicate VINs. */
(() => {
 const labels={wrong_photo:'Wrong photo',already_sold:'Listing already sold',missing_information:'Missing information'};
 const statuses={queued:'Queued',retry_queued:'Retry queued',updated:'Evidence updated',needs_review:'Checked — review needed'};
 const el=(tag,cls,content)=>{const n=document.createElement(tag);if(cls)n.className=cls;if(content)n.textContent=content;return n;};
 const dialog=el('dialog','listing-report-dialog');dialog.id='listing-report-dialog';dialog.setAttribute('aria-labelledby','listing-report-title');
 const header=el('header'),title=el('h2','','Report a listing issue');title.id='listing-report-title';
 const close=el('button','','Close ×');close.type='button';close.setAttribute('aria-label','Close listing report');close.addEventListener('click',()=>dialog.close());header.append(title,close);
 const vehicle=el('p'),label=el('label','','Source listing'),select=el('select');select.id='report-source';label.htmlFor=select.id;
 const note=el('p','report-help','Choose the source with the issue. Reports are rechecked during scheduled refreshes, within free limits. A report alone never changes sale status or proves a photo is wrong.');
 const buttons=el('div','report-options'),status=el('p','report-status');status.setAttribute('role','status');
 const history=el('div','report-history'),unlock=el('a','','Unlock in Watchlist');unlock.href='#watchlist';unlock.hidden=true;unlock.addEventListener('click',()=>dialog.close());
 const check=el('button','','Check report status');check.type='button';
 const privacy=el('small','report-help','Only the listing ID, issue type, and recheck result are stored in the public collection log. No password or personal message is included.');
 dialog.append(header,vehicle,label,select,note,buttons,status,history,unlock,check,privacy);document.body.append(dialog);
 let busy=false,sequence=0;
 function locked(value){busy=value;select.disabled=value;check.disabled=value;buttons.querySelectorAll('button').forEach(b=>b.disabled=value);}
 async function request(body,key=select.value){const r=await fetch('/api/listing-report'+(body?'':'?listing_key='+encodeURIComponent(key)),{method:body?'POST':'GET',credentials:'same-origin',cache:'no-store',...(body?{headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{})});return {response:r,data:await r.json()};}
 function render(reports){history.replaceChildren();for(const report of reports){const item=el('div','report-record');item.append(el('strong','',labels[report.reason]+' · '+(statuses[report.status]||report.status)),el('p','',report.detail));const stamp=report.checked_at||report.requested_at;if(stamp)item.append(el('small','',(report.checked_at?'Checked ':'Reported ')+new Date(stamp).toLocaleString()));history.append(item);}}
 async function load(){if(busy)return;const current=++sequence;locked(true);status.textContent='Checking reports…';try{const {response,data}=await request();if(current!==sequence)return;unlock.hidden=response.status!==401;if(!response.ok){status.textContent=data.message||'Report status unavailable.';return;}render(data.reports);status.textContent=data.reports.length?'Latest recorded reports are shown below.':'No reports recorded for this source listing.';}catch{status.textContent='Could not load report status. Try again later.';}finally{if(current===sequence)locked(false);}}
 async function submit(reason){if(busy)return;const current=++sequence,key=select.value;locked(true);try{const {response,data}=await request({listing_key:key,reason});if(current!==sequence)return;unlock.hidden=response.status!==401;status.textContent=data.message||'Report unavailable.';if(data.report)render([data.report]);if(response.status===202)history.replaceChildren(el('p','','Submitted — waiting for the queue. Check status shortly; the next scheduled refresh will attempt the recheck.'));}catch{status.textContent='Submission could not be confirmed. Check status before trying again.';}finally{if(current===sequence)locked(false);}}
 for(const [reason,text]of Object.entries(labels)){const b=el('button','',text);b.type='button';b.addEventListener('click',()=>submit(reason));buttons.append(b);}
 check.addEventListener('click',load);select.addEventListener('change',()=>{history.replaceChildren();load();});
 dialog.addEventListener('close',()=>{sequence++;locked(false);});
 function button(row,listings){const b=el('button','report-issue-button','Report issue');b.type='button';b.setAttribute('aria-haspopup','dialog');b.setAttribute('aria-label',`Report issue with ${row.year} ${row.make||''} ${row.model}`);b.addEventListener('click',()=>{vehicle.textContent=`${row.year} ${row.make||''} ${row.model}`;select.replaceChildren(...listings.map(r=>new Option(`${r.source} · ${r.seller||'Seller not reported'} · ${r.source_listing_id||r.listing_key}`,r.listing_key,false,r.listing_key===row.listing_key)));history.replaceChildren();dialog.showModal();load();});return b;}
 window.CruiserReports={button};
})();
