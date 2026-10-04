import type { SavedChat, DisplayMessage } from "./pending-generations";

export function conversationTitle(chat: Pick<SavedChat, "title" | "display">): string {
  return chat.title || chat.display.find(message => message.role === "user")?.content.slice(0, 34) || "新对话";
}
export function orderedConversations(chats: SavedChat[]): SavedChat[] {
  return [...chats].sort((a,b) => Number(!!b.pinned)-Number(!!a.pinned) || (Date.parse(b.updatedAt ?? "") || 0)-(Date.parse(a.updatedAt ?? "") || 0));
}
export function searchConversations(chats: SavedChat[], query: string, archived = false): SavedChat[] {
  const words = query.trim().normalize("NFKC").toLocaleLowerCase().split(/\s+/u).filter(Boolean);
  return orderedConversations(chats.filter(chat => !!chat.archived === archived && (!words.length || words.every(word =>
    [conversationTitle(chat), ...chat.display.map(message => message.content)].join("\n").normalize("NFKC").toLocaleLowerCase().includes(word)))));
}
/** Portable text history never grants plan, file, image, tool or workspace ownership. */
export function exportConversation(chat: SavedChat, format: "json" | "markdown"): string {
  const title = conversationTitle(chat);
  if (format === "markdown") return `# ${title.replaceAll("\n", " ")}\n\n` + chat.display.filter(message => message.role !== "tool" && message.phase !== "progress").map(message => `## ${message.role === "user" ? "User" : "Assistant"}\n\n${message.content}${message.images?.length ? `\n\n[${message.images.length} image attachment(s)]` : ""}${message.documents?.length?`\n\n[Document attachments: ${message.documents.map(file=>file.name).join(', ')}]`:''}`).join("\n\n");
  return JSON.stringify({ product:"geod-agent", schemaVersion:1, exportedAt:new Date().toISOString(), conversation:{
    title,
    messages:chat.messages.filter(message => message.role !== "tool" && typeof message.content === "string").map(message => ({role:message.role,content:message.content})),
    display:chat.display.map(message => ({role:message.role,content:message.content,phase:message.phase,
      ...((message.images?.length||message.documents?.length) ? {attachmentNames:[...(message.images??[]).map(image=>image.name),...(message.documents??[]).map(file=>file.name)]} : {})})),
  } }, null, 2);
}
export function importConversation(text: string, id: string): SavedChat {
  if (new TextEncoder().encode(text).byteLength > 16*1024*1024) throw new Error("会话文件超过 16 MB，请拆分后导入。");
  let value;
  try { value = JSON.parse(text); } catch { throw new Error("会话文件不是有效的 JSON。"); }
  const chat = value?.product === "geod-agent" && value?.schemaVersion === 1 ? value.conversation : null;
  if (!chat || typeof chat !== "object" || !Array.isArray(chat.messages) || !Array.isArray(chat.display)
    || chat.messages.length > 100_000 || chat.display.length > 100_000) throw new Error("请选择 GeoD 导出的会话 JSON 文件。");
  const messages = chat.messages.map((message: Record<string,unknown>) => {
    if (!message || !["user","assistant"].includes(String(message.role)) || typeof message.content !== "string") throw new Error("会话文字历史损坏。");
    return {role:message.role as "user"|"assistant",content:message.content};
  });
  const display: DisplayMessage[] = chat.display.map((message: Record<string,unknown>, index: number) => {
    if (!message || !["user","assistant","tool"].includes(String(message.role)) || typeof message.content !== "string") throw new Error("会话显示记录损坏。");
    return {id:`import-${id}-${index}`,role:message.role as DisplayMessage["role"],content:message.content,
      ...(message.phase === "progress" || message.phase === "final" ? {phase:message.phase} : {})};
  });
  return {conversationId:id, title:typeof chat.title === "string" ? chat.title.trim().slice(0,120) : undefined,
    messages,display,updatedAt:new Date().toISOString(),planIds:[],engine:"codex",archived:false,pinned:false};
}
