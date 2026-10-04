import type { Bounds, StoredBoundary } from "./api";

export interface BoundaryBookmark { id: string; boundaryId: string; name: string; bounds: Bounds; polygonCount: number; updatedAt: string }
type BookmarkStore = Pick<Storage, "getItem" | "setItem">;
const key = (conversationId: string) => `geod.boundary-bookmarks.v1:${conversationId}`;
export function readBoundaryBookmarks(store: BookmarkStore, conversationId: string): BoundaryBookmark[] {
  try {
    const value: unknown = JSON.parse(store.getItem(key(conversationId)) || "[]");
    if (!Array.isArray(value)) return [];
    return value.filter((item): item is BoundaryBookmark => !!item && typeof item.id === "string" && typeof item.boundaryId === "string" && typeof item.name === "string" &&
      Array.isArray(item.bounds) && item.bounds.length === 4 && item.bounds.every(Number.isFinite) && Number.isInteger(item.polygonCount) && item.polygonCount > 0 && typeof item.updatedAt === "string");
  } catch { return []; }
}
export function writeBoundaryBookmarks(store: BookmarkStore, conversationId: string, items: BoundaryBookmark[]) {
  store.setItem(key(conversationId), JSON.stringify(items));
}
export function bookmarkBoundary(items: BoundaryBookmark[], boundary: StoredBoundary, replaceId?: string): BoundaryBookmark[] {
  const entry = { id: replaceId ?? boundary.boundaryId, boundaryId: boundary.boundaryId, name: boundary.name, bounds: boundary.bounds, polygonCount: boundary.polygonCount, updatedAt: new Date().toISOString() };
  return [entry, ...items.filter(item => item.id !== entry.id)];
}
