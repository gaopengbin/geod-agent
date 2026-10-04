export interface MapCommand { name: string; args: Record<string, unknown> }
export interface SavedMapSession { commands: MapCommand[]; view?: { center: number[]; zoom: number; rotation: number } }
const key = (conversationId: string) => `geod-map-session-1:${conversationId}`;
export function readMapSession(storage: Pick<Storage,"getItem">, conversationId: string): SavedMapSession {
  try {
    const saved = JSON.parse(storage.getItem(key(conversationId)) ?? "null");
    if (!saved || !Array.isArray(saved.commands)) return { commands: [] };
    return { commands: saved.commands.filter((item: MapCommand) => typeof item?.name === "string" && item.args && typeof item.args === "object"), view: saved.view };
  } catch { return { commands: [] }; }
}
export function saveMapSession(storage: Pick<Storage,"setItem">, conversationId: string, session: SavedMapSession) {
  if (conversationId) storage.setItem(key(conversationId), JSON.stringify(session));
}
