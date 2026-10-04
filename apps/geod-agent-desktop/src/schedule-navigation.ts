export const SCHEDULE_FOCUS = "geod:schedule-focus";
const requests = new Set<string>();
export const pendingScheduleFocus = (conversationId: string) => requests.has(conversationId);
export function requestScheduleFocus(conversationId: string) {
  requests.add(conversationId);
  window.dispatchEvent(new CustomEvent(SCHEDULE_FOCUS, { detail: { conversationId } }));
}
export function consumeScheduleFocus(conversationId: string) {
  return requests.delete(conversationId);
}
