import type { DisplayMessage } from "./pending-generations";

export interface TurnWork {
  kind: "work";
  id: string;
  turnId?: string;
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
  const entries: TranscriptEntry[] = [];
  const turns = new Map<string, TurnWork>();
  let legacyTurn = "legacy-start";
  for (const item of uniqueDisplayMessages(messages)) {
    if (item.role === "user") legacyTurn = `legacy-${item.id}`;
    const work = (item.role === "tool" || item.phase === "progress") && item.role !== "user"
      && !item.sourceDraft && !item.extensionProposal && !item.backgroundJob && !item.userInput && !item.turnOutcome;
    if (work) {
      const turnId = item.turnId ?? item.monitorTrace?.[0]?.turnId;
      const id = turnId ?? legacyTurn;
      let group = turns.get(id);
      if (!group) {
        group = { kind: "work", id, turnId, items: [] };
        turns.set(id, group);
        entries.push(group);
      }
      group.items.push(item);
    } else {
      entries.push(item);
      if (item.role === "assistant" && item.phase !== "progress") legacyTurn = `legacy-after-${item.id}`;
    }
  }
  return entries;
}
