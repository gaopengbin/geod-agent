import type { UserInputQuestion, UserInputReply } from "./user-input";

export function normalizeExportCrs(value: string): string | null {
  const code = value.trim().match(/^EPSG\s*:\s*(\d{1,5})$/i)?.[1];
  return code && +code > 0 && +code < 32767 ? `EPSG:${+code}` : null;
}
const directText = (value: string) => value.split(/\n已附加边界：/)[0].replace(/```[\s\S]*?```|`[^`]*`|“[^”]*”|‘[^’]*’|"[^"]*"|'[^']*'/g, " ");
export function humanCrsIntent(text: string): { crs: string | null; session: boolean; clear: boolean; needsClarification?: true } {
  const direct = directText(text);
  const session = !/如果|除非|unless|\bif\b/i.test(direct) && /(?:本|当前|这个)(?:次)?(?:会话|对话).*(?:都|均|统一|默认|一直|全部)|(?:之后|后续|以后).*(?:都|均|统一|默认).*(?:坐标系|EPSG)|(?:this conversation|this chat|session default)/i.test(direct);
  const clear = /(?:取消|清除|重置|不再沿用).*(?:默认坐标系|会话坐标系)|(?:坐标系).*(?:每次|逐次).*(?:问|询问)|clear.*(?:crs|coordinate).*default/i.test(direct);
  const explicitOutput=direct.match(/(?:导出|输出|成果|目标|转换(?:成|为|到)|export|output|target|reproject)[^。；;\n]*/i)?.[0];
  const codes = [...(explicitOutput ?? direct).matchAll(/EPSG\s*:\s*(\d{1,5})/gi)].map(match => normalizeExportCrs(`EPSG:${match[1]}`)).filter(Boolean);
  // Source/input/map CRS is not an export instruction. Ambiguous alternatives must be asked.
  const sourceOnly = /(?:源|输入|原始|地图)(?:数据)?坐标系|source crs|input crs|map projection/i.test(direct) && !/导出|输出|成果|目标|转换(?:成|为|到)|export|output|target|reproject/i.test(direct);
  const unique = [...new Set(codes)];
  let crs = !sourceOnly && unique.length === 1 ? unique[0] : null;
  if (!sourceOnly && !unique.length && /(?:用|为|成|到|按|export.*in|use)\s*(?:WGS\s*84\s*(?:经纬度)?|Web\s*Mercator|网络墨卡托|Web\s*墨卡托)/i.test(direct)) crs = /Mercator|墨卡托/i.test(direct) ? "EPSG:3857" : "EPSG:4326";
  const unresolved = !crs && ((!sourceOnly && /坐标系|投影|EPSG|CGCS\s*2000|UTM|高斯|北京\s*54|西安\s*80|\bcrs\b|projection/i.test(direct)) || /(?:保留|保持|沿用).*(?:图源|原始|源).*(?:坐标系|投影)/.test(direct));
  return { crs: crs ?? null, session, clear, ...(unresolved ? {needsClarification:true as const} : {}) };
}

export function resolveExportCrs(intent: ReturnType<typeof humanCrsIntent>, answer: string | null | undefined, conversationDefault: string | null | undefined, delegated: boolean, raster: boolean): string | null {
  if (intent.crs) return intent.crs;
  if (answer) return answer;
  if (intent.needsClarification || intent.clear) return null;
  return conversationDefault ?? (delegated ? raster ? "EPSG:3857" : "EPSG:4326" : null);
}

export const exportCrsQuestions: UserInputQuestion[] = [
  { id: "export_crs", header: "成果坐标系", question: "成果要使用哪个坐标系？栅格转换默认采用最近邻，保留原像素取值；可在自定义回答中说明其他要求。", options: [
    { label: "EPSG:4326 · WGS84 经纬度", description: "通用经纬度数据；影像下载后重投影，矢量可导出 GeoJSON 或 GeoPackage。" },
    { label: "EPSG:3857 · Web 墨卡托", description: "适合网页地图；影像保留下载网格，矢量需使用 GeoPackage。" },
    { label: "EPSG:4490 · CGCS2000 经纬度", description: "适合 CGCS2000 地理坐标；高斯投影或 UTM 请自定义具体 EPSG 编号、投影带。" },
  ] },
  { id: "export_crs_scope", header: "应用范围", question: "这个坐标系应用到哪里？", options: [
    { label: "仅本次任务", description: "下次未明确坐标系时继续询问；本次批量任务使用同一坐标系。" },
    { label: "当前会话默认", description: "本会话后续任务沿用；单次明确指定可覆盖，不影响其他会话。" },
  ] },
];

export function crsFromAnswers(questions: UserInputQuestion[], reply: UserInputReply | null): { crs: string; session: boolean; resampling?: "nearest" | "bilinear" | "cubic" } | null {
  if (!reply) return null;
  const answers = questions.filter(q => {
    const text=q.id+' '+q.header+' '+q.question;
    return !/(?:源|输入|原始).*(?:坐标|投影)|(?:source|input|original).*?(?:crs|coordinate|projection)/i.test(text)&&/坐标|投影|西安\s*80|北京\s*54|CGCS\s*2000|xian[_ ]?(?:19)?80|\bcrs\b|projection|coordinate|export_crs/i.test(text)&&!/应用范围|应用方式|scope|apply_mode/i.test(q.id+' '+q.header);
  }).map(q => {
    const value=reply.answers[q.id]?.answers[0]??'';
    // The accepted option may put its EPSG code in the description rather than its label.
    const option=q.options?.find(option=>option.label===value);
    return value+' '+(option?.description??'');
  });
  const codes = [...answers.join(" ").matchAll(/EPSG\s*:\s*(\d{1,5})/gi)].map(m => normalizeExportCrs(`EPSG:${m[1]}`)).filter(Boolean);
  if (new Set(codes).size !== 1) return null;
  const resampling = /双线性|bilinear/i.test(answers.join(" ")) ? "bilinear" : /三次|cubic/i.test(answers.join(" ")) ? "cubic" : undefined;
  const scope=questions.map(q=>{const value=reply.answers[q.id]?.answers[0]??'';return value+' '+(q.options?.find(o=>o.label===value)?.description??'');}).join(' ');
  return { crs: codes[0]!, session: /当前会话默认|(?:本|当前|这个)会话.*(?:都|默认)|将会话默认|替换并设为默认|current conversation default|this.*chat.*default/i.test(scope), resampling };
}

export function isExportPlan(name: string, args: Record<string, unknown>) {
  return name === "plan_imagery" || name === "plan_imagery_batch" || (name === "data_download_plan" && args.kind !== "tiles3d");
}
