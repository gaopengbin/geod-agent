import type { BoundaryImport } from "./api";

type SelectionHandler = (boundary: BoundaryImport) => Promise<void>;
const receivers = new Map<string, SelectionHandler>();

/** Map and chat share a saved native boundary without putting geometry in events. */
export function receiveBoundarySelection(conversationId: string, handler: SelectionHandler) {
  receivers.set(conversationId, handler);
  return () => { if (receivers.get(conversationId) === handler) receivers.delete(conversationId); };
}

export async function selectBoundaryForConversation(conversationId: string, boundary: BoundaryImport) {
  const receiver = receivers.get(conversationId);
  if (!receiver) throw new Error("当前对话尚未就绪，请稍后再使用此范围。");
  await receiver(boundary);
}
