import { cesiumBrowserToolContracts } from 'cesium-mcp-contracts';
import type { McpToolList } from './api';

export const CESIUM_ID = 'builtin-cesium-mcp';
export const CESIUM_CONNECTOR = { id: CESIUM_ID, name: 'Cesium MCP', url: '当前对话三维场景', enabled: true, transport: 'embedded' as const };
const empty = { type: 'object' as const, properties: {}, additionalProperties: false };

/** Use the published Cesium MCP contracts, including their exact tool names. */
export const cesiumToolDefinitions: McpToolList['tools'] = [
  { name: 'getViewMode', description: '读取当前对话实际显示的工作区视图（mode:2d 或 3d）、是否保留三维场景与成果任务。二维为 OpenLayers，三维为 Cesium；不要求三维窗口已打开。', inputSchema: empty, annotations: { readOnlyHint: true } },
  { name: 'setViewMode', description: '切换 GeoD 地图工作区到二维 OpenLayers 或三维 Cesium。这是实际界面切换，不是修改相机俯角。切到二维会保留三维相机、图层和模型，切回三维会恢复同一场景。没有三维场景时先用 data_download_load 打开已完成的三维任务。返回已提交的实际视图状态。', inputSchema: { type: 'object', properties: { mode: { type: 'string', enum: ['2d', '3d'] } }, required: ['mode'], additionalProperties: false } },
  { name: 'closeScene', description: '关闭并释放当前三维成果预览，返回二维地图；不会取消下载或删除成果文件。只想临时切换到二维时用 setViewMode(mode:2d)，以保留三维相机和图层。', inputSchema: empty },
  { name: 'getSceneState', description: '读取当前对话三维场景、实际相机和图层、底图瓦片状态、地形、模型实际 loaded 状态、动画位置和时钟。模型创建成功不代表加载完成；loaded:true 表示实际模型就绪，show 是对象开关，inCameraFrustum 是是否处于镜头范围，仍可能被遮挡。opened:true 且 visible:false 表示保留场景但当前显示二维；用 setViewMode(mode:3d) 恢复。未打开时可用 data_download_load 打开已完成的三维任务。', inputSchema: empty, annotations: { readOnlyHint: true } },
  { name: 'sampleTerrain', description: '从当前 Cesium 场景的实际地形读取经纬度点的高程（米）。会请求真实地形瓦片；失败时返回错误，不用零值代替缺失数据。默认 level 12，最多 100 点；flat 地形的高程是椭球面零值。', inputSchema: { type: 'object', properties: { positions: { type: 'array', minItems: 1, maxItems: 100, items: { type: 'object', properties: { longitude: { type: 'number', minimum: -180, maximum: 180 }, latitude: { type: 'number', minimum: -90, maximum: 90 } }, required: ['longitude', 'latitude'], additionalProperties: false } }, level: { type: 'integer', minimum: 0, maximum: 18, default: 12 } }, required: ['positions'], additionalProperties: false }, annotations: { readOnlyHint: true } },
  { name: 'fitScene', description: '定位当前下载成果的实际范围，避免全球数据根包围球造成镜头过远。', inputSchema: empty },
  { name: 'loadSource', description: '把 sources_list 中已配置的图源加载到 Cesium 三维地球。支持本机 XYZ/TMS/ImageServer 适配及天地图等已保存凭据，密钥不进入模型。默认替换底图，也可叠加注记。实际瓦片异步加载，随后用 getSceneState 核对。', inputSchema: { type: 'object', properties: { sourceId: { type: 'string', minLength: 1 }, replace: { type: 'boolean', default: true }, opacity: { type: 'number', minimum: 0, maximum: 1, default: 1 } }, required: ['sourceId'], additionalProperties: false } },
  ...cesiumBrowserToolContracts.map(contract => {
    const inputSchema = structuredClone(contract.inputSchema) as McpToolList['tools'][number]['inputSchema'];
    if (contract.name === 'setBasemap') {
      // Provider secrets belong to GeoD's native source store.
      delete (inputSchema.properties as Record<string, unknown>).token;
    }
    if (contract.name === 'loadTerrain') (inputSchema.properties as Record<string,unknown>).connectionId = { type:'string', minLength:1, description:'本机保存的 Cesium Ion 连接 ID；只有一个可用 Ion 连接时自动选择。凭据不进入模型。' };
    return { name: contract.name, description: `${contract.localizations['zh-CN'].description}。操作当前 Cesium 三维场景。${contract.name === 'setBasemap' ? '已配置且需要认证的图源使用 loadSource(sourceId)，凭据由本机读取。' : contract.name === 'loadTerrain' ? 'provider=cesiumion 使用本机已保存连接的凭据；connectionId 可明确选择，cesiumIonAssetId 默认为全球地形 1。实际检查 Asset 类型、读取元数据后才替换当前地形，不使用浏览器默认 Token。' : ''}`, inputSchema, annotations: contract.annotations };
  }),
];
