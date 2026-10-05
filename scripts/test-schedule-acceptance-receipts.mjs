import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {cleanupStages,finishAcceptance} from './schedule-acceptance-receipts.mjs';

test('a disconnected original window does not prevent remaining credential and process cleanup',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'geod-cleanup-'));
  try{
    const path=join(directory,'cleanup.json'),released=[];
    const result=await cleanupStages(path,[
      ['original-window',async()=>{throw Error('Original window disconnected');}],
      ['credential',async()=>{released.push('credential');return {removed:true};}],
      ['process',async()=>{released.push('process');return {exited:true};}],
    ]);
    assert.deepEqual(released,['credential','process']);
    assert.equal(result.passed,false);
    assert.deepEqual(JSON.parse(readFileSync(path,'utf8')).stages.map(stage=>stage.passed),[false,true,true]);
  }finally{rmSync(directory,{recursive:true,force:true});}
});

test('a runtime success followed by cleanup failure stays a failed overall acceptance',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'geod-final-acceptance-'));
  try{
    const cleanup=await cleanupStages(join(directory,'cleanup.json'),[
      ['credential',async()=>{throw Error('Credential remains');}],
      ['process',async()=>({exited:true})],
    ]);
    const path=join(directory,'result.json'),cases=[{name:'actual-runtime',passed:true}];
    finishAcceptance(path,{passed:true,cases},cleanup);
    const observed=JSON.parse(readFileSync(path,'utf8'));
    assert.equal(observed.passed,false);assert.equal(observed.runtimeChecksPassed,true);
    assert.equal(observed.cleanupPassed,false);assert.deepEqual(observed.cases,cases);
    assert(observed.finishedAt);assert(observed.cleanupFailure);
  }finally{rmSync(directory,{recursive:true,force:true});}
});

test('a pending stage has a recoverable receipt and cannot be reported as completed',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'geod-cleanup-'));
  try{
    const path=join(directory,'cleanup.json');let finish;
    const running=cleanupStages(path,[['pending',()=>new Promise(resolve=>{finish=resolve;})]]);
    const observed=JSON.parse(readFileSync(path,'utf8'));
    assert.equal(observed.passed,false);assert.equal(observed.stages[0].passed,false);
    assert.equal(observed.stages[0].finishedAt,undefined);
    finish({released:true});assert.equal((await running).passed,true);
    const completed=JSON.parse(readFileSync(path,'utf8'));
    assert.equal(completed.passed,true);assert.deepEqual(completed.stages[0].result,{released:true});
  }finally{rmSync(directory,{recursive:true,force:true});}
});
