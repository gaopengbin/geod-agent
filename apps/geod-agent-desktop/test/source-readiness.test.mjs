import test from 'node:test';
import assert from 'node:assert/strict';
import ts from 'typescript';
import {readFileSync} from 'node:fs';

function load(api){
 const source=readFileSync(new URL('../src/source-configuration.ts',import.meta.url),'utf8');
 const compiled=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
 const exports={};new Function('require','exports',compiled)(name=>name==='./api'?{api}:{normalizeTileTemplate:v=>v},exports);return exports;
}
const draft={source:{id:'tdt',name:'Tianditu',urlTemplate:'https://example.test/{z}/{x}/{y}'},minZoom:0,maxZoom:18,authenticationMode:'queryToken',authenticationParameter:'tk'};
for(const [state,errorCode] of [['missing','SOURCE_CREDENTIAL_REQUIRED'],['unavailable','SOURCE_CREDENTIAL_UNAVAILABLE']])test(`saved ${state} credentials do not claim configured; recovery edits the stored source`,async()=>{
 const stored={endpoint:{...draft.source,authentication:{version:'pending',credentialRef:'native-reference'}},descriptor:{minZoom:0,maxZoom:18}};
 const api={sourcesSave:async()=>({id:'tdt',displayName:'Tianditu'}),sourcesReadiness:async()=>({ready:false,state,errorCode}),sourcesGet:async()=>stored};
 const result=await load(api).configureSource(draft);
 assert.equal(result.saved,true);assert.equal(result.configured,false);assert.equal(result.error,errorCode);assert.equal(result.credentialRequired,true);
 assert.equal(result.draft.editingExisting,true);assert.equal(result.draft.credentialOnly,true);assert.deepEqual(result.draft.source,stored.endpoint);
 assert(!JSON.stringify(result).includes('apiKey'));
});
test('a readable stored credential is configured without requesting another key',async()=>{
 let sourceReads=0;const result=await load({sourcesSave:async()=>({id:'tdt'}),sourcesReadiness:async()=>({ready:true,state:'ready'}),sourcesGet:async()=>{sourceReads++;}}).configureSource(draft);
 assert.equal(result.configured,true);assert.equal(result.credentialRequired,undefined);assert.equal(sourceReads,0);
});
test('planning preflight identifies a missing overlay credential without creating plans',async()=>{
 const inspected=[];const tools=load({sourcesReadiness:async id=>{inspected.push(id);return id==='overlay'?{ready:false,errorCode:'SOURCE_CREDENTIAL_REQUIRED'}:{ready:true}}});
 await assert.rejects(tools.sourceCredentialPreflight(['public','overlay','public']),e=>e.code==='SOURCE_CREDENTIAL_REQUIRED'&&e.sourceId==='overlay');
 assert.deepEqual(inspected,['public','overlay']);
});
