
import http from 'http';
import WebSocket from 'ws';

const PORT = process.env.PORT || 10000;
const BASE_MARKET = 'wss://fstream.binance.com/market/stream';
const BASE_PUBLIC = 'wss://fstream.binance.com/public/stream';
const TOP_DETAIL = 36;
const state = { marketUp:false, publicUp:false, detailMarketUp:false, symbols:new Map(), alerts:[], watch:[], events:0, detailEvents:0, started:Date.now() };
const detailMarketSubs = new Set(), detailPublicSubs = new Set();
let dmWs=null, dpWs=null, rankPrev=new Map(), alertSeq=0;

const now=()=>Date.now();
const fresh=t=>Number.isFinite(t)&&now()-t>=-5000&&now()-t<=90000;
const nullable=x=>x==null||x===''?null:Number.isFinite(Number(x))?Number(x):null;
const num=x=>Number.isFinite(+x)?+x:0;
const clamp=(x,a,b)=>Math.max(a,Math.min(b,x));
const trim=(a,ms)=>{const t=now()-ms; while(a.length && a[0].t<t)a.shift();};
function S(sym){
  if(!state.symbols.has(sym)) state.symbols.set(sym,{sym,p:0,ch24:0,q24:0,funding:null,fundingAt:null,priceAt:null,mark:0,pts:[],trades:[],depth:null,k1:null,k5:null,liq:[],rank:999,persist:0,lastDir:null,lastScore:0});
  return state.symbols.get(sym);
}
function pct(a,b){ return a&&b ? (a/b-1)*100 : 0; }
function histPrice(x,ms){ const t=now()-ms; let v=x.p; for(const h of x.pts){ if(h.t>=t){v=h.p; break;} } return v||x.p; }
function histQ(x,ms){ const t=now()-ms; let v=x.q24; for(const h of x.pts){ if(h.t>=t){v=h.q; break;} } return v||x.q24; }
function flow(x,ms=90000){ trim(x.trades,120000); let b=0,s=0,t=now()-ms; for(const z of x.trades){ if(z.t<t)continue; if(z.side==='buy')b+=z.q; else s+=z.q; } return b+s>0?(b-s)/(b+s):null; }
function liqBias(x,ms=180000){ trim(x.liq,240000); let longL=0,shortL=0,t=now()-ms; for(const z of x.liq){ if(z.t<t)continue; if(z.side==='SELL')longL+=z.q; else shortL+=z.q; } return (shortL-longL)/(shortL+longL||1); }
function detailReady(x){ return fresh(x.priceAt)&&fresh(x.k1?.at)&&fresh(x.k5?.at)&&fresh(x.depth?.t)&&fresh(x.fundingAt)&&x.trades.filter(z=>fresh(z.t)).length>=3&&x.pts.length>1&&now()-x.pts[0].t>=300000; }

function preliminary(){
  const arr=[];
  for(const x of state.symbols.values()){
    if(!x.p || !fresh(x.priceAt) || !x.sym.endsWith('USDT')) continue;
    const p30=histPrice(x,30000), p120=histPrice(x,120000), q30=histQ(x,30000);
    const m30=pct(x.p,p30), m2=pct(x.p,p120);
    const qDelta=Math.max(0,x.q24-q30), expected=Math.max(1,x.q24/2880), volAccel=qDelta/expected;
    const liquid=Math.log10(Math.max(1,x.q24)), quiet=Math.max(0,1-Math.abs(m2)/0.7), fund=fresh(x.fundingAt)&&Number.isFinite(x.funding)?Math.min(2,Math.abs(x.funding)*10000)/2:0;
    const score=18*quiet+18*clamp(volAccel/4,0,1)+10*clamp(Math.abs(m30)/0.18,0,1)+6*fund+6*clamp((liquid-6)/4,0,1);
    arr.push({x,score,m30,m2,volAccel});
  }
  arr.sort((a,b)=>b.score-a.score); arr.forEach((r,i)=>r.x.rank=i+1); return arr;
}

function deepScore(x){
  const p15=histPrice(x,15000),p60=histPrice(x,60000),p5=histPrice(x,300000);
  const m15=pct(x.p,p15),m1=pct(x.p,p60),m5=pct(x.p,p5);
  const q30=histQ(x,30000),expected=Math.max(1,x.q24/2880),volAccel=Math.max(0,(x.q24-q30)/expected);
  const f=flow(x,90000),d=fresh(x.depth?.t)?x.depth.imb:null,lq=liqBias(x),funding=fresh(x.fundingAt)?x.funding:null;
  const dirRaw=1.4*f+1.0*d+0.7*clamp(m15/0.15,-1,1)+0.45*clamp(m1/0.30,-1,1)-0.35*clamp((funding??0)*10000/2,-1,1)+0.35*lq;
  const side=dirRaw>=0?'LONG':'SHORT',sign=side==='LONG'?1:-1;
  const quiet=clamp(1-Math.abs(m5)/0.75,0,1),early=clamp(1-Math.abs(m1)/0.38,0,1);
  const flowA=clamp(sign*f,0,1),depthA=clamp(sign*d,0,1),vol=clamp((volAccel-1)/4,0,1),squeeze=clamp((-sign*(funding??0)*10000)/2,0,1),liq=clamp(sign*lq,0,1);
  const prev=rankPrev.get(x.sym)??x.rank,jump=clamp((prev-x.rank)/12,0,1);
  const b=S('BTCUSDT'),bm=pct(b.p,histPrice(b,60000)),rsBtc=clamp(sign*(m1-bm)/0.35,0,1);
  let score=18*quiet+12*early+18*flowA+14*depthA+14*vol+8*squeeze+6*liq+6*jump+4*rsBtc;
  if(!detailReady(x))score=Math.min(score,59);
  if(Math.abs(m5)>0.9||Math.abs(m1)>0.55)score-=15;
  const confidence=[f,d,funding].filter(Number.isFinite).length/4;score=clamp(score*confidence,0,100);
  if(x.lastDir===side&&score>=65)x.persist++;else x.persist=score>=65?1:0;
  x.lastDir=side;x.lastScore=score;
  const stateName=Math.abs(m5)>0.9||Math.abs(m1)>0.55?'LATE_DO_NOT_CHASE':score>=76&&x.persist>=2?'EARLY_ALERT':score>=64?'PRE_WATCH':'REJECT';
  return {symbol:x.sym,side,score:+score.toFixed(1),state:stateName,price:x.p,priceAt:x.priceAt,confidence,oiDelta:null,oiAt:null,executable:false,ourbit:{status:'UNVERIFIED'},m15:+m15.toFixed(3),m1:+m1.toFixed(3),m5:+m5.toFixed(3),flow:f==null?null:+f.toFixed(3),flowAt:f==null?null:x.trades.at(-1)?.t,depth:d==null?null:+d.toFixed(3),depthAt:d==null?null:x.depth.t,volAccel:+volAccel.toFixed(2),funding,fundingAt:funding==null?null:x.fundingAt,liqBias:+lq.toFixed(3),rank:x.rank,rankJump:Math.max(0,prev-x.rank),persist:x.persist,ready:detailReady(x)};
}
function subscribe(ws,set,want){
  if(!ws||ws.readyState!==1)return;
  const add=[...want].filter(x=>!set.has(x)),rem=[...set].filter(x=>!want.has(x));
  if(rem.length)ws.send(JSON.stringify({method:'UNSUBSCRIBE',params:rem,id:Date.now()%1000000}));
  if(add.length)ws.send(JSON.stringify({method:'SUBSCRIBE',params:add,id:(Date.now()+1)%1000000}));
  set.clear();for(const x of want)set.add(x);
}
function refreshDetail(){
  const syms=preliminary().slice(0,TOP_DETAIL).map(r=>r.x.sym);
  const ms=new Set(syms.flatMap(s=>{const z=s.toLowerCase();return [z+'@aggTrade',z+'@kline_1m',z+'@kline_5m',z+'@forceOrder'];}));
  const ps=new Set(syms.map(s=>s.toLowerCase()+'@depth5@500ms'));
  subscribe(dmWs,detailMarketSubs,ms);subscribe(dpWs,detailPublicSubs,ps);
}
function evaluate(){
  const pre=preliminary();
  const top=pre.slice(0,TOP_DETAIL).map(r=>deepScore(r.x)).sort((a,b)=>b.score-a.score);
  const early=top.filter(x=>x.state==='EARLY_ALERT'),watch=top.filter(x=>x.state==='PRE_WATCH').slice(0,12);state.watch=watch;
  for(const a of early){
    const prev=state.alerts.find(z=>z.symbol===a.symbol&&z.side===a.side&&now()-z.ts<180000);
    if(!prev){const rec={...a,id:++alertSeq,ts:now(),at:new Date().toISOString()};state.alerts.unshift(rec);state.alerts=state.alerts.slice(0,100);console.log('NINA_EARLY_ALERT',JSON.stringify(rec));}
  }
  console.log('NINA_PREIMPULSE',JSON.stringify({at:new Date().toISOString(),early:early.slice(0,8),watch,universe:state.symbols.size,detailMarket:state.detailMarketUp,detailPublic:state.publicUp}));
  rankPrev=new Map(pre.map(r=>[r.x.sym,r.x.rank]));
}
function connectBase(){
  const ws=new WebSocket(BASE_MARKET);
  ws.on('open',()=>{state.marketUp=true;ws.send(JSON.stringify({method:'SUBSCRIBE',params:['!ticker@arr','!markPrice@arr@1s'],id:1}));});
  ws.on('message',buf=>{let m;try{m=JSON.parse(buf)}catch{return}const z=m.data??m,arr=Array.isArray(z)?z:[z];for(const e of arr){if(e.e==='24hrTicker'||e.e==='24hrMiniTicker'){const x=S(e.s);x.p=num(e.c);x.priceAt=nullable(e.E);x.ch24=num(e.P);x.q24=num(e.q);x.pts.push({t:x.priceAt,p:x.p,q:x.q24});trim(x.pts,360000);}else if(e.e==='markPriceUpdate'){const x=S(e.s);x.mark=num(e.p);x.funding=nullable(e.r);x.fundingAt=nullable(e.E);}}state.events+=arr.length;});
  ws.on('close',()=>{state.marketUp=false;setTimeout(connectBase,1800)});ws.on('error',()=>{});
}
function connectDetailMarket(){
  const ws=dmWs=new WebSocket(BASE_MARKET);
  ws.on('open',()=>{state.detailMarketUp=true;refreshDetail()});
  ws.on('message',buf=>{let m;try{m=JSON.parse(buf)}catch{return}const z=m.data??m;if(!z?.s)return;const x=S(z.s),t=nullable(z.E);state.detailEvents++;
    if(z.e==='aggTrade'){x.trades.push({t,side:z.m?'sell':'buy',q:num(z.p)*num(z.q)});trim(x.trades,120000);}
    else if(z.e==='kline'){const k=z.k,o={t:num(k.t),at:t,o:num(k.o),h:num(k.h),l:num(k.l),c:num(k.c),v:num(k.q||k.v),closed:!!k.x};if(k.i==='1m')x.k1=o;else if(k.i==='5m')x.k5=o;}
    else if(z.e==='forceOrder'){const o=z.o;x.liq.push({t,side:o.S,q:num(o.ap||o.p)*num(o.z||o.q)});trim(x.liq,240000);}
  });
  ws.on('close',()=>{state.detailMarketUp=false;detailMarketSubs.clear();setTimeout(connectDetailMarket,1800)});ws.on('error',()=>{});
}
function connectDetailPublic(){
  const ws=dpWs=new WebSocket(BASE_PUBLIC);
  ws.on('open',()=>{state.publicUp=true;refreshDetail()});
  ws.on('message',buf=>{let m;try{m=JSON.parse(buf)}catch{return}const z=m.data??m;if(!z?.s)return;const x=S(z.s),b=z.b||z.bids||[],a=z.a||z.asks||[];let bq=0,aq=0;for(const v of b)bq+=num(v[1]);for(const v of a)aq+=num(v[1]);x.depth=bq+aq>0?{t:nullable(z.E),imb:(bq-aq)/(bq+aq)}:null;state.detailEvents++;});
  ws.on('close',()=>{state.publicUp=false;detailPublicSubs.clear();setTimeout(connectDetailPublic,1800)});ws.on('error',()=>{});
}

const html='<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>NINA Early Warning</title><style>body{font-family:system-ui;background:#0b0d12;color:#eef;margin:0;padding:18px}button{padding:12px 16px;border-radius:10px;border:0}.card{background:#151924;padding:14px;border-radius:14px;margin:10px 0}.hot{border:1px solid #ffb84d}.muted{opacity:.7}</style></head><body><h2>NINA Pre-Impulse v0.8</h2><p class="muted">EARLY_ALERT = before extension, not after the move.</p><button id="n">Enable browser alerts</button><div id="s"></div><script>let last=0;document.getElementById("n").onclick=async()=>{if("Notification"in window)await Notification.requestPermission()};async function tick(){try{const j=await (await fetch("/api/preimpulse")).json();let h="<div class=\\"card\\">Universe "+j.universe+" | base "+j.marketUp+" | detail "+j.detailMarketUp+"/"+j.publicUp+"</div>";for(const a of j.alerts.slice(0,8)){h+="<div class=\\"card hot\\"><b>"+a.symbol+" "+a.side+" "+a.score+"</b><br>price "+a.price+" | 1m "+a.m1+"% | 5m "+a.m5+"% | flow "+a.flow+" | depth "+a.depth+" | volx "+a.volAccel+"</div>";if(a.id>last&&Notification.permission==="granted")new Notification("NINA EARLY "+a.symbol+" "+a.side,{body:"Score "+a.score+" @ "+a.price});last=Math.max(last,a.id)}h+="<h3>Pre-watch</h3>";for(const a of j.watch.slice(0,8))h+="<div class=\\"card\\">"+a.symbol+" "+a.side+" "+a.score+" | m1 "+a.m1+" | flow "+a.flow+" | depth "+a.depth+"</div>";document.getElementById("s").innerHTML=h}catch{}setTimeout(tick,3000)}tick();</script></body></html>';

const server=http.createServer((req,res)=>{
 res.setHeader('access-control-allow-origin','*');res.setHeader('cache-control','no-store');if(!['GET','HEAD'].includes(req.method)){res.statusCode=405;return res.end();}
 if(req.url==='/'){res.writeHead(302,{Location:'https://nina-dashboard-v1.onrender.com/'});return res.end();}
  if(req.url==='/health'){res.setHeader('content-type','application/json');return res.end(JSON.stringify({ok:state.marketUp,version:'1.2.1',alertAgeLimitMs:90000,marketUp:state.marketUp,detailMarketUp:state.detailMarketUp,publicUp:state.publicUp,universe:state.symbols.size,events:state.events,detailEvents:state.detailEvents}))}
  if(req.url==='/api/preimpulse'){res.setHeader('content-type','application/json');return res.end(JSON.stringify({at:new Date().toISOString(),universe:state.symbols.size,marketUp:state.marketUp,detailMarketUp:state.detailMarketUp,publicUp:state.publicUp,version:'1.2.1',alertAgeLimitMs:90000,alerts:state.alerts.filter(a=>fresh(a.ts)&&fresh(a.priceAt)),watch:state.watch.filter(a=>fresh(a.priceAt))}))}
  res.setHeader('content-type','text/html');res.end(html);
});
server.listen(PORT,()=>console.log('NINA_PREIMPULSE_SERVER',PORT));
connectBase();connectDetailMarket();connectDetailPublic();setInterval(refreshDetail,15000);setInterval(evaluate,10000);
