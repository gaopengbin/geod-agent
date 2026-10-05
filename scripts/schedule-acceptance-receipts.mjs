// Persist public ownership and cleanup progress before the next fallible step.
// A failed stage never prevents the remaining cleanup stages from running.
import {renameSync,writeFileSync} from 'node:fs';

export function writeReceipt(path,value){
  const temporary=path+'.tmp';
  writeFileSync(temporary,JSON.stringify(value,null,2));
  renameSync(temporary,path);
}

export async function cleanupStages(path,stages){
  const receipt={passed:false,startedAt:new Date().toISOString(),stages:[]};
  writeReceipt(path,receipt);
  for(const [name,run] of stages){
    const stage={name,passed:false,startedAt:new Date().toISOString()};
    receipt.stages.push(stage);writeReceipt(path,receipt);
    try{stage.result=await run();stage.passed=true;}
    catch(error){stage.failure=error instanceof Error?error.message:String(error?.code??error);}
    stage.finishedAt=new Date().toISOString();writeReceipt(path,receipt);
  }
  receipt.finishedAt=new Date().toISOString();
  receipt.passed=receipt.stages.every(stage=>stage.passed);
  writeReceipt(path,receipt);return receipt;
}

export function finishAcceptance(path,report,cleanup){
  report.runtimeChecksPassed=report.passed;
  report.cleanupPassed=cleanup.passed;
  report.passed=report.runtimeChecksPassed&&report.cleanupPassed;
  report.finishedAt=new Date().toISOString();
  if(!cleanup.passed)report.cleanupFailure='Scoped cleanup did not complete; inspect cleanup.json';
  writeReceipt(path,report);return report;
}
