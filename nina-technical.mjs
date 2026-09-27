import http from 'http';
import WebSocket from 'ws';

const PORT=process.env.PORT||10000;
const state={started:Date.now(),marketConnected:false,detailConnected:false,events:0,detailEvents:0,tickers:new Map(),detail:new Map(),rankPrev:new Map(),sources:{},news:new Map(),lastRank:0,lastSource:0};
const TOP_DETAIL=40, MAX_TRADES=700;
const now=()=>Date.now();
const fresh=t=>Number.isFinite(t)&&now()-t>=-5000&&now()-t<=90000;
const nullable=x=>x==null||x===''?null:Number.isFinite(Number(x))?Number(x):null;
const num=x=>Number(x)||0;
const clip=(x,a,b)=>Math.max(a,Math.min(b,x));
const pct=(a,b)=>b?100*(a/b-1):0;
const base=s=>s.replace(/USDT$/,'');
const isUM=s=>s && s.endsWith('USDT') && !s.includes('_');
function d(sym){if(!state.detail.has(sym))state.detail.set(sym,{trades:[],liq:[],depth:null,k1:null,k5:null,oi:null,oiPrev:null,oiAt:0,persist:0,lastSide:null,lastScore:0});return state.detail.get(sym)}
function trim(arr,ms){const t=now()-ms;while(arr.length&&arr[0].t<t)arr.shift();if(arr.length>MAX_TRADES)arr.splice(0,arr.length-MAX_TRADES)}

function score(sym){
 const t=state.tickers.get(sym); if(!t)return null; const x=d(sym), ts=now();
 const p=t.p, ch=t.ch, q=t.q, funding=Number.isFinite(t.funding)&&fresh(t.fundingAt)?t.funding:null;
 const recent=x.trades.filter(z=>z.t>ts-60000&&fresh(z.t)), qbuy=recent.filter(z=>z.side==='buy').reduce((a,z)=>a+z.q,0), qsell=recent.filter(z=>z.side==='sell').reduce((a,z)=>a+z.q,0);
 const flow=qbuy+qsell>0?(qbuy-qsell)/(qbuy+qsell):null;
 const liq=x.liq.filter(z=>z.t>ts-120000), longLiq=liq.filter(z=>z.side==='sell').reduce((a,z)=>a+z.q,0), shortLiq=liq.filter(z=>z.side==='buy').reduce((a,z)=>a+z.q,0);
 const liqBias=shortLiq+longLiq>0?(shortLiq-longLiq)/(shortLiq+longLiq):null;
 const depth=x.depth&&fresh(x.depth.t)?x.depth.imb:null;
 const k1=x.k1&&fresh(x.k1.at)?x.k1:{}, k5=x.k5&&fresh(x.k5.at)?x.k5:{};
 const m1=k1.o?pct(k1.c,k1.o):null, m5=k5.o?pct(k5.c,k5.o):null;
 const vol1=k1.q||0, vol5=k5.q||0;
 const volAccel=vol5?clip((vol1*5)/vol5-1,-2,3):null;
 const oiDelta=x.oi&&x.oiPrev&&fresh(x.oiAt)?pct(x.oi,x.oiPrev):null;
 const liqLog=Math.log10(1+longLiq+shortLiq);
 // Core evidence is required; optional missing feeds are omitted and flagged, never synthesized as zeros.
 if(![m1,m5,flow,depth].every(Number.isFinite)||!Number.isFinite(p)||!fresh(t.priceAt))return null;
 const optional=[[liqBias,.55], [oiDelta,.45], [volAccel,.3], [funding,-300]];
 const signed=1.35*m1+.8*m5+2.2*flow+1.4*depth+.18*clip(ch,-8,8)
   +optional.reduce((sum,[v,w])=>sum+(Number.isFinite(v)?w*(w===.45?clip(v,-4,4):v):0),0);
 const side=signed>=0?'LONG':'SHORT';
 const strength=Math.abs(signed);
 const liquidity=Math.log10(1+q)/9;
 const quality=clip(48 + strength*8 + liquidity*8 + liqLog*.45,0,100);
 const confidence=[flow,depth,oiDelta,funding].filter(Number.isFinite).length/4;const rankScore=clip(quality*confidence,0,100);
 if(x.lastSide===side && rankScore>=60)x.persist++; else x.persist=1;
 x.lastSide=side;x.lastScore=rankScore;
 const stateName=Math.abs(m1)>=0.9||Math.abs(m5)>=1.5?'LATE_DO_NOT_CHASE':rankScore>=70?'TRIGGER_PENDING':rankScore>=60?'WATCHLIST':'REJECT';
 return {symbol:sym,side,confidence,executable:false,ourbit:{status:'UNVERIFIED'},score:+rankScore.toFixed(1),state:stateName,price:p,priceAt:t.priceAt,change24h:+ch.toFixed(3),qVol:+q.toFixed(0),
   funding:funding==null?null:+funding.toFixed(8),fundingAt:funding==null?null:t.fundingAt,
   m1:+m1.toFixed(3),m5:+m5.toFixed(3),flow:+flow.toFixed(3),flowAt:recent.at(-1)?.t||null,
   depth:+depth.toFixed(3),depthAt:x.depth.t,oiDelta:oiDelta==null?null:+oiDelta.toFixed(3),oiAt:oiDelta==null?null:x.oiAt,
   liqLong:shortLiq+longLiq?+longLiq.toFixed(0):null,liqShort:shortLiq+longLiq?+shortLiq.toFixed(0):null,
   volAccel:volAccel==null?null:+volAccel.toFixed(2),persist:x.persist,news:newsScore(sym),ourbitVerified:false};
}
function newsScore(sym){const n=state.news.get(base(sym));if(!n)return {score:0,mentions:0,latest:null};return {score:+clip(n.score,-10,10).toFixed(2),mentions:n.mentions,latest:n.latest}}
function ranks(){
 const a=[];for(const s of state.tickers.keys()){const z=score(s);if(z)a.push(z)}
 a.sort((x,y)=>y.score-x.score||y.qVol-x.qVol);const top=a.slice(0,100);
 top.forEach((z,i)=>{const old=state.rankPrev.get(z.symbol);z.rank=i+1;z.rankJump=old?old-(i+1):0;state.rankPrev.set(z.symbol,i+1)});state.lastRank=now();return top;
}
const subscriptionSets={market:new Set(),public:new Set()};
function detailStreams(symbols){return symbols.flatMap(s=>{const x=s.toLowerCase();return [`${x}@aggTrade`,`${x}@kline_1m`,`${x}@kline_5m`,`${x}@depth5@500ms`,`${x}@forceOrder`]})}
function refreshSubs(ws,channel){if(!ws||ws.readyState!==1)return;let subscribed=subscriptionSets[channel];const top=[...state.tickers].filter(([,t])=>fresh(t.priceAt)).sort((a,b)=>b[1].q-a[1].q).slice(0,TOP_DETAIL).map(([sym])=>sym), next=new Set(detailStreams(top).filter(s=>channel==='public'?s.includes('@depth'):!s.includes('@depth')));const add=[...next].filter(x=>!subscribed.has(x)), rem=[...subscribed].filter(x=>!next.has(x));if(rem.length)ws.send(JSON.stringify({method:'UNSUBSCRIBE',params:rem,id:'u'+now()}));if(add.length)ws.send(JSON.stringify({method:'SUBSCRIBE',params:add,id:'s'+now()}));subscriptionSets[channel]=next}

function connectMarket(){
 const ws=new WebSocket('wss://fstream.binance.com/market/stream?streams=!ticker@arr/!markPrice@arr@1s');
 ws.on('open',()=>{state.marketConnected=true});ws.on('close',()=>{state.marketConnected=false;setTimeout(connectMarket,2500)});ws.on('error',()=>{});
 ws.on('message',buf=>{state.events++;let m;try{m=JSON.parse(buf)}catch{return}let a=m.data||m;if(!Array.isArray(a))return;
   for(const z of a){if(z.e==='24hrTicker'&&isUM(z.s)){const old=state.tickers.get(z.s)||{};state.tickers.set(z.s,{...old,p:num(z.c),ch:num(z.P),q:num(z.q),h:num(z.h),l:num(z.l),priceAt:num(z.E)})}else if(z.e==='markPriceUpdate'&&isUM(z.s)){const old=state.tickers.get(z.s)||{};state.tickers.set(z.s,{...old,mark:num(z.p),funding:nullable(z.r),fundingAt:num(z.E),nextFunding:num(z.T)})}}
 });
}
function connectDetail(channel='market'){
 const ws=new WebSocket('wss://fstream.binance.com/'+channel+'/stream');
 ws.on('open',()=>{state[channel+'Connected']=true;state.detailConnected=!!(state.marketConnected&&state.publicConnected);refreshSubs(ws,channel)});ws.on('close',()=>{state[channel+'Connected']=false;state.detailConnected=false;subscriptionSets[channel]=new Set();clearInterval(timer);setTimeout(()=>connectDetail(channel),2500)});ws.on('error',()=>{});
 ws.on('message',buf=>{state.detailEvents++;let m;try{m=JSON.parse(buf)}catch{return}const z=m.data||m,s=z.s;if(!s)return;const x=d(s),t=nullable(z.E);
   if(z.e==='aggTrade'){const side=z.m?'sell':'buy';x.trades.push({t,side,q:num(z.p)*num(z.q)});trim(x.trades,125000)}
   else if(z.e==='kline'){const k=z.k, o={t:num(k.t),at:t,o:num(k.o),h:num(k.h),l:num(k.l),c:num(k.c),v:num(k.v),q:num(k.q),closed:!!k.x};if(k.i==='1m')x.k1=o;else if(k.i==='5m')x.k5=o}
   else if(z.e==='forceOrder'){const o=z.o,side=o.S==='SELL'?'sell':'buy';x.liq.push({t,side,q:num(o.ap||o.p)*num(o.z||o.q)});trim(x.liq,300000)}
   else if(z.lastUpdateId||z.u){const bids=z.b||[],asks=z.a||[];let bq=0,aq=0;for(const v of bids)bq+=num(v[1]);for(const v of asks)aq+=num(v[1]);x.depth=bq+aq>0?{t,imb:(bq-aq)/(bq+aq)}:null}
 });
 const timer=setInterval(()=>refreshSubs(ws,channel),30000);
}

async function oiCycle(){try{const top=ranks().slice(0,20);for(let i=0;i<top.length;i++){const s=top[i].symbol;await new Promise(r=>setTimeout(r,700));try{const r=await fetch(`https://fapi.binance.com/fapi/v1/openInterest?symbol=${s}`,{signal:AbortSignal.timeout(5000)});if(!r.ok)continue;const j=await r.json(),x=d(s),v=num(j.openInterest);if(v){if(x.oi&&now()-x.oiAt>30000)x.oiPrev=x.oi;x.oi=v;x.oiAt=nullable(j.time)}}catch{}}}catch{}setTimeout(oiCycle,60000)}

const aliases={BTC:['BITCOIN'],ETH:['ETHEREUM'],SOL:['SOLANA'],XRP:['RIPPLE'],DOGE:['DOGECOIN'],BNB:['BINANCE COIN'],SUI:['SUI'],HYPE:['HYPERLIQUID'],ZEC:['ZCASH'],XLM:['STELLAR'],NEAR:['NEAR'],FIL:['FILECOIN'],ADA:['CARDANO'],AVAX:['AVALANCHE'],LINK:['CHAINLINK'],DOT:['POLKADOT'],LTC:['LITECOIN'],UNI:['UNISWAP'],AAVE:['AAVE'],ARB:['ARBITRUM'],OP:['OPTIMISM']};
const POS=['bullish','breakout','rally','surge','buy','long','support','listing','launch','approval','upgrade','partnership','adoption','inflow','record high'];
const NEG=['bearish','breakdown','sell','short','resistance','delist','hack','exploit','lawsuit','outflow','ban','liquidation','downgrade'];
function ingestText(name,text,weight=1){const u=text.toUpperCase();let baseSent=0;const l=text.toLowerCase();for(const w of POS)if(l.includes(w))baseSent++;for(const w of NEG)if(l.includes(w))baseSent--;const touched=[];for(const sym of state.tickers.keys()){const b=base(sym);const names=[b,...(aliases[b]||[])];if(names.some(n=>new RegExp(`(^|[^A-Z0-9])\\$?${n}([^A-Z0-9]|$)`,'i').test(u))){const n=state.news.get(b)||{score:0,mentions:0,latest:null};n.score=clip(n.score*.92+baseSent*weight,-20,20);n.mentions++;n.latest=name;state.news.set(b,n);touched.push(b)}}return touched.length}
function strip(html){return html.replace(/<script[\s\S]*?<\/script>/gi,' ').replace(/<style[\s\S]*?<\/style>/gi,' ').replace(/<[^>]+>/g,' ').replace(/&[a-z#0-9]+;/gi,' ').replace(/\s+/g,' ').slice(0,300000)}
async function source(name,url,weight){const st={url,ok:false,at:new Date().toISOString(),items:0,error:null};try{const r=await fetch(url,{headers:{'user-agent':'NINA-Market-Intelligence/1.0 (+read-only public research)'},signal:AbortSignal.timeout(12000),redirect:'follow'});st.status=r.status;if(!r.ok)throw Error('HTTP '+r.status);const text=strip(await r.text());st.items=ingestText(name,text,weight);st.ok=true}catch(e){st.error=String(e.message||e)}state.sources[name]=st}
async function sourceCycle(){await Promise.allSettled([
 source('TradingView Ideas','https://www.tradingview.com/markets/cryptocurrencies/ideas/?sort=recent',.35),
 source('Binance Telegram','https://t.me/s/binance_announcements',.8),
 source('CoinDesk RSS','https://www.coindesk.com/arc/outboundfeeds/rss/',.55),
 source('Cointelegraph RSS','https://cointelegraph.com/rss',.45),
 source('Decrypt RSS','https://decrypt.co/feed',.5),
 source('Reddit CryptoCurrency','https://www.reddit.com/r/CryptoCurrency/new.json?limit=50',.25)
]);state.lastSource=now();setTimeout(sourceCycle,180000)}

function context(){const top=ranks();return {at:new Date().toISOString(),version:'NINA Technical v1.2.1',feeds:{binanceMarket:state.marketConnected,binanceDetail:state.detailConnected,ourbit:'execution-only; direct public feed not yet stable'},universe:state.tickers.size,marketEvents:state.events,detailEvents:state.detailEvents,top:top.slice(0,20),sources:state.sources,policy:{venue:'Ourbit only',binance:'market intelligence',external:'confirmation only',states:['REJECT','WATCHLIST','TRIGGER_PENDING','EXECUTABLE_CANDIDATE']}}}
function symData(sym){sym=sym.toUpperCase().replace('/','');if(!sym.endsWith('USDT'))sym+='USDT';const t=state.tickers.get(sym),x=d(sym);return {at:new Date().toISOString(),ticker:t,analysis:score(sym),detail:{k1:x.k1,k5:x.k5,depth:x.depth,oi:x.oi,oiPrev:x.oiPrev,recentTrades:x.trades.slice(-30),recentLiquidations:x.liq.slice(-20)}}}
const html=`<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><title>NINA Market Intelligence</title><style>body{font-family:system-ui;background:#080b12;color:#e8eefc;margin:0}main{max-width:1200px;margin:auto;padding:24px}.card{background:#101725;border:1px solid #22304a;border-radius:16px;padding:16px;margin:12px 0}h1{margin:0 0 6px}.muted{color:#8ea0be}table{width:100%;border-collapse:collapse;font-size:14px}th,td{padding:8px;border-bottom:1px solid #22304a;text-align:right}th:first-child,td:first-child{text-align:left}.LONG{color:#59d98e}.SHORT{color:#ff7b86}.WATCHLIST{color:#ffd166}.TRIGGER_PENDING{color:#ffae57}.EXECUTABLE_CANDIDATE{color:#65e6ff}@media(max-width:700px){table{font-size:11px}.hide{display:none}}</style><main><h1>NINA Market Intelligence</h1><div class=muted id=meta>Loading…</div><div class=card><b>Candidate Race</b><table><thead><tr><th>Symbol</th><th>Side</th><th>Score</th><th>State</th><th>Price</th><th class=hide>1m%</th><th class=hide>Flow</th><th class=hide>Depth</th><th>News</th></tr></thead><tbody id=t></tbody></table></div><div class=card><b>Public intelligence sources</b><div id=s></div></div><script>async function go(){try{let j=await fetch('/api/context').then(r=>r.json());meta.textContent=j.at+' · universe '+j.universe+' · market events '+j.marketEvents+' · detail events '+j.detailEvents; t.innerHTML=j.top.map(x=>'<tr><td>'+x.symbol+'</td><td class='+x.side+'>'+x.side+'</td><td>'+x.score+'</td><td class='+x.state+'>'+x.state+'</td><td>'+x.price+'</td><td class=hide>'+x.m1+'</td><td class=hide>'+x.flow+'</td><td class=hide>'+x.depth+'</td><td>'+x.news.score+' ('+x.news.mentions+')</td></tr>').join('');s.innerHTML=Object.entries(j.sources).map(([k,v])=>'<div>'+ (v.ok?'✅':'⚠️')+' '+k+' · '+(v.status||'')+' · mentions '+(v.items||0)+'</div>').join('')}catch(e){meta.textContent='refreshing…'}}go();setInterval(go,10000)</script>`;
const server=http.createServer((req,res)=>{res.setHeader('access-control-allow-origin','*');res.setHeader('cache-control','no-store');if(!['GET','HEAD'].includes(req.method)){res.statusCode=405;return res.end();}if(req.url==='/'){res.writeHead(302,{Location:'https://nina-dashboard-v1.onrender.com/'});return res.end();}if(req.url==='/health'){res.setHeader('content-type','application/json');return res.end(JSON.stringify({ok:state.marketConnected&&state.detailConnected,version:'1.2.1',market:state.marketConnected,detail:state.detailConnected,universe:state.tickers.size,events:state.events}))}if(req.url.startsWith('/api/symbol/')){res.setHeader('content-type','application/json');return res.end(JSON.stringify(symData(decodeURIComponent(req.url.split('/').pop()))))}if(req.url==='/api/sources'){res.setHeader('content-type','application/json');return res.end(JSON.stringify(state.sources))}if(req.url==='/api/context'||req.url.startsWith('/api/universe')){res.setHeader('content-type','application/json');return res.end(JSON.stringify(context()))}res.setHeader('content-type','text/html;charset=utf-8');res.end(html)});
server.listen(PORT,()=>console.log('NINA_INTEL_LISTEN',PORT));
connectMarket();connectDetail('market');connectDetail('public');setTimeout(oiCycle,30000);setTimeout(sourceCycle,10000);setInterval(()=>{const c=context();console.log('NINA_INTEL',JSON.stringify({at:c.at,universe:c.universe,events:c.marketEvents,detail:c.detailEvents,top:c.top.slice(0,8).map(x=>({symbol:x.symbol,side:x.side,score:x.score,state:x.state,price:x.price,m1:x.m1,m5:x.m5,flow:x.flow,depth:x.depth,oi:x.oiDelta,news:x.news.score}))}))},30000);
