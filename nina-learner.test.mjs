import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
const source=readFileSync(new URL('nina-learner.mjs',import.meta.url),'utf8').replace(/^import .*;$/mg,'').split('const server=')[0];
test('Outcomes spanning a data gap persist without changing challenger weights',async()=>{
 const c=vm.createContext({Date,Math,Map,Set,Number,process:{env:{}},randomUUID:()=> 'test',console:{log(){}}});vm.runInContext(source,c);
 vm.runInContext("store={recordClose:async()=>true};var s={symbol:'SUIUSDT',side:'LONG',entry:1,opened:Date.now()-3600000,dataGap:true,features:{m1:1,m5:1,flow:1,depth:1,funding:0}};shadow.set('SUIUSDT:LONG',s)",c);
 const before=vm.runInContext('JSON.stringify(weights)',c);await vm.runInContext("finish('SUIUSDT:LONG',s,'HORIZON_60M',1.2)",c);
 assert.equal(vm.runInContext('JSON.stringify(weights)',c),before);assert.equal(vm.runInContext('closed[0].dataGap',c),true);assert.equal(vm.runInContext('shadow.size',c),0);
});
