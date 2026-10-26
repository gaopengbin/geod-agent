import { api, type SourceRegistrationDraft } from "./api";
import { normalizeTileTemplate } from "./source-template";

/** Check the base source and overlays before preparing any plans or folders. */
export async function sourceCredentialPreflight(sourceIds:string[]) {
  for(const sourceId of new Set(sourceIds)){
    const state=await api.sourcesReadiness(sourceId);
    if(!state.ready)throw {code:state.errorCode??'SOURCE_CREDENTIAL_REQUIRED',sourceId,message:'请先补全此图源的本机认证，再继续原任务。'};
  }
}

/** Model tools pass technical metadata only; native code handles the credential. */
export async function configureSource(draft: SourceRegistrationDraft) {
  const saved = await api.sourcesSave({...draft.source,urlTemplate:normalizeTileTemplate(draft.source.urlTemplate)}, draft.minZoom, draft.maxZoom, false,
    draft.authenticationMode ? { mode: draft.authenticationMode, parameter: draft.authenticationParameter } : undefined);
  const readiness=await api.sourcesReadiness(saved.id);
  return { saved: true, configured: readiness.ready, id: saved.id, name: saved.displayName, source: saved, readiness,
    ...(!readiness.ready ? await sourceCredentialRecovery(saved.id,readiness.errorCode??'SOURCE_CREDENTIAL_REQUIRED') : {}) };
}

/** Recovery metadata contains no credential value and reopens the existing source. */
export async function sourceCredentialRecovery(sourceId:string,code:string) {
  const stored=await api.sourcesGet(sourceId);
  return {error:code,sourceId,credentialRequired:true,
    ...(stored?{draft:{source:stored.endpoint,minZoom:stored.descriptor.minZoom,maxZoom:stored.descriptor.maxZoom,editingExisting:true,credentialOnly:true} satisfies SourceRegistrationDraft}:{}),
    next:'使用当前消息中的本机认证入口，保存后继续原任务。保留已确认的范围、格式、级别和坐标系；认证问题不能靠降低缩放、重建计划或重复点击同意解决。不要让用户在聊天中发送 Key/Token。'};
}
