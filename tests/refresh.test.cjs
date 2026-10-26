const test = require('node:test');
const assert = require('node:assert/strict');
const handler = require('../api/refresh');
const key = 'test-only-owner-code-with-at-least-32-characters';
process.env.REFRESH_OWNER_KEY = key;
process.env.GITHUB_REFRESH_TOKEN = 'test-token';
async function call(method, body, headers = {}) {
  const res = { headers:{}, setHeader(k,v){this.headers[k]=v;}, status(n){this.code=n;return this;}, json(v){this.body=v;return this;} };
  await handler({method,body,headers:{origin:'https://cruiser-scout.vercel.app','content-type':'application/json',...headers}},res);
  return res;
}
test('owner authentication, origin, cooldown and dispatch protections', async () => {
  let calls = [];
  const original = global.fetch;
  global.fetch = async (url, options) => {
    calls.push({url, options});
    if (url.endsWith('/dispatches')) return {ok:true,status:204};
    return {ok:true,status:200,json:async()=>({workflow_runs:[]})};
  };
  try {
    assert.equal((await call('POST',{action:'start'})).code,401);
    assert.equal(calls.length,0);
    assert.equal((await call('POST',{action:'login',key},{origin:undefined})).code,403);
    assert.equal((await call('POST',{action:'login',key},{origin:'https://evil.example'})).code,403);
    assert.equal((await call('POST',{action:'login',key:'wrong'})).code,401);
    const login = await call('POST',{action:'login',key});
    assert.equal(login.code,200);
    assert.match(login.headers['Set-Cookie'],/HttpOnly; Secure; SameSite=Strict/);
    const cookie = login.headers['Set-Cookie'].split(';')[0];
    assert.equal((await call('GET',null,{cookie:cookie+'tampered'})).code,401);
    assert.equal((await call('POST',{action:'start'},{cookie})).code,202);
    assert.equal(calls.filter(c=>c.url.endsWith('/dispatches')).length,1);
    assert.deepEqual(JSON.parse(calls.at(-1).options.body),{ref:'main'});
    global.fetch = async () => ({ok:true,status:200,json:async()=>({workflow_runs:[{id:1,event:'workflow_dispatch',status:'in_progress',created_at:new Date().toISOString()}]})});
    assert.equal((await call('POST',{action:'start'},{cookie})).code,409);
    const summary = handler.summarize([{id:2,event:'workflow_dispatch',status:'completed',created_at:new Date().toISOString()}]);
    assert.equal(summary.cooldown,true);
    assert.equal(summary.active,false);
    assert.equal(handler.session({headers:{cookie:'__Host-scout-owner=1.invalid'}},key),false);
    const locked = await call('POST',{action:'logout'},{cookie});
    assert.match(locked.headers['Set-Cookie'],/Max-Age=0/);
    global.fetch = async()=>{throw new Error('secret upstream detail');};
    const failure = await call('GET',null,{cookie});
    assert.equal(failure.code,502);
    assert.doesNotMatch(JSON.stringify(failure.body),/secret upstream/);
  } finally { global.fetch = original; }
});
