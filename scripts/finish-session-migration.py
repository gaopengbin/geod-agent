from pathlib import Path
root=Path('apps/geod-agent-desktop/src')
p=root/'agent-panel.tsx'
s=p.read_text(encoding='utf-8')
start=s.index('  function selectChat(chat: SavedChat) {')
end=s.index('\n',start)
s=s[:start]+'''  function selectChat(chat: SavedChat) {
    onMainViewChange("conversation");if(chat.conversationId===conversationId||!accountId)return;
    const next=sessions.get(accountId,chat.conversationId,()=>conversationSessionSeed(chat,readPending(chatStore())?.[chat.conversationId]));
    setConversationId(chat.conversationId);onSelectConversation(next.get<string[]>("planIds",[]),chat.conversationId);
  }'''+s[end:]
s=s.replace('onPlanned: (plan: StoredPlan) => void;', 'onPlanned: (plan: StoredPlan, originConversationId: string) => void;')
s=s.replace('onJobStarted: (job: Job) => void;', 'onJobStarted: (job: Job, originConversationId: string) => void;')
s=s.replace('onJobStarted(started.job)', 'onJobStarted(started.job,conversationId)').replace('onJobStarted(job)', 'onJobStarted(job,conversationId)')
s=s.replace('origin !== conversationRef.current || ', '')
s=s.replace('    const origin = conversationId;\n    const id = `background-job-', '    const id = `background-job-')
s=s.replace('  const conversationRef = useRef(conversationId);\n  conversationRef.current = conversationId;\n','')
s=s.replace('if (busy && chat.conversationId === conversationId) {setError', 'if (runningIds.includes(chat.conversationId)) {setError')
s=s.replace('    if(busy)throw new Error(t("请等当前回复结束后导入会话。"));\n','')
s=s.replace('    if(busy&&chat.conversationId===conversationId)return;', '    if(runningIds.includes(chat.conversationId))return;\n    sessions.forget(accountId??"",chat.conversationId);')
s=s.replace('if (accountId && !busy) void newChat();', 'if (accountId) void newChat();').replace('disabled={busy && mainView === "conversation"}', 'disabled={creatingConversation}')
s=s.replace('disabled={busy || !accountId} onClick={() => void newChat(', 'disabled={creatingConversation || !accountId} onClick={() => void newChat(')
s=s.replace('running={busy&&chat.conversationId===conversationId}', 'running={runningIds.includes(chat.conversationId)}')
s=s.replace('runningIds={busy?[conversationId]:[]}', 'runningIds={runningIds}')
s=s.replace('running={busy&&conversationEditor?.chat.conversationId===conversationId}', 'running={runningIds.includes(conversationEditor?.chat.conversationId??"")}')
s=s.replace('workspaceLabel(directory) ||', 'workspaceLabel(directory) ||')
s=s.replace('directory === "默认工作区" ? "默认工作区" : workspaceName(directory)', 'directory === "默认工作区" ? t("默认工作区") : workspaceName(directory)')
p.write_text(s,encoding='utf-8')
for name in ['task-queue-view.tsx','unified-task-queue-view.tsx','data-task-details.tsx']:
    p=root/name;s=p.read_text(encoding='utf-8')
    import re
    s=re.sub(r': (taskStateLabels\[[^\]]+\] \?\? [\w.]+)}',r': localize(\1)}',s)
    p.write_text(s,encoding='utf-8')
p=root/'extension-store.tsx';s=p.read_text(encoding='utf-8').replace('{skill.description || skill.sourceUrl || t("Skill 指令")}', '{skill.id===SOURCE_CREATOR_ID?t(skill.description):skill.description || skill.sourceUrl || t("Skill 指令")}');p.write_text(s,encoding='utf-8')
