import { invoke, isTauri } from "@tauri-apps/api/core";

export type Bounds = [number, number, number, number];
export type OutputFormat = "geotiff" | "mbtiles";
export type JobState = "queued" | "downloading" | "processing" | "verifying" | "completed" | "partial" | "failed" | "cancelled";

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
}

export interface TaskSpec {
  schemaVersion: "0.1";
  kind: "imagery";
  sourceId: string;
  bounds: Bounds;
  zoomLevels: number[];
  outputFormats: OutputFormat[];
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
  createdAt: string;
  expiresAt: string;
  planHash: string;
}

export interface StoredPlan { planId: string; plan: Plan }
export interface Approval { approvalId: string; planId: string; planHash: string; approvedAt: string }
export interface Job { jobId: string; planId: string; approvalId: string; planHash: string; state: JobState; version: number; createdAt: string }
export interface JobEvent { jobId: string; seq: number; occurredAt: string; state: JobState; errorCode?: string; completedTiles?: number; totalTiles?: number }
export interface Asset { id: string; kind: string; role: string; path: string; bytes: number; sha256: string; bounds: Bounds; width?: number; height?: number }
export interface Manifest { name: string; bounds: Bounds; assets: Asset[]; quality: { status: string; missingTiles: number; warnings: string[] }; provenance: { source: string; attribution: string; retrievedAt: string }[] }
export interface ServiceConfig { identityOrigin: string; gatewayOrigin: string }
export interface AuthStatus { state: "unconfigured" | "disconnected" | "waiting" | "connected"; userId: string | null; error: string | null }
export interface AgentToolCall { id: string; type: "function"; function: { name: string; arguments: string } }
export interface AgentMessage { role: "user" | "assistant" | "tool"; content: string | null; tool_call_id?: string; tool_calls?: AgentToolCall[] }
export interface Generation { generationId: string; conversationId: string; state: "reserved" | "streaming" | "settled" | "failed" | "pending_reconcile"; errorCode: string | null; result: { role: "assistant"; content: string | null; toolCalls: AgentToolCall[] } | null }
export interface ModelUsage { limitTokens: number; committedTokens: number; reservedTokens: number; remainingTokens: number; pendingReconcile: number }

export const desktopAvailable = isTauri();

export const api = {
  sourcesList: () => invoke<SourceDescriptor[]>("sources_list"),
  sourcesSave: (endpoint: HttpSource, minZoom: number, maxZoom: number) => invoke<SourceDescriptor>("sources_save", { endpoint, minZoom, maxZoom, permissionAcknowledged: true }),
  plansCreate: (spec: TaskSpec) => invoke<StoredPlan>("plans_create", { spec }),
  plansGet: (planId: string) => invoke<StoredPlan | null>("plans_get", { planId }),
  approvalsGrant: (planId: string, planHash: string) => invoke<Approval>("approvals_grant", { planId, planHash }),
  jobsStart: (planId: string, planHash: string, approvalId: string, idempotencyKey: string) => invoke<Job>("jobs_start", { planId, planHash, approvalId, idempotencyKey }),
  jobsGet: (jobId: string) => invoke<Job | null>("jobs_get", { jobId }),
  jobsList: () => invoke<Job[]>("jobs_list"),
  jobsActive: () => invoke<string[]>("jobs_active"),
  jobsCancel: (jobId: string) => invoke<Job>("jobs_cancel", { jobId }),
  jobsResume: (jobId: string) => invoke<Job>("jobs_resume", { jobId }),
  jobsEvents: (jobId: string, afterSeq: number) => invoke<JobEvent[]>("jobs_events", { jobId, afterSeq }),
  artifactsInspect: (jobId: string) => invoke<Manifest>("artifacts_inspect", { jobId }),
  serviceConfigGet: () => invoke<ServiceConfig | null>("service_config_get"),
  serviceConfigSet: (config: ServiceConfig) => invoke<ServiceConfig>("service_config_set", { config }),
  authStatus: () => invoke<AuthStatus>("auth_status"),
  authBegin: () => invoke<AuthStatus>("auth_begin"),
  authLogout: () => invoke<AuthStatus>("auth_logout"),
  agentGenerate: (generationId: string, conversationId: string, messages: AgentMessage[]) => invoke<Generation>("agent_generate", { generationId, conversationId, messages }),
  agentUsage: () => invoke<ModelUsage>("agent_usage"),
  agentGenerationGet: (generationId: string) => invoke<Generation>("agent_generation_get", { generationId }),
};

export function errorMessage(error: unknown): string {
  if (typeof error === "string") return error;
  if (error && typeof error === "object" && "message" in error) return String(error.message);
  return "操作失败，请查看本地任务记录。";
}
