import type { AgentMessage, StoredPlan } from "./api";
import type { DisplayMessage } from "./pending-generations";
import { groupWorkRecords, isTurnWork } from "./chat-work.ts";

export interface PlanPresentation {
  planId: string;
  title: string;
  userMessageId?: string;
  toolMessageId?: string;
  answerMessageId?: string;
}
export type PlanPresentations = Record<string, PlanPresentation>;
type Store = Pick<Storage, "getItem" | "setItem">;
export const planPresentationKey = (account: string, conversation: string) => `geod-agent-plan-presentation-1:${encodeURIComponent(account)}:${encodeURIComponent(conversation)}`;

export function defaultPlanTitle(dataName: string | null | undefined, sourceName: string) {
  const name = dataName?.split(/[\\/]/).at(-1)?.replace(/\.(geojson|json|gpkg|shp|kml|tiff?|mbtiles)$/i, "")
    .replace(/[-_]AreaCity[-_]\d{8}$/i, "").trim();
  return name ? /影像$/.test(name) ? name : `${name}影像` : sourceName;
}
export function readPlanPresentations(store: Pick<Storage, "getItem">, account: string | null, conversation: string): PlanPresentations {
  if (!account || !conversation) return {};
  try {
    const value = JSON.parse(store.getItem(planPresentationKey(account, conversation)) ?? "{}");
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    return Object.fromEntries(Object.entries(value).filter(([id, item]) => {
      const entry = item as Partial<PlanPresentation> | null;
      return entry && entry.planId === id && typeof entry.title === "string" &&
        (entry.userMessageId === undefined || typeof entry.userMessageId === "string") &&
        (entry.toolMessageId === undefined || typeof entry.toolMessageId === "string") &&
        (entry.answerMessageId === undefined || typeof entry.answerMessageId === "string");
    })) as PlanPresentations;
  } catch { return {}; }
}
export function savePlanPresentations(store: Store, account: string, conversation: string, entries: PlanPresentation[]) {
  const previous = readPlanPresentations(store, account, conversation);
  const next = { ...previous };
  for (const entry of entries) {
    // Replaying an execution or selecting a task must never reassign its owner.
    const existing = next[entry.planId];
    next[entry.planId] = existing ? { ...entry, ...existing } : entry;
    if (existing && !existing.answerMessageId) {
      delete next[entry.planId].answerMessageId;
      if (entry.answerMessageId && existing.userMessageId === entry.userMessageId && existing.toolMessageId === entry.toolMessageId)
        next[entry.planId].answerMessageId = entry.answerMessageId;
    }
  }
  if (JSON.stringify(next) === JSON.stringify(previous)) return;
  store.setItem(planPresentationKey(account, conversation), JSON.stringify(next));
  if (typeof window !== "undefined") window.dispatchEvent(new Event("geod-plan-presentation-change"));
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
function output(text?: string) {
  try {
    const value = object(JSON.parse(text ?? "null"));
    return value && "arguments" in value ? object(value.result) : value;
  } catch { return undefined; }
}
function sameBounds(a: unknown, b: unknown) {
  return Array.isArray(a) && Array.isArray(b) && a.length === 4 && b.length === 4 &&
    a.every((n, index) => typeof n === "number" && typeof b[index] === "number" && Math.abs(n - b[index]) < 1e-7);
}

/** Recover old cards from actual successful tool results, never from the current request. */
export function inferPlanPresentations(display: DisplayMessage[], plans: StoredPlan[], messages: AgentMessage[] = []): PlanPresentation[] {
  const planCalls = new Set(messages.flatMap(item => item.tool_calls?.filter(call => call.function.name === "plan_imagery").map(call => call.id) ?? []));
  const planOutputs = messages.filter(item => item.role === "tool" && item.tool_call_id && planCalls.has(item.tool_call_id)).map(item => output(item.content ?? undefined))
    .filter(item => typeof item?.planId === "string" && typeof item?.totalTiles === "number");
  const legacyRows = display.filter(item => item.toolName === "plan_imagery" && item.toolStatus === "success" && !output(item.details));
  // Old legacy rows omitted their results. Only align an intact sequence, not truncated history.
  const legacy = legacyRows.length === planOutputs.length ? new Map(legacyRows.map((item, index) => [item.id, planOutputs[index]])) : new Map();
  const rawBoundaries = messages.filter(item => item.role === "tool").flatMap(item => {
    const data = output(item.content ?? undefined);
    const boundary = data?.toolName === "lookup_boundary" ? object(data.result) : data;
    return boundary?.attachedToDesktopPlan === true && typeof boundary.name === "string" ? [boundary] : [];
  });
  const boundaries: Record<string, unknown>[] = [];
  const result = new Map<string, PlanPresentation>();
  let userMessageId: string | undefined;
  for (const item of display) {
    if (item.role === "user") userMessageId = item.id;
    if (item.role !== "tool" || item.toolStatus !== "success") continue;
    const data = output(item.details) ?? legacy.get(item.id);
    const boundary = data?.toolName === "lookup_boundary" ? object(data.result) : data;
    if (boundary?.attachedToDesktopPlan === true && typeof boundary.name === "string") boundaries.push(boundary);
    if (item.toolName !== "plan_imagery" || typeof data?.planId !== "string" || result.has(data.planId)) continue;
    const stored = plans.find(plan => plan.planId === data.planId);
    if (!stored) continue;
    const named = [...boundaries].reverse().find(boundary => sameBounds(boundary.bounds, stored.plan.spec.bounds)) ??
      rawBoundaries.find(boundary => sameBounds(boundary.bounds, stored.plan.spec.bounds));
    const remaining = display.slice(display.indexOf(item) + 1);
    const nextUser = remaining.findIndex(record => record.role === "user");
    const answer = remaining.slice(0, nextUser < 0 ? undefined : nextUser).find(record => record.role === "assistant" && record.phase !== "progress");
    result.set(data.planId, { planId: data.planId, title: defaultPlanTitle(named?.name as string | undefined, stored.plan.sourceName), userMessageId, toolMessageId: item.id, ...(answer ? { answerMessageId: answer.id } : {}) });
  }
  return [...result.values()];
}

/** Anchor inside the originating user turn; new messages cannot pull cards to the footer. */
export function planCardAnchors(messages: DisplayMessage[], presentations: PlanPresentations): Record<string, string[]> {
  const entries = groupWorkRecords(messages);
  const anchors: Record<string, string[]> = {};
  for (const presentation of Object.values(presentations)) {
    const userIndex = messages.findIndex(item => item.id === presentation.userMessageId && item.role === "user");
    const toolIndex = messages.findIndex(item => item.id === presentation.toolMessageId);
    const start = userIndex >= 0 ? userIndex : toolIndex;
    if (start < 0) continue; // Unknown ownership stays in the task panel, not the latest answer.
    let end = start + 1;
    while (end < messages.length && messages[end].role !== "user") end++;
    const turn = messages.slice(start, end);
    const answer = presentation.answerMessageId ? turn.find(item => item.id === presentation.answerMessageId) :
      turn.slice(Math.max(0, toolIndex - start + 1)).find(item => item.role === "assistant" && item.phase !== "progress");
    if (presentation.answerMessageId && !answer) continue;
    const target = answer ?? turn.find(item => item.id === presentation.toolMessageId);
    if (!target) continue;
    const entry = entries.find(item => isTurnWork(item) ? item.items.some(record => record.id === target.id) : item.id === target.id);
    // A steered Codex run can have its work group before a second user message.
    // Wait for that message's answer rather than putting its new card in the earlier group.
    const ownerEntryIndex = entries.findIndex(item => item.id === presentation.userMessageId);
    if (entry && (ownerEntryIndex < 0 || entries.indexOf(entry) > ownerEntryIndex)) (anchors[entry.id] ??= []).push(presentation.planId);
  }
  return anchors;
}
