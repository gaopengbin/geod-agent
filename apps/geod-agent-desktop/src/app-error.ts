/** Native IPC rejects with JSON objects, while other APIs may wrap or stringify them. */
function errorDetails(cause: unknown, seen = new Set<object>(), depth = 0): { code?: string; message?: string } {
  if (depth > 6) return {};
  if (typeof cause === "string") {
    const message = cause.trim();
    if (message.startsWith("{") || message.startsWith("[")) {
      try { return errorDetails(JSON.parse(message), seen, depth + 1); } catch { /* Plain error text. */ }
    }
    return message && message !== "[object Object]" ? { message } : {};
  }
  if (!cause || typeof cause !== "object" || seen.has(cause)) return {};
  seen.add(cause);
  const value = cause as { code?: unknown; message?: unknown; error?: unknown; cause?: unknown };
  const code = typeof value.code === "string" ? value.code : undefined;
  const nested = errorDetails(value.message ?? value.error ?? value.cause, seen, depth + 1);
  return { code: code ?? nested.code, message: nested.message };
}

export const runtimeUpdateMessage = "界面与本机程序版本不一致，请更新并重新启动 GeoD Agent。已停止本轮操作，未使用其他坐标系替代。";
export function runtimeCompatibilityFailure(cause: unknown): boolean {
  const {code, message} = errorDetails(cause);
  return code === "NATIVE_RUNTIME_UPDATE_REQUIRED" ||
    /invalid args.*unknown field [`'"](?:targetCrs|resampling)[`'"]/is.test(message ?? "") ||
    /(?:command.*(?:desktop_runtime_capabilities|gis_install_prepare|gis_install_cancel).*not found|(?:desktop_runtime_capabilities|gis_install_prepare|gis_install_cancel).*(?:unknown|not found))/i.test(message ?? "");
}

export function runtimeUpdateError() {
  return Object.assign(new Error(runtimeUpdateMessage), {code:"NATIVE_RUNTIME_UPDATE_REQUIRED"});
}

const messages: Record<string, string> = {
  PLAN_STALE: "计划已过期或图源配置已变化，请重新生成计划。",
  PLAN_NOT_FOUND: "计划不存在，请重新生成计划。",
  DISK_INSUFFICIENT: "保存位置或缓存空间不足，请释放空间后重试。",
  APPROVAL_REQUIRED: "请先确认所选下载计划。",
};

export function errorMessage(cause: unknown): string {
  const { code, message } = errorDetails(cause);
  if (message && /[\u3400-\u9fff]/u.test(message)) return message;
  return (code && messages[code]) || message || "操作失败，请查看本地任务记录。";
}
