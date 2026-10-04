import { useCallback, useEffect, useState } from "react";
import { dataDownloads, dataDownloadChanged, DATA_DOWNLOAD_CHANGED, type DataDownloadTask } from "./data-downloads";
import { desktopAvailable } from "./api";
import { errorMessage } from "./app-error";
import type { TaskAction } from "./task-queue";

export function useDataDownloads(conversationId?: string) {
  const [tasks, setTasks] = useState<DataDownloadTask[]>([]), [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  const refresh = useCallback(() => setRevision(v => v + 1), []);
  useEffect(() => { setTasks([]); setError(""); }, [conversationId]);
  useEffect(() => {
    if (!conversationId || !desktopAvailable) return;
    let disposed = false, loading = false;
    async function load() {
      if (loading) return; loading = true;
      try { const rows = await dataDownloads.list(conversationId!); if (!disposed) { setTasks(rows); setError(""); } }
      catch (cause) { if (!disposed) setError(errorMessage(cause)); }
      finally { loading = false; }
    }
    const changed = (event: Event) => { if ((event as CustomEvent).detail?.conversationId === conversationId) void load(); };
    window.addEventListener(DATA_DOWNLOAD_CHANGED, changed); void load();
    const timer = setInterval(() => void load(), 3000);
    return () => { disposed = true; clearInterval(timer); window.removeEventListener(DATA_DOWNLOAD_CHANGED, changed); };
  }, [conversationId, revision]);
  async function action(kind: TaskAction, ids: string[]) {
    if (!conversationId) return;
    const errors: string[] = [];
    for (const id of ids) {
      try {
        const current = await dataDownloads.get(conversationId, id);
        if (kind === "start") await dataDownloads.start(conversationId, id, current.planHash, true);
        else if (kind === "discard") await dataDownloads.discard(conversationId, id);
        else if (kind === "cancel") await dataDownloads.cancel(conversationId, id);
        else throw new Error("此数据任务不支持该操作");
      } catch (cause) { errors.push(errorMessage(cause)); }
    }
    dataDownloadChanged(conversationId); if (errors.length) throw new Error(errors.join("；"));
  }
  return { tasks, error, refresh, action };
}
