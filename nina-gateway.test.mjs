import {test} from 'node:test';
import assert from 'node:assert/strict';
import {buildSnapshot, inspectSource, createServer} from './nina-gateway.mjs';
import {parseEligibility} from './nina-ourbit.mjs';

const at = Date.parse('2026-09-25T22:00:00Z');
const source = (data, lag = 1000) => ({ok:true,status:200,data:{at:new Date(at-lag).toISOString(),...data}});
const ready = {
  technical:source({feeds:{binanceMarket:true,binanceDetail:true},top:[{symbol:'SOLUSDT',side:'LONG',score:88,state:'EXECUTABLE_CANDIDATE',price:200,m1:.1,m5:.2}]}),
  preimpulse:source({marketUp:true,detailMarketUp:true,publicUp:true,alerts:[{symbol:'SOLUSDT',side:'LONG',score:92,price:201,m1:.1,m5:.2,at:new Date(at-1000).toISOString()}]}),
  fundamental:source({regime:{}}),
  learner:source({mode:'SHADOW_ONLY',closed:3,avgR:1,promotionEligible:true})
};

test('upstream executable and learner promotion claims fail closed without venue and price proof',()=>{
  const x=buildSnapshot(ready,at);
  assert.equal(x.top.length,1);
  assert.equal(x.top[0].state,'EARLY_WATCH');
  assert.equal(x.top[0].executable,false);
  assert.equal(x.top[0].priceFresh,false);
  assert.equal(x.top[0].ourbit.available,null);
  assert.equal(x.learnerSummary.promotionEligible,false);
});

test('stale, future, missing timestamps, disconnected feeds and HTTP failures are unusable',()=>{
  assert.equal(inspectSource('technical',source({feeds:{binanceMarket:true,binanceDetail:true}},90_001),at).usable,false);
  assert.deepEqual(inspectSource('fundamental',{ok:true,data:{}},at).reasons,['missing_source_timestamp']);
  assert.deepEqual(inspectSource('learner',{ok:false,error:'HTTP 502'},at).reasons,['HTTP 502']);
  assert.equal(inspectSource('technical',source({feeds:{binanceMarket:false,binanceDetail:true}}),at).usable,false);
  assert.equal(inspectSource('fundamental',source({},-6000),at).usable,false);
});

test('late impulse and stale technical source cannot be promoted',()=>{
  const inputs=structuredClone(ready);
  inputs.technical.data.top[0].m5=2;
  inputs.preimpulse.data.alerts=[];
  assert.equal(buildSnapshot(inputs,at).top[0].state,'LATE_DO_NOT_CHASE');
  inputs.technical.data.at=new Date(at-100_000).toISOString();
  assert.equal(buildSnapshot(inputs,at).top.length,0);
});

test('historical alert remains in upstream history but is omitted from current race',()=>{
  const inputs=structuredClone(ready);
  inputs.technical.data.top=[];
  inputs.preimpulse.data.alerts[0].at=new Date(at-180_000).toISOString();
  assert.equal(buildSnapshot(inputs,at).preimpulse.length,0);
});

test('missing OI, flow, depth and funding timestamps are unknown even when upstream emits zero',()=>{
  const inputs=structuredClone(ready);
  Object.assign(inputs.technical.data.top[0],{oiDelta:0,flow:0,depth:0,funding:0});
  inputs.preimpulse.data.alerts=[];
  const row=buildSnapshot(inputs,at).top[0];
  for(const key of ['oiDelta','flow','depth','funding'])assert.equal(row[key],null);
  assert.equal(row.ourbit.status,'UNVERIFIED');
  assert.equal(row.confidence,0.4);
  assert.ok(row.score<row.rawScore);
  Object.assign(inputs.technical.data.top[0],{oiAt:at-1000,flowAt:at-1000,depthAt:at-1000,fundingAt:at-1000});
  const proven=buildSnapshot(inputs,at).top[0];
  for(const key of ['oiDelta','flow','depth','funding'])assert.equal(proven[key],0);
  assert.equal(proven.confidence,1);
});

test('read-only HTTP contract rejects writes and unknown paths',async()=>{
  const server=createServer({collect:async()=>({ok:false,error:'offline'}),eligibilityProvider:async()=>({ok:false,reason:'offline'})});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try {
    const base=`http://127.0.0.1:${server.address().port}`;
    assert.equal((await fetch(base+'/api/top',{method:'POST'})).status,405);
    assert.equal((await fetch(base+'/unknown')).status,404);
    const x=await (await fetch(base+'/api/model-context')).json();
    assert.equal(x.status,'DEGRADED'); assert.equal(x.candidates.length,0);
    assert.equal((await fetch(base+'/ready')).status,503);
  } finally {server.close();}
});

test('verified contract does not promote a price without its own timestamp',()=>{
  const proof=parseEligibility({data:[{symbol:'SOL_USDT',status:'TRADING'}]},
    {data:[{symbol:'SOL_USDT'}]},at);
  const x=buildSnapshot(ready,at,proof);
  assert.equal(x.top[0].ourbit.available,true);
  assert.equal(x.top[0].executable,false);
  assert.equal(x.top[0].priceFresh,false);
});

test('optional Reddit failure affects research health without vetoing live market data',()=>{
  const inputs=structuredClone(ready);
  inputs.technical.data.top=[];
  inputs.preimpulse.data.alerts=[];
  inputs.learner.data.storage={persistent:true};
  inputs.fundamental.data.sources={reddit_cryptocurrency:{ok:false,error:'HTTP 403'},official:{ok:true}};
  const x=buildSnapshot(inputs,at);
  assert.equal(x.health.marketDataHealth,'READY');
  assert.equal(x.health.fundamentalHealth,'DEGRADED');
  assert.equal(x.health.learnerHealth,'READY');
  assert.equal(x.status,'READY');
  assert.equal(x.health.executionReadiness,'VENUE_UNVERIFIED');
  assert.match(x.warnings.join(' '),/reddit_cryptocurrency/);
});
