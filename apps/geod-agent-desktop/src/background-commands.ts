import { invoke } from "@tauri-apps/api/core";
export type CommandState = "planned" | "queued" | "running" | "stopping" | "completed" | "failed" | "cancelled" | "interrupted";
export interface BackgroundCommand {
  id: string; conversationId: string; title: string; command: string[]; workspace: string; cwd: string;
  timeoutMs?: number | null; planHash: string; status: CommandState; createdAt: string; startedAt?: string | null;
  executionMode: "windowsUser" | "workspaceSandbox" | "";
  finishedAt?: string | null; exitCode?: number | null; outputTruncated: boolean;
  error?: { code: string; message: string } | null; stdout?: string; stderr?: string;
}
export interface CommandDraft { title: string; command: string[]; relativeCwd?: string; timeoutMs?: number }
export interface CommandOverview { commands: BackgroundCommand[]; total: number; nextOffset: number | null }
export const BACKGROUND_COMMAND_FOCUS = "geod:background-command-focus";
export const BACKGROUND_COMMAND_CHANGED = "geod:background-command-changed";
const focusIds = new Map<string, string>();
export const pendingCommandFocus = (conversationId: string) => focusIds.get(conversationId);
export function focusBackgroundCommand(conversationId: string, commandId: string) {
  focusIds.set(conversationId, commandId);
  window.dispatchEvent(new CustomEvent(BACKGROUND_COMMAND_FOCUS, { detail: { conversationId, commandId } }));
}
export function commandsChanged(conversationId: string) {
  window.dispatchEvent(new CustomEvent(BACKGROUND_COMMAND_CHANGED, { detail: { conversationId } }));
}
export const backgroundCommands = {
  prepare: (conversationId: string, idempotencyKey: string, draft: CommandDraft) => invoke<{ command: BackgroundCommand; permission: string; confirmationRequired: boolean; windowRequired: false }>("background_command_prepare", { conversationId, idempotencyKey, draft }),
  list: (conversationId: string, offset?: number) => invoke<CommandOverview>("background_command_list", { conversationId, offset }),
  get: (conversationId: string, commandId: string) => invoke<BackgroundCommand>("background_command_get", { conversationId, commandId }),
  start: (conversationId: string, commandId: string, planHash: string, confirmed = false) => invoke<BackgroundCommand>("background_command_start", { conversationId, commandId, planHash, confirmed }),
  stop: (conversationId: string, commandId: string) => invoke<BackgroundCommand>("background_command_stop", { conversationId, commandId }),
  write: (conversationId: string, commandId: string, input?: string, closeStdin = false) => invoke<{ commandId: string; accepted: boolean; stdinClosed: boolean }>("background_command_write", { conversationId, commandId, input, closeStdin }),
};
export function compactCommand(record: BackgroundCommand) {
  const { stdout, stderr, ...summary } = record;
  return { ...summary, ...(stdout !== undefined ? { stdout: stdout.slice(-12000) } : {}), ...(stderr !== undefined ? { stderr: stderr.slice(-12000) } : {}), outputExcerptTruncated: (stdout?.length ?? 0) > 12000 || (stderr?.length ?? 0) > 12000 };
}
