import type { DisplayMessage } from "./pending-generations";

export interface TurnWork {
  kind: "work";
  id: string;
  turnId?: string;
  turnIds: string[];
  items: DisplayMessage[];
}
export type TranscriptEntry = DisplayMessage | TurnWork;
export const isTurnWork = (entry: TranscriptEntry): entry is TurnWork => "kind" in entry && entry.kind === "work";

/** Replayed stream events update one row; they never create another copy of it. */
export function uniqueDisplayMessages(messages: DisplayMessage[]): DisplayMessage[] {
  const records = new Map<string, DisplayMessage>();
  for (const item of messages) records.set(item.id, item.monitorTrace ? { ...item, monitorTrace: uniqueDisplayMessages(item.monitorTrace) } : item);
  return [...records.values()];
}

/** Commentary and execution belong to the same turn, even when a card separates them. */
export function groupWorkRecords(messages: DisplayMessage[]): TranscriptEntry[] {
  const records = uniqueDisplayMessages(messages);
  const completedUsers = new Set<string>();
  const completedTurns = new Set<string>();
  let userId: string | undefined;
  for (const item of records) {
    if (item.role === "user") userId = item.id;
    if ((item.role === "assistant" && item.phase !== "progress" && !item.streaming) || item.turnOutcome) {
      if (userId) completedUsers.add(userId);
      if (item.turnId) completedTurns.add(item.turnId);
    }
  }
  const entries: TranscriptEntry[] = [];
  const turns = new Map<string, TurnWork>();
  let legacyTurn = "legacy-start";
  let currentGroup: TurnWork | undefined;
  userId = undefined;
  for (const item of records) {
    if (item.role === "user") {
      userId = item.id;
      legacyTurn = `legacy-${item.id}`;
      currentGroup = undefined;
    }
    const historicalInput = item.userInput && item.userInput.status !== "pending"
      && (completedUsers.has(item.userInput.userMessageId ?? userId ?? "") || completedTurns.has(item.turnId ?? ""));
    const work = (item.role === "tool" || item.phase === "progress") && item.role !== "user"
      && !item.sourceDraft && !item.extensionProposal && !item.backgroundJob && (!item.userInput || historicalInput) && !item.turnOutcome;
    if (work) {
      const turnId = item.turnId ?? item.monitorTrace?.[0]?.turnId;
      const id = turnId ?? legacyTurn;
      // Local tools can omit a run ID; SDK continuations can introduce another ID.
      // Both belong to the current answer until a new user message or final reply.
      let group = turns.get(id) ?? currentGroup;
      if (!group) {
        group = { kind: "work", id, turnId, turnIds: [], items: [] };
        entries.push(group);
      }
      if (turnId && !group.turnIds.includes(turnId)) {
        group.turnIds.push(turnId);
        if (!group.turnId) { group.turnId = turnId; group.id = turnId; }
      }
      turns.set(id, group);
      currentGroup = group;
      group.items.push(item);
    } else {
      entries.push(item);
      if ((item.role === "assistant" && item.phase !== "progress") || item.turnOutcome) {
        legacyTurn = `legacy-after-${item.id}`;
        currentGroup = undefined;
      }
    }
  }
  return entries;
}
