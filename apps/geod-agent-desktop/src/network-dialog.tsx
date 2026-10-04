import { t, localize } from "./i18n";
// i18n: presentation strings migrated
import { useEffect, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import * as Select from "@radix-ui/react-select";
import { Check, ChevronDown, CircleAlert, Loader2, Network, X } from "./icons";
import { Button } from "@/components/motion/button/base";
import { api, errorMessage, type NetworkProbe, type NetworkSettings, type NetworkStatus } from "./api";

export function NetworkDialog({ onClose, onSaved }: { onClose: () => void; onSaved: (status: NetworkStatus) => void }) {
  const [saved, setSaved] = useState<NetworkStatus | null>(null);
  const [mode, setMode] = useState<NetworkSettings["mode"]>("auto");
  const [manualUrl, setManualUrl] = useState("");
  const [loading, setLoading] = useState(true);
  const [action, setAction] = useState<"test" | "save" | null>(null);
  const working = action !== null;
  const [error, setError] = useState("");
  const [probe, setProbe] = useState<NetworkProbe | null>(null);
  useEffect(() => {
    let active = true;
    void api.networkGet().then(status => {
      if (!active) return;
      setSaved(status);
      setMode(status.settings.mode);
      setManualUrl(status.settings.manualUrl ?? "");
    }).catch(cause => { if (active) setError(errorMessage(cause)); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);
  const settings = (): NetworkSettings => ({ mode, manualUrl: manualUrl.trim() || null });
  async function test() {
    if (working) return;
    setAction("test"); setError(""); setProbe(null);
    try { setProbe(await api.networkTest(settings())); }
    catch (cause) { setError(errorMessage(cause)); }
    finally { setAction(null); }
  }
  async function save() {
    if (working) return;
    setAction("save"); setError("");
    try {
      const status = await api.networkSet(settings());
      setSaved(status);
      setManualUrl(status.settings.manualUrl ?? "");
      onSaved(status);
      onClose();
    }
    catch (cause) { setError(errorMessage(cause)); }
    finally { setAction(null); }
  }
  const selected = saved && saved.settings.mode === mode && (saved.settings.manualUrl ?? "") === manualUrl.trim();
  return <Dialog.Root open onOpenChange={open => { if (!open) onClose(); }}><Dialog.Portal><Dialog.Overlay className="dialog-backdrop" />
    <Dialog.Content className="dialog network-dialog">
      <div className="dialog-head"><div><Dialog.Title>{t("网络与代理")}</Dialog.Title><Dialog.Description>{t("设置此设备的联网方式。")}</Dialog.Description></div><Button variant="ghost" size="icon" aria-label={t("关闭网络设置")} onClick={onClose}><X size={18} /></Button></div>
      <div className="dialog-body">
        <div className="field"><span className="field-label" id="proxy-mode-label">{t("连接方式")}</span><Select.Root value={mode} onValueChange={value => { setMode(value as NetworkSettings["mode"]); setProbe(null); }} disabled={loading || working}><Select.Trigger className="select-trigger" aria-labelledby="proxy-mode-label"><Select.Value /><Select.Icon><ChevronDown size={15} /></Select.Icon></Select.Trigger><Select.Portal><Select.Content className="select-content" position="popper" sideOffset={6} align="start" collisionPadding={8}><Select.Viewport>{[{ value: "auto", label: "自动识别系统代理" }, { value: "manual", label: "手动设置 HTTP 代理" }, { value: "direct", label: "直连" }].map(option => <Select.Item className="select-item" value={option.value} key={option.value}><Select.ItemText>{localize(option.label)}</Select.ItemText><Select.ItemIndicator className="select-item-indicator"><Check size={14} /></Select.ItemIndicator></Select.Item>)}</Select.Viewport></Select.Content></Select.Portal></Select.Root>{mode === "auto" && <small>{t("优先使用系统代理，其次使用环境变量；本机服务直连。")}</small>}</div>
        {mode === "manual" && <label className="field"><span className="field-label">{t("HTTP 代理地址")}</span><input value={manualUrl} onChange={event => { setManualUrl(event.target.value); setProbe(null); }} placeholder="http://127.0.0.1:10808" spellCheck={false} autoComplete="off" /><small>{t("填写主机和端口，不含账号、密码或路径。")}</small></label>}
        <div className="network-current"><Network size={17}/><div><span className="network-current-label">{loading ? t("正在读取配置…") : saved ? t("当前连接") : t("配置暂不可用")}</span>{saved && <><strong>{saved.source}</strong>{saved.effectiveProxy && <code>{saved.effectiveProxy}</code>}<small>{selected ? t("下载中的任务保持原连接。") : t("更改尚未保存，将用于后续请求。")}</small></>}</div></div>
        {probe && <div className="success-box"><Check size={16} />{t("边界服务可达 · ")}{probe.elapsedMs} {t(" 毫秒")}</div>}
        {error && <div className="error-box"><CircleAlert size={16} />{localize(error)}</div>}
      </div>
      <div className="dialog-actions"><Button className="network-test" variant="outline" onClick={() => void test()} disabled={loading || working}>{action === "test" && <Loader2 size={14} className="animate-spin"/>}{action === "test" ? t("测试中…") : t("测试连接")}</Button><Button variant="ghost" onClick={onClose}>{t("取消")}</Button><Button onClick={() => void save()} disabled={loading || working}>{action === "save" && <Loader2 size={14} className="animate-spin"/>}{action === "save" ? t("保存中…") : t("保存设置")}</Button></div>
    </Dialog.Content></Dialog.Portal>
  </Dialog.Root>;
}
