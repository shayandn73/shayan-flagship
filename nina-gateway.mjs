import http from 'node:http';
import {fetchEligibility,contractStatus} from './nina-ourbit.mjs';

export const VERSION = '1.2.1';
export const STALE_MS = 90_000;
const endpoints = {
  technical: process.env.NINA_TECHNICAL_URL || 'https://nina-market-intelligence-v05f.onrender.com/api/context',
  preimpulse: process.env.NINA_PREIMPULSE_URL || 'https://nina-preimpulse-alerts-v081.onrender.com/api/preimpulse',
  fundamental: process.env.NINA_FUNDAMENTAL_URL || 'https://nina-fundamental-intel-v06.onrender.com/api/context',
  learner: process.env.NINA_LEARNER_URL || 'https://nina-learning-lab-v07.onrender.com/api/learner'
};
const iso = ms => new Date(ms).toISOString();
const stamp = value => {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') return null;
  const n = Date.parse(value);
  return Number.isFinite(n) ? n : null;
};
const symbol = s => typeof s === 'string' && /^[A-Z0-9]{2,25}USDT$/.test(s.toUpperCase()) ? s.toUpperCase() : null;

export function inspectSource(name, result, at = Date.now()) {
  const data = result?.data;
  const ts = stamp(data?.at ?? data?.timestamp ?? data?.updatedAt);
  const ageMs = ts == null ? null : at - ts;
  const fresh = Boolean(result?.ok && ts != null && ageMs >= -5000 && ageMs <= STALE_MS);
  const reasons = [];
  if (!result?.ok) reasons.push(result?.error || 'unavailable');
  if (result?.ok && ts == null) reasons.push('missing_source_timestamp');
  if (result?.ok && ts != null && ageMs > STALE_MS) reasons.push('stale_source');
  if (result?.ok && ts != null && ageMs < -5000) reasons.push('future_source_timestamp');
  if (name === 'technical' && fresh && (data?.feeds?.binanceMarket !== true || data?.feeds?.binanceDetail !== true)) reasons.push('market_or_detail_feed_disconnected');
  if (name === 'preimpulse' && fresh && (data?.marketUp !== true || data?.detailMarketUp !== true || data?.publicUp !== true)) reasons.push('preimpulse_feed_disconnected');
  if (name === 'learner' && fresh && data?.mode !== 'SHADOW_ONLY') reasons.push('learner_mode_unverified');
  const usable = fresh && reasons.length === 0;
  return {name, ok: Boolean(result?.ok), usable, fresh, status:result?.status ?? null, sourceAt:ts == null ? null : iso(ts), ageMs, latencyMs:result?.latencyMs ?? null, reasons, error:result?.error ?? null, data:usable ? data : null};
}

export async function fetchSource(url, timeoutMs = 12_000) {
  const start = Date.now();
  try {
    const response = await fetch(url, {signal:AbortSignal.timeout(timeoutMs), headers:{accept:'application/json', 'user-agent':'NINA-Gateway/1.2.1'}});
    if (!response.ok) return {ok:false,status:response.status,latencyMs:Date.now()-start,error:`HTTP ${response.status}`};
    const raw = await response.text();
    if (raw.length > 2_000_000) throw Error('oversized_response');
    return {ok:true,status:response.status,latencyMs:Date.now()-start,data:JSON.parse(raw)};
  } catch (e) {return {ok:false,status:null,latencyMs:Date.now()-start,error:String(e?.message || e)};}
}

export function buildSnapshot(results, at = Date.now(), eligibility = null) {
  const sources = Object.fromEntries(Object.keys(endpoints).map(name => [name, inspectSource(name, results[name], at)]));
  const technical = sources.technical.data;
  const pre = sources.preimpulse.data;
  const fundamental = sources.fundamental.data;
  const learner = sources.learner.data;
  const candidates = new Map();
  function add(row, origin) {
    const sym = symbol(row?.symbol);
    if (!sym || !Number.isFinite(Number(row?.score ?? row?.earlyScore ?? row?.preScore))) return;
    const direction = ['LONG','SHORT'].includes(row.side) ? row.side : null;
    const key = `${sym}:${direction || 'UNKNOWN'}`;
    const prior = candidates.get(key);
    const source = sources[origin];
    const priceAt = stamp(row.priceAt ?? row.tickerAt ?? row.eventAt); // A response timestamp does not prove price freshness.
    const priceAgeMs = priceAt == null ? null : at - priceAt;
    const priceFresh = source.usable && priceAgeMs != null && priceAgeMs >= -5000 && priceAgeMs <= STALE_MS;
    const evidenceFresh = key => {const ts=stamp(row[`${key}At`]);const value=row[key==='oi'?'oiDelta':key];return typeof value==='number' && Number.isFinite(value) && source.usable && ts != null && at-ts >= -5000 && at-ts <= STALE_MS;};
    const flowFresh=evidenceFresh('flow'),depthFresh=evidenceFresh('depth'),oiFresh=evidenceFresh('oi'),fundingFresh=evidenceFresh('funding');
    const rawScore = Number(row.score ?? row.earlyScore ?? row.preScore);
    const venue=contractStatus(eligibility,sym,at);
    const extended = Math.abs(Number(row.m5)) >= 1.5 || Math.abs(Number(row.m1)) >= 0.9;
    const warnings = [
      ...(!priceFresh ? ['price_timestamp_unverified_or_stale'] : []),
      ...(venue.available===true?[]:['ourbit_contract_unverified']),
      ...(!flowFresh ? ['flow_unverified'] : []),
      ...(!depthFresh ? ['depth_unverified'] : []),
      ...(!oiFresh ? ['oi_unverified'] : []),
      ...(!fundingFresh ? ['funding_unverified'] : []),
      ...(extended ? ['already_extended'] : [])
    ];
    const missingCount=[flowFresh,depthFresh,oiFresh,fundingFresh].filter(v=>!v).length;
    const confidence=+(1-0.15*missingCount).toFixed(2);
    const score=+(rawScore*confidence).toFixed(1);
    const state = extended ? 'LATE_DO_NOT_CHASE' : origin === 'preimpulse' ? 'EARLY_WATCH' : 'WATCHLIST';
    const item = {
      symbol:sym, side:direction, score, rawScore, confidence, state, sourceState:row.state || null,
      alertAt:origin==='preimpulse'?iso(stamp(row.at??row.ts)):null,
      evidence:Object.fromEntries(['flow','depth','oi','funding'].map(k=>[k,{status:evidenceFresh(k)?'AVAILABLE':'UNKNOWN',at:evidenceFresh(k)?iso(stamp(row[k+'At'])):null}])),
      price:typeof row.price==='number' && Number.isFinite(row.price) ? row.price : null,
      priceAt:priceAt == null ? null : iso(priceAt), priceFresh,
      m1:row.m1 ?? null, m5:row.m5 ?? null, flow:flowFresh ? row.flow ?? null : null, depth:depthFresh ? row.depth ?? null : null,
      oiDelta:oiFresh ? row.oiDelta ?? null : null, funding:fundingFresh ? row.funding ?? null : null,
      rank:row.rank ?? null, rankJump:row.rankJump ?? null, origins:[origin],
      sourceAt:source.sourceAt, ourbit:{...venue,directPrice:false},
      executable:false, warnings
    };
    if (prior) {
      prior.origins.push(origin);
      if (score > prior.score) Object.assign(prior, {...item, origins:prior.origins});
    } else candidates.set(key,item);
  }
  if (sources.technical.usable) for (const x of technical.top || []) add(x,'technical');
  if (sources.preimpulse.usable) for (const x of pre.alerts || pre.items || pre.top || []) {
    const alertAt=stamp(x?.at ?? x?.ts);
    if (alertAt != null && at-alertAt >= -5000 && at-alertAt <= STALE_MS) add(x,'preimpulse');
  }
  const top = [...candidates.values()].sort((a,b)=>b.score-a.score).slice(0,20);
  const degraded = Object.values(sources).filter(x=>!x.usable).map(x=>`${x.name}:${x.reasons.join(',')}`);
  if (fundamental?.sources) for (const [name,detail] of Object.entries(fundamental.sources)) {
    if (detail?.ok !== true) degraded.push(`fundamental.${name}:${detail?.error || 'unavailable'}`);
  }
  return {
    at:iso(at), version:`NINA Gateway v${VERSION}`, overallFresh:sources.technical.usable,
    status:degraded.length ? 'DEGRADED' : 'READY', warnings:degraded,
    freshCount:Object.values(sources).filter(x=>x.usable).length, totalSources:Object.keys(sources).length,
    sources:Object.fromEntries(Object.entries(sources).map(([k,{data,...v}])=>[k,v])), top, preimpulse:top.filter(x=>x.origins.includes('preimpulse')&&x.state!=='LATE_DO_NOT_CHASE'),
    regime:fundamental?.regime ?? null, fundamentalSources:fundamental?.sources ?? null,
    learnerSummary:learner ? {mode:learner.mode,active:learner.active ?? null,closed:learner.closed ?? null,
      winRate:learner.winRate ?? null,avgR:learner.avgR ?? null,promotionEligible:false,
      storage:learner.storage??null,challengerWeights:learner.challengerWeights??null,avgMFE:learner.avgMFE??null,avgMAE:learner.avgMAE??null,t1BeforeStop:learner.t1BeforeStop??null,
      note:learner.storage?.persistent?'PostgreSQL-backed shadow only; production promotion disabled':'Persistence unverified'} : null,
    ourbit:{contractVerification:eligibility?.ok?'PER_SYMBOL_VERIFICATION':'UNVERIFIED',verifiedAt:eligibility?.ok?eligibility.at:null,
      sourceError:eligibility?.reason||null,directPricing:false},
    rules:{staleAfterMs:STALE_MS,alertAgeLimitMs:STALE_MS,missingEvidence:'UNKNOWN',ourbitStates:['VERIFIED','UNVERIFIED','NOT_LISTED'],writeAccess:'disabled',execution:'manual_only'},commit:process.env.RENDER_GIT_COMMIT??null
  };
}

export function runtimeChecks(){
  const now=Date.now(),time=new Date(now).toISOString();
  const base={technical:{ok:true,data:{at:time,feeds:{binanceMarket:true,binanceDetail:true},top:[]}},preimpulse:{ok:true,data:{at:time,marketUp:true,detailMarketUp:true,publicUp:true,alerts:[]}},fundamental:{ok:true,data:{at:time}},learner:{ok:true,data:{at:time,mode:'SHADOW_ONLY'}}};
  const row={symbol:'BTCUSDT',side:'LONG',score:80,price:100,m1:0,m5:0,at:new Date(now-90001).toISOString()};
  base.preimpulse.data.alerts=[row];
  const stale=buildSnapshot(base,now).top.length===0;
  row.at=new Date(now-90000).toISOString();
  const boundary=buildSnapshot(base,now).top.length===1;
  row.at=time;Object.assign(row,{flow:0,depth:0,oiDelta:0,funding:0});
  const c=buildSnapshot(base,now).top[0];
  return {passed:stale&&boundary&&c.confidence<1&&c.ourbit.status==='UNVERIFIED'&&!c.executable&&['flow','depth','oiDelta','funding'].every(k=>c[k]===null),stale90001Rejected:stale,boundary90000Accepted:boundary,unknownValues:['flow','depth','oiDelta','funding'].every(k=>c[k]===null),confidenceReduced:c.confidence<1,unverifiedNotExecutable:!c.executable&&c.ourbit.status==='UNVERIFIED',fixtureOnly:true};
}

const schema = {openapi:'3.1.0',info:{title:'NINA Market Intelligence Gateway',version:VERSION,description:'Read-only, fail-closed research context. No execution API.'},
  paths:Object.fromEntries(['/health','/api/live','/api/top','/api/preimpulse','/api/learner','/api/sources','/api/debug','/api/model-context','/api/symbol/{symbol}'].map(path=>[path,{get:{operationId:'get'+path.replace(/[^a-zA-Z]/g,'_'),...(path.includes('{symbol}')?{parameters:[{name:'symbol',in:'path',required:true,schema:{type:'string',pattern:'^[A-Za-z0-9]{2,25}USDT$'}}]}:{}),responses:{200:{description:'Read-only snapshot. Underlying observation timestamps govern freshness; unavailable evidence is null with UNKNOWN status. UNVERIFIED Ourbit contracts are never executable.',content:{'application/json':{schema:{type:'object',additionalProperties:true}}}}}}}]))};

export function createServer({sourceUrls=endpoints, collect=fetchSource, eligibilityProvider=fetchEligibility}={}) {
  let flight = null;
  const snapshot = () => {
    if (!flight) flight = Promise.all([
      Promise.all(Object.entries(sourceUrls).map(async([k,url])=>[k,await collect(url)])),
      eligibilityProvider()
    ]).then(([entries,eligibility])=>buildSnapshot(Object.fromEntries(entries),Date.now(),eligibility))
      .finally(()=>{flight=null});
    return flight;
  };
  return http.createServer(async(req,res)=>{
    res.setHeader('access-control-allow-origin','*');res.setHeader('access-control-allow-methods','GET,HEAD,OPTIONS');
    res.setHeader('cache-control','no-store');res.setHeader('x-content-type-options','nosniff');
    if (req.method === 'OPTIONS') {res.statusCode=204;return res.end();}
    if (!['GET','HEAD'].includes(req.method)) {res.statusCode=405;return res.end();}
    try {
      const path = new URL(req.url,'http://localhost').pathname;
      if (path === '/openapi.json') return send(res,schema);
      const x=await snapshot();
      if(path === '/health') return send(res,{ok:x.overallFresh && x.status==='READY',at:x.at,version:x.version,status:x.status,freshCount:x.freshCount,totalSources:x.totalSources,rules:x.rules,commit:x.commit,sources:Object.fromEntries(Object.entries(x.sources).map(([k,v])=>[k,{ok:v.ok,usable:v.usable,ageMs:v.ageMs,sourceAt:v.sourceAt,reasons:v.reasons,error:v.error}]))});
      if(path === '/api/live') return send(res,x);
      if(path === '/api/top') return send(res,{at:x.at,version:x.version,rules:x.rules,overallFresh:x.overallFresh,status:x.status,top:x.top,regime:x.regime,learnerSummary:x.learnerSummary,warnings:x.warnings});
      if(path === '/api/preimpulse') return send(res,{at:x.at,version:x.version,rules:x.rules,status:x.status,items:x.preimpulse,warnings:x.warnings});
      if(path === '/api/learner') return send(res,{at:x.at,source:x.sources.learner.sourceAt,metrics:x.learnerSummary,warnings:x.sources.learner.reasons});
      if(path === '/api/sources') return send(res,{at:x.at,version:x.version,rules:x.rules,sources:Object.fromEntries(Object.entries(x.sources).map(([k,v])=>[k,{usable:v.usable,sourceAt:v.sourceAt,ageMs:v.ageMs,reasons:v.reasons,error:v.error}])),fundamental:x.fundamentalSources,ourbit:x.ourbit});
      if(path === '/api/debug') return send(res,{at:x.at,version:x.version,commit:x.commit,warnings:x.warnings,rules:x.rules,selfTest:runtimeChecks()});
      if(path === '/api/model-context') return send(res,{at:x.at,status:x.status,warnings:x.warnings,ourbit:x.ourbit,version:x.version,rules:x.rules,candidates:x.top.slice(0,8),learner:x.learnerSummary});
      if(path.startsWith('/api/symbol/')) {const sym=symbol(decodeURIComponent(path.slice(12)));if(!sym){res.statusCode=400;return send(res,{error:'invalid_symbol'});}return send(res,{at:x.at,symbol:sym,candidates:x.top.filter(c=>c.symbol===sym),note:'Ourbit proof is per candidate; direct Ourbit pricing is unavailable'});}
      res.statusCode=404;return send(res,{error:'not_found'});
    }catch(e){res.statusCode=503;send(res,{ok:false,error:'snapshot_unavailable'});}
  });
}
function send(res,value){res.setHeader('content-type','application/json; charset=utf-8');res.end(JSON.stringify(value));}
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) createServer().listen(Number(process.env.PORT)||10000,'0.0.0.0');
