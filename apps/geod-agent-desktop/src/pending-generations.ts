import type { AgentMessage } from "./api";

export interface DisplayMessage { id: string; role: "user" | "assistant" | "tool"; content: string }
export interface SavedChat { conversationId: string; messages: AgentMessage[]; display: DisplayMessage[]; pendingId?: string; planId?: string }
export interface CompletedGeneration { messages: AgentMessage[]; display: DisplayMessage[]; planId?: string }
export interface PendingGeneration { conversationId: string; generationId: string; userId: string | null; messages: AgentMessage[]; display?: DisplayMessage[]; committed?: CompletedGeneration }

export const PENDING_KEY = "geod-agent-pending-generations-0.1";
export const CHAT_LIST_KEY = "geod-agent-conversations-0.1";
export const LEGACY_CHAT_KEY = "geod-agent-chat-0.1";
export const LEGACY_IMPORT_MARKER = "geod-agent-legacy-chat-imported-0.1";
type PendingMap = Record<string, PendingGeneration>;
type Store = Pick<Storage, "getItem" | "setItem">;

export function accountChatStore(store: Store, userId: string): Store {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(userId)) throw new Error("GeoD 账号标识无效，无法读取本机对话。");
  const suffix = `:account:${userId}`;
  return {
    getItem: key => store.getItem(`${key}${suffix}`),
    setItem: (key, value) => store.setItem(`${key}${suffix}`, value),
  };
}

function validChat(value: unknown): value is SavedChat {
  if (!value || typeof value !== "object") return false;
  const chat = value as Partial<SavedChat>;
  return typeof chat.conversationId === "string" && Array.isArray(chat.messages) && Array.isArray(chat.display);
}

function chatList(store: Store, key: string): SavedChat[] {
  try {
    const value: unknown = JSON.parse(store.getItem(key) ?? "null");
    return Array.isArray(value) ? value.filter(validChat).slice(0, 30) : validChat(value) ? [value] : [];
  } catch { return []; }
}

export function legacyChats(store: Store): SavedChat[] {
  const listed = chatList(store, CHAT_LIST_KEY);
  if (listed.length) return listed;
  return chatList(store, LEGACY_CHAT_KEY);
}

export function importLegacyChats(store: Store, userId: string): SavedChat[] {
  const scoped = accountChatStore(store, userId);
  const current = chatList(scoped, CHAT_LIST_KEY);
  // Old records had no account owner. Only an explicit UI action may copy them;
  // pending requests are not migrated because their owner cannot be proven.
  const imported = legacyChats(store).map(({ pendingId: _pendingId, ...chat }) => chat);
  const merged = [...current, ...imported.filter(chat => !current.some(item => item.conversationId === chat.conversationId))].slice(0, 30);
  scoped.setItem(CHAT_LIST_KEY, JSON.stringify(merged));
  scoped.setItem(LEGACY_IMPORT_MARKER, "1");
  return merged;
}

function validPending(value: unknown): value is PendingGeneration {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<PendingGeneration>;
  return typeof item.conversationId === "string" && typeof item.generationId === "string"
    && (item.userId === null || typeof item.userId === "string") && Array.isArray(item.messages)
    && (item.display === undefined || Array.isArray(item.display))
    && (item.committed === undefined || (item.committed !== null && typeof item.committed === "object" && Array.isArray(item.committed.messages) && Array.isArray(item.committed.display)));
}

export function readPending(store: Store): PendingMap | null {
  let raw: string | null;
  try { raw = store.getItem(PENDING_KEY); }
  catch { return {}; }
  if (raw === null) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    return Object.fromEntries(Object.entries(value).filter(([id, item]) => validPending(item) && item.conversationId === id));
  } catch { return {}; }
}

export function savePending(store: Store, pending: PendingGeneration): void {
  const current = readPending(store) ?? {};
  store.setItem(PENDING_KEY, JSON.stringify({ ...current, [pending.conversationId]: pending }));
}

export function clearPending(store: Store, conversationId: string): void {
  const current = readPending(store) ?? {};
  delete current[conversationId];
  store.setItem(PENDING_KEY, JSON.stringify(current));
}

export function commitPending(store: Store, conversationId: string, generationId: string, completed: CompletedGeneration): void {
  const current = readPending(store) ?? {};
  const pending = current[conversationId];
  if (!pending || pending.generationId !== generationId) throw new Error("模型请求编号与本机记录不一致，未清除恢复记录。");
  store.setItem(PENDING_KEY, JSON.stringify({ ...current, [conversationId]: { ...pending, committed: completed } }));
}

export function persistCompletedChat(store: Store, chat: SavedChat): SavedChat[] {
  let existing: SavedChat[] = [];
  try {
    const value: unknown = JSON.parse(store.getItem(CHAT_LIST_KEY) ?? "[]");
    if (Array.isArray(value)) existing = value.filter(item => item && typeof item.conversationId === "string");
  } catch { /* A damaged chat index cannot discard the completed answer. */ }
  const updated = [chat, ...existing.filter(item => item.conversationId !== chat.conversationId)].slice(0, 30);
  store.setItem(CHAT_LIST_KEY, JSON.stringify(updated));
  return updated;
}

export function restorePendingChats(store: Store, chats: SavedChat[]): SavedChat[] {
  let pending = readPending(store);
  if (pending === null) {
    pending = Object.fromEntries(chats.filter(chat => chat.pendingId).map(chat => [chat.conversationId, {
      conversationId: chat.conversationId, generationId: chat.pendingId!, userId: null, messages: chat.messages,
    }]));
    try { store.setItem(PENDING_KEY, JSON.stringify(pending)); }
    catch { /* Sending a new model request will fail if this storage remains unwritable. */ }
  }
  const restored = chats.map(chat => ({
    ...chat,
    pendingId: pending[chat.conversationId]?.committed ? undefined : pending[chat.conversationId]?.generationId,
    messages: pending[chat.conversationId]?.committed?.messages ?? pending[chat.conversationId]?.messages ?? chat.messages,
    display: pending[chat.conversationId]?.committed?.display ?? ((pending[chat.conversationId]?.display?.length ?? 0) > chat.display.length ? pending[chat.conversationId].display! : chat.display),
    planId: pending[chat.conversationId]?.committed?.planId ?? chat.planId,
  }));
  const missing = Object.values(pending)
    .filter(item => !restored.some(chat => chat.conversationId === item.conversationId))
    .map(item => ({ conversationId: item.conversationId, messages: item.committed?.messages ?? item.messages, display: item.committed?.display ?? item.display ?? [], pendingId: item.committed ? undefined : item.generationId, planId: item.committed?.planId }));
  const result = [...missing, ...restored].slice(0, 30);
  if (Object.values(pending).some(item => item.committed)) {
    try {
      store.setItem(CHAT_LIST_KEY, JSON.stringify(result));
      for (const [id, item] of Object.entries(pending)) if (item.committed) delete pending[id];
      store.setItem(PENDING_KEY, JSON.stringify(pending));
    } catch { /* Committed snapshot remains available for the next restart. */ }
  }
  return result;
}
