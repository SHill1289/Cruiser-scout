const {test}=require('node:test');
const assert=require('node:assert/strict');
const {createHmac}=require('node:crypto');
const {createHandler}=require('../api/watchlist');
const key='test-owner-code-at-least-32-characters';
process.env.REFRESH_OWNER_KEY=key;
const expiry=String(Date.now()+86400000);
const cookie='__Host-scout-owner='+expiry+'.'+createHmac('sha256',key).update(expiry).digest('hex');
function store(saved=['vin-old']) {
 return {saved,version:1,writes:0,BlobPreconditionFailedError:class extends Error{},
 async get(){return {stream:new Response(JSON.stringify({saved:this.saved})).body,blob:{etag:String(this.version)}};},
 async put(path,body,options){assert.equal(options.access,'private');assert.equal(options.ifMatch,String(this.version));this.saved=JSON.parse(body).saved;this.version++;this.writes++;}};
}
async function call(storage,method='GET',body,headers={}){
 const res={setHeader(){},status(n){this.code=n;return this;},json(v){this.body=v;}};
 await createHandler(storage)({method,body,headers:{cookie,origin:'https://cruiser-scout.vercel.app','content-type':'application/json',...headers}},res);return res;
}
test('private access, CSRF and invalid changes are rejected before storage access',async()=>{
 const db=store();db.get=()=>{throw new Error('must not read');};
 assert.equal((await call(db,'GET',null,{cookie:''})).code,401);
 assert.equal((await call(db,'POST',{operations:[]},{origin:'https://other.test'})).code,403);
 assert.equal((await call(db,'POST',{operations:[{key:'../../x',saved:true}]})).code,400);
});
test('import merges devices, removal persists, duplicate retries do not write again',async()=>{
 const db=store();const op={operations:[{key:'vin-new',saved:true}]};
 assert.deepEqual((await call(db,'POST',op)).body.saved,['vin-new','vin-old']);
 await call(db,'POST',op);assert.equal(db.writes,1);
 await call(db,'POST',{operations:[{key:'vin-old',saved:false}]});
 assert.deepEqual((await call(db)).body.saved,['vin-new']);
});
test('concurrent save retries against the fresh version without losing the other browser',async()=>{
 const db=store();const put=db.put;
 db.put=async function(...args){if(!this.conflicted){this.conflicted=true;this.saved.push('vin-other');this.version++;throw new this.BlobPreconditionFailedError();}return put.apply(this,args);};
 const result=await call(db,'POST',{operations:[{key:'vin-new',saved:true}]});
 assert.equal(result.code,200);assert.deepEqual(result.body.saved,['vin-new','vin-old','vin-other']);
});
test('storage failures leave changes unacknowledged for client retry',async()=>{
 const db=store();db.get=()=>{throw new Error('offline');};
 assert.equal((await call(db,'POST',{operations:[{key:'vin-new',saved:true}]})).code,503);
});
