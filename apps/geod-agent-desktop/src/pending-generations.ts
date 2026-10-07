import type { AgentMessage, BoundaryImport, SourceRegistrationDraft, ImageAttachment, DocumentAttachment } from "./api";
import type {UserInputRecord} from './user-input-records';
import type {TurnOutcome} from './turn-outcome';

export interface ExtensionProposal { kind: "mcp" | "skill"; id: string; name: string; description: string; detail: string; toolNames?: string[]; sha256?: string; requiresKey?:boolean }
export interface BackgroundJob { jobId: string; planId: string; sourceName: string; totalTiles: number; zoomLevels: number[]; outputFormats: string[] }

export interface DisplayMessage {
  id: string;
  role: "user" | "assistant" | "tool";
  content: string;
  images?:ImageAttachment[];
  documents?:DocumentAttachment[];
  phase?: "progress" | "final";
  streaming?: boolean;
  turnId?: string;
  itemType?: string;
  details?: string;
  toolName?: string;
  toolStatus?: "running" | "success" | "attention";
  sourceDraft?: SourceRegistrationDraft;
  extensionProposal?: ExtensionProposal;
  backgroundJob?: BackgroundJob;
  monitorTrace?: DisplayMessage[];
  userInput?:UserInputRecord;
  turnOutcome?:TurnOutcome;
}
export interface QueuedInput{id:string;text:string;images?:ImageAttachment[];documents?:DocumentAttachment[];createdAt:string}
export interface SavedChat { conversationId: string; messages: AgentMessage[]; display: DisplayMessage[]; pendingId?: string; planId?: string; planIds?: string[]; workspaceDirectory?: string; updatedAt?: string; lastInputTokens?: number; contextCompressed?: boolean; engine?: "codex" | "legacy"; title?:string;forkFromConversationId?:string;queuedInputs?:QueuedInput[];queuePaused?:boolean; archived?:boolean;pinned?:boolean; codexContext?: { inputTokens: number; outputTokens: number; cachedInputTokens: number; modelContextWindow: number | null } }
export interface CompletedGeneration { messages: AgentMessage[]; display: DisplayMessage[]; planId?: string; planIds?: string[]; lastInputTokens?: number; contextCompressed?: boolean; engine?: SavedChat["engine"]; codexContext?: SavedChat["codexContext"] }
export interface PendingGeneration { conversationId: string; generationId: string; userId: string | null; messages: AgentMessage[]; display?: DisplayMessage[]; boundary?: BoundaryImport | null; boundaryRequired?: boolean; committed?: CompletedGeneration; engine?: "codex" | "legacy" }

export const PENDING_KEY = "geod-agent-pending-generations-0.1";
export const CHAT_LIST_KEY = "geod-agent-conversations-0.1";
export const LEGACY_CHAT_KEY = "geod-agent-chat-0.1";
export const LEGACY_IMPORT_MARKER = "geod-agent-legacy-chat-imported-0.1";
export const DELETED_CHAT_KEY = "geod-agent-deleted-conversations-1";
export function chatPlanIds(chat: Pick<SavedChat, "planId" | "planIds">): string[] {
  return [...new Set([...(chat.planIds ?? []), ...(chat.planId ? [chat.planId] : [])].filter(id => typeof id === "string" && id.length > 0))];
}
type PendingMap = Record<string, PendingGeneration>;
type Store = Pick<Storage, "getItem" | "setItem">;

export function deletedConversationIds(store: Store): Set<string> {
  try { const value = JSON.parse(store.getItem(DELETED_CHAT_KEY) ?? "[]"); return new Set(Array.isArray(value) ? value.filter(id=>typeof id === "string") : []); }
  catch { return new Set(); }
}
export function deleteStoredConversation(store: Store, conversationId: string): SavedChat[] {
  const deleted=deletedConversationIds(store);deleted.add(conversationId);
  // Persist the tombstone first, so a late model callback cannot resurrect the row.
  store.setItem(DELETED_CHAT_KEY,JSON.stringify([...deleted]));
  clearPending(store,conversationId);
  const chats=chatList(store,CHAT_LIST_KEY).filter(chat=>!deleted.has(chat.conversationId));
  store.setItem(CHAT_LIST_KEY,JSON.stringify(chats));return chats;
}

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
    return Array.isArray(value) ? value.filter(validChat) : validChat(value) ? [value] : [];
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
  const merged = [...current, ...imported.filter(chat => !current.some(item => item.conversationId === chat.conversationId))];
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

function validBoundary(value: unknown): value is BoundaryImport {
  if (!value || typeof value !== "object") return false;
  const boundary = value as Partial<BoundaryImport>;
  return typeof boundary.name === "string" && boundary.name.length > 0
    && Array.isArray(boundary.bounds) && boundary.bounds.length === 4
    && boundary.bounds.every(value => typeof value === "number" && Number.isFinite(value))
    && typeof boundary.polygonCount === "number" && Number.isInteger(boundary.polygonCount) && boundary.polygonCount > 0
    && !!boundary.geometry && Array.isArray(boundary.geometry.polygons) && boundary.geometry.polygons.length > 0;
}

export function pendingBoundary(pending: PendingGeneration): BoundaryImport | null {
  if (validBoundary(pending.boundary)) return pending.boundary;
  const lastUserMessage = [...pending.messages].reverse().find(message => message.role === "user");
  if (pending.boundaryRequired || lastUserMessage?.content?.includes("本机已附加 GeoJSON 多边形")) {
    throw new Error("本机 GeoJSON 边界恢复记录缺失或损坏。请新建对话、重新附加边界后发送，不能按外接矩形继续规划。");
  }
  return null;
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
  const deleted = deletedConversationIds(store);
  let existing: SavedChat[] = [];
  try {
    const value: unknown = JSON.parse(store.getItem(CHAT_LIST_KEY) ?? "[]");
    if (Array.isArray(value)) existing = value.filter(item => validChat(item) && !deleted.has(item.conversationId));
  } catch { /* A damaged chat index cannot discard the completed answer. */ }
  if (deleted.has(chat.conversationId)) return existing;
  const previous=existing.find(item=>item.conversationId===chat.conversationId);
  const updated = [{...previous,...chat,queuedInputs:chat.queuedInputs??previous?.queuedInputs,queuePaused:chat.queuePaused??previous?.queuePaused,title:chat.title??previous?.title,forkFromConversationId:chat.forkFromConversationId??previous?.forkFromConversationId}, ...existing.filter(item => item.conversationId !== chat.conversationId)];
  store.setItem(CHAT_LIST_KEY, JSON.stringify(updated));
  return updated;
}

export function restorePendingChats(store: Store, chats: SavedChat[]): SavedChat[] {
  const deleted = deletedConversationIds(store);
  chats = chats.filter(chat => !deleted.has(chat.conversationId));
  let pending = readPending(store);
  if (pending === null) {
    pending = Object.fromEntries(chats.filter(chat => chat.pendingId).map(chat => [chat.conversationId, {
      conversationId: chat.conversationId, generationId: chat.pendingId!, userId: null, messages: chat.messages,
    }]));
    try { store.setItem(PENDING_KEY, JSON.stringify(pending)); }
    catch { /* Sending a new model request will fail if this storage remains unwritable. */ }
  }
  pending = Object.fromEntries(Object.entries(pending).filter(([id])=>!deleted.has(id)));
  const restored = chats.map(chat => ({
    ...chat,
    pendingId: pending[chat.conversationId]?.committed ? undefined : pending[chat.conversationId]?.generationId,
    messages: pending[chat.conversationId]?.committed?.messages ?? pending[chat.conversationId]?.messages ?? chat.messages,
    display: pending[chat.conversationId]?.committed?.display ?? ((pending[chat.conversationId]?.display?.length ?? 0) > chat.display.length ? pending[chat.conversationId].display! : chat.display),
    planId: pending[chat.conversationId]?.committed?.planId ?? chat.planId,
    planIds: pending[chat.conversationId]?.committed?.planIds ?? chatPlanIds(chat),
    lastInputTokens: pending[chat.conversationId]?.committed?.lastInputTokens ?? chat.lastInputTokens,
    contextCompressed: pending[chat.conversationId]?.committed?.contextCompressed ?? chat.contextCompressed,
    engine: pending[chat.conversationId]?.committed?.engine ?? pending[chat.conversationId]?.engine ?? chat.engine,
    codexContext: pending[chat.conversationId]?.committed?.codexContext ?? chat.codexContext,
  }));
  const missing = Object.values(pending)
    .filter(item => !restored.some(chat => chat.conversationId === item.conversationId))
    .map(item => ({ conversationId: item.conversationId, messages: item.committed?.messages ?? item.messages, display: item.committed?.display ?? item.display ?? [], pendingId: item.committed ? undefined : item.generationId, planId: item.committed?.planId, planIds: item.committed?.planIds ?? (item.committed?.planId ? [item.committed.planId] : []), engine: item.committed?.engine ?? item.engine, codexContext: item.committed?.codexContext }));
  const result = [...missing, ...restored];
  if (Object.values(pending).some(item => item.committed)) {
    try {
      store.setItem(CHAT_LIST_KEY, JSON.stringify(result));
      for (const [id, item] of Object.entries(pending)) if (item.committed) delete pending[id];
      store.setItem(PENDING_KEY, JSON.stringify(pending));
    } catch { /* Committed snapshot remains available for the next restart. */ }
  }
  return result;
}
