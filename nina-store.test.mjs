import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createStore} from './nina-store.mjs';

test('open and close persist idempotently with challenger weights in one transaction',async()=>{
  const calls=[];let status='OPEN';
  const client={query:async(sql,args)=>{calls.push(sql.trim().split(/\s+/).slice(0,3).join(' '));if(sql.startsWith('UPDATE')){if(status==='CLOSED')return {rowCount:0};status='CLOSED';return {rowCount:1}}return {rowCount:1}},release(){calls.push('release')}};
  const pool={query:async(sql)=>{calls.push(sql.trim().split(/\s+/).slice(0,3).join(' '));return {rowCount:1,rows:[]}},connect:async()=>client};
  const store=createStore(pool);await store.migrate();
  const sig={id:'SOLUSDT:LONG:1',symbol:'SOLUSDT',side:'LONG',opened:1};
  assert.equal(await store.recordOpen(sig),true);
  assert.equal(await store.recordClose({...sig,closed:2},{flow:1.02}),true);
  assert.equal(await store.recordClose({...sig,closed:3},{flow:1.04}),false);
  assert.equal(calls.filter(x=>x==='COMMIT').length,1);
  assert.equal(calls.filter(x=>x==='ROLLBACK').length,1);
});
