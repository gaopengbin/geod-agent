import type { QueuedInput, FollowupReceipt } from './pending-generations';

export const queuedRequestId=(item:QueuedInput)=>`${item.id}:${item.revision??0}`;
export const queueLocked=(item:QueuedInput)=>item.delivery?.state==='sending'||item.delivery?.state==='outcome-unknown';
export const readyQueuedInput=(items:QueuedInput[])=>items.find(item=>!item.delivery&&item.editDraft===undefined);
export const restoreQueuedInputs=(items:QueuedInput[])=>items.map(item=>item.delivery?.state==='sending'?{...item,delivery:{...item.delivery,state:'outcome-unknown' as const}}:item);
export function editQueuedInput(item:QueuedInput,text:string):QueuedInput {
  if(queueLocked(item)||!text.trim())return item;
  return {...item,text:text.trim(),revision:(item.revision??0)+1,delivery:undefined,editDraft:undefined};
}
export function receiptQueuedInputs(items:QueuedInput[],receipt:FollowupReceipt):{items:QueuedInput[];accepted?:QueuedInput}{
  const item=items.find(item=>item.delivery?.clientRequestId===receipt.clientRequestId&&(!receipt.runId||item.delivery.runId===receipt.runId));
  if(!item)return {items};
  if(receipt.state==='accepted')return {items:items.filter(row=>row.id!==item.id),accepted:item};
  const state=receipt.state;
  return {items:items.map(row=>row.id!==item.id?row:{...row,delivery:state==='not-submitted'?undefined:{...row.delivery!,state,message:receipt.result?.message}})};
}

// Promote the selected message without losing other queued messages or attachments.
export function promoteQueuedInput(items: QueuedInput[], id: string): QueuedInput[] {
  const selected = items.find(item => item.id === id);
  return selected ? [selected, ...items.filter(item => item.id !== id)] : items;
}

export function inactiveInterrupt(cause: unknown): boolean {
  const value = cause as { code?: string; message?: string } | null;
  return value?.code === 'CODEX_RUN_NOT_FOUND' || /^no active turn to interrupt[.!]?$/i.test(value?.message ?? String(cause));
}
