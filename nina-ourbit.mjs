// Official public futures endpoints documented by ourbitdevelop/ourbit-api-postman.
// Unknown response shapes or network errors must never imply eligibility.
const BASE='https://contract.ourbit.com/api/v1/contract';
export const OURBIT_PROVENANCE={detail:`${BASE}/detail`,ticker:`${BASE}/ticker`};
const norm=x=>typeof x==='string'?x.toUpperCase().replace(/_/g,''):null;
const array=x=>Array.isArray(x)?x:[];

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
  const observed=new Set(tickers.map(x=>norm(x?.symbol)).filter(Boolean));
  const contractsOut=new Map();
  for(const [s] of tradeable)if(observed.has(s))contractsOut.set(s,{status:'VERIFIED',available:true,verifiedAt:new Date(at).toISOString(),evidence:'official_contract_detail_and_ticker'});
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
  }catch(e){return {ok:false,at:new Date(at).toISOString(),reason:String(e?.message||e),contracts:new Map()};}
}

export function contractStatus(snapshot,symbol,at=Date.now()){
  const s=norm(symbol);
  if(!snapshot?.ok||!Number.isFinite(Date.parse(snapshot.at))||at-Date.parse(snapshot.at)>60000||at-Date.parse(snapshot.at)<-5000)return {status:'UNVERIFIED',available:null,verifiedAt:null,reason:'official_contract_source_unavailable_or_stale'};
  return snapshot.contracts.get(s)||{status:'UNVERIFIED',available:null,verifiedAt:snapshot.at,reason:'contract_not_positively_verified'};
}
