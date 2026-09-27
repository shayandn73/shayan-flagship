
import http from 'node:http';
import crypto from 'node:crypto';

const PORT = process.env.PORT || 10000;
const UA = 'NINA-Market-Intelligence/0.6 (+public-readonly)';
const now = () => Date.now();
const state = {
  version: '0.6.1-fundamental',
  startedAt: new Date().toISOString(),
  cycles: 0,
  lastCycleAt: null,
  regime: {},
  fundamentals: new Map(),
  mentions: new Map(),
  sources: new Map(),
  events: [],
};

const SOURCES = [
  {name:'ourbit_official', url:'https://t.me/s/ourbitofficial', type:'official_exchange', weight:0.95},
  {name:'binance_announcements', url:'https://t.me/s/binance_announcements', type:'official_exchange', weight:0.90},
  {name:'cryptoquant_alert', url:'https://t.me/s/cryptoquant_alert', type:'institutional_analytics', weight:0.85},
  {name:'cryptoquant_official', url:'https://t.me/s/cryptoquant_official', type:'institutional_analytics', weight:0.80},
  {name:'glassnode', url:'https://t.me/s/glassnode', type:'institutional_analytics', weight:0.80},
  {name:'whale_alert', url:'https://t.me/s/whale_alert', type:'onchain_alert', weight:0.75},
  {name:'cointelegraph', url:'https://cointelegraph.com/rss', type:'news', weight:0.62},
  {name:'coindesk', url:'https://www.coindesk.com/arc/outboundfeeds/rss/', type:'news', weight:0.65},
  {name:'decrypt', url:'https://decrypt.co/feed', type:'news', weight:0.60},
  {name:'tradingview_ideas', url:'https://www.tradingview.com/markets/cryptocurrencies/ideas/', type:'analyst_crowd', weight:0.35},
  {name:'reddit_cryptocurrency', url:'https://www.reddit.com/r/CryptoCurrency/hot.json?limit=50', type:'crowd', weight:0.20},
];

const POS = [
  ['bullish',1],['breakout',1],['accumulation',0.8],['reclaim',0.7],['inflow',0.25],
  ['outflow',0.15],['surge',0.6],['rally',0.8],['long',0.65],['buy',0.45],
  ['listing',0.7],['listed',0.7],['launch',0.35],['adoption',0.55],['upgrade',0.35],
];
const NEG = [
  ['bearish',1],['breakdown',1],['selloff',0.9],['dump',0.9],['short',0.65],
  ['sell',0.45],['delist',1],['delisted',1],['hack',1],['exploit',1],['outage',0.8],
  ['liquidation',0.35],['lawsuit',0.6],['investigation',0.5],['risk',0.25],
];

const COMMON = new Set(['USDT','USD','BTC','ETH','CRYPTO','THE','AND','FOR','NEW','ALL','ETF','API','AI','CEO','SEC','US','TVL','DEX','CEX','APR','UTC','LONG','SHORT']);
const symNorm = s => String(s||'').toUpperCase().replace(/[^A-Z0-9]/g,'').replace(/USDT$/,'');
const clamp=(x,a,b)=>Math.max(a,Math.min(b,x));

function stripHtml(x){
  return String(x||'')
    .replace(/<script[\s\S]*?<\/script>/gi,' ')
    .replace(/<style[\s\S]*?<\/style>/gi,' ')
    .replace(/<[^>]+>/g,' ')
    .replace(/&nbsp;|&#160;/g,' ')
    .replace(/&amp;/g,'&')
    .replace(/&lt;/g,'<').replace(/&gt;/g,'>')
    .replace(/\s+/g,' ').trim();
}
function sha(x){return crypto.createHash('sha256').update(x).digest('hex').slice(0,20)}
function sentiment(text){
  const t=text.toLowerCase(); let s=0;
  for(const [w,v] of POS) if(t.includes(w)) s+=v;
  for(const [w,v] of NEG) if(t.includes(w)) s-=v;
  return clamp(s,-4,4);
}
function extractSymbols(text){
  const out=new Set();
  for(const m of text.matchAll(/[$#]\s*([A-Za-z][A-Za-z0-9]{1,11})\b/g)){
    const s=symNorm(m[1]); if(s && !COMMON.has(s)) out.add(s);
  }
  for(const m of text.matchAll(/\b([A-Z][A-Z0-9]{1,9})\/?USDT\b/g)){
    const s=symNorm(m[1]); if(s && !COMMON.has(s)) out.add(s);
  }
  return [...out].slice(0,50);
}
function addMention(symbol, source, rawScore, text){
  const s=symNorm(symbol); if(!s)return;
  const src=SOURCES.find(x=>x.name===source);
  const weight=src?.weight ?? .2;
  const score=rawScore*weight;
  const rec={at:now(),publishedAt:null,verification:'UNVERIFIED_PUBLICATION_TIME',source,type:src?.type||'unknown',weight,score:+score.toFixed(3),excerpt:text.slice(0,220)};
  const arr=state.mentions.get(s)||[]; arr.push(rec);
  state.mentions.set(s,arr.filter(x=>now()-x.at<24*3600e3).slice(-100));
  state.events.push({symbol:s,...rec});
  if(state.events.length>2000) state.events.splice(0,state.events.length-2000);
}
function sourceHealth(name, patch){
  state.sources.set(name,{...(state.sources.get(name)||{}),...patch,updatedAt:new Date().toISOString()});
}
async function fetchText(url){
  const r=await fetch(url,{headers:{'user-agent':UA,'accept':'text/html,application/json,application/rss+xml;q=0.9,*/*;q=0.8'},redirect:'follow',signal:AbortSignal.timeout(12000)});
  const text=await r.text();
  if(!r.ok) throw new Error(`${r.status} ${r.statusText}`);
  return {text,status:r.status,ct:r.headers.get('content-type')||''};
}

async function updateFearGreed(){
  try{
    const {text}=await fetchText('https://api.alternative.me/fng/?limit=2');
    const j=JSON.parse(text), d=j.data?.[0];
    state.regime.fearGreed = d ? {value:+d.value,class:d.value_classification,at:+d.timestamp*1000} : null;
    sourceHealth('alternative_fng',{ok:true,type:'macro_sentiment',weight:.7});
  }catch(e){sourceHealth('alternative_fng',{ok:false,error:String(e).slice(0,160)})}
}

async function updateCoinPaprika(){
  try{
    const {text}=await fetchText('https://api.coinpaprika.com/v1/tickers?quotes=USD');
    const arr=JSON.parse(text);
    let n=0;
    for(const x of arr){
      const s=symNorm(x.symbol); if(!s) continue;
      const q=x.quotes?.USD||{};
      state.fundamentals.set(s,{
        rank:+x.rank||null, marketCap:+q.market_cap||0, volume24h:+q.volume_24h||0,
        pct1h:+q.percent_change_1h||0, pct24h:+q.percent_change_24h||0,
        pct7d:+q.percent_change_7d||0, circulating:+x.circulating_supply||0,
        maxSupply:+x.max_supply||0, lastUpdated:x.last_updated||null
      }); n++;
    }
    sourceHealth('coinpaprika',{ok:true,type:'fundamentals',weight:.8,items:n});
  }catch(e){sourceHealth('coinpaprika',{ok:false,error:String(e).slice(0,160)})}
}

async function updateSource(src){
  try{
    const {text,ct}=await fetchText(src.url);
    const plain=ct.includes('json') ? (()=>{try{return JSON.stringify(JSON.parse(text))}catch{return text}})() : stripHtml(text);
    const h=sha(plain);
    const prev=state.sources.get(src.name);
    const changed=!!prev?.hash && prev.hash!==h;
    const bootstrap=!prev?.hash;
    sourceHealth(src.name,{ok:true,type:src.type,weight:src.weight,hash:h,bytes:text.length,changed,bootstrap:false});
    // First crawl establishes baseline; it does NOT create a trading signal from old posts.
    if(bootstrap || !changed) return;
    const score=sentiment(plain);
    const symbols=extractSymbols(plain);
    for(const s of symbols) addMention(s,src.name,score,plain);
  }catch(e){
    sourceHealth(src.name,{ok:false,type:src.type,weight:src.weight,error:String(e).slice(0,180)});
  }
}

function symbolContext(sym){
  const s=symNorm(sym);
  const arr=(state.mentions.get(s)||[]).filter(x=>now()-x.at<24*3600e3);
  let weighted=0, wsum=0;
  for(const x of arr){
    const ageH=(now()-x.at)/3600e3;
    const decay=Math.exp(-ageH/6);
    weighted+=x.score*decay; wsum+=x.weight*decay;
  }
  return {
    symbol:s,
    fundamental:state.fundamentals.get(s)||null,
    social:{score:null,heuristicScore:arr.length?+clamp(weighted,-5,5).toFixed(3):null,status:arr.length?'UNVERIFIED_PUBLICATION_TIME':'UNKNOWN',mentions:arr.length,sources:[...new Set(arr.map(x=>x.source))],latest:arr.slice(-8).reverse()},
    regime:state.regime
  };
}
function topSocial(){
  return [...state.mentions.keys()].map(symbolContext)
    .sort((a,b)=>Math.abs(b.social.heuristicScore)-Math.abs(a.social.heuristicScore)).slice(0,25);
}
async function cycle(){
  state.cycles++;
  await Promise.allSettled([updateFearGreed(), updateCoinPaprika(), ...SOURCES.map(updateSource)]);
  const health=Object.fromEntries([...state.sources].map(([k,v])=>[k,{ok:v.ok,type:v.type,changed:v.changed,items:v.items,error:v.error}]));
  state.lastCycleAt=new Date().toISOString();
  const snap={at:new Date().toISOString(),version:state.version,cycles:state.cycles,regime:state.regime,fundamentals:state.fundamentals.size,sources:health,topSocial:topSocial().slice(0,8)};
  console.log('NINA_FUNDAMENTAL',JSON.stringify(snap));
  setTimeout(cycle,180000);
}

const server=http.createServer((req,res)=>{
  const u=new URL(req.url,'http://localhost');
  res.setHeader('content-type','application/json; charset=utf-8');
  res.setHeader('access-control-allow-origin','*');res.setHeader('cache-control','no-store');if(!['GET','HEAD'].includes(req.method)){res.statusCode=405;return res.end(JSON.stringify({error:'read_only'}));}
  if(u.pathname==='/health'||u.pathname==='/ready'){
    const cycleAgeMs=state.lastCycleAt?Date.now()-Date.parse(state.lastCycleAt):null;
    const required=[...state.sources].filter(([k,v])=>v.type!=='crowd'&&v.ok);
    const reasons=[];if(cycleAgeMs==null||cycleAgeMs>360000)reasons.push('fundamental_cycle_stale');if(!required.length)reasons.push('all_primary_research_sources_unavailable');
    const h={ok:reasons.length===0,reasons,version:state.version,commit:process.env.RENDER_GIT_COMMIT||null,at:new Date().toISOString(),lastCycleAt:state.lastCycleAt,cycleAgeMs,cycles:state.cycles,fundamentals:state.fundamentals.size,sources:Object.fromEntries(state.sources)};
    if(u.pathname==='/ready'&&!h.ok)res.statusCode=503;res.end(JSON.stringify(h)); return;
  }
  if(u.pathname==='/api/context'){
    res.end(JSON.stringify({at:new Date().toISOString(),version:state.version,regime:state.regime,topSocial:topSocial(),sources:Object.fromEntries(state.sources)})); return;
  }
  if(u.pathname.startsWith('/api/symbol/')){
    res.end(JSON.stringify(symbolContext(decodeURIComponent(u.pathname.split('/').pop())))); return;
  }
  res.end(JSON.stringify({
    name:'NINA Fundamental & Crowd Intelligence',
    version:state.version,
    rules:[
      'Public sources only; no private/login bypass.',
      'Official/institutional sources weighted above anonymous crowd.',
      'First crawl is bootstrap and cannot create a signal.',
      'Sentiment/fundamentals confirm or veto; never create EXECUTABLE alone.'
    ],
    endpoints:['/health','/api/context','/api/symbol/BTC']
  }));
});
server.listen(PORT,()=>console.log('NINA_FUNDAMENTAL_LISTEN',PORT));
cycle();
