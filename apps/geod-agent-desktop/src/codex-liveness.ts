export interface TurnGuardOptions {
  probe: () => Promise<unknown>;
  interrupt: () => Promise<unknown>;
  tickMs?: number;
  probeAfterMs?: number;
  probeTimeoutMs?: number;
  startupTimeoutMs?: number;
  silenceTimeoutMs?: number;
}

/** A lost native IPC promise must not keep the composer busy forever. */
export function guardedCodexTurn<T>(start: (activity: () => void) => Promise<T>, options: TurnGuardOptions): Promise<T> {
  const started = Date.now(); let lastActivity = started; let received = false; let probing = false;
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (error: unknown, value?: T) => {
      if (settled) return; settled = true; clearInterval(timer);
      error ? reject(error) : resolve(value as T);
    };
    const fail = (message: string) => {
      if (settled) return;
      finish(new Error(message)); void options.interrupt().catch(() => {});
    };
    const timer = setInterval(() => {
      if (!received && Date.now() - started > (options.startupTimeoutMs ?? 35_000)) {
        fail("Codex 启动未完成，已结束等待。请重试；若仍失败，可切回现有引擎。"); return;
      }
      // The native host sends heartbeats even while a model or input request waits.
      // A responsive auth command alone cannot prove this turn's event channel works.
      if (received && Date.now() - lastActivity > (options.silenceTimeoutMs ?? 45_000)) {
        fail("本次执行的消息连接已中断，已结束等待。请检查任务状态后继续。"); return;
      }
      if (probing || Date.now() - lastActivity < (options.probeAfterMs ?? 8_000)) return;
      probing = true;
      let timeout: ReturnType<typeof setTimeout>;
      Promise.race([options.probe(), new Promise((_, rejectProbe) => { timeout = setTimeout(() => rejectProbe(new Error("IPC timeout")), options.probeTimeoutMs ?? 3_500); })])
        .catch(() => { if (!settled) fail("本机引擎连接已中断，已结束等待。请重新打开 GeoD Agent 后继续。"); })
        .finally(() => { clearTimeout(timeout); probing = false; });
    }, options.tickMs ?? 2_000);
    Promise.resolve().then(() => start(() => { lastActivity = Date.now(); received = true; })).then(value => finish(null, value), error => finish(error));
  });
}
