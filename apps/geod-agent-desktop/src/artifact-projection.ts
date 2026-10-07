import proj4 from "proj4";
import { register } from "ol/proj/proj4.js";
import { get as getProjection } from "ol/proj.js";

/** Definitions come from the verified native export, without a network lookup. */
export function registerArtifactProjection(crs: string, definition?: string | null) {
  if (!getProjection(crs)) {
    if (!definition) throw new Error(`缺少成果投影定义：${crs}`);
    proj4.defs(crs, definition);
    register(proj4);
    if (!getProjection(crs)) throw new Error(`无法识别成果投影：${crs}`);
  }
}
