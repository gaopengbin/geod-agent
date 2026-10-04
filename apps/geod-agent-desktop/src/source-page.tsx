import { localize, t } from "./i18n";
// i18n: presentation strings migrated
import { useEffect, useId, useState, type ReactNode } from "react";
import { ArrowLeft, Check, ChevronDown, CircleAlert, Loader2, MapTrifold, PencilSimple, Plus, RefreshCw, Save, X } from "./icons";
import * as Select from "@radix-ui/react-select";
import { Button } from "@/components/motion/button/base";
import { UiTooltip } from "./ui-tooltip";
import { ScrollArea } from "@/components/ui/scroll-area";
import { SourceThumbnail } from "./source-thumbnail";
import { thumbnailKey } from "./source-thumbnails";
import { separateUrlToken, sourceCredential, sourcePresets, tiandituPreset, rasterSourcePresets, rasterPreset } from "./source-presets";
import { api, desktopAvailable, errorMessage, type HttpSource, type SourceDescriptor, type SourceRegistrationDraft, type SourceCredentialInput } from "./api";
import { usePageWidth } from "./use-page-width";

const initial: HttpSource = { id: "", name: "", attribution: "", license: "", urlTemplate: "", scheme: "XYZ", tileSize: 256, networkPolicy: "PublicHttps", minIntervalMs: 0 };
const usgsConus: HttpSource = { id: "usgs-naip-plus-conus", name: "USGS NAIP Plus · 美国本土", attribution: "USGS, USDA, The National Map: Orthoimagery", license: "USGS The National Map 公共领域影像；仅用于美国本土已确认覆盖范围", urlTemplate: "https://imagery.nationalmap.gov/arcgis/rest/services/USGSNAIPPlus/ImageServer/exportImage", scheme: "XYZ", tileSize: 256, networkPolicy: "PublicHttps", minIntervalMs: 0 };

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return <label className="field"><span className="field-label">{localize(label)}</span>{children}{hint && <small>{localize(hint)}</small>}</label>;
}
function SelectField({ label, value, options, onChange }: { label: string; value: string; options: { value: string; label: string }[]; onChange: (value: string) => void }) {
  const id = `source-${label}`;
  return <div className="field"><span className="field-label" id={id}>{localize(label)}</span><Select.Root value={value} onValueChange={onChange}><Select.Trigger className="select-trigger" aria-labelledby={id}><Select.Value /><Select.Icon><ChevronDown size={15} /></Select.Icon></Select.Trigger><Select.Portal><Select.Content className="select-content" position="popper" sideOffset={6} align="start" collisionPadding={8}><Select.Viewport>{options.map(option => <Select.Item className="select-item" value={option.value} key={option.value}><Select.ItemText>{localize(option.label)}</Select.ItemText><Select.ItemIndicator className="select-item-indicator"><Check size={14} /></Select.ItemIndicator></Select.Item>)}</Select.Viewport></Select.Content></Select.Portal></Select.Root></div>;
}

function SourceForm({ draft, editing, existingIds, onCancel, onSaved, onSavingChange }: {
  draft: SourceRegistrationDraft | null; editing: boolean; existingIds: string[];
  onCancel: () => void; onSaved: (source: SourceDescriptor) => void; onSavingChange: (saving: boolean) => void;
}) {
  const [source, setSource] = useState<HttpSource>(draft?.source ?? initial);
  const [minZoom, setMinZoom] = useState(draft?.minZoom ?? 0);
  const [maxZoom, setMaxZoom] = useState(draft?.maxZoom ?? 18);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [moreOpen, setMoreOpen] = useState(editing || !!draft);
  const moreId = useId();
  const [previewDraft, setPreviewDraft] = useState<SourceRegistrationDraft | null>(null);
  const [previewVersion, setPreviewVersion] = useState(0);
  const [authMode, setAuthMode] = useState<string>(draft?.source.authentication?.mode ?? draft?.authenticationMode ?? "none");
  const [authParameter, setAuthParameter] = useState(draft?.source.authentication?.parameter ?? draft?.authenticationParameter ?? "token");
  const [token, setToken] = useState("");
  const [previewCredential, setPreviewCredential] = useState<SourceCredentialInput>();
  const [authRevision, setAuthRevision] = useState(0);
  const [previewAuthRevision, setPreviewAuthRevision] = useState(-1);
  const currentDraft = { source, minZoom, maxZoom };
  const previewMatches = previewDraft && authRevision === previewAuthRevision && thumbnailKey({ draft: previewDraft }) === thumbnailKey({ draft: currentDraft });
  const change = <K extends keyof HttpSource>(key: K, value: HttpSource[K]) => { setSource(current => ({ ...current, [key]: value })); };
  function authChange(mode: string) {
    setAuthMode(mode); setAuthParameter(mode === "headerToken" ? "X-API-Key" : mode === "bearerToken" ? "Authorization" : "token");
    setAuthRevision(value => value + 1);
  }
  function connection() {
    const parsed = separateUrlToken(source.urlTemplate.trim(), authMode === "queryToken" ? authParameter : undefined);
    if (parsed.parameter) {
      setSource(current => ({ ...current, urlTemplate: parsed.url })); setAuthMode("queryToken"); setAuthParameter(parsed.parameter); setToken(parsed.token ?? "");
      setAuthRevision(value => value + 1);
    }
    return { endpoint: { ...source, urlTemplate: parsed.url }, credential: sourceCredential(parsed.parameter ? "queryToken" : authMode, parsed.parameter ?? authParameter, parsed.token ?? token), movedToken: !!parsed.parameter };
  }
  function preview() {
    setError("");
    try { const { endpoint, credential, movedToken } = connection(); setPreviewDraft({ source: endpoint, minZoom, maxZoom }); setPreviewCredential(credential); setPreviewAuthRevision(authRevision + (movedToken ? 1 : 0)); setPreviewVersion(value => value + 1); }
    catch (cause) { setError(errorMessage(cause)); }
  }
  const duplicate = !editing && existingIds.includes(source.id);
  async function save() {
    if (!desktopAvailable || saving || duplicate) return;
    if (![source.id, source.name, source.urlTemplate].every(value => value.trim())) {
      setError("请填写图源 ID、名称和服务地址。"); return;
    }
    if (!Number.isInteger(minZoom) || !Number.isInteger(maxZoom) || minZoom < 0 || maxZoom > 22 || minZoom > maxZoom) {
      setError("缩放级别须为 0–22 的整数，最低缩放不能大于最高缩放。"); return;
    }
    setSaving(true); onSavingChange(true); setError("");
    try {
      // Recheck before writing so a new-source form cannot silently replace an existing ID.
      if (!editing && (await api.sourcesList()).some(item => item.id === source.id)) {
        setError("此图源 ID 已登记，请返回列表选择编辑，或使用新的 ID。"); return;
      }
      const { endpoint, credential } = connection();
      onSaved(await api.sourcesSave(endpoint, minZoom, maxZoom, editing, credential));
    } catch (cause) { setError(errorMessage(cause)); }
    finally { setSaving(false); onSavingChange(false); }
  }
  return <form noValidate className="source-form" aria-label={editing ? t("编辑图源") : t("登记图源")} aria-busy={saving} onSubmit={event => { event.preventDefault(); void save(); }}>
    <fieldset disabled={saving} className="source-form-fields">
    <section className="source-form-section"><div className="source-form-section-head"><h2>{t("连接信息")}</h2>{!editing && <UiTooltip content={t("填入 USGS NAIP 美国本土影像服务")}><Button type="button" variant="ghost" size="sm" className="source-example-button" whileHover={undefined} whileTap={undefined} onClick={() => { setSource(usgsConus); setMinZoom(10); setMaxZoom(18); authChange("none"); setToken(""); setError(""); }}>{t("填入示例")}</Button></UiTooltip>}</div>
      {!editing && <SelectField label={t("图源预设")} value={rasterSourcePresets.some(item => item.id === source.id) ? source.id : sourcePresets.some(([id]) => source.id === `tianditu-${id}-w`) ? source.id.split("-")[1] : "custom"} options={[{ value: "custom", label: "自定义图源" }, ...rasterSourcePresets.map(({id,name}) => ({value:id,label:name})), ...sourcePresets.map(([value, label]) => ({ value, label }))]} onChange={value => {
        if (value === "custom") { setSource(initial); setMinZoom(0); setMaxZoom(18); authChange("none"); }
        else if (rasterSourcePresets.some(item => item.id === value)) { const preset = rasterPreset(value); setSource(preset.source); setMinZoom(preset.minZoom); setMaxZoom(preset.maxZoom); authChange("none"); }
        else { const preset = tiandituPreset(value); setSource(preset.source); setMinZoom(preset.minZoom); setMaxZoom(preset.maxZoom); setAuthMode("queryToken"); setAuthParameter("tk"); setAuthRevision(value => value + 1); }
        setToken(""); setPreviewDraft(null); setError("");
      }} />}
      <div className="form-grid"><Field label={t("显示名称")}><input required value={source.name} onChange={e => change("name", e.target.value)} placeholder={t("我的影像服务")} /></Field><Field label={t("图源 ID")} hint={editing ? t("保存后保持不变。") : t("用于区分图源，保存后不可修改。")}><input required value={source.id} readOnly={editing} onChange={e => change("id", e.target.value)} placeholder="my-imagery" className="source-identifier" spellCheck={false} /></Field></div>
      {duplicate && <p className="source-form-warning" role="status">{t("此 ID 已登记。请返回列表编辑已有图源，或填写新的 ID。")}</p>}
      <Field label={t("服务地址")} hint={t("支持 XYZ/TMS、WMTS 瓦片模板和 ArcGIS ImageServer。粘贴带 Token 的地址后会移入认证字段。")}><input required value={source.urlTemplate} onChange={e => change("urlTemplate", e.target.value)} onBlur={() => { try { connection(); } catch (cause) { setError(errorMessage(cause)); } }} placeholder="https://tiles.example.com/{z}/{x}/{y}.png" className="source-endpoint" spellCheck={false} /></Field>
    </section>
    <section className="source-form-section"><div className="source-form-section-head"><h2>{t("连接认证")}</h2></div>
      <SelectField label={t("认证方式")} value={authMode} onChange={authChange} options={[{ value: "none", label: "无需认证" }, { value: "queryToken", label: "URL 参数 Token（如天地图 Key）" }, { value: "bearerToken", label: "Bearer Token" }, { value: "headerToken", label: "自定义请求头" }]} />
      {authMode !== "none" && <div className="form-grid">{authMode !== "bearerToken" && <Field label={authMode === "queryToken" ? t("认证参数名称") : t("请求头名称")}><input value={authParameter} onChange={event => { setAuthParameter(event.target.value); setAuthRevision(value => value + 1); }} placeholder={authMode === "queryToken" ? "tk / token" : "X-API-Key"} spellCheck={false} /></Field>}
        <Field label={authParameter === "tk" ? t("天地图 Key") : "Key / Token"} hint={source.authentication && source.authentication.version !== "pending" ? t("留空保持已保存的 Token；填写新值会替换。") : t("可以稍后填写，填写后才能预览和下载。")}><input type="password" autoComplete="new-password" aria-label={authParameter === "tk" ? t("天地图 Key") : "Key / Token"} value={token} onChange={event => { setToken(event.target.value); setAuthRevision(value => value + 1); }} placeholder={source.authentication?.version !== "pending" && source.authentication ? t("已保存 · 留空保持") : t("在此填写 Key / Token")} spellCheck={false} /></Field>
      </div>}
      {authMode !== "none" && <p className="source-preview-note">{t("Token 保存在本机系统凭证存储，Agent 使用已保存的连接。天地图预设使用 Web Mercator 网格。")}</p>}
      <div className="source-preview-action"><Button type="button" variant="outline" size="sm" disabled={!desktopAvailable || !source.urlTemplate.trim()} onClick={preview}><MapTrifold size={15}/>{previewDraft ? t("更新预览") : t("预览图源")}</Button><span>{previewDraft && !previewMatches ? t("参数已更改，请更新预览。") : t("预览不会保存配置。")}</span></div>
      {previewMatches && previewDraft && <SourceThumbnail key={previewVersion} target={{ draft: previewDraft, credential: previewCredential, revision: previewVersion }} name={source.name} detailed refresh />}
    </section>
    <section className="source-form-section"><div className="source-form-section-head"><h2>{t("瓦片设置")}</h2></div>
      <div className="form-grid"><SelectField label={t("瓦片编号方式")} value={source.scheme} onChange={value => change("scheme", value as HttpSource["scheme"])} options={[{ value: "XYZ", label: "XYZ" }, { value: "TMS", label: "TMS" }]} /><SelectField label={t("瓦片大小")} value={String(source.tileSize)} onChange={value => change("tileSize", Number(value))} options={[{ value: "256", label: "256 px" }, { value: "512", label: "512 px" }]} /></div>
      <div className="form-grid"><Field label={t("最低缩放级别")}><input required type="number" min="0" max={maxZoom} value={minZoom} onChange={e => { setMinZoom(Number(e.target.value)); }} /></Field><Field label={t("最高缩放级别")}><input required type="number" min={minZoom} max="22" value={maxZoom} onChange={e => { setMaxZoom(Number(e.target.value)); }} /></Field></div>
      <div className="form-grid"><SelectField label={t("图源坐标系")} value={source.coordinateSystem ?? "wgs84"} onChange={value => change("coordinateSystem", value === "gcj02" ? "gcj02" : undefined)} options={[{value:"wgs84",label:"WGS84（标准经纬度）"},{value:"gcj02",label:"GCJ-02（高德等国内图源）"}]}/><Field label={t("轮换子域（选填）")} hint={t("地址中用 {s}，多个值用逗号分隔，如 0,1,2,3。")}><input value={source.subdomains?.join(",") ?? ""} onChange={e => change("subdomains", e.target.value.split(/[,，\s]+/).filter(Boolean))} placeholder="0,1,2,3" spellCheck={false}/></Field></div>
      {source.coordinateSystem === "gcj02" && <p className="source-preview-note">{t("预览和下载时自动配准到 WGS84，与行政边界对齐。")}</p>}
    </section>
    <section className="source-more-settings"><Button type="button" variant="ghost" whileHover={undefined} whileTap={undefined} className="source-more-trigger" aria-expanded={moreOpen} aria-controls={moreId} onClick={() => setMoreOpen(!moreOpen)}><span>{t("更多设置")}<small>{t("来源、备注与连接")}</small></span><ChevronDown size={16} className={moreOpen ? "is-open" : ""} /></Button>
      <div id={moreId} hidden={!moreOpen} className="source-more-content">
        <div className="form-grid"><Field label={t("数据来源（选填）")}><input value={source.attribution} onChange={e => change("attribution", e.target.value)} placeholder={t("提供方名称")} /></Field><Field label={t("备注（选填）")}><input value={source.license} onChange={e => change("license", e.target.value)} placeholder={t("服务说明")} /></Field></div>
        <div className="form-grid"><SelectField label={t("连接类型")} value={source.networkPolicy} onChange={value => change("networkPolicy", value as HttpSource["networkPolicy"])} options={[{ value: "PublicHttps", label: "公网 HTTPS" }, { value: "UserTrustedHttp", label: "信任的 HTTP" }]} /><Field label={t("请求间隔（毫秒）")} hint={t("每个下载通道的间隔，0 表示不额外等待。")}><input required type="number" min="0" max="60000" step="50" value={source.minIntervalMs} onChange={e => change("minIntervalMs", Number(e.target.value))} /></Field></div>
      </div>
    </section>
    </fieldset>
    {editing && <p className="source-edit-note">{t("修改后需重新生成使用此图源的计划。")}</p>}
    {error && <div className="error-box" role="alert"><CircleAlert size={16} />{localize(error)}</div>}
    {!desktopAvailable && <p className="source-preview-note">{t("浏览器预览可查看表单；保存图源请使用桌面应用。")}</p>}
    <div className="source-form-actions"><Button type="button" variant="ghost" disabled={saving} onClick={onCancel}>{t("取消")}</Button><Button type="submit" disabled={!desktopAvailable || saving || duplicate}>{saving ? <Loader2 size={16} className="extension-spin" /> : <Save size={16} />}{saving ? t("正在保存…") : editing ? t("保存修改") : t("保存图源")}</Button></div>
  </form>;
}

export function SourcePage({ active, draft, reviewing, onReturn, onSaved, onOpenConnections }: {
  active: boolean; draft: SourceRegistrationDraft | null; reviewing: boolean;
  onReturn: () => void; onSaved: (source: SourceDescriptor) => void;
  onOpenConnections?: () => void;
}) {
  const page = usePageWidth();
  const [sources, setSources] = useState<SourceDescriptor[]>([]);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [editor, setEditor] = useState<{ key: string; draft: SourceRegistrationDraft | null; editing: boolean } | null>(null);
  const [openingId, setOpeningId] = useState<string | null>(null);
  const [selected, setSelected] = useState<SourceDescriptor | null>(null);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    setEditor(draft ? { key: crypto.randomUUID(), draft, editing: false } : null);
    setError(""); setNotice("");
  }, [draft]);
  useEffect(() => {
    if (!active || !desktopAvailable) return;
    let cancelled = false;
    setLoading(true); setError("");
    api.sourcesList().then(items => { if (!cancelled) setSources(items); })
      .catch(cause => { if (!cancelled) setError(errorMessage(cause)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [active]);
  async function refresh() {
    if (!desktopAvailable || loading) return;
    setLoading(true); setError("");
    try { setSources(await api.sourcesList()); } catch (cause) { setError(errorMessage(cause)); }
    finally { setLoading(false); }
  }
  async function edit(item: SourceDescriptor) {
    if (openingId) return;
    setOpeningId(item.id); setError(""); setNotice("");
    try {
      const stored = await api.sourcesGet(item.id);
      if (!stored) { setError("此图源已不存在，请刷新列表。"); return; }
      setEditor({ key: crypto.randomUUID(), editing: true, draft: { source: stored.endpoint, minZoom: stored.descriptor.minZoom, maxZoom: stored.descriptor.maxZoom } });
    } catch (cause) { setError(errorMessage(cause)); }
    finally { setOpeningId(null); }
  }
  function saved(source: SourceDescriptor) {
    setSelected(null);
    setSources(items => [...items.filter(item => item.id !== source.id), source].sort((a, b) => a.id.localeCompare(b.id)));
    setEditor(null); setNotice(`已保存图源：${source.displayName}`); onSaved(source);
  }
  const visible = sources.filter(item => `${item.id} ${item.displayName} ${item.attribution}`.toLowerCase().includes(query.trim().toLowerCase()));
  return <section ref={page.ref} className={`source-page ${editor ? "is-editing" : ""} ${selected && !editor ? "has-details" : ""} ${page.compact ? "page-compact" : ""}`} aria-label={t("图源管理")} hidden={!active} aria-busy={loading || !!openingId}>
    <header className={`source-page-head ${editor ? "source-editor-head" : ""}`}>
      {editor ? <div className="source-editor-head-inner"><UiTooltip content={reviewing ? t("返回对话") : t("返回图源列表")}><Button variant="ghost" size="icon" aria-label={reviewing ? t("返回对话") : t("返回图源列表")} disabled={saving} onClick={() => { if (reviewing) onReturn(); else setEditor(null); }}><ArrowLeft size={18}/></Button></UiTooltip><div><h1>{editor.editing ? t("编辑图源") : reviewing ? t("核对图源草稿") : t("添加图源")}</h1><p>{reviewing ? t("核对 Agent 准备的服务地址和参数。") : t("填写影像服务地址和参数。")}</p></div></div> : <><div><h1>{t("图源管理")}</h1><p>{t("管理 Agent 可用于规划和下载的影像服务。")}</p></div><div className="source-page-toolbar">{onOpenConnections && <Button variant="ghost" onClick={onOpenConnections}>{t("三维连接")}</Button>}<input aria-label={t("搜索图源")} placeholder={t("搜索图源")} value={query} onChange={event => setQuery(event.target.value)} /><UiTooltip content={t("刷新图源列表")}><Button variant="ghost" size="icon" aria-label={t("刷新图源列表")} disabled={!desktopAvailable || loading} onClick={() => void refresh()}><RefreshCw size={17} className={loading ? "extension-spin" : ""} /></Button></UiTooltip><Button variant="outline" onClick={() => { setEditor({ key: crypto.randomUUID(), draft: null, editing: false }); setNotice(""); setError(""); }}><Plus size={16} />{t("添加图源")}</Button></div></>}
    </header>
    <ScrollArea className="source-page-scroll" viewportProps={{ "aria-label": editor ? "图源配置表单" : "图源列表" }}><div className="source-page-body">
      {error && <div className="error-box" role="alert"><CircleAlert size={17} />{localize(error)}</div>}
      {notice && !editor && <div className="source-save-notice" role="status"><Check size={17} />{localize(notice)}</div>}
      {editor ? <SourceForm key={editor.key} draft={editor.draft} editing={editor.editing} existingIds={sources.map(item => item.id)} onSavingChange={setSaving} onCancel={() => { if (reviewing) onReturn(); else setEditor(null); }} onSaved={saved} /> : <>
        <div className="source-list-heading"><h2>{t("已登记图源 ")}<span>{sources.length}</span></h2><span>{t("服务配置保存在本机")}</span></div>
        {loading && <div className="extension-page-loading" role="status"><Loader2 size={17} className="extension-spin" />{t("正在读取图源…")}</div>}
        {visible.length > 0 ? <div className="source-list">{visible.map(item => <article className={`source-row ${selected?.id === item.id ? "is-selected" : ""}`} key={item.id}><SourceThumbnail target={{ registered: item }} name={item.displayName}/><Button variant="ghost" size="sm" className="source-row-select" whileHover={undefined} whileTap={undefined} aria-label={t("查看{0}配置", {"0": item.displayName})} aria-pressed={selected?.id === item.id} onClick={() => setSelected(item)}><span className="source-row-info"><strong>{item.displayName}</strong><span>{item.scheme} · {item.tileSize} px · Z{item.minZoom}–{item.maxZoom}</span></span></Button><span className="source-row-status">{item.credentialRefVersion === "pending" ? <><CircleAlert size={16} />{t("待填写 Token")}</> : <><Check size={16} />{t("已配置")}</>}</span><Button variant="ghost" size="sm" disabled={!!openingId} onClick={() => void edit(item)}>{openingId === item.id ? <Loader2 size={16} className="extension-spin" /> : <PencilSimple size={16} />}{t("编辑")}</Button></article>)}</div> : !loading && <div className="source-list-empty"><MapTrifold size={28} /><h3>{query ? t("没有匹配的图源") : t("还没有登记图源")}</h3><p>{query ? t("试试其他名称或提供方。") : t("添加影像服务，也可以在对话中让 Agent 从网络查找并配置图源。")}</p>{!query && <Button variant="outline" onClick={() => setEditor({ key: crypto.randomUUID(), draft: null, editing: false })}><Plus size={16} />{t("添加图源")}</Button>}</div>}
      </>}
    </div></ScrollArea>
    {selected && !editor && <aside className="source-detail-pane panel-scroll" aria-label={t("图源详情")}><div className="extension-details-head"><strong>{selected.displayName}</strong><Button variant="ghost" size="icon" aria-label={t("收起图源详情")} onClick={() => setSelected(null)}><X size={17}/></Button></div><SourceThumbnail key={selected.id + selected.configRevision} target={{ registered: selected }} name={selected.displayName} detailed/><dl className="task-detail-list"><div><dt>ID</dt><dd>{selected.id}</dd></div><div><dt>{t("瓦片")}</dt><dd>{selected.scheme} · {selected.tileSize} px</dd></div><div><dt>{t("缩放")}</dt><dd>Z{selected.minZoom}–{selected.maxZoom}</dd></div><div><dt>{t("来源")}</dt><dd>{selected.attribution || t("未填写")}</dd></div><div><dt>{t("备注")}</dt><dd>{selected.license || t("未填写")}</dd></div></dl><Button variant="outline" size="sm" disabled={!!openingId} onClick={() => void edit(selected)}><PencilSimple size={16}/>{t("编辑配置")}</Button></aside>}
  </section>;
}
