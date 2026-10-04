import declared from "../src-tauri/codex-tools.json";
import type { McpToolList } from "./api";
import { backgroundCommands, compactCommand, commandsChanged, focusBackgroundCommand, type CommandDraft } from "./background-commands";
export const BACKGROUND_COMMAND_ID = "builtin-background-commands";
export const backgroundCommandTools = (): McpToolList => ({ connectorId: BACKGROUND_COMMAND_ID, name: "后台命令", tools: declared.filter(tool => tool.function.name.startsWith("background_command_")).map(({ function: tool }) => ({ name: tool.name, description: tool.description, inputSchema: tool.parameters })) });
export async function executeBackgroundCommandTool(conversationId: string, name: string, args: Record<string, unknown>, key: string) {
  if (name === "background_command_prepare") {
    const result = await backgroundCommands.prepare(conversationId, key, args as unknown as CommandDraft);
    commandsChanged(conversationId); focusBackgroundCommand(conversationId, result.command.id); return result;
  }
  if (name === "background_command_list") return backgroundCommands.list(conversationId, typeof args.offset === "number" ? args.offset : undefined);
  const id = String(args.commandId);
  if (name === "background_command_get") return compactCommand(await backgroundCommands.get(conversationId, id));
  if (name === "background_command_start") {
    const result = await backgroundCommands.start(conversationId, id, String(args.planHash));
    commandsChanged(conversationId); focusBackgroundCommand(conversationId, id); return compactCommand(result);
  }
  if (name === "background_command_stop") { const result = await backgroundCommands.stop(conversationId, id); commandsChanged(conversationId); return compactCommand(result); }
  if (name === "background_command_write") return backgroundCommands.write(conversationId, id, typeof args.input === "string" ? args.input : undefined, args.closeStdin === true);
  return { error: "TOOL_NOT_ALLOWED" };
}
