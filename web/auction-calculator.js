/* Local arithmetic only: no requests, saved budgets, or bidding actions. */
function auctionCalculator(row=null) {
  const section=document.createElement('section');section.className='panel auction-calculator';
  const heading=document.createElement('h3');heading.textContent='Auction premium calculator';section.append(heading);
  const intro=document.createElement('p');intro.textContent='Plan a bid or work backward from your budget. USD vehicle auctions only.';section.append(intro);
  const grid=document.createElement('div');grid.className='auction-calculator-fields';section.append(grid);
  function field(label,element){const wrap=document.createElement('label');wrap.append(document.createTextNode(label),element);grid.append(wrap);return element;}
  const source=field('Auction site',document.createElement('select'));
  for(const [value,label] of [['bringatrailer','Bring a Trailer'],['carsandbids','Cars & Bids']])source.add(new Option(label,value));
  source.value=CruiserAuctionFees.sourceKey(row?.source)==='carsbids'||CruiserAuctionFees.sourceKey(row?.source)==='carsandbids'?'carsandbids':'bringatrailer';
  function numeric(label,placeholder){const input=document.createElement('input');input.type='number';input.min='0';input.max='100000000';input.step='.01';input.inputMode='decimal';input.placeholder=placeholder;return field(label,input);}
  const bid=numeric('Your bid ($)','Enter an amount');
  const extras=numeric('Extra costs you expect ($)','Optional: tax, transport, registration');
  const budget=numeric('Your total budget ($)','Optional');
  const initial=row?.hammer_price ?? (row?.status==='sold'?row?.sold_price:row?.current_bid);
  if(Number.isFinite(initial)&&initial>0)bid.value=String(initial);
  const result=document.createElement('div');result.className='auction-calculator-result';result.setAttribute('role','status');result.setAttribute('aria-live','polite');section.append(result);
  const budgetResult=document.createElement('p');budgetResult.className='auction-budget-result';budgetResult.setAttribute('aria-live','polite');section.append(budgetResult);
  const use=document.createElement('button');use.type='button';use.textContent='Use maximum bid';use.className='secondary-button';use.hidden=true;section.append(use);
  const note=document.createElement('p');note.className='auction-fee-note';section.append(note);
  const link=document.createElement('a');link.target='_blank';link.rel='noopener noreferrer';link.textContent='View published buyer fees ↗';section.append(link);
  const money=new Intl.NumberFormat('en-US',{style:'currency',currency:'USD',minimumFractionDigits:2});
  let maximum=null;
  const number=input=>input.value.trim()===''?null:Number(input.value);
  function update(){
    const extra=extras.value.trim()===''?0:number(extras),amount=number(bid);
    const quote=CruiserAuctionFees.estimate(amount,extra);
    result.replaceChildren();
    if(quote){for(const [label,value] of [['Bid',quote.bid],["Buyer’s fee",quote.fee],['Extra costs',quote.extras],['Estimated total',quote.total]]){const item=document.createElement('div');const title=document.createElement('span');title.textContent=label;const valueNode=document.createElement('strong');valueNode.textContent=money.format(value);item.append(title,valueNode);result.append(item);}}
    else result.textContent=bid.value===''?'Enter a bid to calculate the buyer’s fee.':'Enter a positive bid and valid nonnegative extra costs.';
    maximum=CruiserAuctionFees.maxBid(number(budget),extra);use.hidden=maximum===null;
    budgetResult.textContent=budget.value===''?'':maximum===null?'This budget cannot cover a bid, the minimum buyer’s fee, and your extra costs.':`Maximum bid within your budget: ${money.format(maximum)}. Round down to an allowed bidding increment.${quote&&quote.total>number(budget)?' Your entered bid exceeds this budget.':''}`;
    note.textContent='Current fee: 5% of the winning bid, $250 minimum, $7,500 maximum. Taxes, shipping, registration and other charges are included only if you enter them above. This is an estimate, not a bid or invoice.';
    link.href=source.value==='carsandbids'?'https://carsandbids.com/what-is/':'https://bringatrailer.com/how-bat-works/';
  }
  use.addEventListener('click',()=>{if(maximum!==null){bid.value=String(maximum);update();}});
  for(const input of [source,bid,extras,budget])input.addEventListener('input',update);
  update();return section;
}
