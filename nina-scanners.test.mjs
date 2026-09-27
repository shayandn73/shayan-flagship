import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
function scanner(file){const text=readFileSync(new URL(file,import.meta.url),'utf8').replace(/^import .*;$/mg,'').split('const html=')[0];const c=vm.createContext({Date,Math,Map,Set,Number,process:{env:{}},console});vm.runInContext(text,c);return code=>vm.runInContext(code,c);}
test('PRE rejects missing detail and never fabricates derivatives',()=>{const run=scanner('nina-preimpulse.mjs');run("var x=S('SUIUSDT');x.p=1;x.priceAt=Date.now();x.q24=1e8;x.pts=[{t:Date.now()-310000,p:1,q:1e8},{t:Date.now(),p:1,q:1e8}]");const s=run('deepScore(x)');for(const k of ['flow','depth','funding','oiDelta'])assert.equal(s[k],null);assert.equal(s.ready,false);assert.equal(s.executable,false);assert.equal(s.state,'REJECT');});
test('PRE age boundary and future timestamps fail closed',()=>{const run=scanner('nina-preimpulse.mjs');assert.equal(run('fresh(Date.now()-90001)'),false);assert.equal(run('fresh(Date.now()+5001)'),false);assert.equal(run('fresh(null)'),false);assert.equal(run('fresh(Date.now())'),true);});
test('Technical missing detail cannot produce a signal',()=>{const run=scanner('nina-technical.mjs');run("state.tickers.set('SUIUSDT',{p:1,ch:1,q:1e8,priceAt:Date.now()})");assert.equal(run("score('SUIUSDT')"),null);});
