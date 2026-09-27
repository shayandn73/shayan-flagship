import {test} from 'node:test';
import assert from 'node:assert/strict';
import {parseEligibility,contractStatus,fetchEligibility} from './nina-ourbit.mjs';

test('positive proof requires official active contract plus matching futures ticker',()=>{
  const at=Date.now();
  const snapshot=parseEligibility({data:[{symbol:'BTC_USDT',status:'TRADING'},{symbol:'SOL_USDT',state:0},{symbol:'LUNA_USDT',status:'DELISTED'}]},
    {data:[{symbol:'BTC_USDT',timestamp:at,bidPrice:'100',askPrice:'101'},{symbol:'SOL_USDT'}]},at);
  assert.equal(contractStatus(snapshot,'BTCUSDT',at).status,'VERIFIED');
  assert.equal(contractStatus(snapshot,'SOLUSDT',at).status,'UNVERIFIED');
  assert.equal(contractStatus(snapshot,'LUNAUSDT',at).status,'NOT_LISTED');
  assert.equal(contractStatus(snapshot,'BTCUSDT',at+61000).status,'UNVERIFIED');
  const stale=parseEligibility({data:[{symbol:'BTC_USDT',status:'TRADING'}]},{data:[{symbol:'BTC_USDT',timestamp:at-90001,bidPrice:'100',askPrice:'101'}]},at);
  assert.equal(contractStatus(stale,'BTCUSDT',at).status,'UNVERIFIED');
});
test('HTTP errors and unknown response shapes fail closed',async()=>{
  const no=await fetchEligibility({fetcher:async()=>({ok:false,status:502})});
  assert.equal(contractStatus(no,'BTCUSDT').available,null);
  assert.equal(parseEligibility({data:{}},{data:[]}).ok,false);
});
