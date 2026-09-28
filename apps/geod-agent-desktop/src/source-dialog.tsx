import { useState, type ReactNode } from "react";
import { ArrowRight, CircleAlert, X } from "lucide-react";
import * as Dialog from "@radix-ui/react-dialog";
import * as Select from "@radix-ui/react-select";
import { Check, ChevronDown } from "lucide-react";
import { Button } from "@/components/motion/button/base";
import { api, errorMessage, type HttpSource, type SourceDescriptor } from "./api";

const initial: HttpSource = { id: "", name: "", attribution: "", license: "", urlTemplate: "", scheme: "XYZ", tileSize: 256, networkPolicy: "PublicHttps", minIntervalMs: 250 };
const usgsConus: HttpSource = { id: "usgs-naip-plus-conus", name: "USGS NAIP Plus · 美国本土", attribution: "USGS, USDA, The National Map: Orthoimagery", license: "USGS The National Map 公共领域影像；仅用于美国本土已确认覆盖范围", urlTemplate: "https://imagery.nationalmap.gov/arcgis/rest/services/USGSNAIPPlus/ImageServer/exportImage", scheme: "XYZ", tileSize: 256, networkPolicy: "PublicHttps", minIntervalMs: 500 };
function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) { return <label className="field"><span className="field-label">{label}</span>{children}{hint && <small>{hint}</small>}</label>; }
function SelectField({ label, value, options, onChange }: { label: string; value: string; options: { value: string; label: string }[]; onChange: (value: string) => void }) {
  const id = `source-${label}`;
  return <div className="field"><span className="field-label" id={id}>{label}</span><Select.Root value={value} onValueChange={onChange}><Select.Trigger className="select-trigger" aria-labelledby={id}><Select.Value /><Select.Icon><ChevronDown size={15} /></Select.Icon></Select.Trigger><Select.Portal><Select.Content className="select-content" position="popper" sideOffset={6} align="start" collisionPadding={8}><Select.Viewport>{options.map(option => <Select.Item className="select-item" value={option.value} key={option.value}><Select.ItemText>{option.label}</Select.ItemText><Select.ItemIndicator className="select-item-indicator"><Check size={14} /></Select.ItemIndicator></Select.Item>)}</Select.Viewport></Select.Content></Select.Portal></Select.Root></div>;
}

export function SourceDialog({ onClose, onSaved }: { onClose: () => void; onSaved: (source: SourceDescriptor) => void }) {
  const [source, setSource] = useState<HttpSource>(initial);
  const [minZoom, setMinZoom] = useState(0);
  const [maxZoom, setMaxZoom] = useState(18);
  const [ack, setAck] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const change = <K extends keyof HttpSource>(key: K, value: HttpSource[K]) => setSource(current => ({ ...current, [key]: value }));
  async function save() {
    if (!ack || saving) return;
    setSaving(true); setError("");
    try { onSaved(await api.sourcesSave(source, minZoom, maxZoom)); }
    catch (cause) { setError(errorMessage(cause)); }
    finally { setSaving(false); }
  }
  return <Dialog.Root open onOpenChange={open => { if (!open) onClose(); }}><Dialog.Portal><Dialog.Overlay className="dialog-backdrop" />
    <Dialog.Content className="dialog">
      <div className="dialog-head"><div><span className="eyebrow">SOURCE REGISTRY</span><Dialog.Title id="source-title">登记授权图源</Dialog.Title><Dialog.Description>支持 XYZ/TMS 与 ArcGIS ImageServer 导出接口。地址保存在本机。</Dialog.Description></div><Button variant="ghost" size="icon" aria-label="关闭" onClick={onClose}><X size={20} /></Button></div>
      <div className="dialog-body">
        <button type="button" className="source-preset" onClick={() => { setSource(usgsConus); setMinZoom(10); setMaxZoom(18); }}><strong>填入 USGS NAIP 示例</strong><span>美国本土公共领域影像 · 256 px · 请求间隔 500 毫秒</span></button>
        <div className="form-grid"><Field label="图源 ID"><input value={source.id} onChange={e => change("id", e.target.value)} placeholder="my-imagery" /></Field><Field label="显示名称"><input value={source.name} onChange={e => change("name", e.target.value)} placeholder="我的影像服务" /></Field></div>
        <Field label="图源地址" hint="XYZ/TMS 使用 {z}、{x}、{y}；ArcGIS 使用 /ImageServer/exportImage。不得包含密钥、Token 或查询参数。"><input value={source.urlTemplate} onChange={e => change("urlTemplate", e.target.value)} placeholder="https://tiles.example.com/{z}/{x}/{y}.png" spellCheck={false} /></Field>
        <div className="form-grid"><Field label="署名 / 数据来源"><input value={source.attribution} onChange={e => change("attribution", e.target.value)} placeholder="提供方名称" /></Field><Field label="许可或授权依据"><input value={source.license} onChange={e => change("license", e.target.value)} placeholder="协议名称或授权编号" /></Field></div>
        <div className="form-grid three"><SelectField label="瓦片坐标系" value={source.scheme} onChange={value => change("scheme", value as HttpSource["scheme"])} options={[{ value: "XYZ", label: "XYZ" }, { value: "TMS", label: "TMS" }]} /><SelectField label="瓦片大小" value={String(source.tileSize)} onChange={value => change("tileSize", Number(value))} options={[{ value: "256", label: "256 px" }, { value: "512", label: "512 px" }]} /><SelectField label="网络策略" value={source.networkPolicy} onChange={value => change("networkPolicy", value as HttpSource["networkPolicy"])} options={[{ value: "PublicHttps", label: "公网 HTTPS" }, { value: "UserTrustedHttp", label: "信任的 HTTP" }]} /></div>
        <div className="form-grid three"><Field label="最低缩放"><input type="number" min="0" max="22" value={minZoom} onChange={e => setMinZoom(Number(e.target.value))} /></Field><Field label="最高缩放"><input type="number" min="0" max="22" value={maxZoom} onChange={e => setMaxZoom(Number(e.target.value))} /></Field><Field label="请求间隔 / 毫秒"><input type="number" min="0" step="50" value={source.minIntervalMs} onChange={e => change("minIntervalMs", Number(e.target.value))} /></Field></div>
        <label className="check-row"><input type="checkbox" checked={ack} onChange={e => setAck(e.target.checked)} /><span>我确认此图源允许本次用途的批量下载，并会遵守其许可和服务限制。</span></label>
        {error && <div className="error-box"><CircleAlert size={16} />{error}</div>}
      </div>
      <div className="dialog-actions"><Button variant="secondary" onClick={onClose}>取消</Button><Button disabled={!ack || saving} onClick={save}>{saving ? "正在登记…" : "保存图源"}<ArrowRight size={16} /></Button></div>
    </Dialog.Content>
  </Dialog.Portal></Dialog.Root>;
}
