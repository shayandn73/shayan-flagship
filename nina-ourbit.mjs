// Official public futures endpoints documented by ourbitdevelop/ourbit-api-postman.
// Unknown response shapes or network errors must never imply eligibility.
const BASE='https://contract.ourbit.com/api/v1/contract';
export const OURBIT_PROVENANCE={detail:`${BASE}/detail`,ticker:`${BASE}/ticker`};
const norm=x=>typeof x==='string'?x.toUpperCase().replace(/_/g,''):null;
const array=x=>Array.isArray(x)?x:[];
const observedTime=x=>{const v=x?.timestamp??x?.time??x?.ts??x?.t;const n=Number(v);return Number.isFinite(n)?(n<1e11?n*1000:n):NaN};
const positive=x=>Number.isFinite(Number(x))&&Number(x)>0;

export function parseEligibility(detailPayload,tickerPayload,at=Date.now()){
  const contracts=array(detailPayload?.data);
  const tickers=array(tickerPayload?.data);
  if(!contracts.length||!tickers.length)return {ok:false,at:new Date(at).toISOString(),reason:'unrecognized_or_empty_response',contracts:new Map()};
  const tradeable=new Map();
  const explicitlyDelisted=new Set();
  for(const x of contracts){
    const s=norm(x?.symbol);if(!s||!s.endsWith('USDT'))continue;
    // An explicit live trading flag is required. Do not guess the meaning of numeric state codes.
    if(x.tradeable===true||x.status==='TRADING'||x.state==='TRADING')tradeable.set(s,x);
    if(x.status==='DELISTED'||x.state==='DELISTED'||x.listed===false)explicitlyDelisted.add(s);
  }
  const observed=new Map(tickers.map(x=>[norm(x?.symbol),x]).filter(([s])=>s));
  const contractsOut=new Map();
  for(const [s] of tradeable){const t=observed.get(s),ts=observedTime(t);if(t&&Number.isFinite(ts)&&at-ts>=-5000&&at-ts<=60000&&(positive(t.bidPrice)&&positive(t.askPrice)||positive(t.markPrice)||positive(t.lastPrice))){
    contractsOut.set(s,{status:'VERIFIED',available:true,verifiedAt:new Date(ts).toISOString(),evidence:'official_active_contract_and_fresh_ticker',directPrice:true,bid:positive(t.bidPrice)?Number(t.bidPrice):null,ask:positive(t.askPrice)?Number(t.askPrice):null,mark:positive(t.markPrice)?Number(t.markPrice):null});
  }}
  for(const s of explicitlyDelisted)if(!tradeable.has(s))contractsOut.set(s,{status:'NOT_LISTED',available:false,verifiedAt:new Date(at).toISOString(),evidence:'explicit_official_delisting'});
  return {ok:true,at:new Date(at).toISOString(),reason:null,contracts:contractsOut};
}

export async function fetchEligibility({fetcher=fetch,timeoutMs=6000}={}){
  const at=Date.now();
  try{
    const result=await Promise.all([OURBIT_PROVENANCE.detail,OURBIT_PROVENANCE.ticker].map(async url=>{
      const r=await fetcher(url,{signal:AbortSignal.timeout(timeoutMs),headers:{accept:'application/json'}});
      if(!r.ok)throw Error(`HTTP_${r.status}`);
      return r.json();
    }));
    return parseEligibility(...result,at);
  }catch(e){const cause=e?.cause;return {ok:false,at:new Date(at).toISOString(),reason:[e?.name,e?.message,cause?.code,cause?.message].filter(Boolean).join(': ').slice(0,300),contracts:new Map()};}
}

export function contractStatus(snapshot,symbol,at=Date.now()){
  const s=norm(symbol);
  if(!snapshot?.ok||!Number.isFinite(Date.parse(snapshot.at))||at-Date.parse(snapshot.at)>60000||at-Date.parse(snapshot.at)<-5000)return {status:'UNVERIFIED',available:null,verifiedAt:null,reason:'official_contract_source_unavailable_or_stale'};
  return snapshot.contracts.get(s)||{status:'UNVERIFIED',available:null,verifiedAt:snapshot.at,reason:'contract_not_positively_verified'};
}
