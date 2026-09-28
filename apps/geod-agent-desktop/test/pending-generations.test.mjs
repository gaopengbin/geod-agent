import assert from "node:assert/strict";
import test from "node:test";
import { accountChatStore, CHAT_LIST_KEY, clearPending, commitPending, importLegacyChats, legacyChats, PENDING_KEY, pendingBoundary, persistCompletedChat, readPending, restorePendingChats, savePending } from "../src/pending-generations.ts";

function store() {
  const values = new Map();
  return {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  };
}

test("generation ID and exact context survive an interrupted response", () => {
  const storage = store();
  const request = { conversationId: "chat-1", generationId: "generation-1", userId: "geod-user-1", messages: [{ role: "user", content: "下载已授权影像" }] };
  savePending(storage, request);
  const recovered = restorePendingChats(storage, [{ conversationId: "chat-1", messages: [], display: [], pendingId: "stale" }]);
  assert.equal(recovered[0].pendingId, request.generationId);
  assert.deepEqual(recovered[0].messages, request.messages);
  assert.deepEqual(readPending(storage)?.["chat-1"], request);

  savePending(storage, { ...request, conversationId: "chat-2", generationId: "generation-2" });
  clearPending(storage, "chat-1");
  assert.equal(readPending(storage)?.["chat-1"], undefined);
  assert.equal(readPending(storage)?.["chat-2"].generationId, "generation-2");
  assert.equal(restorePendingChats(storage, recovered).find(chat => chat.conversationId === "chat-1")?.pendingId, undefined);
});

test("legacy pending conversations migrate without claiming an account", () => {
  const storage = store();
  const recovered = restorePendingChats(storage, [{ conversationId: "legacy", messages: [{ role: "user", content: "旧请求" }], display: [], pendingId: "legacy-generation" }]);
  assert.equal(recovered[0].pendingId, "legacy-generation");
  assert.equal(readPending(storage)?.legacy.userId, null);
  assert.ok(storage.getItem(PENDING_KEY));
});

test("unlisted pending conversation is restored ahead of a full recent list", () => {
  const storage = store();
  savePending(storage, { conversationId: "recover-me", generationId: "generation-31", userId: "geod-user", messages: [{ role: "user", content: "保存中的请求" }], display: [{ id: "visible-1", role: "user", content: "保存中的请求" }] });
  const chats = Array.from({ length: 30 }, (_, index) => ({ conversationId: `chat-${index}`, messages: [], display: [] }));
  const recovered = restorePendingChats(storage, chats);
  assert.equal(recovered.length, 30);
  assert.equal(recovered[0].conversationId, "recover-me");
  assert.equal(recovered[0].display[0].content, "保存中的请求");
});

test("settled answer survives a crash between committing and clearing recovery", () => {
  const storage = store();
  const original = { conversationId: "chat-1", generationId: "generation-1", userId: "geod-user", messages: [{ role: "user", content: "影像需求" }] };
  const completed = { messages: [...original.messages, { role: "assistant", content: "计划已准备好" }], display: [{ id: "user-1", role: "user", content: "影像需求" }, { id: "answer-1", role: "assistant", content: "计划已准备好" }], planId: "plan-1" };
  savePending(storage, original);
  commitPending(storage, "chat-1", "generation-1", completed);
  assert.throws(() => commitPending(storage, "chat-1", "different-id", completed), /不一致/);
  const recovered = restorePendingChats(storage, [{ conversationId: "chat-1", messages: original.messages, display: [], pendingId: "generation-1" }]);
  assert.equal(recovered[0].pendingId, undefined);
  assert.deepEqual(recovered[0].messages, completed.messages);
  assert.deepEqual(recovered[0].display, completed.display);
  assert.equal(recovered[0].planId, "plan-1");
  assert.equal(readPending(storage)?.["chat-1"], undefined);
  assert.deepEqual(JSON.parse(storage.getItem(CHAT_LIST_KEY))[0].messages, completed.messages);

  persistCompletedChat(storage, { ...recovered[0], pendingId: undefined });
  assert.equal(JSON.parse(storage.getItem(CHAT_LIST_KEY)).length, 1);
});

test("a request is not sent when its recovery record cannot be saved", () => {
  const storage = { getItem: () => null, setItem: () => { throw new Error("disk unavailable"); } };
  assert.throws(() => savePending(storage, { conversationId: "chat", generationId: "generation", userId: "geod-user", messages: [] }), /disk unavailable/);
});

test("an attached GeoJSON boundary survives pending recovery and cannot silently become a rectangle", () => {
  const storage = store();
  const boundary = { name: "study.geojson", bounds: [-77.05, 38.85, -77.04, 38.86], polygonCount: 1, geometry: { polygons: [[[[-77.05, 38.85], [-77.04, 38.85], [-77.04, 38.86], [-77.05, 38.85]]]] } };
  const request = { conversationId: "boundary-chat", generationId: "boundary-generation", userId: "geod-user", messages: [{ role: "user", content: "本机已附加 GeoJSON 多边形" }], boundary, boundaryRequired: true };
  savePending(storage, request);
  assert.deepEqual(pendingBoundary(readPending(storage)["boundary-chat"]), boundary);
  restorePendingChats(storage, [{ conversationId: "boundary-chat", messages: [], display: [] }]);
  assert.deepEqual(pendingBoundary(readPending(storage)["boundary-chat"]), boundary);

  storage.setItem(PENDING_KEY, JSON.stringify({ "boundary-chat": { ...request, boundary: null } }));
  assert.throws(() => pendingBoundary(readPending(storage)["boundary-chat"]), /不能按外接矩形继续规划/);
  storage.setItem(PENDING_KEY, JSON.stringify({ "boundary-chat": { conversationId: request.conversationId, generationId: request.generationId, userId: request.userId, messages: request.messages } }));
  assert.throws(() => pendingBoundary(readPending(storage)["boundary-chat"]), /不能按外接矩形继续规划/);
});

test("conversation history and interrupted requests stay within one GeoD account", () => {
  const storage = store();
  const first = accountChatStore(storage, "user-first");
  const second = accountChatStore(storage, "user-second");
  persistCompletedChat(first, { conversationId: "first-chat", messages: [], display: [] });
  savePending(first, { conversationId: "first-chat", generationId: "first-generation", userId: "user-first", messages: [{ role: "user", content: "private context" }] });
  assert.equal(second.getItem(CHAT_LIST_KEY), null);
  assert.equal(readPending(second), null);
  persistCompletedChat(second, { conversationId: "second-chat", messages: [], display: [] });
  assert.equal(JSON.parse(first.getItem(CHAT_LIST_KEY))[0].conversationId, "first-chat");
  assert.equal(readPending(first)?.["first-chat"].generationId, "first-generation");
  assert.equal(JSON.parse(second.getItem(CHAT_LIST_KEY))[0].conversationId, "second-chat");
});

test("unowned legacy conversations require explicit import and do not resume pending generations", () => {
  const storage = store();
  const old = { conversationId: "old-chat", messages: [{ role: "user", content: "legacy context" }], display: [], pendingId: "unowned-request" };
  storage.setItem(CHAT_LIST_KEY, JSON.stringify([old]));
  savePending(storage, { conversationId: "old-chat", generationId: "unowned-request", userId: "user-unknown", messages: old.messages });
  const current = accountChatStore(storage, "user-current");
  assert.equal(current.getItem(CHAT_LIST_KEY), null);
  assert.equal(legacyChats(storage).length, 1);
  const imported = importLegacyChats(storage, "user-current");
  assert.equal(imported[0].conversationId, "old-chat");
  assert.equal(imported[0].pendingId, undefined);
  assert.equal(readPending(current), null);
  assert.equal(JSON.parse(storage.getItem(CHAT_LIST_KEY))[0].pendingId, "unowned-request");
});
