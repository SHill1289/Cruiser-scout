const {createHash}=require('node:crypto');
const {session}=require('./refresh');
const reasons=['wrong_photo','already_sold','missing_information'];
const validKey=k=>typeof k==='string'&&/^[a-zA-Z0-9:_.-]{1,200}$/.test(k);
const id=(key,reason)=>createHash('sha256').update(key+':'+reason).digest('hex');
const repo='SHill1289/Cruiser-scout';
async function record(key,reason){
 const r=await fetch(`https://raw.githubusercontent.com/${repo}/main/data/recheck_requests/${id(key,reason)}.json?check=${Date.now()}`,{cache:'no-store',redirect:'error',signal:AbortSignal.timeout(8000)});
 if(r.status===404)return null;if(!r.ok)throw Error('Queue unavailable');
 const d=await r.json();return {reason:d.reason,status:d.status,requested_at:d.requested_at,checked_at:d.checked_at||null,detail:d.detail||'',attempts:d.attempts||0};
}
async function handler(req,res){
 res.setHeader('Cache-Control','private, no-store');res.setHeader('Vary','Cookie');
 const send=(code,data)=>res.status(code).json(data);
 if(!['GET','POST'].includes(req.method))return send(405,{message:'Method not allowed.'});
 const secret=process.env.REFRESH_OWNER_KEY;
 if(!secret||!session(req,secret,res))return send(401,{message:'Unlock owner syncing in Watchlist to report an issue.'});
 let body=req.body;
 if(req.method==='POST'){
  const origins=['https://cruiser-scout.vercel.app',process.env.VERCEL_URL&&'https://'+process.env.VERCEL_URL];
  if(!origins.includes(req.headers.origin)||!String(req.headers['content-type']||'').startsWith('application/json'))return send(403,{message:'Request rejected.'});
  if(Number(req.headers['content-length']||0)>2000)return send(413,{message:'Report too large.'});
  try{if(typeof body==='string')body=JSON.parse(body);}catch{return send(400,{message:'Invalid report.'});}
 }
 const key=req.method==='GET'?req.query?.listing_key:body?.listing_key;
 if(!validKey(key)||(req.method==='POST'&&!reasons.includes(body?.reason)))return send(400,{message:'Choose a listing and issue type.'});
 try{
  if(req.method==='GET')return send(200,{reports:(await Promise.all(reasons.map(reason=>record(key,reason)))).filter(Boolean)});
  const existing=await record(key,body.reason);
  if(existing&&(['queued','retry_queued'].includes(existing.status)||Date.now()-Date.parse(existing.requested_at)<86400000))return send(200,{report:existing,message:'This issue is already recorded. Check its status below.'});
  const token=process.env.GITHUB_REFRESH_TOKEN;if(!token)return send(503,{message:'Report queue is not configured.'});
  const r=await fetch(`https://api.github.com/repos/${repo}/actions/workflows/listing_recheck.yml/dispatches`,{method:'POST',redirect:'error',signal:AbortSignal.timeout(10000),headers:{Authorization:'Bearer '+token,Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28','Content-Type':'application/json'},body:JSON.stringify({ref:'main',inputs:{listing_key:key,reason:body.reason}})});
  if(!r.ok)throw Error('Queue unavailable');
  return send(202,{message:'Report submitted. It will appear in the queue shortly and be checked during a scheduled refresh. Reports do not automatically change listing data.'});
 }catch{return send(503,{message:'Could not confirm submission. Check status before trying again.'});}
}
module.exports=handler;module.exports.reportId=id;
