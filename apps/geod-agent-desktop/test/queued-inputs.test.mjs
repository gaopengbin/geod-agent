import test from 'node:test';
import assert from 'node:assert/strict';
import {promoteQueuedInput,inactiveInterrupt,queuedRequestId,queueLocked,readyQueuedInput,editQueuedInput,receiptQueuedInputs,restoreQueuedInputs} from '../src/queued-inputs.ts';
test('send now keeps selected attachments and other pending messages in their original order',()=>{
  const items=[{id:'one',text:'first'},{id:'two',text:'second',images:[{id:'image'}],documents:[{id:'doc'}]},{id:'three',text:'third'}];
  const next=promoteQueuedInput(items,'two');
  assert.deepEqual(next.map(item=>item.id),['two','one','three']);assert.strictEqual(next[0],items[1]);assert.equal(items[0].id,'one');
  assert.strictEqual(promoteQueuedInput(items,'unknown'),items);
});

test('editing keeps row and attachments, invalidates old ack, and never touches a sending row',()=>{
  const item={id:'one',text:'old',images:[{id:'i'}],documents:[{id:'d'}],createdAt:'now'};
  const edited=editQueuedInput(item,' new ');assert.equal(edited.id,item.id);assert.equal(edited.text,'new');assert.strictEqual(edited.images,item.images);assert.equal(queuedRequestId(edited),'one:1');
  const sending={...edited,delivery:{state:'sending',clientRequestId:queuedRequestId(edited),runId:'r'}};
  assert.strictEqual(editQueuedInput(sending,'changed'),sending);assert.equal(queueLocked(sending),true);
  assert.strictEqual(receiptQueuedInputs([sending],{state:'accepted',runId:'r',clientRequestId:'one:0'}).items[0],sending);
  assert.equal(receiptQueuedInputs([sending],{state:'accepted',runId:'other',clientRequestId:'one:1'}).items.length,1);
  const accepted=receiptQueuedInputs([sending],{state:'accepted',runId:'r',clientRequestId:'one:1'});assert.equal(accepted.items.length,0);assert.strictEqual(accepted.accepted,sending);
});
test('uncertain delivery remains locked through reload and explicit lookup; failed or unsubmitted is editable',()=>{
  const item={id:'one',text:'test',createdAt:'now',delivery:{state:'sending',clientRequestId:'one:0',runId:'r'}};
  const restored=restoreQueuedInputs([item]);assert.equal(restored[0].delivery.state,'outcome-unknown');assert.equal(queueLocked(restored[0]),true);assert.equal(readyQueuedInput(restored),undefined);
  const failed=receiptQueuedInputs(restored,{state:'failed',clientRequestId:'one:0',runId:'r',result:{message:'rejected'}}).items;
  assert.equal(queueLocked(failed[0]),false);assert.equal(failed[0].delivery.message,'rejected');assert.equal(readyQueuedInput(failed),undefined);
  const unsent=receiptQueuedInputs(restored,{state:'not-submitted',clientRequestId:'one:0'}).items;assert.equal(readyQueuedInput(unsent).id,'one');
  assert.equal(readyQueuedInput([{id:'editing',editDraft:''},...unsent]).id,'one');
});
test('only an already-ended interrupt is a harmless stop, never arbitrary model/network errors',()=>{
  for(const cause of [new Error('no active turn to interrupt'),{code:'CODEX_RUN_NOT_FOUND'}])assert.equal(inactiveInterrupt(cause),true);
  for(const cause of [new Error('stream disconnected'),{message:'no active turn to steer'},{code:'MODEL_OUTPUT_LIMIT'}])assert.equal(inactiveInterrupt(cause),false);
});
