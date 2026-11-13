const {session}=require('./refresh');
const {randomUUID}=require('node:crypto');
const PATH='preferences/inventory-filters-v1.json';
const fields=new Set(['color','year','interior','age','minPrice','minMileage','search','model','type','status','deal','owners','accidents','price','mileage','zip','radius','source','sort']);
function valid(query){
 if(typeof query!=='string'||query.length>6000)return false;
 const entries=[...new URLSearchParams(query)];
 return entries.length<=120&&entries.every(([k,v])=>fields.has(k)&&v.length<=200&&!/[\x00-\x1f]/.test(v));
}
function createHandler(storage){return async(req,res)=>{
 res.setHeader('Cache-Control','private, no-store');res.setHeader('Vary','Cookie');
 const send=(code,data)=>res.status(code).json(data);
 if(!['GET','POST'].includes(req.method))return send(405,{message:'Method not allowed.'});
 const key=process.env.REFRESH_OWNER_KEY;
 if(!key||!session(req,key,res))return send(401,{message:'Unlock syncing in Watchlist with your owner code.'});
 let body=req.body;
 if(req.method==='POST'){
  const origins=['https://cruiser-scout.vercel.app',process.env.VERCEL_URL&&'https://'+process.env.VERCEL_URL];
  if(!origins.includes(req.headers.origin)||!String(req.headers['content-type']||'').startsWith('application/json'))return send(403,{message:'Request rejected.'});
  if(Number(req.headers['content-length']||0)>12000)return send(413,{message:'Filters are too large.'});
  try{if(typeof body==='string')body=JSON.parse(body);}catch{return send(400,{message:'Invalid filters.'});}
  if(!body||!valid(body.query)||!(body.revision===null||typeof body.revision==='string'&&body.revision.length<=100))return send(400,{message:'Invalid filters.'});
 }
 try{
  const blob=storage||require('@vercel/blob');const options={access:'private',token:process.env.BLOB_READ_WRITE_TOKEN};
  const current=await blob.get(PATH,{...options,useCache:false});
  const data=current?await new Response(current.stream).json():{query:null,revision:null};
  if(data.query!==null&&!valid(data.query))throw Error('Invalid stored filters');
  if(req.method==='GET'||body.query===data.query)return send(200,data);
  if(body.revision!==data.revision)return send(409,{...data,message:'Filters changed on another device.'});
  const next={query:body.query,revision:randomUUID()};
  try{await blob.put(PATH,JSON.stringify(next),{...options,addRandomSuffix:false,allowOverwrite:!!current,...(current?{ifMatch:current.blob.etag}:{}),contentType:'application/json'});}
  catch(e){if(e.name==='BlobPreconditionFailedError'||e.name==='BlobPathnameConflictError'||(blob.BlobPreconditionFailedError&&e instanceof blob.BlobPreconditionFailedError)||(blob.BlobPathnameConflictError&&e instanceof blob.BlobPathnameConflictError))return send(409,{message:'Filters changed on another device. Sync again to load them.'});throw e;}
  return send(200,next);
 }catch{return send(503,{message:'Sync unavailable. Filters remain saved on this device.'});}
};}
module.exports=createHandler();module.exports.createHandler=createHandler;module.exports.valid=valid;
