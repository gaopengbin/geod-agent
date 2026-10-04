import test from 'node:test';
import assert from 'node:assert/strict';
import{codexApprovalPolicy}from'../src-tauri/codex-host.mjs';
import{elicitationBrowserUrl}from'../src/codex-elicitation.ts';
test('full access preserves explicit connector interaction and background has no prompts',()=>{
  assert.equal(codexApprovalPolicy('fullAccess').granular.mcp_elicitations,true);
  assert.equal(codexApprovalPolicy('fullAccess').granular.sandbox_approval,false);
  assert.equal(codexApprovalPolicy('fullAccess',true),'never');
  assert.equal(codexApprovalPolicy('confirmEach'),'on-request');
});
test('browser cards show safe web flows and disable executable or embedded-credential URLs',()=>{
  for(const value of ['https://provider.example/authorize#return','http://localhost:43120/login','http://127.0.0.1:43120/login','http://[::1]:43120/login'])assert(elicitationBrowserUrl(value));
  for(const value of ['javascript:alert(1)','file:///C:/private.txt','http://provider.example/login','https://user:secret@provider.example/','https://user@provider.example/',null,''])assert.equal(elicitationBrowserUrl(value),null);
});
