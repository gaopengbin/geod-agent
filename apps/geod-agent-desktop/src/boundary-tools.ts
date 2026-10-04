import { api, type BoundaryImport } from "./api";
import { boundaryLookupReply } from "./agent-workflow";

export const rangeSummary = (range: BoundaryImport) => ({ boundaryId: range.boundaryId, name: range.name, bounds: range.bounds, polygonCount: range.polygonCount, attachedToDesktopPlan: true });

/** The actual desktop attachment path, shared by UI and real model tests. */
export async function saveBoundary(conversationId: string, boundary: BoundaryImport) {
  return boundary.boundaryId ? api.boundariesGet(conversationId, boundary.boundaryId) : api.boundariesSave(conversationId, boundary);
}

export async function attachBoundaryLookup(conversationId: string, tool: string, raw: Record<string, unknown>, attach: (boundary: BoundaryImport) => void | Promise<void>) {
  if (tool === "lookup_boundary" || tool === "wayback_changes") {
    const reply = boundaryLookupReply(raw);
    if (!reply.attachment) return reply.result;
    const saved = await saveBoundary(conversationId, reply.attachment);
    await attach(saved);
    return { ...reply.result, ...rangeSummary(saved) };
  }
  if (tool === "lookup_boundaries") {
    const items: unknown[] = [];
    for (const item of Array.isArray(raw.items) ? raw.items : []) {
      items.push(await attachBoundaryLookup(conversationId, "lookup_boundary", item as Record<string, unknown>, attach));
    }
    return { ...raw, items };
  }
  return raw;
}
