
import http from 'http';
import WebSocket from 'ws';
import {createStore} from './nina-store.mjs';
import {randomUUID,createHash} from 'node:crypto';
const VERSION='1.2.2';const bootId=randomUUID(),bootAt=new Date().toISOString();
let restoration=null;

const PORT=process.env.PORT||10000;
const SYMBOLS=['BRUSDT','SUIUSDT','LINKUSDT','AKEUSDT','HYPEUSDT','ENAUSDT','NEARUSDT'];
const state=new Map(SYMBOLS.map(s=>[s,{symbol:s,trades:[],k1:null,k5:null,depth:null,funding:null,fundingAt:0,price:0,priceAt:0,last:0}]));
const shadow=new Map(), closed=[];
const weights={m1:1,m5:1,flow:1,depth:1,funding:1};
let store=null, dbReady=false, storageError='not_initialized', cycling=false;
const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
const num=v=>Number(v)||0;
const trim=(a,ms)=>{const c=Date.now()-ms;while(a.length&&a[0].t<c)a.shift()};

function score(x){
  const now=Date.now(),fresh=t=>Number.isFinite(t)&&now-t>=-5000&&now-t<=90000;
  if(!x.price||!fresh(x.priceAt))return null;
  const p=x.price,m1=x.k1&&fresh(x.k1.at)?100*(p/x.k1.o-1):null,m5=x.k5&&fresh(x.k5.at)?100*(p/x.k5.o-1):null;
  trim(x.trades,120000);let buy=0,sell=0;
  for(const t of x.trades){if(t.side==='buy')buy+=t.q;else sell+=t.q;}
  const flow=buy+sell>0&&fresh(x.trades.at(-1)?.t)?(buy-sell)/(buy+sell):null;
  const depth=x.depth&&fresh(x.depth.at)?x.depth.imb:null;
  const funding=fresh(x.fundingAt)&&Number.isFinite(x.funding)?x.funding:null;
  const confidence=[m1,m5,flow,depth,funding].filter(Number.isFinite).length/6; // OI is unavailable.
  const raw=50+(m1==null?0:18*Math.tanh(m1*4))+(m5==null?0:12*Math.tanh(m5*2))+(flow==null?0:16*flow)+(depth==null?0:12*depth)-(funding==null?0:4*Math.tanh(funding*1000));
  return {symbol:x.symbol,price:p,priceAt:new Date(x.priceAt).toISOString(),side:raw>=50?'LONG':'SHORT',score:+(50+Math.abs(raw-50)*confidence).toFixed(1),confidence,m1,m5,flow,depth,funding,oiDelta:null,oiStatus:'UNKNOWN',ready:[m1,m5,flow,depth,funding].every(Number.isFinite)&&x.trades.length>=5};
}
function key(r){return r.symbol+':'+r.side}
async function openShadow(r){
  const k=key(r);
  if(!dbReady||!r.ready||r.score<70||shadow.has(k)) return;
  const sig={id:k+':'+Date.now(),symbol:r.symbol,side:r.side,entry:r.price,opened:Date.now(),lastObservedAt:Date.now(),dataGap:false,score:r.score,
    features:{m1:r.m1,m5:r.m5,flow:r.flow,depth:r.depth,funding:r.funding},mfe:0,mae:0,t1:false,stop:false,t1At:null,stopAt:null};
  if(await store.recordOpen(sig))shadow.set(k,sig);
}
function aligned(v,side){return side==='LONG'?num(v):-num(v)}
function updateWeights(sig,reward){
  for(const k of ['m1','m5','flow','depth']){
    const a=aligned(sig.features[k],sig.side);
    weights[k]=clamp(weights[k]+(a===0?0:Math.sign(a)*reward*0.01),0.6,1.4);
  }
  const f=-aligned(sig.features.funding,sig.side);
  weights.funding=clamp(weights.funding+(f===0?0:Math.sign(f)*reward*0.002),0.8,1.2);
}
async function finish(k,sig,reason,px){
  const R=(sig.side==='LONG'?1:-1)*100*(px-sig.entry)/sig.entry/0.4;
  const rec={...sig,closed:Date.now(),reason,exit:px,R:+R.toFixed(2),leadMs:sig.t1At?sig.t1At-sig.opened:null};
  const before={...weights};if(!sig.legacy&&!sig.dataGap)updateWeights(sig,R>0?1:-1);
  try{if(!await store.recordClose(rec,weights)){Object.assign(weights,before);return}}
  catch(e){Object.assign(weights,before);throw e}
  closed.push(rec); if(closed.length>1000) closed.shift();shadow.delete(k);
  console.log('NINA_SHADOW_CLOSE',JSON.stringify(rec));
}
async function cycle(){
  if(cycling||!store)return;cycling=true;
  try{
  const ranked=SYMBOLS.map(s=>score(state.get(s))).filter(Boolean).sort((a,b)=>b.score-a.score);
  for(const r of ranked) await openShadow(r);
  const by=new Map(ranked.map(r=>[r.symbol,r]));
  for(const [k,sig] of shadow){
    const r=by.get(sig.symbol); if(!r) continue;
    if(Date.now()-(sig.lastObservedAt??sig.opened)>90000)sig.dataGap=true;sig.lastObservedAt=Date.now();
    const move=100*(sig.side==='LONG'?(r.price/sig.entry-1):((sig.entry-r.price)/sig.entry));
    sig.mfe=Math.max(sig.mfe,move); sig.mae=Math.min(sig.mae,move);
    if(!sig.t1&&move>=0.6){sig.t1=true;sig.t1At=Date.now();}
    if(!sig.stop&&move<=-0.4){sig.stop=true;sig.stopAt=Date.now();}
    if(sig.stop) await finish(k,sig,sig.t1?'STOP_AFTER_T1':'STOP_BEFORE_T1',r.price);
    else if(sig.t1&&move>=1.2) await finish(k,sig,'T2',r.price);
    else if(Date.now()-sig.opened>=3600000) await finish(k,sig,'HORIZON_60M',r.price);
    else await store.recordProgress(sig);
  }
  const measured=closed.filter(x=>!x.legacy&&!x.dataGap&&Number.isFinite(x.lastObservedAt));const n=measured.length,w=measured.filter(x=>x.R>0).length;
  const avg=a=>a.length?a.reduce((s,x)=>s+x,0)/a.length:0;
  const report={at:new Date().toISOString(),version:VERSION,mode:'SHADOW_ONLY',universe:SYMBOLS.length,
    top:ranked.slice(0,7),active:shadow.size,closed:n,legacyOutcomes:closed.filter(x=>x.legacy).length,gapOutcomes:closed.filter(x=>!x.legacy&&(x.dataGap||!Number.isFinite(x.lastObservedAt))).length,totalOutcomes:closed.length,winRate:n?+(100*w/n).toFixed(1):null,
    avgR:+avg(measured.map(x=>x.R)).toFixed(2),avgMFE:+avg(measured.map(x=>x.mfe)).toFixed(3),avgMAE:+avg(measured.map(x=>x.mae)).toFixed(3),
    t1BeforeStop:n?+(100*measured.filter(x=>x.t1&&(!x.stopAt||x.t1At<=x.stopAt)).length/n).toFixed(1):null,
    challengerWeights:Object.fromEntries(Object.entries(weights).map(([k,v])=>[k,+v.toFixed(3)])),
    promotionEligible:false,storage:{persistent:dbReady,backend:'PostgreSQL',schemaVersion:1,bootId,bootAt,restoration,summary:await store.summary()}};
  dbReady=true;storageError=null;await store.saveState('learner',{version:VERSION,mode:'SHADOW_ONLY',lastCycleAt:report.at,weightsVersion:'0.7-shadow',promotionEligible:false});globalThis.lastReport=report;
  console.log('NINA_LEARNER',JSON.stringify(report));
  }catch(e){dbReady=false;storageError='database_operation_failed';console.error('NINA_LEARNER_STORAGE_UNAVAILABLE')}
  finally{cycling=false}
}
function onMarket(z){
  const x=state.get(z.s); if(!x) return;
  const t=num(z.E)||Date.now(); x.last=t;
  if(z.e==='aggTrade'){
    x.price=num(z.p); x.priceAt=t; x.trades.push({t,side:z.m?'sell':'buy',q:num(z.p)*num(z.q)}); trim(x.trades,120000);
  } else if(z.e==='kline'){
    const k=z.k,o={o:num(k.o),c:num(k.c),t:num(k.t),at:t};
    x.price=o.c;x.priceAt=t; if(k.i==='1m')x.k1=o; else if(k.i==='5m')x.k5=o;
  }
}
function connectMarket(){
  const streams=SYMBOLS.flatMap(s=>{const x=s.toLowerCase();return [`${x}@aggTrade`,`${x}@kline_1m`,`${x}@kline_5m`]}).join('/');
  const ws=new WebSocket('wss://fstream.binance.com/market/stream?streams='+streams);
  ws.on('message',b=>{try{const m=JSON.parse(b),z=m.data||m;if(z?.s)onMarket(z)}catch{}});
  ws.on('close',()=>setTimeout(connectMarket,1500)); ws.on('error',()=>{});
}
function connectPublic(){
  const streams=SYMBOLS.map(s=>`${s.toLowerCase()}@depth5@500ms`).join('/');
  const ws=new WebSocket('wss://fstream.binance.com/public/stream?streams='+streams);
  ws.on('message',b=>{try{const m=JSON.parse(b),z=m.data||m;if(!z?.s)return;const x=state.get(z.s);if(!x)return;
    let bq=0,aq=0;for(const v of(z.b||[]))bq+=num(v[1]);for(const v of(z.a||[]))aq+=num(v[1]);x.depth=bq+aq>0?{imb:(bq-aq)/(bq+aq),at:num(z.E)||Date.now()}:null;
  }catch{}});
  ws.on('close',()=>setTimeout(connectPublic,1500)); ws.on('error',()=>{});
}
function connectFunding(){
  const streams=SYMBOLS.map(s=>`${s.toLowerCase()}@markPrice@1s`).join('/');
  const ws=new WebSocket('wss://fstream.binance.com/market/stream?streams='+streams);
  ws.on('message',b=>{try{const m=JSON.parse(b),z=m.data||m;if(!z?.s)return;const x=state.get(z.s);if(x){x.funding=z.r==null?null:Number(z.r);x.fundingAt=num(z.E)||Date.now();if(!x.price){x.price=num(z.p);x.priceAt=x.fundingAt;}}}catch{}});
  ws.on('close',()=>setTimeout(connectFunding,1500)); ws.on('error',()=>{});
}
const server=http.createServer(async(req,res)=>{
  res.setHeader('access-control-allow-origin','*');res.setHeader('cache-control','no-store');
  if(!['GET','HEAD'].includes(req.method)){res.statusCode=405;return res.end();}
  try{
  res.setHeader('content-type','application/json');
  if(req.url==='/health'||req.url==='/ready'){
    let databaseAvailable=false,dbError=null;
    if(dbReady&&store){try{await store.summary();databaseAvailable=true}catch(e){dbError=e.code||e.name||'query_failed'}}
    const cycleAt=globalThis.lastReport?.at||null,cycleAgeMs=cycleAt?Date.now()-Date.parse(cycleAt):null;
    const reasons=[];if(!databaseAvailable)reasons.push('learner_database_unavailable');if(globalThis.lastReport?.mode&&globalThis.lastReport.mode!=='SHADOW_ONLY')reasons.push('wrong_learner_mode');if(cycleAgeMs==null||cycleAgeMs>90000)reasons.push('learner_cycle_stale');
    const h={ok:reasons.length===0,reasons,storagePersistent:databaseAvailable,storageError:dbError||storageError,mode:'SHADOW_ONLY',version:VERSION,commit:process.env.RENDER_GIT_COMMIT||null,at:new Date().toISOString(),cycleAt,cycleAgeMs,bootId,bootAt,restoration};
    if(req.url==='/ready'&&!h.ok)res.statusCode=503;return res.end(JSON.stringify(h));
  }
  if(req.url==='/api/learner') return res.end(JSON.stringify(dbReady?(globalThis.lastReport||{ok:false,warming:true,at:new Date().toISOString()}):{ok:false,at:new Date().toISOString(),error:'persistent_storage_unavailable'}));
  if(req.url==='/api/history'){if(!dbReady){res.statusCode=503;return res.end(JSON.stringify({error:'storage_unavailable'}));}return res.end(JSON.stringify({at:new Date().toISOString(),version:VERSION,items:await store.history(),summary:await store.summary()}));}
  if(req.url==='/api/shadow') return res.end(JSON.stringify({active:[...shadow.values()],closed:closed.slice(-100)}));
  res.statusCode=404;res.end(JSON.stringify({error:'not_found'}));
  }catch{res.statusCode=503;res.end(JSON.stringify({error:'storage_unavailable'}));}
});
server.listen(PORT,()=>console.log('NINA_LEARNER_LISTEN',PORT));
async function init(){
  let pool, phase="configuration";
  try{
    if(!process.env.DATABASE_URL)throw Error('DATABASE_URL_missing');
    const {default:pg}=await import('pg');
    pool=new pg.Pool({connectionString:process.env.DATABASE_URL,max:3,connectionTimeoutMillis:5000});
    store=createStore(pool);phase="migration";await store.migrate();
    phase="legacy_import";const seed=JSON.parse(process.env.NINA_LEGACY_BOOTSTRAP||'{}');await store.importLegacy(seed);
    phase="restore";await store.saveWeights(weights);
    const previousModel=await store.state('learner');
    const saved=await store.load();
    restoration={restoredAt:new Date().toISOString(),open:saved.open.length,outcomes:saved.closed.length,weightsLoaded:!!saved.weights,modelStateLoaded:!!previousModel,previousModel,summary:await store.summary(),weightsDigest:createHash('sha256').update(JSON.stringify(saved.weights)).digest('hex'),outcomeIds:saved.closed.slice(-10).map(s=>s.id),signalIds:saved.open.slice(0,10).map(s=>s.id)};
    await store.saveState('boot',{bootId,bootAt,restoration});for(const sig of saved.open)shadow.set(key(sig),sig);
    closed.push(...saved.closed);if(saved.weights)Object.assign(weights,saved.weights);
    dbReady=true;storageError=null;
    connectMarket();connectPublic();connectFunding();setInterval(cycle,30000);setTimeout(cycle,12000);
  }catch(e){dbReady=false;store=null;storageError='database_initialization_failed';console.error('NINA_LEARNER_STORAGE_UNAVAILABLE',JSON.stringify({phase,code:/^[A-Z0-9_]{2,32}$/.test(e.code||'')?e.code:'UNKNOWN'}));if(pool)await pool.end().catch(()=>{});setTimeout(init,30000)}
}
init();
