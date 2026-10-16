export interface PlanReferences { planId?: string; planIds?: string[]; unavailablePlanIds?: string[] }
export interface PlanClaimReport {
  bound: string[];
  rejected: { planId?: string; plan_id?: string; code: string; message: string }[];
}
export interface HistoryInspection {
  workspaceBound: boolean; workspaceDirectory: string | null; workspaceAvailable: boolean;
  databasePath: string; actualDatabasePath: string; dataDirectoryRedirected: boolean; recoverablePlanIds: string[];
}
export interface HistoryRestoreReport { restored: string[]; notFound: string[]; rejected?: {planId:string;code:string;message:string}[]; snapshotPath: string | null }
export interface PlanRecoveryProblem { count: number; codes: string[] }
export function planRecoveryProblem(report: PlanClaimReport): PlanRecoveryProblem | null {
  return report.rejected.length ? {count: new Set(report.rejected.map(r=>r.planId??r.plan_id).filter(Boolean)).size,codes:[...new Set(report.rejected.map(r=>r.code))]} : null;
}
export function recoveryFailure(cause: unknown, count: number): PlanRecoveryProblem {
  const code = typeof cause==='object' && cause!==null && 'code' in cause && typeof cause.code==='string' ? cause.code : 'STORAGE_ERROR';
  return {count,codes:[code]};
}
export async function loadHistoryWorkspace<T extends {directory:string}>(getWorkspace:()=>Promise<T>,claim:(ids:string[])=>Promise<PlanClaimReport>,requested:string[],savedDirectory?:string):Promise<{workspace:T;claim:PlanClaimReport}> {
  const workspace=await getWorkspace();
  const pathKey=(path:string)=>path.replace(/^\\\\\?\\/,'').replaceAll('\\','/').replace(/\/$/,'').toLowerCase();
  if(!requested.length&&savedDirectory&&pathKey(savedDirectory)!==pathKey(workspace.directory))throw {code:'WORKSPACE_NOT_BOUND'};
  // Return the workspace only after ownership checks; callers must never save a fallback path on failure.
  const report=requested.length?await claim(requested):{bound:[],rejected:[]};
  return {workspace,claim:report};
}
const unavailable = new Set(["PLAN_NOT_FOUND", "PLAN_NOT_OWNED", "WORKSPACE_DENIED"]);
const ids = (values: (string | undefined)[]) => [...new Set(values.filter((id): id is string => !!id))];

/** Reconcile navigation references only. Original messages and native tasks are untouched. */
export function recoverPlanReferences(current: PlanReferences, report: PlanClaimReport): PlanReferences {
  const requested = new Set(ids([...(current.planIds ?? []), current.planId, ...(current.unavailablePlanIds ?? [])]));
  const rejected = new Set(report.rejected.filter(item => unavailable.has(item.code)).map(item => item.planId ?? item.plan_id).filter((id): id is string => !!id && requested.has(id)));
  const bound = report.bound.filter(id => requested.has(id) && !rejected.has(id));
  const active = ids([...(current.planIds ?? []), current.planId, ...bound]).filter(id => !rejected.has(id));
  const archived = ids([...(current.unavailablePlanIds ?? []), ...rejected]).filter(id => !bound.includes(id));
  return { planIds: active, planId: current.planId && active.includes(current.planId) ? current.planId : active.at(-1), unavailablePlanIds: archived };
}
export function planRecoveryNotice(report: PlanClaimReport): string | null {
  const problem=planRecoveryProblem(report);
  return problem ? `${problem.count} 项历史任务需要检查，可打开恢复入口处理。` : null;
}
export function isPlanRecoveryNotice(value: string): boolean {
  return value.startsWith("部分旧任务未能关联到当前工作区：") || value === "暂时无法读取部分历史任务，稍后重新打开会话可重试。" || value === '请先恢复此历史会话保存的工作区，再迁移任务归属';
}
