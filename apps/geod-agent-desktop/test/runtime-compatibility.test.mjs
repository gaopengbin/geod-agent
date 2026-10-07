import test from 'node:test';
import assert from 'node:assert/strict';
import {ensureExportRuntime} from '../src/runtime-compatibility.ts';
import {runtimeCompatibilityFailure} from '../src/app-error.ts';

test('old native command and targetCrs schema fail once without falling back to a different CRS',async()=>{
  for(const rejection of ['Command desktop_runtime_capabilities not found','Command gis_install_prepare not found','Command gis_install_cancel not found',"invalid args `spec` for command `plans_create`: unknown field `targetCrs`, expected one of `cacheOnly`, `compression`",{error:{message:"invalid args `spec`: unknown field `resampling`"}}]){
    let calls=0;
    await assert.rejects(ensureExportRuntime(async()=>{calls++;throw rejection;}),{code:'NATIVE_RUNTIME_UPDATE_REQUIRED'});
    assert.equal(calls,1);
  }
});
test('actual native fields are required; unrelated local failures remain precise',async()=>{
  const native={version:'0.2.4',exportCrs:true,conversationOutputCrs:true,exportOptions:['targetCrs','resampling']};
  await ensureExportRuntime(async()=>native);
  for(const change of [{exportCrs:false},{conversationOutputCrs:false},{exportOptions:['targetCrs']}]) await assert.rejects(ensureExportRuntime(async()=>({...native,...change})),{code:'NATIVE_RUNTIME_UPDATE_REQUIRED'});
  const auth={code:'AUTH_REQUIRED',message:'请登录'};
  await assert.rejects(ensureExportRuntime(async()=>{throw auth;}),e=>e===auth);
  assert.equal(runtimeCompatibilityFailure("unknown field `token`"),false);
});
