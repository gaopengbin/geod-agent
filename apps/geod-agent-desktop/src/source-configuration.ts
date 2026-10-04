import { api, type SourceRegistrationDraft } from "./api";

/** Model tools pass technical metadata only; native code handles the credential. */
export async function configureSource(draft: SourceRegistrationDraft) {
  const saved = await api.sourcesSave(draft.source, draft.minZoom, draft.maxZoom, false,
    draft.authenticationMode ? { mode: draft.authenticationMode, parameter: draft.authenticationParameter } : undefined);
  return { saved: true, configured: true, id: saved.id, name: saved.displayName, source: saved,
    ...(saved.credentialRefVersion === "pending" ? { credentialRequired: true, next: "用户在图源管理中填写 Key/Token 后即可预览和下载；不要让用户在聊天中发送 Token。" } : {}) };
}
