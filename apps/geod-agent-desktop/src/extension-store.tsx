import { t, localize } from "./i18n";
// i18n: presentation strings migrated
import { useEffect, useRef, useState, type FormEvent } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { Button } from "@/components/motion/button/base";
import { CircleAlert, Loader2, Network, Plus, PuzzlePiece, X } from "./icons";
import { api, desktopAvailable, errorMessage, type ExtensionOverview, type McpToolList, type OnlineSkillCandidate, type RegistryMcpItem, type RemoteSkillStage, type SkillSourceCandidate } from "./api";
import {AMAP_MCP_URL,mcpProvider,providerSetupProposal} from './mcp-provider-presets';
import {McpKeyDialog} from './mcp-key-dialog';
import {ConnectorActions} from './connector-actions';
import { SOURCE_CREATOR_ID, sourceCreatorContent, sourceCreatorSummary } from "./builtin-skills";
import { dataInputTools } from "./data-input-tools";
import { usePageWidth } from "./use-page-width";
import {McpOAuthPanel} from "./mcp-oauth-panel";
import { MemoryPanel } from "./memory-panel";
import { PluginPanel } from "./plugin-panel";
import {GisSkills} from "./gis-skills";
import {RtkOutputComponent} from "./rtk-output-component";

const gdalToolLabels: Record<string, string> = {
  raster_info: "栅格信息", raster_stats: "栅格统计", raster_convert: "栅格转换", raster_reproject: "栅格重投影",
  vector_info: "矢量信息", vector_convert: "矢量转换", vector_clip: "矢量裁剪",
  vector_buffer: "缓冲区", vector_simplify: "矢量简化", vector_reproject: "矢量重投影",
};

export function ExtensionStorePage({ active, conversationId }: { active: boolean; conversationId: string }) {
  const page = usePageWidth();
  const [tab, setTab] = useState<"skills" | "mcp" | "plugins" | "memory">("skills");
  const [items, setItems] = useState<ExtensionOverview>({ skills: [sourceCreatorSummary], connectors: [] });
  const [builtinPreview, setBuiltinPreview] = useState(false);
  const [databasePreview, setDatabasePreview] = useState(false);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<RegistryMcpItem[]>([]);
  const [showCustomConnector, setShowCustomConnector] = useState(false);
  const [skillQuery, setSkillQuery] = useState("");
  const [skillResults, setSkillResults] = useState<OnlineSkillCandidate[]>([]);
  const [skillLink, setSkillLink] = useState("");
  const [showSkillLink, setShowSkillLink] = useState(false);
  const [skillSources, setSkillSources] = useState<SkillSourceCandidate[]>([]);
  const [skillReview, setSkillReview] = useState<RemoteSkillStage | null>(null);
  const [skillPreview, setSkillPreview] = useState("");
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [credentialSetup,setCredentialSetup]=useState<string|null>(null);
  const [transport,setTransport]=useState<"http"|"stdio">("http");
  const [command,setCommand]=useState("");
  const [processArgs,setProcessArgs]=useState("[]");
  const [processEnv,setProcessEnv]=useState("{}");
  const [httpHeaders,setHttpHeaders]=useState("{}");
  const [oauthConnectorId,setOauthConnectorId]=useState<string|null>(null);
  const [details, setDetails] = useState<McpToolList | null>(null);
  const [pendingEnable, setPendingEnable] = useState<string | null>(null);
  const [connectorProgress, setConnectorProgress] = useState<{ id: string; mode: "inspect" | "enable" } | null>(null);
  const [connectorError, setConnectorError] = useState<{ id: string; message: string } | null>(null);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const detailsRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!active || !desktopAvailable) return;
    let cancelled = false;
    setLoading(true);
    void api.extensionsList().then(value => { if (!cancelled) setItems(value); })
      .catch(cause => { if (!cancelled) setError(errorMessage(cause)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [active]);

  useEffect(() => {
    if (!connectorProgress) return;
    const started = Date.now();
    setElapsedSeconds(0);
    const timer = window.setInterval(() => setElapsedSeconds(Math.floor((Date.now() - started) / 1000)), 1000);
    return () => window.clearInterval(timer);
  }, [connectorProgress]);

  const detailOpen = tab === "skills" ? builtinPreview || !!skillReview : tab === "mcp" && (databasePreview || !!details || !!oauthConnectorId);
  const detailTrigger = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (detailOpen) {
      detailTrigger.current = document.activeElement as HTMLElement;
      detailsRef.current?.focus({ preventScroll: true });
    } else if (detailTrigger.current?.isConnected) {
      detailTrigger.current.focus({ preventScroll: true }); detailTrigger.current = null;
    }
  }, [detailOpen]);

  async function run(action: () => Promise<void>) {
    setBusy(true); setError("");
    try { await action(); }
    catch (cause) { setError(errorMessage(cause)); }
    finally { setBusy(false); }
  }

  async function importSkill() {
    const selected = await open({ directory: true, multiple: false, title: "选择包含 SKILL.md 的 Skill 文件夹" });
    if (typeof selected === "string") setItems(await api.skillImport(selected));
  }

  function searchSkills(event: FormEvent) {
    event.preventDefault();
    void run(async () => {
      setSkillSources([]);
      setSkillResults(await api.skillCatalogSearch(skillQuery));
    });
  }

  function inspectSkillLink(event: FormEvent) {
    event.preventDefault();
    void run(async () => {
      setSkillResults([]);
      setSkillSources(await api.skillSourceInspect(skillLink.trim()));
    });
  }

  async function stageSkill(source: string) {
    const staged = await api.skillRemoteStage(source);
    setItems(await api.extensionsList());
    setSkillReview(staged);
    setSkillPreview(await api.skillPreview(staged.id));
  }

  async function enableStagedSkill() {
    if (!skillReview) return;
    const current = (await api.extensionsList()).skills.find(skill => skill.id === skillReview.id);
    if (current?.sourceUrl !== skillReview.sourceUrl || current.contentSha256 !== skillReview.contentSha256) {
      throw new Error("Skill 内容已变化，请重新检查来源和内容");
    }
    setItems(await api.skillSetEnabled(skillReview.id, true));
    setSkillReview(null);
    setSkillPreview("");
  }

  async function reviewSavedSkill(skill: ExtensionOverview["skills"][number]) {
    if (!skill.sourceUrl || !skill.contentSha256) {
      setItems(await api.skillSetEnabled(skill.id, true));
      return;
    }
    setSkillReview({ id: skill.id, name: skill.name, description: skill.description,
      sourceUrl: skill.sourceUrl, contentSha256: skill.contentSha256, enabled: false });
    setSkillPreview(await api.skillPreview(skill.id));
  }

  async function addConnector(label: string, address: string) {
    if(mcpProvider(address.trim())){setCredentialSetup(address.trim());return;}
    setItems(await api.mcpAdd(label.trim(), address.trim()));
    setName(""); setUrl("");
  }

  function submitConnector(event: FormEvent) {
    event.preventDefault();
    void run(async () => {
      function object(value:string,label:string):Record<string,string> {
        let parsed:unknown;
        try{parsed=JSON.parse(value);}catch{throw new Error(`${label}应为 JSON 对象`);}
        if(!parsed || Array.isArray(parsed) || typeof parsed!=="object" || Object.values(parsed).some(value=>typeof value!=="string"))throw new Error(`${label}应为键和值都是文本的 JSON 对象`);
        return parsed as Record<string,string>;
      }
      if(transport==="stdio") {
        let args:unknown;try{args=JSON.parse(processArgs);}catch{throw new Error("启动参数应为 JSON 文本数组");}
        if(!Array.isArray(args)||args.some(value=>typeof value!=="string"))throw new Error("启动参数应为 JSON 文本数组");
        setItems(await api.mcpAdd(name.trim(),"",{command:command.trim(),args,env:object(processEnv,"环境变量")}));
       } else {if(mcpProvider(url.trim())){setCredentialSetup(url.trim());return;}setItems(await api.mcpAdd(name.trim(),url.trim(),{headers:object(httpHeaders,"请求头")}));}
      setName("");setUrl("");setCommand("");setProcessArgs("[]");setProcessEnv("{}");setHttpHeaders("{}");setShowCustomConnector(false);
    });
  }

  function search(event: FormEvent) {
    event.preventDefault();
    void run(async () => { setResults(await api.mcpRegistrySearch(query)); });
  }

  async function inspectConnector(connector: ExtensionOverview["connectors"][number], requestEnable: boolean) {
    setOauthConnectorId(null);
    setDatabasePreview(false);
    if (busy) return;
    setBusy(true);
    setError("");
    setConnectorError(null);
    setPendingEnable(null);
    setDetails(null);
    setConnectorProgress({ id: connector.id, mode: requestEnable ? "enable" : "inspect" });
    try {
      const toolList = await api.mcpTools(connector.id, conversationId);
      setDetails(toolList);
      if (requestEnable) setPendingEnable(connector.id);
    } catch (cause) {
      setConnectorError({ id: connector.id, message: errorMessage(cause) });
    } finally {
      setConnectorProgress(null);
      setBusy(false);
    }
  }

  const selectedConnector = items.connectors.find(connector => connector.id === details?.connectorId);
  const oauthConnector=items.connectors.find(connector=>connector.id===oauthConnectorId);

  return <section ref={page.ref} className={`extension-store ${detailOpen ? "has-details" : ""} ${page.compact ? "page-compact" : ""}`} aria-label={t("技能与连接器")} hidden={!active} aria-busy={loading || busy}>
      <header className="extension-page-title"><div><h1>{t("技能与连接器")}</h1><p>{t("管理 Agent 可调用的技能和工具")}</p></div></header>
      {credentialSetup&&<McpKeyDialog proposal={providerSetupProposal(credentialSetup,'provider-setup')} conversationId={conversationId} onClose={()=>setCredentialSetup(null)} onConnected={(connector,tools)=>{void api.extensionsList().then(setItems).catch(e=>setError(errorMessage(e)));setDetails(tools);setPendingEnable(connector.id);setShowCustomConnector(false);}}/>}
      <header className="extension-store-head">
        <nav className="extension-store-tabs" aria-label={t("扩展类别")}>
          <Button variant="ghost" size="sm" className={tab === "skills" ? "active" : ""} aria-pressed={tab === "skills"} onClick={() => setTab("skills")}><PuzzlePiece size={17} />{t("技能 ")}<span>{items.skills.length}</span></Button>
          <Button variant="ghost" size="sm" className={tab === "mcp" ? "active" : ""} aria-pressed={tab === "mcp"} onClick={() => setTab("mcp")}><Network size={17} />{t("连接器 ")}<span>{items.connectors.length + 1}</span></Button>
          <Button variant="ghost" size="sm" className={tab === "memory" ? "active" : ""} aria-pressed={tab === "memory"} onClick={() => setTab("memory")}>{t("记忆")}</Button>
          <Button variant="ghost" size="sm" className={tab === "plugins" ? "active" : ""} aria-pressed={tab === "plugins"} onClick={() => setTab("plugins")}>{t("插件")}</Button>
        </nav>
        <div className="extension-catalog-toolbar" hidden={tab === "memory" || tab === "plugins"}>
          <form onSubmit={tab === "skills" ? searchSkills : search}>
            <input value={tab === "skills" ? skillQuery : query} onChange={event => tab === "skills" ? setSkillQuery(event.target.value) : setQuery(event.target.value)} placeholder={tab === "skills" ? t("搜索技能") : t("搜索连接器")} aria-label={tab === "skills" ? t("搜索在线 Skill") : t("搜索 MCP Registry")} minLength={2} maxLength={80} />
            <Button size="sm" variant="outline" type="submit" disabled={busy || !desktopAvailable || (tab === "skills" ? skillQuery : query).trim().length < 2}>{busy && <Loader2 size={16} className="extension-spin" />}{t("搜索")}</Button>
          </form>
          <div className="extension-toolbar-actions">
            {tab === "skills" ? <><Button size="sm" variant="outline" aria-expanded={showSkillLink} onClick={() => setShowSkillLink(value => !value)}><Plus size={16} />{t("通过链接添加")}</Button><Button size="sm" variant="ghost" onClick={() => void run(importSkill)} disabled={busy || !desktopAvailable}>{t("导入本地")}</Button></> : <Button size="sm" variant="outline" aria-expanded={showCustomConnector} onClick={() => setShowCustomConnector(value => !value)}><Plus size={16} />{t("自定义连接器")}</Button>}
          </div>
        </div>
      </header>
      {error && <div className="extension-error"><CircleAlert size={17} /><span>{localize(error)}</span><button type="button" aria-label={t("关闭错误")} onClick={() => setError("")}><X size={16} /></button></div>}
      <div className="extension-store-body">
        {loading && <div className="extension-page-loading" role="status"><Loader2 size={17} className="extension-spin" />{t("正在读取已添加的技能与连接器…")}</div>}
        {tab === "plugins" ? <PluginPanel active={active&&tab==="plugins"} conversationId={conversationId} onChanged={()=>void api.extensionsList().then(setItems).catch(e=>setError(errorMessage(e)))}/> : tab === "memory" ? <MemoryPanel active={active&&tab==="memory"} conversationId={conversationId}/> : tab === "skills" ? <>
          {showSkillLink && <form className="extension-skill-link-form" onSubmit={inspectSkillLink}><input value={skillLink} onChange={event => setSkillLink(event.target.value)} placeholder={t("https://skills.sh/... 或 GitHub / SKILL.md 链接")} aria-label={t("检查 Skill 链接")} type="url" required /><Button size="sm" variant="outline" type="submit" disabled={busy || !skillLink.trim()}>{t("检查链接")}</Button><Button size="icon" variant="ghost" aria-label={t("收起 Skill 链接")} onClick={() => setShowSkillLink(false)}><X size={17} /></Button></form>}
          <GisSkills active={active&&tab==="skills"} revision={JSON.stringify(items.skills.map(s=>[s.id,s.enabled]))} onChanged={async()=>setItems(await api.extensionsList())}/>
          <RtkOutputComponent active={active&&tab==="skills"}/>
          <section className="extension-catalog-section" aria-labelledby="extension-saved-skills-title"><div className="extension-catalog-heading"><h3 id="extension-saved-skills-title">{t("我的 Skills ")}<span>{items.skills.length}</span></h3></div>{items.skills.length ? <div className="extension-connector-grid">{items.skills.map(skill => <article className="extension-tile" key={skill.id}><div className="extension-tile-top"><span className="extension-tile-icon"><PuzzlePiece size={18} /></span><strong>{skill.id === SOURCE_CREATOR_ID ? t("图源 Creator") : skill.name}</strong><span className={skill.enabled ? "extension-status enabled" : "extension-status"}>{skill.enabled ? t("已启用") : t("未启用")}</span></div><p className="extension-tile-description">{skill.id===SOURCE_CREATOR_ID?t(skill.description):skill.description || skill.sourceUrl || t("Skill 指令")}</p><div className="extension-tile-actions">{skill.id === SOURCE_CREATOR_ID && <Button variant="ghost" size="sm" onClick={() => { setSkillReview(null); setBuiltinPreview(current => !current); }}>{t("查看指令")}</Button>}<Button variant={skill.enabled ? "secondary" : "outline"} size="sm" disabled={busy || !desktopAvailable} onClick={() => void run(async () => { if (skill.enabled) setItems(await api.skillSetEnabled(skill.id, false)); else await reviewSavedSkill(skill); })}>{skill.enabled ? t("停用") : skill.sourceUrl ? t("检查并启用") : t("启用")}</Button></div></article>)}</div> : <p className="extension-empty-inline">{t("还没有 Skill。可以搜索、粘贴链接或导入本地文件夹。")}</p>}</section>
          <section className="extension-catalog-section" aria-labelledby="extension-find-skills-title"><div className="extension-catalog-heading"><h3 id="extension-find-skills-title">{t("发现 Skills")}</h3><p>{t("获取后先检查指令内容，再决定是否启用。")}</p></div>{skillResults.length || skillSources.length ? <div className="extension-connector-grid">{[...skillResults, ...skillSources].map(item => <article className="extension-tile" key={item.id}><div className="extension-tile-top"><span className="extension-tile-icon"><PuzzlePiece size={18} /></span><strong>{item.name}</strong></div><p className="extension-tile-description">{item.source}</p><div className="extension-tile-actions"><Button size="sm" variant="outline" disabled={busy} onClick={() => void run(() => stageSkill(item.id))}>{t("获取并检查")}</Button></div></article>)}</div> : <p className="extension-empty-inline">{t("搜索所需能力，或使用上方入口添加 Skill。")}</p>}</section>
        </> : <>
          {showCustomConnector && <form className="extension-custom-form extension-runtime-form" onSubmit={submitConnector}>
            <div className="extension-runtime-heading"><strong>{t("添加连接器")}</strong><Button size="icon" variant="ghost" aria-label={t("收起自定义连接器")} onClick={()=>setShowCustomConnector(false)}><X size={17}/></Button></div>
            <div className="extension-runtime-tabs" aria-label={t("MCP 连接方式")}><Button size="sm" variant={transport==="http"?"secondary":"ghost"} aria-pressed={transport==="http"} onClick={()=>setTransport("http")}>{t("在线服务")}</Button><Button size="sm" variant={transport==="stdio"?"secondary":"ghost"} aria-pressed={transport==="stdio"} onClick={()=>setTransport("stdio")}>{t("本机命令 · stdio")}</Button></div>
            <label>{t("名称")}<input value={name} onChange={event=>setName(event.target.value)} placeholder={t("连接器名称")} maxLength={80} required/></label>
            {transport==="http"?<><label>{t("服务地址")}<input value={url} onChange={event=>setUrl(event.target.value)} placeholder="https://example.com/mcp" type="url" required/></label><label>{t("认证请求头 ")}<span>{t("可选")}</span><textarea className="extension-secret-input" value={httpHeaders} onChange={event=>setHttpHeaders(event.target.value)} spellCheck={false} autoComplete="off" aria-label={t("MCP 认证请求头")} placeholder={'{"Authorization":"Bearer …"}'}/></label></>:<><label>{t("可执行程序")}<input value={command} onChange={event=>setCommand(event.target.value)} placeholder={t("node 或本机程序的完整路径")} required/></label><label>{t("启动参数")}<textarea value={processArgs} onChange={event=>setProcessArgs(event.target.value)} spellCheck={false} aria-label={t("MCP 启动参数")} placeholder={'["C:/tools/server.mjs"]'}/></label><label>{t("环境变量 ")}<span>{t("可选")}</span><textarea className="extension-secret-input" value={processEnv} onChange={event=>setProcessEnv(event.target.value)} spellCheck={false} autoComplete="off" aria-label={t("MCP 环境变量")} placeholder={'{"API_KEY":"…"}'}/></label></>}
            <div className="extension-runtime-footer"><p>{transport==="stdio"?t("在当前对话工作区启动你信任的本机服务。参数和环境变量保存在系统凭据库。"):t("支持 Streamable HTTP。认证信息保存在系统凭据库，不会加入模型上下文。")}</p><Button size="sm" type="submit" disabled={busy}>{t("保存连接器")}</Button></div>
          </form>}
          <section className="extension-catalog-section" aria-labelledby="extension-connected-title">
            <div className="extension-catalog-heading"><h3 id="extension-connected-title">{t("我的连接器 ")}<span>{items.connectors.length + 1}</span></h3></div>
            <div className="extension-connector-grid"><article className="extension-tile"><div className="extension-tile-top"><span className="extension-tile-icon"><Network size={18} /></span><strong>PostgreSQL / PostGIS</strong><span className="extension-status">{t("内置")}</span></div><p className="extension-tile-description">{t("连接数据库，发现空间图层、读取字段和裁剪范围")}</p><div className="extension-tile-actions"><Button variant="ghost" size="sm" aria-expanded={databasePreview} onClick={() => { setDetails(null); setPendingEnable(null); setDatabasePreview(value => !value); }}>{t("查看用法")}</Button></div></article>{items.connectors.map(connector =>
              <article className="extension-tile" key={connector.id} aria-busy={connectorProgress?.id === connector.id}>
                <div className="extension-tile-top"><span className="extension-tile-icon">{connector.transport === "gdalStdio" || connector.transport === "stdio" ? <PuzzlePiece size={18} /> : <Network size={18} />}</span><strong>{connector.name}</strong><span className={connector.enabled ? "extension-status enabled" : "extension-status"}>{connector.enabled ? t("已启用") : t("未启用")}</span></div>
                <p className="extension-tile-description">{connector.transport === "embedded" ? t("内置 · {0}", {"0": connector.url}) : connector.transport === "gdalStdio" ? t("本机 · 当前对话工作区") : connector.transport==="stdio"?t("本机 · {0} · {1} 个参数", {"0": connector.command, "1": connector.argumentCount??0}):connector.url}</p>
                {!!connector.queryNames?.length&&<p className="extension-credential-label">{t("已保存认证 · ")}{connector.queryNames.join("、")}</p>}{!!connector.headerNames?.length && <p className="extension-credential-label">{t("已保存认证 · ")}{connector.headerNames.join("、")}</p>}
                {connectorProgress?.id === connector.id && <div className="extension-tile-progress"><Loader2 size={17} className="extension-spin" /><span><span role="status">{connector.transport === "gdalStdio" ? t("正在启动 GDAL 并读取工具") : t("正在连接并读取工具")}</span><span aria-hidden="true"> · {elapsedSeconds} {t(" 秒")}</span>{connector.transport === "gdalStdio" && <small>{t("GIS 组件从技能页单独安装，运行时使用本机缓存")}</small>}</span></div>}
                {connectorError?.id === connector.id && <p className="extension-tile-error" role="alert"><CircleAlert size={16} />{connectorError.message}</p>}
                <ConnectorActions connector={connector} busy={busy} progress={connectorProgress?.id===connector.id?connectorProgress.mode:undefined}
                  onInspect={()=>void inspectConnector(connector,false)} onToggle={()=>void(connector.enabled?run(async()=>setItems(await api.mcpSetEnabled(connector.id,false))):inspectConnector(connector,true))}
                  onKey={mcpProvider(connector.url)?()=>setCredentialSetup(connector.url):undefined}
                  onAuth={connector.transport==='http'&&connector.url!==AMAP_MCP_URL?()=>{setDetails(null);setDatabasePreview(false);setOauthConnectorId(connector.id);}:undefined}
                  onRemove={connector.transport!=='embedded'?()=>void run(async()=>{setItems(await api.mcpRemove(connector.id));if(oauthConnectorId===connector.id)setOauthConnectorId(null);if(details?.connectorId===connector.id){setDetails(null);setPendingEnable(null);}}):undefined}/>
              </article>
            )}</div>
          </section>
          <section className="extension-catalog-section" aria-labelledby="extension-discover-title">
            <div className="extension-catalog-heading"><h3 id="extension-discover-title">{t("发现连接器")}</h3><p>{t("搜索公开 HTTP 服务或官方服务预设，添加前请核对来源和认证要求。")}</p></div>
            {(results.length > 0) ? <div className="extension-connector-grid">

              {results.map(item => <article className="extension-tile" key={item.name}><div className="extension-tile-top"><span className="extension-tile-icon"><Network size={18} /></span><strong>{item.title}</strong><span className="extension-status">MCP</span></div><p className="extension-tile-description">{item.description || item.url}</p><div className="extension-tile-actions"><Button size="sm" variant="outline" disabled={busy || items.connectors.some(connector => connector.url === item.url)} onClick={() => void run(() => addConnector(item.title.slice(0, 80), item.url))}>{items.connectors.some(connector => connector.url === item.url) ? t("已添加") : <><Plus size={16} />{t("添加")}</>}</Button></div></article>)}
            </div> : <p className="extension-empty-inline">{t("输入关键词搜索公开 MCP 服务，或添加自定义地址。")}</p>}
          </section>
        </>}
      </div>
      <div ref={detailsRef} className="extension-detail-pane panel-scroll" hidden={!detailOpen} tabIndex={-1} aria-label={t("扩展详情")}>
{builtinPreview && <div className="extension-details"><div className="extension-details-head"><strong>{t("图源 Creator · 内置技能")}</strong><Button variant="ghost" size="icon" aria-label={t("收起 Creator 指令")} onClick={() => setBuiltinPreview(false)}><X size={17} /></Button></div><p>{t("在对话里提供影像服务网址或接入需求，Agent 会读取服务信息并保存图源配置。")}</p><pre className="agent-skill-preview">{sourceCreatorContent}</pre></div>}
{skillReview && <div className="extension-details"><div className="extension-details-head"><strong>{t("启用前检查 · ")}{skillReview.name}</strong><Button size="icon" variant="ghost" aria-label={t("关闭 Skill 检查")} onClick={() => { setSkillReview(null); setSkillPreview(""); }}><X size={17} /></Button></div><p className="extension-review-source">{t("来源：")}{skillReview.sourceUrl}<br />SHA-256：{skillReview.contentSha256}</p><pre className="agent-skill-preview">{skillPreview}</pre><p>{t("GitHub 与本地文件夹会保留脚本和参考资源，Codex 可在工作区权限范围内使用。其他 SKILL.md 链接只包含指令。")}</p><div className="extension-review-actions"><Button variant="ghost" size="sm" onClick={() => { setSkillReview(null); setSkillPreview(""); }}>{t("暂不启用")}</Button><Button size="sm" disabled={busy || !skillPreview} onClick={() => void run(enableStagedSkill)}>{t("确认启用")}</Button></div></div>}
{databasePreview && <div className="extension-details"><div className="extension-details-head"><strong>PostgreSQL / PostGIS · pgEdge MCP</strong><Button variant="ghost" size="icon" aria-label={t("收起数据库用法")} onClick={() => setDatabasePreview(false)}><X size={17} /></Button></div><p>{t("直接在对话里告诉 Agent 数据库地址、端口、库名和用户名。需要认证时会打开本机密码输入框；也可以使用工作区内的连接配置 JSON。")}</p><p>{t("例如：“连接我的 PostGIS，查看有哪些图层，读取边界表作为下载范围。”已有连接可以直接按名称使用。")}</p><div className="extension-tool-list">{dataInputTools().tools.map(tool => <span key={tool.name}>{tool.name}</span>)}</div><p>{t("只读访问。密码保存在系统凭据库，几何数据留在桌面端。内置运行环境由应用管理，无需单独安装 MCP。")}</p></div>}
{oauthConnector&&<div className="extension-details"><div className="extension-details-head"><strong>{oauthConnector.name} {t(" · 浏览器授权")}</strong><Button size="icon" variant="ghost" aria-label={t("收起 MCP 浏览器授权")} onClick={()=>setOauthConnectorId(null)}><X size={17}/></Button></div><McpOAuthPanel key={oauthConnector.id} connector={oauthConnector} onUpdated={async()=>setItems(await api.extensionsList())}/></div>}
{details && selectedConnector && <div className="extension-details"><div className="extension-details-head"><strong>{selectedConnector.name} · {details.tools.length} {t(" 个工具")}</strong><Button size="icon" variant="ghost" aria-label={t("收起工具详情")} onClick={() => { setDetails(null); setPendingEnable(null); }}><X size={17} /></Button></div><div className="extension-tool-list">{details.tools.length ? details.tools.map(tool => <span key={tool.name}>{selectedConnector.transport === "gdalStdio" ? `${gdalToolLabels[tool.name] ?? tool.name} · ${tool.name}` : tool.name}</span>) : t("此服务未返回工具")}</div>{pendingEnable === selectedConnector.id && <div className="extension-approval"><p>{t("启用后，Agent 可以在对话中调用这些工具。")}{selectedConnector.transport === "gdalStdio" ? t("GDAL 可读取当前工作区文件；转换、裁剪、缓冲区、简化和重投影仅在完全访问模式下写入新文件。") : t("此服务可能读取或更改外部数据；请确认你信任该地址。")}</p><div><Button variant="ghost" size="sm" onClick={() => setPendingEnable(null)}>{t("取消")}</Button><Button size="sm" disabled={busy} onClick={() => void run(async () => { setItems(await api.mcpSetEnabled(selectedConnector.id, true)); setPendingEnable(null); })}>{t("确认启用")}</Button></div></div>}</div>}
      </div>
  </section>;
}
