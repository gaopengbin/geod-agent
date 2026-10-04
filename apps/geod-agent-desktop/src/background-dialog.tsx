import { t, localize } from "./i18n";
// i18n: presentation strings migrated
import { useEffect, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { Button } from "@/components/motion/button/base";
import { Loader2, Server, X } from "./icons";
import { api, errorMessage, type BackgroundStatus } from "./api";

export const BACKGROUND_OPEN = "geod:background-open";
export function BackgroundDialog({ onClose }: { onClose: () => void }) {
  const [status, setStatus] = useState<BackgroundStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    let disposed = false, loading = false;
    const refresh = async () => {
      if (loading) return;
      loading = true;
      try { const current = await api.backgroundStatus(); if (!disposed) setStatus(current); }
      catch (cause) { if (!disposed) setError(errorMessage(cause)); }
      finally { loading = false; }
    };
    void refresh(); const timer = setInterval(() => void refresh(), 5000);
    return () => { disposed = true; clearInterval(timer); };
  }, []);
  const toggle = async () => {
    setBusy(true); setError("");
    try {
      if (status?.running) { await api.backgroundStop(); setStatus({ running: false, activeDownloads: 0, windowRequired: false }); }
      else setStatus(await api.backgroundStart());
    } catch (cause) { setError(errorMessage(cause)); }
    finally { setBusy(false); }
  };
  return <Dialog.Root open onOpenChange={open => { if (!open) onClose(); }}><Dialog.Portal>
    <Dialog.Overlay className="dialog-overlay" />
    <Dialog.Content className="dialog network-dialog" aria-describedby="background-description">
      <div className="dialog-head"><div><Dialog.Title>{t("后台运行")}</Dialog.Title><Dialog.Description id="background-description">{t("关闭窗口后，下载、后台命令与定时任务继续在本机执行。")}</Dialog.Description></div><Button variant="ghost" size="icon" aria-label={t("关闭后台设置")} onClick={onClose}><X size={18}/></Button></div>
      <div className="dialog-body">
        <div className="network-current"><Server size={18}/><div><strong>{!status ? t("正在检查后台…") : status.running ? t("后台运行中") : t("后台已退出")}</strong><small>{status?.running ? t("{0} 个下载 · {1} 个命令 · {2} 个 AI 执行", {"0": status.activeDownloads, "1": status.activeCommands??0, "2": status.activeAiTurns??0}) : t("启动后台后可继续下载和定时执行。")}</small></div></div>
        <p className="field-hint">{t("退出后台或关机后停止执行；再次打开应用会启动后台并读取原有任务。电脑休眠期间不执行。")}</p>
        {status?.activeDownloads ? <p className="field-hint">{t("先暂停或取消正在执行的下载，再退出后台。")}</p> : null}
        {status?.activeCommands ? <p className="field-hint">{t("先在任务面板停止正在运行的命令，再退出后台。")}</p> : null}
        {error && <p role="alert" className="form-error">{localize(error)}</p>}
      </div>
      <div className="dialog-actions"><Button variant="outline" disabled={busy || !status || status.activeDownloads > 0 || (status.activeCommands??0)>0 || (status.activeAiTurns??0)>0 || status.maintenanceActive} onClick={() => void toggle()}>{busy && <Loader2 size={14} className="animate-spin"/>}{status?.running ? t("退出后台") : t("启动后台")}</Button><Button onClick={onClose}>{t("完成")}</Button></div>
    </Dialog.Content>
  </Dialog.Portal></Dialog.Root>;
}
