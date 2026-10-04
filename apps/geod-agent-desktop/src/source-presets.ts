import type { SourceCredentialInput, SourceRegistrationDraft } from "./api";
import catalog from "../../../contracts/source-presets.v1.json";

export const rasterSourcePresets = catalog.presets;
export function rasterPreset(id: string): SourceRegistrationDraft {
  const preset = rasterSourcePresets.find(item => item.id === id);
  if (!preset) throw new Error("未知图源预设");
  return { source: {id:preset.id,name:preset.name,urlTemplate:preset.urlTemplate,attribution:preset.attribution,
    license:"",scheme:"XYZ",tileSize:256,networkPolicy:"PublicHttps",minIntervalMs:0,...(preset.subdomains ? {subdomains:[...preset.subdomains]} : {}),...(preset.coordinateSystem === "gcj02" ? {coordinateSystem:"gcj02" as const} : {}),...(preset.elevationEncoding === "terrarium" ? {elevationEncoding:"terrarium" as const} : {})},minZoom:preset.minZoom,maxZoom:preset.maxZoom };
}

export const sourcePresets = [
  ["img", "天地图 · 影像"], ["cia", "天地图 · 影像注记"],
  ["vec", "天地图 · 矢量底图"], ["cva", "天地图 · 矢量注记"],
  ["cta", "天地图 · 地形注记"],
] as const;

export function tiandituPreset(layer: string): SourceRegistrationDraft {
  const preset = sourcePresets.find(([id]) => id === layer);
  if (!preset) throw new Error("未知天地图图层");
  return { source: { id: `tianditu-${layer}-w`, name: preset[1], attribution: "天地图", license: "",
    urlTemplate: `https://t{s}.tianditu.gov.cn/${layer}_w/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=${layer}&STYLE=default&TILEMATRIXSET=w&FORMAT=tiles&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}`,
    subdomains: ["0","1","2","3","4","5","6","7"], scheme: "XYZ", tileSize: 256, networkPolicy: "PublicHttps", minIntervalMs: 0 },
    minZoom: 1, maxZoom: 18, authenticationMode: "queryToken", authenticationParameter: "tk" };
}

const secretParameter = /^(tk|token|access_token|api_key|apikey|key|authorization|signature|sig)$/i;
/** Split a pasted URL without encoding the XYZ placeholders. No value is logged. */
export function separateUrlToken(raw: string, authenticationParameter?: string): { url: string; parameter?: string; token?: string } {
  if (raw.includes("#")) throw new Error("图源地址不能包含 # 片段，请核对服务地址。");
  const question = raw.indexOf("?");
  if (question < 0) return { url: raw };
  const parts = raw.slice(question + 1).split("&"), keep: string[] = [];
  let parameter: string | undefined, token: string | undefined;
  for (const part of parts) {
    const equal = part.indexOf("="), key = decodeURIComponent(equal < 0 ? part : part.slice(0, equal));
    if (secretParameter.test(key) || (authenticationParameter && key.toLowerCase() === authenticationParameter.toLowerCase())) {
      if (parameter) throw new Error("地址包含多个认证参数，请在认证设置中分别核对。");
      parameter = key; token = decodeURIComponent(equal < 0 ? "" : part.slice(equal + 1).replace(/\+/g, " "));
    } else keep.push(part);
  }
  return { url: raw.slice(0, question) + (keep.length ? `?${keep.join("&")}` : ""), parameter, token };
}

export function sourceCredential(mode: string, parameter: string, token: string): SourceCredentialInput {
  return { mode: mode === "none" ? null : mode as SourceCredentialInput["mode"], parameter: mode === "bearerToken" ? "Authorization" : parameter.trim(), token };
}
