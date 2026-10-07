import { OPENLAYERS_ID, OPENLAYERS_CONNECTOR, openLayersEnabled, setOpenLayersEnabled, openLayersTools, openLayersCall } from "./openlayers-mcp";
import { CESIUM_ID, CESIUM_CONNECTOR, cesiumEnabled, setCesiumEnabled, cesiumTools, cesiumCall } from "./cesium-mcp";
import { Channel, invoke, isTauri } from "@tauri-apps/api/core";
import type { CodexEvent, CodexResult } from "./codex-client";
import {hasBulkGeometry} from '../../../packages/codex-protocol/bulk-data.mjs';

export type Bounds = [number, number, number, number];
export type OutputFormat = "geotiff" | "mbtiles" | "png" | "jpeg" | "gpkg" | "tiles";
export interface ExportOptions { targetCrs?: string; resampling?: "nearest" | "bilinear" | "cubic"; cacheOnly?: boolean; reuseVerifiedCache?: boolean; compression?: "none" | "lzw" | "deflate"; buildPyramid?: boolean; generateSidecars?: boolean; jpegQuality?: number; overlaySources?: { sourceId: string; configRevision: string }[]; elevationEncoding?: "terrarium" }
export type JobState = "queued" | "downloading" | "paused" | "processing" | "verifying" | "completed" | "partial" | "failed" | "cancelled";
export interface BoundaryGeometry { polygons: [number, number][][][] }
export interface BoundaryImport { name: string; bounds: Bounds; polygonCount: number; geometry: BoundaryGeometry; boundaryId?: string }
export interface BoundarySummary { boundaryId: string; name: string; bounds: Bounds; polygonCount: number; inputIds: string[]; createdAt: string }
export interface StoredBoundary extends BoundaryImport, BoundarySummary { boundaryId: string }
export interface DataLayer { name: string; geometryType: string; crs: string | null; featureCount: number | null }
export interface DatabaseFilter { field: string; op: "eq"|"ne"|"lt"|"lte"|"gt"|"gte"|"in"|"isNull"|"isNotNull"|"contains"|"startsWith"; value?: string|number|boolean|null|(string|number|boolean)[] }
export interface DatabaseSelection { filters?: DatabaseFilter[]; bounds?: Bounds; maxFeatures?: number }
export interface DataInputRequest extends DatabaseSelection { files?: { name: string; base64: string }[]; url?: string; relativePath?: string; connectionId?: string; onlineConnectionId?: string; pageSize?: number; handle?: string; layer?: string; sourceCrs?: string }
export interface OnlineConnection { id: string; name: string; url: string; headerNames: string[] }
export interface OnlineService { kind: string; layers?: { name: string; title: string; geometryType?: string; queryUrl?: string }[]; fields?: unknown[]; queryUrl?: string }
export interface DatabaseMcpInfo { server: string; version: string; protocolVersion: string; transport: "stdio"; tools: string[]; toolCalls: number }
export interface DataTable { name: string; type: "TABLE" | "VIEW" }
export interface DataInputResult { handle?: string; layers?: DataLayer[]; tables?: DataTable[]; selectedLayer?: string; sourceCrs?: string; selectionRequired?: boolean; boundary?: BoundaryImport; mcp?: DatabaseMcpInfo; error?: { code: string; message: string } }
export interface DataConnection { id: string; name: string; host: string; port: number; database: string; user: string; sslMode: string; databaseType?: "PostGIS" | "PostgreSQL" | null; clientCertificate?: boolean }
export type SqlDatabaseKind = "sqlite" | "mysql" | "sqlserver" | "oracle";
export interface SqlConnectionDraft { name:string;kind:SqlDatabaseKind;host?:string|null;port?:number|null;database?:string|null;user?:string|null;relativePath?:string|null;sslMode?:string|null;password?:string;sslRootCert?:string;sslClientCert?:string;sslClientKey?:string;sslClientKeyPassword?:string;sslClientBundle?:string;clientCertificate?:boolean;authMode?:'password'|'windowsDomain';domain?:string|null }
export interface SqlConnection extends SqlConnectionDraft {id:string;readOnly:true}
export interface SqlConnectionResult {connection?:SqlConnection;catalog?:unknown;mcp?:unknown;readOnly?:boolean;error?:{code:string;message:string};authentication?:SqlConnectionDraft}
/** Sent only to the native credential adapter. Client private keys never enter tool results. */
export interface DataConnectionDraft { name: string; host: string; port: number; database: string; user: string; password: string; sslMode: string; sslRootCert?: string; sslClientCert?: string; sslClientKey?: string;sslClientKeyPassword?:string;sslClientBundle?:string }
export type DataConnectionRequest = Partial<Omit<DataConnectionDraft, "password" | "sslClientCert" | "sslClientKey" | "sslClientKeyPassword" | "sslClientBundle">> & { credentialFile?: string };
export type DataConnectionAuthentication = Omit<DataConnectionDraft, "password" | "sslClientCert" | "sslClientKey" | "sslClientKeyPassword" | "sslClientBundle"> & { clientCertificate?: boolean };
export interface DataConnectionResult { connection?: Pick<DataConnection, "id" | "name"> | null; layers?: DataLayer[]; tables?: DataTable[]; error?: { code: string; message: string } | null; authentication?: DataConnectionAuthentication | null; readOnly?: boolean; mcp?: DatabaseMcpInfo | null }

export interface SourceDescriptor {
  schemaVersion: "0.1";
  id: string;
  displayName: string;
  attribution: string;
  license: string;
  bulkDownloadAllowed: boolean;
  scheme: "XYZ" | "TMS";
  tileSize: number;
  minZoom: number;
  maxZoom: number;
  configRevision: string;
  credentialRefVersion: string | null;
  elevationEncoding?: "terrarium";
}

export interface HttpSource {
  id: string;
  name: string;
  attribution: string;
  license: string;
  urlTemplate: string;
  scheme: "XYZ" | "TMS";
  tileSize: number;
  networkPolicy: "PublicHttps" | "UserTrustedHttp";
  minIntervalMs: number;
  elevationEncoding?: "terrarium";
  subdomains?: string[];
  coordinateSystem?: "wgs84" | "gcj02";
  authentication?: SourceAuthentication | null;
}
export type SourceAuthMode = "queryToken" | "bearerToken" | "headerToken";
export interface SourceAuthentication { mode: SourceAuthMode; parameter: string; credentialRef: string; version: string; origin: string }
/** Only sent to native credential storage, never to an Agent tool or localStorage. */
export interface SourceCredentialInput { mode: SourceAuthMode | null; parameter?: string; token?: string }
export interface SourceRegistrationDraft { source: HttpSource; minZoom: number; maxZoom: number; authenticationMode?: SourceAuthMode; authenticationParameter?: string }
export interface RegisteredSource { descriptor: SourceDescriptor; endpoint: HttpSource; configuredAt: string }

export interface TaskSpec {
  schemaVersion: "0.1";
  kind: "imagery";
  sourceId: string;
  bounds: Bounds;
  boundary?: BoundaryGeometry;
  zoomLevels: number[];
  outputFormats: OutputFormat[];
  exportOptions?: ExportOptions;
  outputDirectory: string;
  limits: { maxTiles: number; maxDecodedRgbaBytes: number };
}

export interface PlanTileGrid {
  zoom: number;
  columns: number;
  rows: number;
  tileCount: number;
  pixelWidth: number;
  pixelHeight: number;
  actualBounds: Bounds;
}

export interface Plan {
  spec: TaskSpec;
  sourceName: string;
  attribution: string;
  license: string;
  tileGrids: PlanTileGrid[];
  totalTiles: number;
  decodedRgbaBytes: number;
  requiredFreeDiskBytes?: number;
  createdAt: string;
  expiresAt: string;
  planHash: string;
}

export interface StoredPlan { planId: string; plan: Plan }
export interface ImagerySchedule { templatePlanId:string|null; scheduleId:string; conversationId:string; name:string; enabled:boolean; nextRunAt:string; repeatSeconds:number|null; maxRetries:number; sourceId:string; zoomLevels:number[]; appMustBeRunning:boolean }
export interface ScheduleRun { runId:string; scheduleId:string; scheduledAt:string; state:string; attempt:number; nextAttemptAt:string; planId:string|null; jobId:string|null; errorCode:string|null; finishedAt:string|null }
export interface Approval { approvalId: string; planId: string; planHash: string; approvedAt: string }
export interface Job { jobId: string; planId: string; approvalId: string; planHash: string; state: JobState; version: number; createdAt: string }
export interface JobEvent { jobId: string; seq: number; occurredAt: string; state: JobState; processingStage?: "assembling" | "reprojecting"; errorCode?: string; completedTiles?: number; totalTiles?: number }
export interface Asset { crs: string; crsDefinition?: string; geoTransform?: number[]; id: string; kind: string; role: string; path: string; bytes: number; sha256: string; bounds: Bounds; width?: number; height?: number }
export interface Manifest { name: string; bounds: Bounds; assets: Asset[]; quality: { status: string; missingTiles: number; missing?: { zoom: number; x: number; y: number }[]; warnings: string[] }; provenance: { source: string; attribution: string; retrievedAt: string }[] }
export interface ArtifactPreview { dataUrl: string; bounds: Bounds; attribution: string }
export interface AuthStatus { state: "unconfigured" | "disconnected" | "waiting" | "connected"; userId: string | null; error: string | null }
export interface AccountProfile { accountId: string; email: string; nickname: string | null; avatar: { kind: "preset"; id: string } | { kind: "upload"; version: string } | null; avatarDataUrl: string | null }
export interface WorkspaceSettings { directory: string; permission: "confirmEach" | "fullAccess"; outputCrs?: string }
export interface NetworkSettings { mode: "auto" | "manual" | "direct"; manualUrl: string | null }
export interface NetworkStatus { settings: NetworkSettings; effectiveProxy: string | null; source: string }
export interface NetworkProbe { effectiveProxy: string | null; source: string; elapsedMs: number }
export interface AgentToolCall { id: string; type: "function"; function: { name: string; arguments: string } }
export interface ImageAttachment { id:string; conversationId:string; name:string; mimeType:string; bytes:number; width:number; height:number; sha256:string }
export interface DocumentAttachment {id:string;conversationId:string;name:string;extension:string;kind:string;bytes:number;sha256:string;textSha256:string;characters:number;units:number;unitLabel:string;excerpt:string;truncated:boolean;warnings:string[];transcriptEdited?:boolean;ocrPages?:number[];ocrEngine?:string}
export interface AudioSettings {model:string;language:string;models:{id:string;bytes:number;available:boolean}[];downloading:{id:string;downloaded:number;total:number}|null;engine:string;engineVersion:string;localOnly:true}
export interface AudioDownloadProgress {phase:'downloading'|'verifying'|'complete';downloaded:number;total:number}
export interface DocumentRead {attachment:DocumentAttachment;text:string;offset:number;nextOffset:number|null;complete:boolean;available:boolean;untrustedContent:true}
export interface AgentMessage { role: "user" | "assistant" | "tool"; content: string | null; tool_call_id?: string; tool_calls?: AgentToolCall[]; images?:ImageAttachment[]; documents?:DocumentAttachment[] }
export interface Generation { generationId: string; conversationId: string; state: "reserved" | "streaming" | "settled" | "failed" | "pending_reconcile"; errorCode: string | null; inputTokens?: number | null; outputTokens?: number | null; billingScope?: "hosted" | "personal" | "sponsored"; channelId?: string; selectedModel?: string; usageKnown?: boolean; result: { role: "assistant"; content: string | null; toolCalls: AgentToolCall[] } | null }
export type GenerationStreamEvent =
  | { type: "started"; data: { generationId: string } }
  | { type: "content_delta"; data: { text: string } }
  | { type: "tool_start"; data: { name: string; index: number } }
  | { type: "generation"; data: Generation };
export interface ModelUsage { quotaEnforced?: boolean; limitTokens: number | null; committedTokens: number; reservedTokens: number; remainingTokens: number | null; pendingReconcile: number }
export interface PaymentProduct {id:string;name:string;kind:'topup'|'subscription';priceFen:number;creditNanoCny:string;days:number}
export interface PaymentOrder {orderId:string;product:PaymentProduct;priceFen:number;creditNanoCny:string;currency:'CNY';status:'pending'|'paid'|'cancel-requested'|'closed'|'payment-review'|'refunding'|'refunded';createdAt:number;expiresAt:number;paidAt:number|null;environment:string;fixture:boolean}
export interface PaymentRefund {refundId:string;orderId:string;amountFen:number;status:'pending'|'submitted'|'uncertain'|'refunded';createdAt?:number;updatedAt?:number;fixture:boolean}
export interface PaymentCharge {generationId:string;chargeNanoCny:string;createdAt:number;model:string|null;inputTokens:number;cachedInputTokens:number;outputTokens:number;reasoningTokens:number|null;pricingVersion:string;pricingDigest:string|null;ratesNanoPerToken:{cachedInput:string;uncachedInput:string;output:string}|null}
export interface PaymentReservation {generationId:string;maximumNanoCny:string;createdAt:number;pricingVersion:string|null;model:string|null}
export interface PaymentCreditGrant {kind:'welcome';policyId:string;creditNanoCny:string;remainingNanoCny:string;createdAt:number}
export type CreditHistoryKind='usage'|'reservations';
export interface CreditHistoryQuery {kind:CreditHistoryKind;from?:number|null;to?:number|null;cursor?:string|null;limit?:number}
export interface CreditHistoryPage {kind:CreditHistoryKind;from:number|null;to:number|null;asOf:number;totalCount:number;items:(PaymentCharge|PaymentReservation)[];nextCursor:string|null}
export type PaymentHistoryKind='orders'|'refunds';
export interface PaymentHistoryQuery {kind:PaymentHistoryKind;from?:number|null;to?:number|null;cursor?:string|null;limit?:number}
export interface PaymentHistoryPage {kind:PaymentHistoryKind;from:number|null;to:number|null;asOf:number;totalCount:number;items:(PaymentOrder|PaymentRefund)[];nextCursor:string|null}
export interface PaymentSnapshot {status:{candidate:boolean;available?:boolean;checkoutEnabled:boolean;environment:string;fixture:boolean;billingMode:'prepaid'|'unlimited-test'|'token-quota';pricingVersion?:string;pricesApproved?:boolean;welcomeCreditEnabled?:boolean;creditHistoryEnabled?:boolean;paymentHistoryEnabled?:boolean;products:PaymentProduct[]};wallet:{balanceNanoCny:string|null;reservedNanoCny:string|null;frozenNanoCny?:string|null;availableNanoCny:string|null;subscription:{expiresAt:number}|null;orders:PaymentOrder[];orderCount?:number;refunds:PaymentRefund[];refundCount?:number;charges?:PaymentCharge[];chargeCount?:number;reservations?:PaymentReservation[];reservationCount?:number;grants?:PaymentCreditGrant[]}|null}
export interface SkillSummary { id: string; name: string; description: string; enabled: boolean; sourceUrl?: string | null; contentSha256?: string | null }
export interface OnlineSkillCandidate { id: string; name: string; source: string; installs?: number | null }
export interface SkillSourceCandidate { id: string; name: string; source: string }
export interface RemoteSkillStage { id: string; name: string; description: string; sourceUrl: string; contentSha256: string; enabled: boolean }
export interface McpRuntimeSettings { cwd?: string | null; envVars?: string[]; envHttpHeaders?: Record<string,string>; bearerTokenEnvVar?: string | null; startupTimeoutSec?: number | null; toolTimeoutSec?: number | null; enabledTools?: string[] | null; disabledTools?: string[] }
export interface McpConnector { id: string; name: string; url: string; enabled: boolean; transport?: "http" | "gdalStdio" | "stdio" | "embedded"; command?: string | null; headerNames?: string[]; queryNames?:string[]; envNames?: string[]; argumentCount?: number; private?: boolean; oauth?: boolean; runtime?: McpRuntimeSettings }
export interface McpAuthorization { authorizationId: string; connectorId:string; state:"waiting"|"saving"|"authorized"|"failed"|"cancelled"; message?:string; authorizationUrl?:string }
export interface McpConnectionOptions { command?: string; args?: string[]; env?: Record<string,string>; headers?: Record<string,string>; query?:Record<string,string>; runtime?: McpRuntimeSettings }
export interface RegisteredPluginApp { pluginId: string; pluginName: string; name: string; registeredId: string; category: string | null; route: "bundledMcp" | "unavailable"; connectorId: string | null; enabled: boolean; registeredAccountRouteAvailable: false; reason: string | null }
export interface ExtensionOverview { skills: SkillSummary[]; connectors: McpConnector[]; registeredApps?: RegisteredPluginApp[] }
export interface McpTool { name: string; description?: string; inputSchema: Record<string, unknown>; annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint?: boolean } }
export interface McpToolList { connectorId: string; name: string; tools: McpTool[] }
export interface ArtifactRaster { resourceId: string; jobId: string; assetId: string; name: string; path: string; bounds: Bounds; crs: string; crsDefinition?: string | null; width: number; height: number; sha256: string; elevationEncoding?: "terrarium" | null }
export interface RegistryMcpItem { name: string; title: string; description: string; url: string; source?:'officialPreset'|'registry'; documentationUrl?:string }
export interface WorkspaceSkillCandidate { name: string; description: string; relativePath: string }

export const desktopAvailable = isTauri();

export interface BackgroundStatus { running: boolean; activeDownloads: number; activeCommands?:number; activeAiTurns?:number; maintenanceActive?:boolean; windowRequired: boolean; pid?: number }
export interface DesktopBackup {path:string;records:number;bytes:number;includesConversations:boolean;verified:boolean}
export interface AiSchedule { scheduleId:string; conversationId:string; name:string; prompt:string; enabled:boolean; nextRunAt:string; repeatSeconds:number|null }
export interface AiScheduledRun { runId:string; scheduleId:string; conversationId:string; name:string; state:string; scheduledAt:string; attempt:number; result?:{text?:string;status?:string}|null; error?:{code:string;message:string}|null }
export interface AiScheduleOverview { schedules:AiSchedule[]; runs:AiScheduledRun[]; windowRequired:boolean }

export const api = {
  runtimeCapabilities:()=>invoke<import("./runtime-compatibility").NativeRuntimeCapabilities>("desktop_runtime_capabilities"),
  agentMessages:()=>invoke<AppMessageFeed>("agent_messages_list"),
  agentMessagesRead:(accountId:string,messageIds:string[])=>invoke<{accountId:string;accepted:number}>("agent_messages_read",{accountId,messageIds}),
  agentMessageOpenLink:(url:string)=>invoke<void>("agent_message_open_link",{url}),
  desktopSettings:()=>invoke<DesktopSettings>("desktop_settings_get"),
  desktopAutostart:(enabled:boolean)=>invoke<DesktopSettings>("desktop_autostart_set",{enabled}),
  desktopUpdatePreferences:(automaticChecks:boolean)=>invoke<DesktopSettings>("desktop_update_preferences",{automaticChecks}),
  desktopUpdateCheck:()=>invoke<DesktopUpdate>("desktop_update_check"),
  desktopUpdateDownload:(version:string,onEvent:(event:DesktopUpdateProgress)=>void)=>{const events=new Channel<DesktopUpdateProgress>();events.onmessage=onEvent;return invoke<DesktopUpdate>("desktop_update_download",{version,events});},
  desktopUpdateInstall:(version:string,uiState?:{schemaVersion:1;entries:[string,string][]})=>invoke<{installed:boolean}>("desktop_update_install",{version,uiState}),
  desktopBackupCreate:(uiState:{schemaVersion:1;entries:[string,string][]})=>invoke<DesktopBackup>("desktop_backup_create",{uiState}),
  aiSchedulesCreate:(conversationId:string,name:string,prompt:string,nextRunAt:string,repeatSeconds:number|null,executionId:string=crypto.randomUUID(),history?:AgentMessage[])=>invoke<AiSchedule>("ai_schedules_create",{conversationId,name,prompt,nextRunAt,repeatSeconds,executionId,history}),
  aiSchedulesList:(conversationId:string)=>invoke<AiScheduleOverview>("ai_schedules_list",{conversationId}),
  aiSchedulesSetEnabled:(scheduleId:string,enabled:boolean,nextRunAt?:string)=>invoke<AiSchedule>("ai_schedules_set_enabled",{scheduleId,enabled,nextRunAt}),
  aiSchedulesRunEvents:(runId:string)=>invoke<{run:AiScheduledRun;events:Record<string,unknown>[]}>("ai_schedules_run_events",{runId}),
  aiSchedulesCancelRun:(runId:string)=>invoke<AiScheduledRun>("ai_schedules_cancel_run",{runId}),
  aiSchedulesRetryRun:(runId:string)=>invoke<AiScheduledRun>("ai_schedules_retry_run",{runId}),
  backgroundStatus: () => invoke<BackgroundStatus>("background_status"),
  backgroundStart: () => invoke<BackgroundStatus>("background_start"),
  backgroundStop: () => invoke<{stopped: boolean}>("background_stop"),
  schedulesCreate: (conversationId:string,planId:string,name:string,nextRunAt:string,repeatSeconds:number|null,maxRetries=2,executionId:string=crypto.randomUUID()) => invoke<ImagerySchedule>("schedules_create",{conversationId,planId,name,nextRunAt,repeatSeconds,maxRetries,executionId}),
  schedulesList: (conversationId:string) => invoke<ImagerySchedule[]>("schedules_list",{conversationId}),
  schedulesSetEnabled: (scheduleId:string,enabled:boolean,nextRunAt?:string) => invoke<ImagerySchedule>("schedules_set_enabled",{scheduleId,enabled,nextRunAt}),
  schedulesRuns: (conversationId:string) => invoke<ScheduleRun[]>("schedules_runs",{conversationId}),
  schedulesCancelRun: (runId:string) => invoke<ScheduleRun>("schedules_cancel_run",{runId}),
  networkGet: () => invoke<NetworkStatus>("network_get"),
  networkSet: (settings: NetworkSettings) => invoke<NetworkStatus>("network_set", { settings }),
  networkTest: (settings: NetworkSettings) => invoke<NetworkProbe>("network_test", { settings }),
  workspaceSetOutputCrs: (conversationId: string, crs: string | null) => invoke<WorkspaceSettings>("workspace_set_output_crs", { conversationId, crs }),
  workspaceGet: (conversationId: string) => invoke<WorkspaceSettings>("workspace_get", { conversationId }),
  workspaceOpenDirectory: (conversationId: string) => invoke<void>("workspace_open_directory", { conversationId }),
  workspaceDefault: () => invoke<WorkspaceSettings>("workspace_default"),
  workspaceSet: (conversationId: string, directory: string, permission: WorkspaceSettings["permission"]) => invoke<WorkspaceSettings>("workspace_set", { conversationId, directory, permission }),
  osmBasemapTile: (z: number, x: number, y: number) => invoke<string>("osm_basemap_tile", { z, x, y }),
  outputDirectorySuggest: (conversationId: string) => invoke<string>("output_directory_suggest", { conversationId }),
  workspaceBoundariesList: (conversationId: string) => invoke<string[]>("workspace_boundaries_list", { conversationId }),
  workspaceGisFilesList: (conversationId: string) => invoke<string[]>("workspace_gis_files_list", { conversationId }),
  workspaceBoundaryUse: (conversationId: string, relativePath: string) => invoke<BoundaryImport>("workspace_boundary_use", { conversationId, relativePath }),
  boundaryInspect: (name: string, text: string) => invoke<BoundaryImport>("boundary_inspect", { name, text }),
  boundariesSave: (conversationId: string, boundary: BoundaryImport) => invoke<StoredBoundary>("boundaries_save", { conversationId, boundary }),
  boundariesList: (conversationId: string) => invoke<BoundarySummary[]>("boundaries_list", { conversationId }),
  boundariesGet: (conversationId: string, boundaryId: string) => invoke<StoredBoundary>("boundaries_get", { conversationId, boundaryId }),
  boundariesCombine: (conversationId: string, boundaryIds: string[], name?: string) => invoke<StoredBoundary>("boundaries_combine", { conversationId, boundaryIds, name }),
  dataInputRead: (conversationId: string, request: DataInputRequest) => invoke<DataInputResult>("data_input_read", { conversationId, request }),
  onlineConnectionsList: () => invoke<OnlineConnection[]>("online_connections_list"),
  onlineConnectionSave: (draft: { name: string; url: string; headers: Record<string, string> }) => invoke<OnlineConnection>("online_connection_save", { draft }),
  onlineConnectionRemove: (connectionId: string) => invoke<void>("online_connection_remove", { connectionId }),
  onlineServicesDiscover: (url?: string, connectionId?: string) => invoke<OnlineService>("online_services_discover", { url, connectionId }),
  dataConnectionsList: () => invoke<DataConnection[]>("data_connections_list"),
  sqlConnectionsList:()=>invoke<{connections:SqlConnection[]}>("sql_connections_list"),
  sqlConnectionConnect:(conversationId:string,request:Record<string,unknown>)=>invoke<SqlConnectionResult>("sql_connection_connect",{conversationId,request}),
  sqlConnectionSave:(conversationId:string,draft:SqlConnectionDraft)=>invoke<SqlConnectionResult>("sql_connection_save",{conversationId,draft}),
  sqlConnectionRemove:(connectionId:string)=>invoke<void>("sql_connection_remove",{connectionId}),
  billingRunSnapshot:(runId:string)=>invoke<{status:string;conversationId:string;generations:{generationId:string}[]}>("billing_run_snapshot",{runId}),
  sqlObjectsSearch:(connectionId:string,request:Record<string,unknown>={objectType:"table"})=>invoke<{result:unknown;mcp:unknown}>("sql_objects_search",{connectionId,request}),
  sqlQuery:(connectionId:string,sql:string)=>invoke<unknown>("sql_query",{connectionId,sql}),
  dataConnectionConnect: (conversationId: string, request: DataConnectionRequest) => invoke<DataConnectionResult>("data_connection_connect", { conversationId, request }),
  dataLayerInspect: (connectionId: string, layer: string, limit = 5, selection?: DatabaseSelection) => invoke<Record<string, unknown>>("data_layer_inspect", { connectionId, layer, limit, selection }),
  dataConnectionSave: (draft: DataConnectionDraft) => invoke<{ connection?: DataConnection; layers?: DataLayer[]; tables?: DataTable[]; mcp?: DatabaseMcpInfo; error?: { code: string; message: string } }>("data_connection_save", { draft }),
  dataConnectionRemove: (connectionId: string) => invoke<void>("data_connection_remove", { connectionId }),
  usCountyBoundary: (stateFips: string, countyName: string) => invoke<BoundaryImport>("us_county_boundary", { stateFips, countyName }),
  sourcesList: () => invoke<SourceDescriptor[]>("sources_list"),
  mapPreviewTile: (sourceId: string | null, url: string | null, z: number, x: number, y: number) => invoke<string>("map_preview_tile", { sourceId, url, z, x, y }),
  sourcePreviewTile: (endpoint: HttpSource, z: number, x: number, y: number, credential?: SourceCredentialInput) => invoke<string>("map_preview_tile", { sourceId: null, url: null, endpoint, credential, z, x, y }),
  sourceThumbnailMetadata: (url: string) => invoke<Record<string, unknown>>("source_thumbnail_metadata", { url }),
  sourcesGet: (sourceId: string) => invoke<RegisteredSource | null>("sources_get", { sourceId }),
  gisSkillsList:()=>invoke<GisSkill[]>("gis_skills_list"),
  rtkStatus:()=>invoke<RtkStatus>("rtk_status"),
  rtkInstall:(requestId:string,archivePath:string|null=null)=>invoke<RtkStatus>("rtk_install",{requestId,archivePath}),
  rtkSetEnabled:(value:boolean)=>invoke<RtkStatus>("rtk_set_enabled",{value}),
  rtkInstallCancel:(requestId:string)=>invoke<{cancelled:boolean}>("rtk_install_cancel",{requestId}),
  gisInstallPrepare:(id:string,requireTools=false)=>invoke<GisInstallOffer>("gis_install_prepare",{id,requireTools}),
  gisSkillInstall:(id:string,directory:string|null=null,requestId:string=crypto.randomUUID())=>invoke<{installed:boolean;id:string}>("gis_skill_install",{id,directory,requestId}),
  gisInstallCancel:(requestId:string)=>invoke<{cancelled:boolean}>("gis_install_cancel",{requestId}),
  sourceCreatorTools: () => invoke<McpToolList & { kind: "builtin" }>("source_creator_tools"),
  sourceCreatorCall: (toolName: string, arguments_: Record<string, unknown>) => invoke<Record<string, unknown>>("source_creator_call", { toolName, arguments: arguments_ }),
  sourcesSave: (endpoint: HttpSource, minZoom: number, maxZoom: number, replaceExisting = false, credential?: SourceCredentialInput) => invoke<SourceDescriptor>("sources_save", { endpoint, minZoom, maxZoom, replaceExisting, credential }),
  plansCreate: (spec: TaskSpec, toolExecutionId: string, conversationId: string) => invoke<StoredPlan>("plans_create", { spec, toolExecutionId, conversationId }),
  imageryPlansClaim: (conversationId: string, planIds: string[]) => invoke<{bound:string[];rejected:{planId:string;code:string;message:string}[]}>("imagery_plans_claim", { conversationId, planIds }),
  plansForToolExecution: (toolExecutionId: string) => invoke<StoredPlan | null>("plans_for_tool_execution", { toolExecutionId }),
  plansGet: (planId: string) => invoke<StoredPlan | null>("plans_get", { planId }),
  approvalsGrant: (planId: string, planHash: string) => invoke<Approval>("approvals_grant", { planId, planHash }),
  jobsStart: (planId: string, planHash: string, approvalId: string, idempotencyKey: string) => invoke<Job>("jobs_start", { planId, planHash, approvalId, idempotencyKey }),
  jobsStartAuto: (planId: string, conversationId: string, idempotencyKey: string) => invoke<Job>("jobs_start_auto", { planId, conversationId, idempotencyKey }),
  jobsGet: (jobId: string) => invoke<Job | null>("jobs_get", { jobId }),
  jobsForPlan: (planId: string) => invoke<Job | null>("jobs_for_plan", { planId }),
  jobsList: () => invoke<Job[]>("jobs_list"),
  jobsActive: () => invoke<string[]>("jobs_active"),
  jobsCancel: (jobId: string) => invoke<Job>("jobs_cancel", { jobId }),
  jobsPause: (jobId: string) => invoke<Job>("jobs_pause", { jobId }),
  jobsResume: (jobId: string) => invoke<Job>("jobs_resume", { jobId }),
  jobsEvents: (jobId: string, afterSeq: number) => invoke<JobEvent[]>("jobs_events", { jobId, afterSeq }),
  artifactsInspect: (jobId: string) => invoke<Manifest>("artifacts_inspect", { jobId }),
  artifactOpenDirectory: (conversationId: string, jobId: string) => invoke<void>("artifact_open_directory", { conversationId, jobId }),
  artifactPreview: (jobId: string) => invoke<ArtifactPreview | null>("artifact_preview", { jobId }),
  artifactRaster: (jobId: string, assetId?: string) => invoke<ArtifactRaster>("artifact_raster", { jobId, assetId }),
  authStatus: () => invoke<AuthStatus>("auth_status"),
  accountProfile: (accountId: string) => invoke<AccountProfile>("account_profile", { accountId }),
  authBegin: () => invoke<AuthStatus>("auth_begin"),
  authLogout: () => invoke<AuthStatus>("auth_logout"),
  agentGenerate: (generationId: string, conversationId: string, messages: AgentMessage[]) => invoke<Generation>("agent_generate", { generationId, conversationId, messages }),
  agentGenerateStream: (generationId: string, conversationId: string, messages: AgentMessage[], onEvent: (event: GenerationStreamEvent) => void) => {
    const events = new Channel<GenerationStreamEvent>();
    events.onmessage = onEvent;
    return invoke<Generation>("agent_generate_stream", { generationId, conversationId, messages, events });
  },
  agentUsage: () => invoke<ModelUsage>("agent_usage"),
  agentPaymentSnapshot:()=>invoke<PaymentSnapshot>('agent_payment_snapshot'),
  agentCreditHistory:(query:CreditHistoryQuery)=>invoke<CreditHistoryPage>('agent_credit_history',{query}),
  agentCreditHistoryExport:(query:CreditHistoryQuery,path:string)=>invoke<{records:number;bytes:number;asOf:number;sha256:string}>('agent_credit_history_export',{query,path}),
  agentPaymentHistory:(query:PaymentHistoryQuery)=>invoke<PaymentHistoryPage>('agent_credit_history',{query}),
  agentPaymentHistoryExport:(query:PaymentHistoryQuery,path:string)=>invoke<{records:number;bytes:number;asOf:number;sha256:string}>('agent_credit_history_export',{query,path}),
  agentPaymentAction:(action:'create'|'checkout'|'refresh'|'cancel'|'refund',options:{orderId?:string;productId?:string;requestKey?:string}={})=>invoke<{order?:PaymentOrder;orderId?:string;opened?:boolean;fixture?:boolean;unconfirmed?:boolean;status?:string}>('agent_payment_action',{action,...options}),
  agentEvents: (accountId: string, events: unknown[]) => invoke<{ accepted: number; duplicates: number }>("agent_events", { accountId, events }),
  agentGenerationGet: (generationId: string) => invoke<Generation>("agent_generation_get", { generationId }),
  codexAvailable: () => invoke<{ available: boolean; requiredVersion: string; development: boolean }>("codex_available"),
  imageAttachmentAdd: (conversationId:string,name:string,base64:string)=>invoke<ImageAttachment>("image_attachment_add",{conversationId,name,base64}),
  imageAttachmentPreview: (conversationId:string,id:string)=>invoke<string>("image_attachment_preview",{conversationId,id}),
  documentAttachmentAdd:(conversationId:string,name:string,base64:string,password?:string)=>invoke<DocumentAttachment>("document_attachment_add",{conversationId,name,base64,password:password??null}),
  audioSettings:()=>invoke<AudioSettings>("audio_settings_get"),
  audioSettingsSet:(model:string,language:string)=>invoke<AudioSettings>("audio_settings_set",{model,language}),
  audioModelDownload:(modelId:string,onEvent:(event:AudioDownloadProgress)=>void)=>{const onProgress=new Channel<AudioDownloadProgress>();onProgress.onmessage=onEvent;return invoke<AudioSettings>("audio_model_download",{modelId,onProgress});},
  audioModelCancel:()=>invoke<void>("audio_model_cancel"),
  audioModelRemove:(modelId:string)=>invoke<AudioSettings>("audio_model_remove",{modelId}),
  audioAttachmentAdd:(conversationId:string,requestId:string,name:string,base64:string,wavBase64:string)=>invoke<DocumentAttachment>("audio_attachment_add",{conversationId,requestId,name,base64,wavBase64}),
  audioTranscriptionCancel:(conversationId:string,requestId:string)=>invoke<void>("audio_transcription_cancel",{conversationId,requestId}),
  audioAttachmentDraft:(conversationId:string,id:string)=>invoke<{attachment:DocumentAttachment;text:string;untrustedContent:true}>("audio_attachment_draft",{conversationId,id}),
  audioAttachmentEdit:(conversationId:string,id:string,text:string)=>invoke<DocumentAttachment>("audio_attachment_edit",{conversationId,id,text}),
  documentAttachmentDiscard:(conversationId:string,id:string)=>invoke<void>("document_attachment_discard",{conversationId,id}),
  documentAttachmentsList:(conversationId:string)=>invoke<DocumentAttachment[]>("document_attachments_list",{conversationId}),
  documentAttachmentRead:(conversationId:string,id:string,offset?:number,limit?:number)=>invoke<DocumentRead>("document_attachment_read",{conversationId,id,offset,limit}),
  codexTurn: (runId: string, conversationId: string, input: string, history: AgentMessage[], onEvent: (event: CodexEvent) => void, images?:ImageAttachment[],documents?:DocumentAttachment[]) => {
    const events = new Channel<CodexEvent>(); events.onmessage = onEvent;
    return invoke<CodexResult>("codex_turn", { runId, conversationId, input, history, events,images:images?.map(image=>image.id),documentIds:documents?.map(document=>document.id) });
  },
  codexCommand: (runId: string, command: Record<string, unknown>) => invoke<void>("codex_command", { runId, command }),
  codexFork:(sourceConversationId:string,conversationId:string,imageIds:string[],documentIds:string[]=[])=>invoke<{threadId:string;sourceThreadId:string;forkedFromId:string;images:[string,ImageAttachment][];documents:DocumentAttachment[]}>("codex_fork",{sourceConversationId,conversationId,imageIds,documentIds}),
  extensionsList: async () => { const overview = await invoke<ExtensionOverview>("extensions_list"); return { ...overview, connectors: [{ ...OPENLAYERS_CONNECTOR, enabled: openLayersEnabled() }, { ...CESIUM_CONNECTOR, enabled: cesiumEnabled() }, ...overview.connectors] }; },
  skillImport: async (path: string) => { await invoke<ExtensionOverview>("skill_import", { path }); return api.extensionsList(); },
  skillSetEnabled: async (id: string, enabled: boolean) => { await invoke<ExtensionOverview>("skill_set_enabled", { id, enabled }); return api.extensionsList(); },
  skillRemove: async (id: string) => { await invoke<ExtensionOverview>("skill_remove", { id }); return api.extensionsList(); },
  skillRead: (name: string) => invoke<string>("skill_read", { name }),
  skillPreview: (id: string) => invoke<string>("skill_preview", { id }),
  skillCatalogSearch: (query: string) => invoke<OnlineSkillCandidate[]>("skill_catalog_search", { query }),
  skillSourceInspect: (url: string) => invoke<SkillSourceCandidate[]>("skill_source_inspect", { url }),
  skillRemoteStage: (source: string) => invoke<RemoteSkillStage>("skill_remote_stage", { source }),
  mcpAdd: async (name: string, url: string, options: McpConnectionOptions = {}) => { await invoke<ExtensionOverview>("mcp_add", { name, url, ...options }); return api.extensionsList(); },
  mcpQueryCredentialsSet:(id:string,query:Record<string,string>)=>invoke<void>('mcp_query_credentials_set',{id,query}),
  mcpHeaderCredentialsSet:(id:string,headers:Record<string,string>)=>invoke<void>('mcp_header_credentials_set',{id,headers}),
  mcpRemove: async (id: string) => { await invoke<ExtensionOverview>("mcp_remove", { id }); return api.extensionsList(); },
  mcpOauthStart: (id:string,clientId?:string,scopes?:string[],clientSecret?:string,callbackPort?:number) => invoke<McpAuthorization>("mcp_oauth_start",{id,clientId,scopes,clientSecret,callbackPort}),
  mcpOauthStatus: (authorizationId:string) => invoke<McpAuthorization>("mcp_oauth_status",{authorizationId}),
  mcpOauthPending: (id:string) => invoke<McpAuthorization|null>("mcp_oauth_pending",{id}),
  mcpOauthOpen: (authorizationId:string) => invoke<void>("mcp_oauth_open",{authorizationId}),
  mcpOauthCancel: (authorizationId:string) => invoke<McpAuthorization>("mcp_oauth_cancel",{authorizationId}),
  mcpOauthDisconnect: (id:string) => invoke<{disconnected:boolean;revocation:"revoked"|"partial"|"unsupported"|"unavailable"|"noCredentials";message:string}>("mcp_oauth_disconnect",{id}),
  mcpAddGdal: async () => { await invoke<ExtensionOverview>("mcp_add_gdal"); return api.extensionsList(); },
  mcpSetEnabled: async (id: string, enabled: boolean): Promise<ExtensionOverview> => { if (id === OPENLAYERS_ID) setOpenLayersEnabled(enabled); else if (id === CESIUM_ID) setCesiumEnabled(enabled); else await invoke<ExtensionOverview>("mcp_set_enabled", { id, enabled }); return api.extensionsList(); },
  mcpTools: (id: string, conversationId?: string) => id === OPENLAYERS_ID ? openLayersTools(conversationId ?? "") : id === CESIUM_ID ? cesiumTools(conversationId ?? "") : invoke<McpToolList>("mcp_tools", { id, conversationId }),
  mcpCall: async (id: string, toolName: string, arguments_: Record<string, unknown>, executionId: string, conversationId?: string) => {
    if(id!==OPENLAYERS_ID&&id!==CESIUM_ID)return invoke<unknown>("mcp_call", { id, toolName, arguments: arguments_, executionId, conversationId, interactive:true });
    const result=id===OPENLAYERS_ID?await openLayersCall(conversationId??"",toolName,arguments_):await cesiumCall(conversationId??"",toolName,arguments_);
    // Embedded map results share the native, account-owned geometry receipt path.
    if(desktopAvailable&&hasBulkGeometry(result))return invoke<unknown>("mcp_embedded_result_save",{id,toolName,arguments:arguments_,result,executionId,conversationId});
    return result;
  },
  mcpRequestOpenBrowser: (requestId:string)=>invoke<{opened:boolean}>("mcp_request_open_browser",{requestId}),
  mcpPendingRequests: (conversationId:string)=>invoke<{type:"request";requestId:string;method:string;params:Record<string,unknown>}[]>("mcp_requests_pending",{conversationId}),
  mcpRequestReply: (requestId:string,value:unknown)=>invoke<void>("mcp_request_reply",{requestId,value}),
  mcpRequestsCancel: (conversationId:string)=>invoke<void>("mcp_requests_cancel",{conversationId}),
  mcpResultRead: (executionId: string, offset: number) => invoke<unknown>("mcp_result_read", { executionId, offset }),
  mcpResultExport: (executionId: string, conversationId: string, jsonPointer = "") => invoke<unknown>("mcp_result_export", { executionId, conversationId, jsonPointer }),
  mcpRegistrySearch: (query: string) => invoke<RegistryMcpItem[]>("mcp_registry_search", { query }),
  workspaceSkillsList: (conversationId: string) => invoke<WorkspaceSkillCandidate[]>("workspace_skills_list", { conversationId }),
  workspaceSkillImport: (conversationId: string, relativePath: string) => invoke<ExtensionOverview>("workspace_skill_import", { conversationId, relativePath }),
};

export { errorMessage } from "./app-error";
export interface AppMessageText {zh:string;en?:string}
export interface AppMessage {id:string;revision:number;title:AppMessageText;body:AppMessageText;priority:'normal'|'important';publishedAt:string;expiresAt:string|null;readAt:string|null;action:{kind:'update'|'link';label:AppMessageText;url?:string}|null}
export interface AppMessageFeed {schemaVersion:1;accountId:string;checkedAt:string;unreadCount:number;items:AppMessage[]}
export interface DesktopSettings {version:string;development:boolean;autostart:boolean;automaticUpdateChecks:boolean;lastUpdateCheck:string|null;updateConfigured:boolean}
export interface DesktopUpdate {state:"unconfigured"|"upToDate"|"available"|"ready";currentVersion?:string;version?:string;notes?:string|null;publishedAt?:string|null;bytes?:number;verified?:boolean}
export interface DesktopUpdateProgress {phase:"downloading"|"verifying"|"ready";downloaded?:number;total?:number|null}

export interface GisSkill {id:string;name:string;description:string;tools:string[];installed:boolean;enabled:boolean;ready:boolean;downloadBytes:number;installedBytes:number}
export interface RtkStatus {supported:boolean;version:string;installed:boolean;ready:boolean;enabled:boolean;downloadBytes:number;installedBytes:number;activeRequestId:string|null;sourceUrl:string}
export interface RtkInstallProgress {requestId:string;phase:string;bytes:number;total:number}
export interface GisInstallOffer {id:string;name:string;description:string;ready:boolean;enabled:boolean;downloadBytes:number;installedBytes:number;components:{id:string;ready:boolean;cached:boolean;downloadBytes:number;installedBytes:number}[]}
export interface GisInstallProgress {requestId:string;featureId:string;phase:'checking'|'downloading'|'verifying'|'installing'|'ready';bytes:number;total:number;component?:string|null}
