import { getLocale, t, localize, replyLanguageInstruction } from "./i18n";
import {continueTaskContext} from './continue-task';
import {inheritedImageryCrs,resolvedRevisionQuestions} from './imagery-revision';
// i18n: presentation strings migrated
import { localStateStore, flushLocalState } from "./local-state";
import { TILES3D_CONNECTION_ID, tiles3dConnectionTools, executeTiles3dConnectionTool } from "./data-connection-tools";
import { IMAGERY_RECOVERY_PLANNED, planImageryRecovery, type ImageryRecoveryPlan } from "./imagery-recovery";
import { executeDataScheduleTool, dataScheduleTools, executeCacheTool, cacheTools } from "./maintenance-tools";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type ClipboardEvent } from "react";
import { ConversationSessions, conversationSessionSeed } from "./conversation-sessions";
import { useConversationState } from "./use-conversation-session";
import { motion, useReducedMotion } from "motion/react";
import * as Dialog from "@radix-ui/react-dialog";
import { Bot, ChevronDown, CircleAlert, Clock3, DotsThree, File, Folder, FolderOpen, FolderPlus, GitBranch, MapTrifold, NewChat, PencilSimple, Plus, PuzzlePiece, Search, ShieldAlert, ShieldCheck, Trash, X } from "./icons";
import { open, save as saveFileDialog } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import { ConversationRow, ConversationHistory, ConversationEditor, type ConversationAction } from "./conversation-manager";
import { orderedConversations, exportConversation, importConversation } from "./conversation-history";
import { Button } from "@/components/motion/button/base";
import { UiTooltip } from "./ui-tooltip";
import { PromptInput } from "@/components/agents/prompt-input";
import { MorphPopover, MorphPopoverContent, MorphPopoverTrigger } from "@/components/motion/popover-morph";
import { ContextWindow } from "./context-window";
import { AccountMenu } from "./account-menu";
import type { GeoDAuth } from "./geod-auth";
import { useAIModels, modelValue,availableAIChannels,SPONSORED_CHANNELS_VISIBLE } from "./ai-channels";
import { useDownloadTelemetry } from "./use-download-telemetry";
import { ChatTranscript } from "./chat-ui";
import { ExtensionStorePage } from "./extension-store";
import { SchedulesPage } from "./schedules-page";
import { requestScheduleFocus } from "./schedule-navigation";
import { api, desktopAvailable, errorMessage, type AgentMessage, type AgentToolCall, type BoundaryImport, type DataInputRequest, type DataConnectionDraft, type DataConnectionResult, type Generation, type Job, type ModelUsage, type OnlineSkillCandidate, type RegistryMcpItem, type SkillSourceCandidate, type SourceRegistrationDraft, type StoredPlan, type WorkspaceSettings } from "./api";
import { crsFromAnswers, exportCrsQuestions, humanCrsIntent, isExportPlan, resolveExportCrs } from "./export-crs";
import {ensureExportRuntime} from "./runtime-compatibility";
import {listen} from "@tauri-apps/api/event";
import {GisInstallCard} from "./gis-install-card";
import {GisInstallFlow,type GisInstallRequest} from "./gis-install-flow";
import {GisDependencyGate,gisRequirement,missingGisDependency,type GisRequirement} from "./gis-dependencies";
import type {GisInstallProgress} from "./api";
import {runtimeCompatibilityFailure, runtimeUpdateError} from "./app-error";
import { sourceRegistrationDraft, toolDisplay, userProvidedUrl, workspacePermissionContext } from "./agent-workflow";
import { configureSource } from "./source-configuration";
import { artifactResultForModel, modelMessagesWithoutArtifactPaths } from "./model-artifacts";
import {aiScheduleTools,executeAiScheduleTool,AI_SCHEDULE_ID} from "./ai-schedule-tools";
import { backgroundCommandTools, executeBackgroundCommandTool, BACKGROUND_COMMAND_ID } from "./background-command-tools";
import { memoryTools, executeMemoryTool, MEMORY_ID } from "./agent-memory";
import {agentTaskTools,executeAgentTaskTool,AGENT_TASK_ID} from "./agent-task-tools";
import { discoverExtensions } from "./extension-discovery";
import { boundedContext, contextWindowUsage } from "./conversation-context";
import { SOURCE_CREATOR_ID, skillDiscoveryText } from "./builtin-skills";
import { displayPath } from "./path-display";
import { runCodexTurn, type CodexEvent, type CodexTokenUsage } from "./codex-client";
import { reduceCodexItems } from "./codex-items";
import { CodexRequestCard, type CodexRequest } from "./codex-request";
import { inputQuestions, validatedInputReply, UserInputGate } from "./user-input";
import {answeredCrsChoice,reusableInputReply,userInputReplyText,detachedUserInput,isDetachedUserInput,inputOrigin,type UserInputDraft} from './user-input-records';
import {userApprovedMcpUrl,reconcileMcpProposals} from './mcp-onboarding';
import {resolveMcpTarget,prepareMcpConnection} from './mcp-connection';
import {repairSavedMcpHistory,knownSavedMcpAddress} from './mcp-history-repair';
import {turnOutcomeMessage,outputFailureCode,modelResponseIssue,orphanedReasoningTurn,recoverTurnOutcome} from './turn-outcome';
import { McpRequestQueue } from "./mcp-request-queue";
import { backgroundHandoff, backgroundRunning, backgroundStateLabels, type BackgroundSnapshot } from "./background-jobs";
import { jobExecutionState, jobStatusFacts } from "./job-runtime";
import { startPlanJob } from "./job-start";
import { useBackgroundJobs } from "./use-background-jobs";
import { TranscriptTaskGroup } from "./transcript-plan-card";
import { assertPlanAvailable, withPlanTaskLock, type QueueTask } from "./task-queue";
import { defaultPlanTitle, inferPlanPresentations, planCardAnchors, savePlanPresentations } from "./plan-presentation";
import { usePlanPresentations } from "./use-plan-presentations";
import { DataInputPanel, vectorAccept, vectorFiles } from "./data-input-panel";
import { DATA_INPUT_ID, dataInputTools, executeDataInputTool } from "./data-input-tools";
import { attachBoundaryLookup, rangeSummary, saveBoundary } from "./boundary-tools";
import { compactPlan, planImagery } from "./imagery-planning";
import type { BoundarySummary } from "./api";
import { BoundaryPicker } from "./boundary-picker";
import {ImageAttachments,imageFiles,imageAccept} from "./image-attachments";
import {DocumentAttachments,documentFiles,documentAccept,documentContext} from "./document-attachments";
import {DocumentPasswordDialog,type DocumentPasswordRequest} from "./document-password-dialog";
import {AudioSetupDialog,AudioTranscriptDialog,audioAccept,audioFiles} from "./audio-attachments";
import {AudioLines,Loader2,Settings} from "./icons";
import {SqlConnectionDialog} from "./sql-connections";
import type {SqlConnectionDraft,SqlConnectionResult} from "./api";
import type {ImageAttachment,DocumentAttachment} from "./api";
import { receiveBoundarySelection } from "./boundary-selection";
import { scheduleTools, SCHEDULE_CONNECTOR_ID } from "./schedule-tools";
import { dataDownloadTools, DATA_DOWNLOAD_ID, executeDataDownloadTool } from "./data-download-tools";
import { accountChatStore, chatPlanIds, CHAT_LIST_KEY, clearPending, commitPending, deleteStoredConversation, importLegacyChats, LEGACY_IMPORT_MARKER, legacyChats, pendingBoundary, persistCompletedChat, readPending, restorePendingChats, savePending, type DisplayMessage, type ExtensionProposal, type SavedChat } from "./pending-generations";

const WORKSPACE_LIST_KEY = "geod-agent-workspace-list-0.1";
const ACTIVE_CHAT_KEY = "geod-agent-active-conversation-0.1";
interface WorkspaceListView { names: Record<string, string>; hidden: string[] }
const emptyWorkspaceList = (): WorkspaceListView => ({ names: {}, hidden: [] });
function restoreWorkspaceList(store: Pick<Storage, "getItem">): WorkspaceListView {
  try {
    const value = JSON.parse(store.getItem(WORKSPACE_LIST_KEY) ?? "null") as Partial<WorkspaceListView> | null;
    if (!value || typeof value !== "object") return emptyWorkspaceList();
    const names = Object.fromEntries(Object.entries(value.names ?? {}).filter(([path, name]) => path && typeof name === "string" && name.trim().length > 0 && name.length <= 64));
    const hidden = Array.isArray(value.hidden) ? value.hidden.filter((path): path is string => typeof path === "string" && path.length > 0) : [];
    return { names, hidden };
  } catch { return emptyWorkspaceList(); }
}
function restoreChats(store: Pick<Storage, "getItem" | "setItem">): SavedChat[] {
  try {
    const value = JSON.parse(store.getItem(CHAT_LIST_KEY) ?? "null") as SavedChat[];
    if (Array.isArray(value) && value.length && value.every(item => typeof item.conversationId === "string" && Array.isArray(item.messages) && Array.isArray(item.display))) return restorePendingChats(store, value);
  } catch { /* An invalid account index starts a new conversation. */ }
  return restorePendingChats(store, [{ conversationId: crypto.randomUUID(), messages: [], display: [], updatedAt: new Date().toISOString() }]);
}
function chatTitle(chat: SavedChat) { return chat.title||chat.display.find(item => item.role === "user")?.content.slice(0, 34) || t("新对话"); }
function chatTime(chat: SavedChat, now: number) {
  const time = chat.updatedAt ? Date.parse(chat.updatedAt) : NaN;
  if (!Number.isFinite(time)) return "";
  const minutes = Math.max(0, Math.floor((now - time) / 60_000));
  if (minutes < 1) return t("刚刚");
  const relative = new Intl.RelativeTimeFormat(getLocale(), {numeric:"always"});
  if (minutes < 60) return relative.format(-minutes, "minute");
  if (minutes < 24 * 60) return relative.format(-Math.floor(minutes / 60), "hour");
  if (minutes < 7 * 24 * 60) return relative.format(-Math.floor(minutes / (24 * 60)), "day");
  return new Date(time).toLocaleDateString(getLocale(), { month: "numeric", day: "numeric" });
}
function workspaceName(directory: string) { return displayPath(directory).split(/[\\/]/).filter(Boolean).at(-1) || displayPath(directory) || "默认工作区"; }
function modelUserText(value: string, boundary: BoundaryImport | null) {
  const text = value.trim();
  if (!text) return "";
  const language = replyLanguageInstruction(text);
  return language + (boundary ? `${text}\n[本机当前选择范围：${boundary.name}；boundaryId: ${boundary.boundaryId ?? "未保存"}。WGS84 范围：${boundary.bounds.join(", ")}；共 ${boundary.polygonCount} 个面。仅当此范围符合当前请求时使用。boundaries_list 可读取其他已保存范围，多地区可合并或拆分规划；几何由本机处理，GeoTIFF 边界外透明。请先读取已配置图源。]` : text);
}
function stringArg(value: unknown) { return typeof value === "string" && value.length > 0 && value.length <= 100 ? value : null; }
export type AgentMainView = "conversation" | "extensions" | "sources" | "models" | "schedules";
export function AgentPanel({ auth, onAccountChange, onBackgroundSnapshots, ledgerJobs, conversationTasks, onTaskGroupSelect, onWorkspaceChange, onConversationChange, registeredSource, onPlanned, onOpenSources, onOpenNetwork, onOpenCache, onToggleTheme, onEmptyConversationChange, mainView, onMainViewChange, theme, onSelectConversation, selectedJob, onJobStarted, onOpenJob }: { auth: GeoDAuth; onAccountChange: (id: string | null) => void; onBackgroundSnapshots: (snapshots: Record<string, BackgroundSnapshot>) => void; ledgerJobs: Job[]; conversationTasks: QueueTask[]; onTaskGroupSelect: (planIds: string[]) => void; onWorkspaceChange?: (state: { conversationId: string; permission: WorkspaceSettings["permission"] | null }) => void; onConversationChange: (conversationId: string) => void; registeredSource: { eventId: string; conversationId: string; sourceId: string; displayName: string } | null; onPlanned: (plan: StoredPlan, originConversationId: string) => void; onOpenSources: (draft?: SourceRegistrationDraft, originConversationId?: string) => void; onOpenNetwork: () => void; onOpenCache: () => void; onToggleTheme: () => void; onEmptyConversationChange: (empty: boolean) => void; mainView: AgentMainView; onMainViewChange: (view: AgentMainView) => void; theme: "light" | "dark"; onSelectConversation: (planIds: string[], conversationId: string) => void; selectedJob: Job | null; onJobStarted: (job: Job, originConversationId: string) => void; onOpenJob?: (job: Job) => void }) {
  const reduceMotion = useReducedMotion();
  const [accountId, setAccountId] = useState<string | null>(null);
  useEffect(() => onAccountChange(accountId), [accountId, onAccountChange]);
  const [backgroundNotice, setBackgroundNotice] = useState<BackgroundSnapshot | null>(null);
  const [chatRecords, setChatRecords] = useState<SavedChat[]>([]);
  const chatRecordsRef=useRef(chatRecords);chatRecordsRef.current=chatRecords;
  const [historyOpen,setHistoryOpen]=useState(false);
  const [conversationEditor,setConversationEditor]=useState<{chat:SavedChat;mode:"rename"|"delete"}|null>(null);
  const [visibleConversations,setVisibleConversations]=useState<Record<string,number>>({});
  const [conversationId, setConversationId] = useState("");
  const sessions = useRef(new ConversationSessions()).current;
  const sessionRevision = useSyncExternalStore(sessions.subscribe,sessions.getRevision,sessions.getRevision);
  const session = sessions.get(accountId ?? "",conversationId,()=>conversationSessionSeed(
    chatRecords.find(chat=>chat.conversationId===conversationId),
    accountId?readPending(accountChatStore(localStateStore,accountId))?.[conversationId]:undefined));
  const runningIds = sessions.running(accountId??"").map(session=>session.conversationId);
  const aiModels = useAIModels(accountId, conversationId, chatRecords.some(c => c.conversationId === conversationId && c.messages.length > 0));
  const activeConversationRef = useRef(conversationId);
  activeConversationRef.current = conversationId;
  const presentations = usePlanPresentations(accountId, conversationId);
  useEffect(() => { onConversationChange(conversationId); }, [conversationId, onConversationChange]);
  const [messages, setMessages] = useConversationState<AgentMessage[]>(session,"messages",[]);
  const [display, setDisplay] = useConversationState<DisplayMessage[]>(session,"display",[]);
  const accountPlanIds = new Set(chatRecords.flatMap(chatPlanIds));
  const backgroundIds = [...ledgerJobs.filter(job => accountPlanIds.has(job.planId)).map(job => job.jobId), ...chatRecords.flatMap(chat => chat.display.flatMap(item => item.backgroundJob ? [item.backgroundJob.jobId] : [])), ...display.flatMap(item => item.backgroundJob ? [item.backgroundJob.jobId] : [])];
  const backgroundJobs = useBackgroundJobs(accountId, backgroundIds, setBackgroundNotice);
  const downloadTelemetry = useDownloadTelemetry(accountId, backgroundJobs);
  useEffect(() => onBackgroundSnapshots(backgroundJobs), [backgroundJobs, onBackgroundSnapshots]);
  useEffect(() => setBackgroundNotice(null), [accountId]);
  useEffect(() => {
    if (!backgroundNotice) return;
    const timer = window.setTimeout(() => setBackgroundNotice(null), 8000);
    return () => window.clearTimeout(timer);
  }, [backgroundNotice]);
  const displayRef = session.ref<DisplayMessage[]>("displayRef",display);
  const registryCandidates = session.ref("registryCandidates",new Map<string, RegistryMcpItem>());
  const skillCandidates = session.ref("skillCandidates",new Map<string, OnlineSkillCandidate | SkillSourceCandidate>());
  const [pendingId, setPendingId] = useConversationState(session,"pendingId","");
  const [pendingNeedsReview, setPendingNeedsReview] = useConversationState(session,"pendingNeedsReview",false);
  const [followupMode,setFollowupMode]=useConversationState<"queue"|"steer">(session,"followupMode","queue");
  const [followupMenuOpen,setFollowupMenuOpen]=useConversationState(session,"followupMenuOpen",false);
  const currentChat=chatRecords.find(chat=>chat.conversationId===conversationId);
  const queuedInputs=currentChat?.queuedInputs??[];
  const queuePaused=!!currentChat?.queuePaused;
  function changeQueue(change:(chat:SavedChat)=>SavedChat){setChatRecords(chats=>chats.map(chat=>chat.conversationId===conversationId?change(chat):chat));}
  const [planId, setPlanId] = useConversationState(session,"planId","");
  const planIdRef = session.ref("planIdRef",planId);
  const [planIds, setPlanIds] = useConversationState<string[]>(session,"planIds",[]);
  const planIdsRef = session.ref<string[]>("planIdsRef",planIds);
  const ownedTasks = conversationTasks.filter(task => planIds.includes(task.stored.planId));
  useEffect(() => {
    if (accountId && conversationId) savePlanPresentations(localStateStore, accountId, conversationId,
      inferPlanPresentations(display, ownedTasks.map(task => task.stored), messages));
  }, [accountId, conversationId, display, messages, conversationTasks]);
  const planAnchors = planCardAnchors(display, presentations);
  const planTitles = Object.fromEntries(Object.values(presentations).map(item => [item.planId, item.title]));
  const [workspace, setWorkspace] = useConversationState<WorkspaceSettings | null>(session,"workspace",null);
  function applyWorkspace(current: WorkspaceSettings | null, id = conversationId) {
    setWorkspace(current);
    if(activeConversationRef.current===id)onWorkspaceChange?.({ conversationId: id, permission: current?.permission ?? null });
  }
  const [defaultWorkspaceDirectory, setDefaultWorkspaceDirectory] = useState("");
  const [closedGroups, setClosedGroups] = useState<string[]>([]);
  const [workspaceList, setWorkspaceList] = useState<WorkspaceListView>(emptyWorkspaceList);
  const [workspaceMenu, setWorkspaceMenu] = useState<string | null>(null);
  const [renameDirectory, setRenameDirectory] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [removeDirectory, setRemoveDirectory] = useState<string | null>(null);
  const [accountMenuOpen, setAccountMenuOpen] = useState(false);
  const [fullAccessDialogOpen, setFullAccessDialogOpen] = useConversationState(session,"fullAccessDialogOpen",false);
  const [permissionMenuOpen, setPermissionMenuOpen] = useConversationState(session,"permissionMenuOpen",false);
  const extensionStoreOpen = mainView === "extensions";
  const [contextCompressed, setContextCompressed] = useConversationState(session,"contextCompressed",false);
  const contextCompressedRef = session.ref("contextCompressedRef",contextCompressed);
  const [lastInputTokens, setLastInputTokens] = useConversationState<number | null>(session,"lastInputTokens",null);
  const [codexAvailable, setCodexAvailable] = useState(false);
  const [codexContext, setCodexContext] = useConversationState<CodexTokenUsage | null>(session,"codexContext",null);
  const codexRun = session.ref<string | null>("codexRun",null);
  const [codexRequests, setCodexRequests] = useConversationState<CodexRequest[]>(session,"codexRequests",[]);
  const codexRequest = codexRequests[0];
  const codexRequestResolve = session.ref("codexRequestResolve",new Map<string, (value: unknown) => void>());
  const [openInputId,setOpenInputId]=useConversationState<string|null>(session,'openInputId',null);
  const userInputGate = session.ref("userInputGate",new UserInputGate());
  const humanRequestRevision=session.ref("humanRequestRevision",0);
  const gisDependencyGate=session.ref("gisDependencyGate",new GisDependencyGate());
  const [gisInstallRequest,setGisInstallRequest]=useConversationState<GisInstallRequest|null>(session,"gisInstallRequest",null);
  const gisInstallFlow=session.ref("gisInstallFlow",new GisInstallFlow({
    install:(id,requestId)=>api.gisSkillInstall(id,null,requestId),cancel:api.gisInstallCancel,
    subscribe:callback=>listen<GisInstallProgress>('geod:gis-install-progress',event=>callback(event.payload)),
    change:setGisInstallRequest,
    installed:offer=>appendDisplay({id:crypto.randomUUID(),role:"tool",content:`已安装技能 · ${offer.name}`}),
    failure:cause=>setError(errorMessage(cause)),errorMessage,
  }));
  function cancelGisInstall(){gisInstallFlow.current.cancel();}
  async function pauseUserWait(requestId:string|undefined,waiting:boolean){
    const run=codexRun.current;if(run&&requestId)await api.codexCommand(run,{type:'userInputState',requestId,waiting}).catch(()=>{});
  }
  async function ensureGis(requirement:GisRequirement,nativeRequestId?:string) {
    const result=await gisDependencyGate.current.ensure(()=>api.gisInstallPrepare(requirement.id,requirement.requireTools),offer=>{
      if(userInputGate.current.cancelled)return Promise.resolve(false);
      userInputGate.current.begin();setLiveActivity("等待确认组件安装…");
      void pauseUserWait(nativeRequestId,true);
      return gisInstallFlow.current.ask(offer,requirement.reason).then(accepted=>{
        void pauseUserWait(nativeRequestId,false);
        userInputGate.current.finishDependency(accepted);
        setLiveActivity(accepted?"正在继续原来的操作…":"已取消组件安装");
        return accepted;
      });
    });
    if(userInputGate.current.cancelled||result==='cancelled')return {error:"USER_INPUT_CANCELLED",message:"用户取消了组件安装，未继续本次操作。"};
    if(result==='pending')return {error:"USER_INPUT_PENDING",message:"正在等待所需组件安装，不重复发起安装或规划。"};
    return null;
  }
  const exportCrsPreferenceProcessed=session.ref<string|undefined>("exportCrsPreferenceProcessed",undefined);
  const exportCrsChoice = session.ref<{userMessageId?:string;crs:string;resampling?:"nearest"|"bilinear"|"cubic"}|null>("exportCrsChoice",null);
  async function rememberHumanCrsPreference(text: string, messageId?: string) {
    const intent = humanCrsIntent(text);
    if (intent.clear) await api.workspaceSetOutputCrs(conversationId, null);
    else if (intent.session && intent.crs) await api.workspaceSetOutputCrs(conversationId, intent.crs);
    exportCrsPreferenceProcessed.current = messageId;
  }
  async function rememberCrsAnswer(questions: ReturnType<typeof inputQuestions>, reply: ReturnType<typeof validatedInputReply>,userMessageId=[...displayRef.current].reverse().find(item=>item.role==='user')?.id) {
    const choice=crsFromAnswers(questions,reply);
    if (!choice) return;
    exportCrsChoice.current={...choice,userMessageId};
    if(choice.session) await api.workspaceSetOutputCrs(conversationId,choice.crs);
  }
  async function persistQuestionTranscript(){
    const previous=chatRecordsRef.current.find(chat=>chat.conversationId===conversationId);
    setChatRecords(persistCompletedChat(chatStore(),{...previous,...session.snapshot(),conversationId,messages:session.get('messages',[]),display:displayRef.current,updatedAt:new Date().toISOString()}));
    await flushLocalState();
  }
  async function waitForUserInput(request: CodexRequest,nativeRequestId?:string,toolCallId?:string): Promise<unknown> {
    const question=request.method==='item/tool/requestUserInput';
    if(question){
      const questions=inputQuestions(request.params.questions);
      if(questions.some(q=>q.isSecret))throw new Error('认证信息请通过对应的本机认证表单填写。');
      const human=[...displayRef.current].reverse().find(item=>item.role==='user');
      const id=`question-${request.requestId}`;
      appendDisplay({id,role:'tool',content:'补充需求',turnId:codexRun.current??undefined,userInput:{requestId:request.requestId,questions,status:'pending',userMessageId:human?.id,userText:human?.content,toolCallId,createdAt:new Date().toISOString()}});
      setOpenInputId(id);
      await persistQuestionTranscript();
    }
    await pauseUserWait(nativeRequestId??(question?request.requestId:undefined),true);
    try{return await new Promise(resolve => {
      codexRequestResolve.current.set(request.requestId, resolve);
      if(!question)setCodexRequests(previous => [...previous, request]);setLiveActivity("等待你的回复…");
    });}finally{await pauseUserWait(nativeRequestId??(question?request.requestId:undefined),false);}
  }
  function updateInputDraft(id:string,value:UserInputDraft){
    const current=displayRef.current.find(item=>item.id===id)?.userInput;if(!current||current.status!=='pending'||JSON.stringify(current.draft)===JSON.stringify(value))return;
    replaceDisplay(id,{userInput:{...current,draft:value}});void persistQuestionTranscript().catch(cause=>setError(errorMessage(cause)));
  }
  async function replyToInput(id:string,value:unknown){
    const record=displayRef.current.find(item=>item.id===id)?.userInput;if(!record)return;
    if(record.status==='resolved'&&record.resolution?.kind==='existingPlanCrs'&&value&&typeof value==='object'&&'continueRevision' in value){
      if(busy||sending.current||inputOrigin(displayRef.current,[...displayRef.current].reverse().find(m=>m.role==='user')?.id)!==record.userMessageId)return;
      if(pendingId){const generation=await api.agentGenerationGet(pendingId);if(['reserved','streaming','pending_reconcile'].includes(generation.state))throw new Error('模型请求还在核对中，请稍后检查。');await releasePending();await persistQuestionTranscript();}
      await send('继续刚才的任务');return;
    }
    if(record.status!=='pending')return;
    const reply=validatedInputReply(record.questions,value),resolve=codexRequestResolve.current.get(record.requestId);
    if(!resolve&&(busy||sending.current))throw new Error('请等当前回复结束后，再回答这张历史问答卡。');
    if(!resolve&&reply&&pendingId){
      const generation=await api.agentGenerationGet(pendingId);
      if(['reserved','streaming','pending_reconcile'].includes(generation.state))throw new Error('模型请求还在核对中，请稍后检查。');
      await releasePending();
    }
    await rememberCrsAnswer(record.questions,reply,record.userMessageId);
    replaceDisplay(id,{userInput:{...record,status:reply?'answered':'cancelled',reply:reply??undefined,draft:undefined}});
    await persistQuestionTranscript();setOpenInputId(null);
    if(resolve){codexRequestResolve.current.delete(record.requestId);if(reply)setLiveActivity("正在继续处理…");resolve(reply??{answers:{}});}
    else if(reply)await send(userInputReplyText(record,reply),undefined,false,undefined,crsFromAnswers(record.questions,reply));
    if(!reply&&resolve){userInputGate.current.cancelled=true;if(codexRun.current)void api.codexCommand(codexRun.current,{type:'interrupt'}).catch(cause=>setError(errorMessage(cause)));}
  }
  function cancelInputRequests(explicit=false) {
    cancelGisInstall();
    if(explicit){displayRef.current=displayRef.current.map(item=>item.userInput?.status==='pending'&&codexRequestResolve.current.has(item.userInput.requestId)?{...item,userInput:{...item.userInput,status:'cancelled'}}:item);setDisplay(displayRef.current);}
    for (const resolve of codexRequestResolve.current.values()) resolve(explicit?{ answers: {} }:detachedUserInput);
    codexRequestResolve.current.clear(); setCodexRequests([]);
  }
  const engine = chatRecords.find(chat => chat.conversationId === conversationId)?.engine ?? (codexAvailable ? "codex" : "legacy");
  const lastInputTokensRef = session.ref<number | null>("lastInputTokensRef",lastInputTokens);
  const [clock, setClock] = useState(() => Date.now());
  const [extensionApprovalBusy, setExtensionApprovalBusy] = useConversationState(session,"extensionApprovalBusy",false);
  const [legacyImportReady, setLegacyImportReady] = useState(false);
  const [draft, setDraft] = useConversationState(session,"draft","");
  const [images,setImages]=useConversationState<ImageAttachment[]>(session,"images",[]);
  const [imagesBusy,setImagesBusy]=useConversationState(session,"imagesBusy",false);
  const imageFileInput=useRef<HTMLInputElement>(null);
  const [documents,setDocuments]=useConversationState<DocumentAttachment[]>(session,"documents",[]);
  const [documentsBusy,setDocumentsBusy]=useConversationState(session,"documentsBusy",false);
  const documentFileInput=useRef<HTMLInputElement>(null);
  const [documentPasswordRequest,setDocumentPasswordRequest]=useConversationState<DocumentPasswordRequest|null>(session,"documentPasswordRequest",null);
  const documentCancels=useRef(new Map<string,()=>void>());
  useEffect(()=>()=>{documentCancels.current.get(session.conversationId)?.();},[session]);
  const audioFileInput=useRef<HTMLInputElement>(null);
  const [audioSetupOpen,setAudioSetupOpen]=useConversationState(session,"audioSetupOpen",false);
  const [pendingAudioFiles,setPendingAudioFiles]=useConversationState<File[]>(session,"pendingAudioFiles",[]);
  const [audioBusy,setAudioBusy]=useConversationState(session,"audioBusy",false);
  const [reviewAudio,setReviewAudio]=useConversationState<DocumentAttachment|null>(session,"reviewAudio",null);
  const audioCancels=useRef(new Map<string,()=>void>());
  async function attachAudio(files:File[]){
    if(engine!=="codex")throw new Error("音频输入请使用 Codex 引擎");
    if(documentsBusy)throw new Error("请等当前附件添加结束");
    if(documents.length+files.length>8)throw new Error("每轮最多附加 8 个文件");
    if(documents.reduce((sum,file)=>sum+file.bytes,0)+files.reduce((sum,file)=>sum+file.size,0)>64*1024*1024)throw new Error("本轮附件总大小不能超过 64 MB");
    const origin=conversationId;setDocumentsBusy(true);let cancelled=false,request='';
    const cancel=()=>{cancelled=true;if(request)void api.audioTranscriptionCancel(origin,request).catch(cause=>setError(errorMessage(cause)));};audioCancels.current.set(origin,cancel);
    try{const settings=await api.audioSettings();if(!settings.models.find(item=>item.id===settings.model)?.available){setPendingAudioFiles(files);setAudioSetupOpen(true);return;}
      setAudioBusy(true);await audioFiles(files,origin,id=>{request=id;},()=>cancelled,file=>setDocuments(current=>[...current,file]));
    }finally{audioCancels.current.delete(origin);setAudioBusy(false);setDocumentsBusy(false);}
  }
  async function attachDocuments(files:File[]){
    if(engine!=="codex")throw new Error("文档输入请使用 Codex 引擎");
    if(documentsBusy)throw new Error("请等当前附件添加结束");
    if(documents.length+files.length>8)throw new Error("每轮最多附加 8 个文档");
    if(documents.reduce((sum,file)=>sum+file.bytes,0)+files.reduce((sum,file)=>sum+file.size,0)>64*1024*1024)throw new Error("本轮文档总大小不能超过 64 MB");
    setDocumentsBusy(true);const origin=conversationId;let cancelled=false,respond:((password:string|null)=>void)|null=null;
    const cancel=()=>{cancelled=true;respond?.(null);respond=null;setDocumentPasswordRequest(null);};
    documentCancels.current.set(origin,cancel);
    try{await documentFiles(files,origin,file=>setDocuments(current=>[...current,file]),{
      cancelled:()=>cancelled,
      requestPassword:(file,error)=>new Promise(resolve=>{
        if(cancelled){resolve(null);return;}
        respond=resolve;
        setDocumentPasswordRequest({id:crypto.randomUUID(),name:file.name,error,respond:password=>{respond=null;setDocumentPasswordRequest(null);resolve(password);}});
      }),
    });}finally{if(documentCancels.current.get(origin)===cancel)documentCancels.current.delete(origin);setDocumentPasswordRequest(null);setDocumentsBusy(false);}
  }
  async function attachImages(files:File[]){
    if(engine!=="codex")throw new Error("图片输入请使用 Codex 引擎");
    if(images.length+files.length>8)throw new Error("每轮最多附加 8 张图片");
    if(images.reduce((sum,image)=>sum+image.bytes,0)+files.reduce((sum,file)=>sum+file.size,0)>24*1024*1024)throw new Error("本轮图片总大小不能超过 24 MB");
    setImagesBusy(true);const origin=conversationId;
    try{const added=await imageFiles(files,origin);setImages(current=>[...current,...added]);}finally{setImagesBusy(false);}
  }
  const [boundary, setBoundary] = useConversationState<BoundaryImport | null>(session,"boundary",null);
  const [savedBoundaries, setSavedBoundaries] = useConversationState<BoundarySummary[]>(session,"savedBoundaries",[]);
  async function attachRange(found: BoundaryImport) {
    const saved = await saveBoundary(conversationId, found);
    boundaryRef.current = saved; setBoundary(saved);
    const items = await api.boundariesList(conversationId);
    setSavedBoundaries(items);
  }
  useEffect(() => {
    let cancelled = false;
    setSavedBoundaries([]);
    if (desktopAvailable) void api.boundariesList(conversationId).then(items => { if (!cancelled) setSavedBoundaries(items); }).catch(cause => { if (!cancelled) setError(errorMessage(cause)); });
    return () => { cancelled = true; };
  }, [conversationId]);
  const [dataInputOpen, setDataInputOpen] = useConversationState(session,"dataInputOpen",false);
  const [initialDataInput, setInitialDataInput] = useConversationState<DataInputRequest | null>(session,"initialDataInput",null);
  const [connectionAuthentication, setConnectionAuthentication] = useConversationState<Omit<DataConnectionDraft, "password"> | null>(session,"connectionAuthentication",null);
  const connectionResolve = session.ref<((value: DataConnectionResult) => void) | null>("connectionResolve",null);
  const [sqlAuthentication,setSqlAuthentication]=useConversationState<SqlConnectionDraft|null>(session,"sqlAuthentication",null);
  const sqlResolve=session.ref<((value:SqlConnectionResult)=>void)|null>("sqlResolve",null);
  function finishSqlAuthentication(value:SqlConnectionResult){sqlResolve.current?.(value);sqlResolve.current=null;setSqlAuthentication(null);}
  function finishConnectionAuthentication(value: DataConnectionResult) {
    connectionResolve.current?.(value); connectionResolve.current = null;
    setConnectionAuthentication(null); setDataInputOpen(false);
  }
  async function runDataTool(tool: string, args: Record<string, unknown>,nativeRequestId?:string) {
    const revision=humanRequestRevision.current;
    const userId=[...displayRef.current].reverse().find(item=>item.role==='user')?.id;
    const run=()=>executeDataInputTool(conversationId, tool, args, {
      attach: attachRange,
      authenticate: draft => new Promise<DataConnectionResult>(resolve => {
        connectionResolve.current = resolve; setConnectionAuthentication(draft); setInitialDataInput(null); setDataInputOpen(true); setLiveActivity("等待数据库认证…");
      }),
      authenticateSql: draft=>new Promise<SqlConnectionResult>(resolve=>{sqlResolve.current=resolve;setSqlAuthentication(draft);setLiveActivity("等待数据库认证…");}),
    });
    let result;
    try{result=await run();}catch(cause){if(!missingGisDependency(cause))throw cause;result=cause;}
    const requirement=missingGisDependency(result)?gisRequirement(tool,args,true):null;
    if(!requirement)return result;
    const blocked=await ensureGis(requirement,nativeRequestId);if(blocked)return blocked;
    if(revision!==humanRequestRevision.current||userId!==[...displayRef.current].reverse().find(item=>item.role==='user')?.id)return {error:"REPLAN_AFTER_USER_INPUT",message:"用户请求已更新，请重新读取当前请求。"};
    return await run();
  }
  const boundaryRef = session.ref<BoundaryImport | null>("boundaryRef",boundary);
  const { status } = auth;
  const [usage, setUsage] = useState<ModelUsage | null>(null);
  const [busy, setBusy] = useConversationState(session,"busy",false);
  const revisionQuestionState=JSON.stringify(display.filter(m=>m.userInput?.status==='pending'&&m.userInput.requestId.startsWith('crs-')).map(m=>[m.id,m.userInput?.draft]));
  useEffect(()=>{
    if(!desktopAvailable||!accountId||mainView!=='conversation'||!displayRef.current.some(m=>m.userInput?.status==='pending'&&m.userInput.requestId.startsWith('crs-')))return;
    let cancelled=false;
    const original=displayRef.current;
    void resolvedRevisionQuestions(original,planIdsRef.current,boundaryRef.current,api.plansGet).then(async next=>{
      if(cancelled||next===original)return;
      const changed=next.filter((m,i)=>m!==original[i]).filter(m=>{const current=displayRef.current.find(n=>n.id===m.id);return current?.userInput?.status==='pending'&&JSON.stringify(current.userInput)===JSON.stringify(original.find(o=>o.id===m.id)?.userInput);});
      if(!changed.length)return;
      // A live old question belongs to the superseded implementation. Stop
      // that waiting turn without billing another generation or inventing answers.
      const runs=[...new Set(changed.map(m=>m.turnId).filter((id):id is string=>!!id))];
      displayRef.current=displayRef.current.map(m=>changed.find(n=>n.id===m.id)??m);
      setDisplay(displayRef.current);await persistQuestionTranscript();
      for(const run of runs){const proof=await api.billingRunSnapshot(run);if(proof.status==='running'&&proof.conversationId===conversationId){try{await api.codexCommand(run,{type:'interrupt'});}catch(cause){if(!(cause&&typeof cause==='object'&&'code' in cause&&cause.code==='CODEX_RUN_NOT_FOUND'))throw cause;}}}
      for(const m of changed){const r=m.userInput!;codexRequestResolve.current.get(r.requestId)?.(detachedUserInput);codexRequestResolve.current.delete(r.requestId);}
    }).catch(cause=>{if(!cancelled)setError(errorMessage(cause));});
    return ()=>{cancelled=true;};
  },[accountId,conversationId,mainView,revisionQuestionState]);
  const resolvedRevisionState=JSON.stringify(display.filter(m=>m.userInput?.resolution?.kind==='existingPlanCrs').map(m=>[m.id,m.turnId]));
  useEffect(()=>{
    if(!accountId||busy||!pendingId||!resolvedRevisionState||mainView!=='conversation')return;
    let cancelled=false;
    const generationId=pendingId;
    const origin=inputOrigin(displayRef.current,[...displayRef.current].reverse().find(m=>m.role==='user')?.id);
    const records=displayRef.current.filter(m=>m.userInput?.resolution?.kind==='existingPlanCrs'&&m.userInput.userMessageId===origin&&m.turnId);
    void (async()=>{
      for(const record of records){const proof=await api.billingRunSnapshot(record.turnId!);
        if(proof.status==='running'||proof.conversationId!==conversationId||!proof.generations.some(g=>g.generationId===generationId))continue;
        const generation=await api.agentGenerationGet(generationId);
        if(generation.state!=='settled'||cancelled||session.get('pendingId','')!==generationId)return;
        await releasePending();await persistQuestionTranscript();return;
      }
    })().catch(cause=>{if(!cancelled)setError(errorMessage(cause));});
    return ()=>{cancelled=true;};
  },[accountId,conversationId,mainView,busy,pendingId,resolvedRevisionState]);
  // Recheck restored/new cards without requesting connector state on every streamed delta.
  const mcpProposalState=JSON.stringify(display.filter(item=>item.extensionProposal?.kind==='mcp').map(item=>[item.id,item.extensionProposal!.id,item.extensionProposal!.detail,!!item.extensionProposal!.requiresKey]));
  useEffect(()=>{
    if(!desktopAvailable||!accountId||mainView!=='conversation')return;
    let cancelled=false;
    void api.extensionsList().then(installed=>{
      if(cancelled)return;
      const next=reconcileMcpProposals(busy?displayRef.current:repairSavedMcpHistory(displayRef.current,installed.connectors),installed.connectors);
      if(next!==displayRef.current){displayRef.current=next;setDisplay(next);void persistQuestionTranscript().catch(()=>{});}
    }).catch(()=>{});
    return ()=>{cancelled=true;};
  },[accountId,conversationId,mainView,busy,mcpProposalState]);
  const orphanedTurn=orphanedReasoningTurn(display);
  useEffect(()=>{
    if(!desktopAvailable||!accountId||busy||codexRun.current||!orphanedTurn||mainView!=='conversation')return;
    let cancelled=false;
    void recoverTurnOutcome(displayRef.current,conversationId,api).then(outcome=>{
      if(cancelled||!outcome||session.get('busy',false)||codexRun.current||orphanedReasoningTurn(displayRef.current)!==orphanedTurn)return;
      appendDisplay(outcome);void persistQuestionTranscript().catch(()=>{});
    }).catch(()=>{});
    return()=>{cancelled=true;};
  },[accountId,conversationId,mainView,busy,orphanedTurn]);

  const [liveActivity, setLiveActivity] = useConversationState(session,"liveActivity","正在思考下一步…");
  const [error, setError] = useConversationState(session,"error","");
  useEffect(()=>{
    if(busy||sending.current||pendingId||queuePaused||!queuedInputs.length||status.state!=="connected"||status.userId!==accountId||!workspace)return;
    const next=queuedInputs[0];const timer=window.setTimeout(()=>{if(sending.current)return;changeQueue(chat=>({...chat,queuedInputs:chat.queuedInputs?.filter(item=>item.id!==next.id)}));void send(next.text,next.images??[],true,next.documents??[]);},80);
    return()=>window.clearTimeout(timer);
  },[busy,pendingId,queuedInputs,queuePaused,conversationId,status.state,status.userId,accountId,workspace]);
  const [planReady, setPlanReady] = useConversationState(session,"planReady",false);
  const sending = session.ref("sending",false);
  const handledRegistration = session.ref<string | null>("handledRegistration",null);
  const emptyConversation = display.length === 0 && !pendingId && !planReady;
  const contextUsage = useMemo(() => contextWindowUsage(messages, modelUserText(draft, boundary)), [messages, draft, boundary]);

  useEffect(() => receiveBoundarySelection(conversationId, async found => {
    if (busy || pendingId || sending.current) throw new Error("请等当前回复结束后，再将地图范围用于对话。");
    await attachRange(found);
  }), [conversationId, busy, pendingId]);

  useEffect(() => onEmptyConversationChange(emptyConversation), [emptyConversation, onEmptyConversationChange]);

  useEffect(() => {
    if (!desktopAvailable) return;
    void api.codexAvailable().then(value => setCodexAvailable(value.available)).catch(() => setCodexAvailable(false));
  }, []);
  function changeEngine(value: string) {
    if (busy || pendingId || (value !== "codex" && value !== "legacy")) return;
    if(value==="legacy"&&images.length){setError("已附加图片，请使用 Codex 引擎发送，或先移除图片。");return;}
    if(value==="legacy"&&documents.length){setError("已附加文档，请使用 Codex 引擎发送，或先移除文档。");return;}
    setChatRecords(records => records.map(chat => chat.conversationId === conversationId ? { ...chat, engine: value } : chat));
  }
  useEffect(() => { if (status.state === "connected") void api.agentUsage().then(setUsage).catch(cause => setError(errorMessage(cause))); }, [status.state]);
  useEffect(() => {
    if (!desktopAvailable || !accountMenuOpen || status.state !== "connected") return;
    let cancelled = false;
    const refresh = () => void api.agentUsage().then(value => { if (!cancelled) setUsage(value); }).catch(() => {});
    refresh();
    const timer = window.setInterval(refresh, 15_000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [accountMenuOpen, status.state, status.userId]);
  useEffect(() => { const timer = window.setInterval(() => setClock(Date.now()), 60_000); return () => window.clearInterval(timer); }, []);
  useEffect(() => {
    if (status.state !== "connected") return;
    void api.workspaceDefault().then(value => setDefaultWorkspaceDirectory(value.directory)).catch(cause => setError(errorMessage(cause)));
  }, [status.state, status.userId]);
  useEffect(() => {
    if (status.state !== "connected" || !conversationId) return;
    let cancelled = false;
    void api.workspaceGet(conversationId).then(async current => {
      if (cancelled) return;
      applyWorkspace(current);
      const claim=await api.imageryPlansClaim(conversationId,planIdsRef.current);
      if(cancelled)return;
      if(claim.rejected.length)setError(`部分旧任务未能关联到当前工作区：${claim.rejected.map(item=>item.message).join("；")}`);
      setChatRecords(records => records.map(item => item.conversationId === conversationId && item.workspaceDirectory !== current.directory ? { ...item, workspaceDirectory: current.directory } : item));
    }).catch(cause => { if (!cancelled) setError(errorMessage(cause)); });
    return () => { cancelled = true; };
  }, [status.state, status.userId, conversationId]);
  useEffect(() => {
    if (status.state !== "connected" || !status.userId) {
      if (accountId) {
        for(const running of sessions.running(accountId)){ running.ref("userInputGate",new UserInputGate()).current.cancelled=true; const replies=running.ref("codexRequestResolve",new Map<string,(value:unknown)=>void>()).current; for(const reply of replies.values())reply({answers:{}});replies.clear();running.set("codexRequests",[]); const run=running.ref<string|null>("codexRun",null).current;if(run)void api.codexCommand(run,{type:"interrupt"}).catch(()=>{});}
        setAccountId(null); setChatRecords([]); setConversationId(""); setWorkspaceList(emptyWorkspaceList()); setWorkspaceMenu(null);setLegacyImportReady(false);onSelectConversation([], '');
      }
      return;
    }
    if (accountId === status.userId) return;
    try {
      const scoped = accountChatStore(localStateStore, status.userId);
      const restored = restoreChats(scoped);
      const list = restoreWorkspaceList(scoped);
      setWorkspaceList(list);
      const active = scoped.getItem(ACTIVE_CHAT_KEY);
      const first = restored.find(chat => chat.conversationId === active && !chat.archived && !list.hidden.includes(chat.workspaceDirectory ?? ""))
        ?? restored.find(chat => !chat.archived && !list.hidden.includes(chat.workspaceDirectory ?? "")) ?? restored[0];
      sessions.get(status.userId,first.conversationId,()=>conversationSessionSeed(first,readPending(scoped)?.[first.conversationId]));
      setChatRecords(restored);setConversationId(first.conversationId);setAccountId(status.userId);
      setLegacyImportReady(legacyChats(localStateStore).length > 0 && scoped.getItem(LEGACY_IMPORT_MARKER) !== "1");
      onSelectConversation(chatPlanIds(first), first.conversationId);
    } catch (cause) { setError(errorMessage(cause)); }
  }, [status.state, status.userId, accountId]);
  useEffect(() => {
    if(!accountId||status.state!=="connected"||status.userId!==accountId)return;
    const dirty=sessions.takeDirty(accountId);
    if(dirty.length)setChatRecords(current=>{
      let changed=false;const next=current.map(chat=>{const slot=dirty.find(slot=>slot.conversationId===chat.conversationId);if(!slot)return chat;
        const changes=slot.snapshot();if(Object.entries(changes).every(([key,value])=>Object.is(chat[key as keyof SavedChat],value)))return chat;
        changed=true;return {...chat,...changes};});return changed?next:current;
    });
  }, [accountId,status.state,status.userId,sessionRevision]);
  useEffect(()=>{onWorkspaceChange?.({conversationId,permission:workspace?.permission??null});},[conversationId,workspace?.permission,onWorkspaceChange]);
  useEffect(() => {
    if (accountId && status.state === "connected" && status.userId === accountId) accountChatStore(localStateStore, accountId).setItem(CHAT_LIST_KEY, JSON.stringify(chatRecords));
  }, [accountId, status.state, status.userId, chatRecords]);
  useEffect(() => {
    if (accountId && status.state === "connected" && status.userId === accountId && conversationId)
      accountChatStore(localStateStore, accountId).setItem(ACTIVE_CHAT_KEY, conversationId);
  }, [accountId, status.state, status.userId, conversationId]);
  useEffect(() => {
    if (!registeredSource || registeredSource.conversationId !== conversationId || handledRegistration.current === registeredSource.eventId || status.state !== "connected" || busy || pendingId || sending.current) return;
    handledRegistration.current = registeredSource.eventId;
    displayRef.current = displayRef.current.map(item => item.sourceDraft?.source.id === registeredSource.sourceId
      ? { ...item, content: `登记图源 · ${registeredSource.displayName} 已保存`, toolStatus: "success" as const, sourceDraft: undefined }
      : item);
    setDisplay(displayRef.current);
    void send(`我已核对并在本机登记图源「${registeredSource.displayName}」（ID：${registeredSource.sourceId}）。请继续刚才的任务。`);
  }, [registeredSource, conversationId, status.state, busy, pendingId]);

  function chatStore() {
    if (!accountId) throw new Error("请先登录 GeoD 再读取本机对话。");
    return accountChatStore(localStateStore, accountId);
  }

  async function logout() {
    if (runningIds.length || auth.busy) return;
    if (await auth.logout()) setUsage(null);
  }
  function saveWorkspaceList(next: WorkspaceListView) {
    if (!accountId) return;
    accountChatStore(localStateStore, accountId).setItem(WORKSPACE_LIST_KEY, JSON.stringify(next));
    setWorkspaceList(next);
  }
  function workspaceLabel(directory: string) {
    return workspaceList.names[directory] || (directory === defaultWorkspaceDirectory || directory === "默认工作区" ? t("默认工作区") : workspaceName(directory));
  }
  async function openWorkspaceFolder(chatId: string) {
    setWorkspaceMenu(null);
    try { await api.workspaceOpenDirectory(chatId); }
    catch (cause) { setError(errorMessage(cause)); }
  }
  function saveWorkspaceName() {
    if (!renameDirectory) return;
    const name = renameDraft.trim();
    if (!name) return;
    saveWorkspaceList({ ...workspaceList, names: { ...workspaceList.names, [renameDirectory]: name } });
    setRenameDirectory(null);
  }
  async function hideWorkspace() {
    if (!removeDirectory || !accountId || busy || sending.current || removeDirectory === defaultWorkspaceDirectory) return;
    const directory = removeDirectory;
    const activeIsHere = chatRecords.some(chat => chat.conversationId === conversationId && (chat.workspaceDirectory || defaultWorkspaceDirectory || "默认工作区") === directory);
    if (activeIsHere) {
      const nextChat = chatRecords.find(chat => {
        const path = chat.workspaceDirectory || defaultWorkspaceDirectory || "默认工作区";
        return path !== directory && !workspaceList.hidden.includes(path);
      });
      if (nextChat) selectChat(nextChat);
      else {
        const fallback = defaultWorkspaceDirectory || (await api.workspaceDefault()).directory;
        if (!await newChat(fallback)) return;
      }
    }
    saveWorkspaceList({ ...workspaceList, hidden: [...new Set([...workspaceList.hidden, directory])] });
    setRemoveDirectory(null);
  }
  async function addWorkspace() {
    if (!desktopAvailable || !accountId || busy || sending.current) return;
    try {
      const selected = await open({ directory: true, multiple: false, title: "选择或创建文件夹作为 GeoD Agent 工作区" });
      if (typeof selected === "string") await newChat(selected);
    } catch (cause) { setError(errorMessage(cause)); }
  }
  async function changePermission(permission: WorkspaceSettings["permission"]) {
    if (!workspace || busy) return;
    if (permission === "fullAccess" && workspace.permission !== "fullAccess") { setFullAccessDialogOpen(true); return; }
    try { applyWorkspace(await api.workspaceSet(conversationId, workspace.directory, permission)); }
    catch (cause) { setError(errorMessage(cause)); }
  }
  async function confirmFullAccess() {
    if (!workspace || busy) return;
    setBusy(true);
    try { applyWorkspace(await api.workspaceSet(conversationId, workspace.directory, "fullAccess")); setFullAccessDialogOpen(false); }
    catch (cause) { setError(errorMessage(cause)); }
    finally { setBusy(false); }
  }
  function rememberPlan(stored: StoredPlan, origin?: { userMessageId?: string; toolMessageId?: string; dataName?: string }) {
    if (origin && accountId) {
      savePlanPresentations(localStateStore, accountId, conversationId, [{ planId: stored.planId,
        title: defaultPlanTitle(origin.dataName, stored.plan.sourceName), userMessageId: origin.userMessageId, toolMessageId: origin.toolMessageId }]);
    }
    planIdRef.current = stored.planId; setPlanId(stored.planId);
    if (!planIdsRef.current.includes(stored.planId)) { planIdsRef.current = [...planIdsRef.current, stored.planId]; setPlanIds(planIdsRef.current); }
    setPlanReady(true); onPlanned(stored,conversationId);
  }
  const [creatingConversation,setCreatingConversation]=useState(false);
  async function newChat(directory?: string): Promise<boolean> {
    if(creatingConversation||!accountId)return false;
    setCreatingConversation(true);
    try {
      const id = crypto.randomUUID();
      const target = directory ?? workspace?.directory;
      const nextWorkspace = target ? await api.workspaceSet(id, target, "confirmEach") : await api.workspaceGet(id);
      const next: SavedChat = { conversationId: id, messages: [], display: [], planIds: [], workspaceDirectory: nextWorkspace.directory, updatedAt: new Date().toISOString() };
      setClosedGroups(current => current.filter(item => item !== nextWorkspace.directory));
      if (workspaceList.hidden.includes(nextWorkspace.directory)) saveWorkspaceList({ ...workspaceList, hidden: workspaceList.hidden.filter(path => path !== nextWorkspace.directory) });
      sessions.get(accountId,id,{...conversationSessionSeed(next),workspace:nextWorkspace});
      setChatRecords(current => [next, ...current]);setConversationId(id);onSelectConversation([],id);
      onMainViewChange("conversation");
      return true;
    } catch (cause) { setError(errorMessage(cause)); return false; }
    finally { setCreatingConversation(false); }
  }
  async function forkChat(){
    if(busy||sending.current||pendingId||!workspace||!accountId||engine!=="codex")return;
    setBusy(true);setError("");
    try{
      const id=crypto.randomUUID();const nextWorkspace=await api.workspaceSet(id,workspace.directory,workspace.permission);
      const source={conversationId,messages,display:displayRef.current};
      const imageIds=[...new Set([...source.messages.flatMap(m=>m.images?.map(i=>i.id)??[]),...source.display.flatMap(m=>m.images?.map(i=>i.id)??[])])];
      const documentIds=[...new Set([...source.messages.flatMap(m=>m.documents?.map(file=>file.id)??[]),...source.display.flatMap(m=>m.documents?.map(file=>file.id)??[])])];
      const result=await api.codexFork(conversationId,id,imageIds,documentIds);
      const images=new Map(result.images);const replaceImages=(items:ImageAttachment[]|undefined)=>items?.map(image=>images.get(image.id)??image);
      const clonedDocuments=new Map(result.documents.map(file=>[file.id,file]));const replaceDocuments=(items:DocumentAttachment[]|undefined)=>items?.map(file=>clonedDocuments.get(file.id)??file);
      const forkMessages=source.messages.map(message=>({...message,images:replaceImages(message.images),documents:replaceDocuments(message.documents)}));
      const forkDisplay=source.display.map(({sourceDraft:_sourceDraft,extensionProposal:_extensionProposal,backgroundJob:_backgroundJob,...item})=>({...item,images:replaceImages(item.images),documents:replaceDocuments(item.documents)}));
      const next:SavedChat={conversationId:id,title:`${chatTitle(currentChat??source).slice(0,24)} · 分支`,forkFromConversationId:conversationId,engine:"codex",messages:forkMessages,display:forkDisplay,planIds:[],workspaceDirectory:nextWorkspace.directory,updatedAt:new Date().toISOString(),codexContext:codexContext??undefined};
      const active=boundary?await api.boundariesSave(id,boundary):null;
      sessions.get(accountId,id,{...conversationSessionSeed(next),workspace:nextWorkspace,boundary:active});
      setChatRecords(persistCompletedChat(chatStore(),next));setConversationId(id);onSelectConversation([],id);onMainViewChange("conversation");
    }catch(cause){setError(errorMessage(cause));}finally{setBusy(false);}
  }
  function selectChat(chat: SavedChat) {
    onMainViewChange("conversation");if(chat.conversationId===conversationId||!accountId)return;
    const next=sessions.get(accountId,chat.conversationId,()=>conversationSessionSeed(chat,readPending(chatStore())?.[chat.conversationId]));
    setConversationId(chat.conversationId);onSelectConversation(next.get<string[]>("planIds",[]),chat.conversationId);
  }

  useEffect(() => {
    const search = (event: KeyboardEvent) => { if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") { event.preventDefault();setHistoryOpen(value=>!value); } };
    window.addEventListener("keydown",search);return()=>window.removeEventListener("keydown",search);
  }, []);
  function changeConversation(chat: SavedChat, change: Partial<SavedChat>) {
    const updated=persistCompletedChat(chatStore(),{...chatRecords.find(item=>item.conversationId===chat.conversationId)??chat,...change});
    setChatRecords(updated);void flushLocalState().catch(cause=>setError(errorMessage(cause)));
  }
  async function conversationAction(chat: SavedChat, action: ConversationAction) {
    if (action === "rename" || action === "delete") {setConversationEditor({chat,mode:action});return;}
    if (action === "pin") {changeConversation(chat,{pinned:!chat.pinned});return;}
    if (action === "archive" || action === "restore") {
      if (runningIds.includes(chat.conversationId)) {setError(t("停止回复后可以归档此会话。"));return;}
      changeConversation(chat,{archived:action==="archive"});
      if(action==="archive"&&chat.conversationId===conversationId){const next=chatRecords.find(item=>item.conversationId!==chat.conversationId&&!item.archived);if(next)selectChat(next);else await newChat();}
      return;
    }
    const format=action==="export-json"?"json":"markdown",content=exportConversation(chat,format);
    const filename=`${chatTitle(chat).replace(/[<>:"/\\|?*\x00-\x1f]/g,"_").slice(0,80)||"conversation"}.${format==="json"?"json":"md"}`;
    if(desktopAvailable){const path=await saveFileDialog({title:t("导出会话"),defaultPath:filename,filters:[{name:format==="json"?"JSON":"Markdown",extensions:[format==="json"?"json":"md"]}]});if(path)await invoke("conversation_export_save",{path,content});}
    else{const url=URL.createObjectURL(new Blob([content],{type:format==="json"?"application/json":"text/markdown"})),link=document.createElement("a");link.href=url;link.download=filename;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
  }
  async function importChat(file: File) {
    const imported=importConversation(await file.text(),crypto.randomUUID());
    const settings=await api.workspaceGet(imported.conversationId);imported.workspaceDirectory=settings.directory;
    setChatRecords(persistCompletedChat(chatStore(),imported));await flushLocalState();setHistoryOpen(false);selectChat(imported);
  }
  async function deleteConversation(chat: SavedChat) {
    if(runningIds.includes(chat.conversationId))return;
    sessions.forget(accountId??"",chat.conversationId);
    const next=deleteStoredConversation(chatStore(),chat.conversationId);setChatRecords(next);setConversationEditor(null);await flushLocalState();
    if(chat.conversationId===conversationId){const target=next.find(chat=>!chat.archived);if(target)selectChat(target);else await newChat();}
  }

  async function approveExtension(proposal: ExtensionProposal) {
    if (busy || extensionApprovalBusy || sending.current) return;
    setExtensionApprovalBusy(true);
    setError("");
    try {
      if (proposal.kind === "mcp") {
        const current = await api.extensionsList();
        const found = current.connectors.find(item => item.id === proposal.id);
        if (!found || found.url !== proposal.detail) throw new Error("连接器信息已变化，请重新检查后再接入。");
        const tools = await api.mcpTools(found.id, conversationId);
        if (!tools.tools.length) throw new Error("MCP 服务没有可用工具，暂未启用。");
        await api.mcpSetEnabled(found.id, true);
      } else {
        const current = await api.extensionsList();
        if (!current.skills.some(item => item.id === proposal.id && item.name === proposal.name
          && (!proposal.sha256 || item.contentSha256 === proposal.sha256 && item.sourceUrl === proposal.detail))) throw new Error("Skill 来源或内容已变化，请重新检查后再接入。");
        await api.skillSetEnabled(proposal.id, true);
      }
      displayRef.current = displayRef.current.map(item => item.extensionProposal?.id === proposal.id
        ? { ...item, content: `已启用 ${proposal.kind === "mcp" ? "MCP 连接器" : "Skill"} · ${proposal.name}`, toolStatus: "success" as const, extensionProposal: undefined }
        : item);
      setDisplay(displayRef.current);
      await send(`我已在对话中确认启用「${proposal.name}」。请继续刚才的任务。`);
    } catch (cause) { setError(errorMessage(cause)); }
    finally { setExtensionApprovalBusy(false); }
  }
  function importOlderChats() {
    if (!accountId || sending.current || busy) return;
    try {
      setChatRecords(importLegacyChats(localStateStore, accountId));
      setLegacyImportReady(false);
    } catch (cause) { setError(errorMessage(cause)); }
  }
  function pasteIntoComposer(event: ClipboardEvent<HTMLTextAreaElement>) {
    if (!desktopAvailable || busy || pendingId) return;
    const images=Array.from(event.clipboardData.files).filter(file=>file.type.startsWith("image/"));
    if(images.length){event.preventDefault();void attachImages(images).catch(cause=>setError(errorMessage(cause)));return;}
    const files = Array.from(event.clipboardData.files).filter(item => vectorAccept.split(',').some(ext => item.name.toLowerCase().endsWith(ext)));
    if (files.length) {
      event.preventDefault();
      void vectorFiles(files).then(request => { setInitialDataInput(request); setDataInputOpen(true); }).catch(cause => setError(errorMessage(cause)));
    }
  }
  useEffect(() => {
    const receive = (event: Event) => {
      const detail = (event as CustomEvent<{conversationId:string;result:ImageryRecoveryPlan}>).detail;
      if (detail?.conversationId === conversationId) rememberPlan(detail.result.stored, {dataName: detail.result.mode === "retryMissing" ? "影像补漏" : "缓存影像导出"});
    };
    window.addEventListener(IMAGERY_RECOVERY_PLANNED, receive);
    return () => window.removeEventListener(IMAGERY_RECOVERY_PLANNED, receive);
  }, [conversationId]);
  async function ownsPlan(id: string) {
    return planIdsRef.current.includes(id) || (await api.schedulesRuns(conversationId)).some(run => run.planId === id);
  }
  async function executeTool(call: AgentToolCall, generationId: string, context: AgentMessage[], toolMessageId?: string,nativeRequestId?:string): Promise<unknown> {
    // Capture the requesting message before awaits: steering and parallel calls may arrive meanwhile.
    const userMessageId = [...displayRef.current].reverse().find(item => item.role === "user")?.id;
    const requestRevision=humanRequestRevision.current;
    let args: Record<string, unknown>;
    try { args = JSON.parse(call.function.arguments) as Record<string, unknown>; }
    catch { return { error: "INVALID_TOOL_ARGUMENTS" }; }
    if (!args || typeof args !== "object" || Array.isArray(args)) return { error: "INVALID_TOOL_ARGUMENTS" };
    const inputBlock = userInputGate.current.block(call.function.name);
    if (inputBlock) return inputBlock;
    try {
      if (isExportPlan(call.function.name,args)) {
        await ensureExportRuntime(api.runtimeCapabilities);
        const human=[...displayRef.current].reverse().find(item=>item.role==="user");
        const intent=humanCrsIntent(human?.content ?? "");
        let workspace=await api.workspaceGet(conversationId);
        if ([...displayRef.current].reverse().find(item=>item.role==="user")?.id !== human?.id) return {error:"REPLAN_AFTER_USER_INPUT",message:"用户请求已更新，请依据最新请求重新规划。"};
        if(exportCrsPreferenceProcessed.current!==human?.id) {
          if(intent.clear) workspace=await api.workspaceSetOutputCrs(conversationId,null);
          else if(intent.session && intent.crs) workspace=await api.workspaceSetOutputCrs(conversationId,intent.crs);
          exportCrsPreferenceProcessed.current=human?.id;
        }
        const accepted=exportCrsChoice.current?.userMessageId===human?.id ? exportCrsChoice.current : answeredCrsChoice(displayRef.current,human?.id);
        const inherited=!accepted?await inheritedImageryCrs({messages:displayRef.current,userMessageId:human?.id,toolName:call.function.name,args,planIds:planIdsRef.current,activeBoundary:boundaryRef.current},api.plansGet):null;
        const answer=accepted??inherited;
        const raster=call.function.name!=="data_download_plan";
        const crs=resolveExportCrs(intent,answer?.crs,workspace.outputCrs,userInputGate.current.allowsChoices,raster);
        if(!crs) {
          if(userInputGate.current.waiting) return {error:"USER_INPUT_PENDING",message:"等待用户选择坐标系，不重复询问。"};
          const questions=inputQuestions(exportCrsQuestions.map(question=>({...question,header:t(question.header),question:t(question.question),options:question.options?.map(option=>({...option,label:t(option.label),description:option.description ? t(option.description) : undefined}))})));
          userInputGate.current.begin();
          const value=await waitForUserInput({type:"request",requestId:`crs-${crypto.randomUUID()}`,method:"item/tool/requestUserInput",params:{questions}},nativeRequestId,toolMessageId);
          if(isDetachedUserInput(value)){userInputGate.current.waiting=false;return {error:'USER_INPUT_SAVED',message:'问题已保存在会话中，用户可稍后打开并回答。未继续操作。'};}
          const reply=validatedInputReply(questions,value);
          userInputGate.current.finish(questions,reply);
          await rememberCrsAnswer(questions,reply);
          return reply ? {error:"REPLAN_AFTER_USER_INPUT",...reply,answeredBy:"user",message:"用户已选择成果坐标系和应用范围。读取答案后重新规划，未执行旧参数。"} : {error:"USER_INPUT_CANCELLED"};
        }
        if(raster) args.exportOptions={...(args.exportOptions as object ?? {}),targetCrs:crs,...(answer?.resampling?{resampling:answer.resampling}:{})};
        else args.targetCrs=crs;
        const requirement=gisRequirement(call.function.name,args);
        if(requirement){const blocked=await ensureGis(requirement,nativeRequestId);if(blocked)return blocked;}
        if(userInputGate.current.cancelled)return {error:"USER_INPUT_CANCELLED"};
        if(requestRevision!==humanRequestRevision.current||[...displayRef.current].reverse().find(item=>item.role==='user')?.id!==userMessageId)return {error:"REPLAN_AFTER_USER_INPUT",message:"用户请求已更新，请依据最新请求重新规划。"};
      }
      if (call.function.name === "ask_user") {
        const questions = inputQuestions(args.questions);
        if (questions.some(question => question.isSecret)) return { error: "SECRET_INPUT_NOT_SUPPORTED", message: "认证信息请通过对应的本机认证表单填写。" };
        const accepted=reusableInputReply(questions,displayRef.current,userMessageId);
        if(accepted)return {...accepted,answeredBy:'user',reusedPreviousAnswer:true};
        if(questions.some(q=>/(?:MCP|服务|server)/i.test(q.question)&&/(?:地址|endpoint|url)/i.test(q.question))){
          const known=knownSavedMcpAddress(questions,(await api.extensionsList()).connectors,displayRef.current.find(m=>m.id===userMessageId)?.content??'');
          if(known)return known;
        }
        userInputGate.current.begin();
        const value = await waitForUserInput({ type: "request", requestId: `ask-${crypto.randomUUID()}`, method: "item/tool/requestUserInput", params: { questions } },nativeRequestId,toolMessageId);
        if(isDetachedUserInput(value)){userInputGate.current.waiting=false;return {error:'USER_INPUT_SAVED',message:'问题已保存在会话中，用户可稍后打开并回答。未继续操作。'};}
        const reply = validatedInputReply(questions, value);
        userInputGate.current.finish(questions, reply);
        await rememberCrsAnswer(questions,reply);
        if (!reply) return { error: "USER_INPUT_CANCELLED", message: "用户取消了本次操作；未使用默认答案。" };
        return { ...reply, answeredBy: "user" };
      }
      if(call.function.name==="attachment_list")return await api.documentAttachmentsList(conversationId);
      if(call.function.name==="attachment_read"){const id=stringArg(args.id);if(!id)return{error:"INVALID_ATTACHMENT_ID"};return await api.documentAttachmentRead(conversationId,id,typeof args.offset==="number"?args.offset:undefined,typeof args.limit==="number"?args.limit:undefined);}
      if (call.function.name.startsWith("tiles3d_connection")) return await executeTiles3dConnectionTool(call.function.name, args);
      if (call.function.name.startsWith("ai_schedules_")) return await executeAiScheduleTool(conversationId,call.function.name,args,`${generationId}:${call.id}`,context);
      if (call.function.name.startsWith("background_command_")) return await executeBackgroundCommandTool(conversationId,call.function.name,args,`${generationId}:${call.id}`);
      if (call.function.name.startsWith("agent_memory_")) return await executeMemoryTool(conversationId,call.function.name,args);
      if (call.function.name.startsWith("agent_tasks_")) return await executeAgentTaskTool(conversationId,call.function.name,args,`${generationId}:${call.id}`);
      if (call.function.name.startsWith("data_schedules_")) return await executeDataScheduleTool(conversationId, call.function.name, args, `${generationId}:${call.id}`);
      if (call.function.name.startsWith("cache_")) return await executeCacheTool(call.function.name, args);
      if (call.function.name === "imagery_recovery_plan") {
        if (args.mode !== "retryMissing" && args.mode !== "exportAvailable") return {error:"INVALID_RECOVERY_MODE"};
        const result = await planImageryRecovery(conversationId, String(args.jobId), args.mode, `${generationId}:${call.id}`);
        rememberPlan(result.stored, {userMessageId, toolMessageId, dataName: args.mode === "retryMissing" ? "影像补漏" : "缓存影像导出"});
        return {...compactPlan(result.stored, result.permission), originalJobId:result.originalJobId, mode:result.mode};
      }
      if (call.function.name.startsWith("data_download_")) return await executeDataDownloadTool(conversationId, call.function.name, args, `${generationId}:${call.id}`);
      if (call.function.name === "sources_list") {
        const sources = await api.sourcesList();
        return { sources: sources.map(source => ({ id: source.id, name: source.displayName, license: source.license, attribution: source.attribution, minZoom: source.minZoom, maxZoom: source.maxZoom })) };
      }
      if (call.function.name === "extensions_list") {
        const installed = await api.extensionsList();
        const next=reconcileMcpProposals(displayRef.current,installed.connectors);if(next!==displayRef.current){displayRef.current=next;setDisplay(next);await persistQuestionTranscript();}
        const builtin = installed.skills.some(item => item.id === SOURCE_CREATOR_ID && item.enabled)
          ? [dataInputTools(), await api.sourceCreatorTools()] : [dataInputTools()];
        builtin.push(scheduleTools());
        builtin.push(aiScheduleTools());
        builtin.push(backgroundCommandTools());
        builtin.push(memoryTools());
        builtin.push(agentTaskTools());
        builtin.push(dataDownloadTools(), dataScheduleTools(), cacheTools(), tiles3dConnectionTools());
        const query = typeof args.query === "string" ? args.query.trim().toLowerCase().slice(0, 80) : "";
        return discoverExtensions(installed, query, id => api.mcpTools(id, conversationId), builtin);
      }
      if (call.function.name === "workspace_gis_files_list") {
        return { files: await api.workspaceGisFilesList(conversationId) };
      }
      if (call.function.name === "workspace_skills_list") {
        return { skills: await api.workspaceSkillsList(conversationId) };
      }
      if (call.function.name === "workspace_skill_import") {
        const relativePath = typeof args.relativePath === "string" ? args.relativePath : "";
        const candidates = await api.workspaceSkillsList(conversationId);
        const candidate = candidates.find(item => item.relativePath === relativePath);
        if (!candidate) return { error: "SKILL_NOT_IN_WORKSPACE" };
        const overview = await api.workspaceSkillImport(conversationId, relativePath);
        const skill = overview.skills.find(item => item.name === candidate.name);
        if (!skill) return { error: "SKILL_IMPORT_FAILED" };
        return { imported: true, enabled: false, requiresUserReview: true,
          extensionProposal: { kind: "skill", id: skill.id, name: skill.name, description: skill.description, detail: relativePath } satisfies ExtensionProposal };
      }
      if (call.function.name === "skill_catalog_search") {
        const query = stringArg(args.query);
        if (!query || query.trim().length < 2) return { error: "INVALID_SKILL_QUERY" };
        const results = (await api.skillCatalogSearch(query)).slice(0, 12);
        skillCandidates.current.clear();
        for (const item of results) skillCandidates.current.set(item.id, item);
        return { candidates: results };
      }
      if (call.function.name === "skill_source_inspect") {
        const url = typeof args.url === "string" ? args.url : "";
        const lastUser = [...context].reverse().find(message => message.role === "user")?.content ?? "";
        if (!url || url.length > 2048 || !userProvidedUrl(lastUser, url)) return { error: "SKILL_URL_NOT_USER_PROVIDED" };
        const results = (await api.skillSourceInspect(url)).slice(0, 30);
        for (const item of results) skillCandidates.current.set(item.id, item);
        return { candidates: results };
      }
      if (call.function.name === "skill_connect") {
        const id = typeof args.candidateId === "string" ? args.candidateId : "";
        const explicitUrl = typeof args.url === "string" ? args.url : "";
        const lastUser = [...context].reverse().find(message => message.role === "user")?.content ?? "";
        const source = skillCandidates.current.has(id) ? id : explicitUrl && explicitUrl.length <= 2048 && userProvidedUrl(lastUser, explicitUrl) ? explicitUrl : "";
        if (!source) return { error: "SKILL_CANDIDATE_NOT_FOUND", next: "先搜索网络 Skill，或使用用户本轮明确提供的链接" };
        const staged = await api.skillRemoteStage(source);
        if (staged.enabled) return { installed: true, enabled: true, name: staged.name, source: staged.sourceUrl };
        return { installed: true, enabled: false, requiresUserReview: true,
          extensionProposal: { kind: "skill", id: staged.id, name: staged.name, description: staged.description,
            detail: staged.sourceUrl, sha256: staged.contentSha256 } satisfies ExtensionProposal };
      }
      if (call.function.name === "mcp_registry_search") {
        const query = stringArg(args.query);
        if (!query || query.trim().length < 2) return { error: "INVALID_REGISTRY_QUERY" };
        const results = (await api.mcpRegistrySearch(query)).slice(0, 8);
        for (const item of results) registryCandidates.current.set(item.name, item);
        const saved=(await api.extensionsList()).connectors;
        while(registryCandidates.current.size>32)registryCandidates.current.delete(registryCandidates.current.keys().next().value!);
        return {candidates:results.map(item=>{const found=saved.find(c=>c.url===item.url);return {...item,candidateId:item.name,registryName:item.name,...(found?{connectorId:found.id,registered:true,enabled:found.enabled,authenticationConfigured:!!(found.queryNames?.length||found.headerNames?.length||found.oauth)}:{})};})};
      }
      if (call.function.name === "mcp_connect") {
        const installed=(await api.extensionsList()).connectors;
        const lastUser=[...context].reverse().find(message=>message.role==='user')?.content??'';
        const target=resolveMcpTarget(args,installed,registryCandidates.current,url=>userProvidedUrl(lastUser,url)||userApprovedMcpUrl(displayRef.current,userMessageId,url));
        if('error' in target)return target;
        const existingSetup=displayRef.current.some(m=>m.extensionProposal?.requiresKey&&m.extensionProposal.detail===target.item.url);
        return prepareMcpConnection(target,conversationId,call.id,api,existingSetup);
      }
      if (call.function.name === "gdal_connect") {
        let connector = (await api.extensionsList()).connectors.find(item => item.transport === "gdalStdio");
        if (!connector) connector = (await api.mcpAddGdal()).connectors.find(item => item.transport === "gdalStdio");
        if (!connector) return { error: "GDAL_CONNECTOR_UNAVAILABLE" };
        const tools = await api.mcpTools(connector.id, conversationId);
        if (!tools.tools.length) return { error: "GDAL_NO_TOOLS", registered: true, enabled: false };
        if (connector.enabled) return { connected: true, enabled: true, connectorId: connector.id, tools: tools.tools.map(tool => tool.name) };
        return { connected: true, enabled: false, requiresUserReview: true,
          extensionProposal: { kind: "mcp", id: connector.id, name: connector.name,
            description: "本机 GDAL：在当前对话工作区查看、统计、转换和处理栅格及矢量文件。重投影需要 AI 说明坐标系和重采样选择；写入新文件需要完全访问权限。",
            detail: connector.url, toolNames: tools.tools.map(tool => tool.name) } satisfies ExtensionProposal };
      }
      if (call.function.name === "skill_read") {
        const name = stringArg(args.name);
        if (!name) return { error: "INVALID_SKILL_NAME" };
        const content = await api.skillRead(name);
        return { name, content: content.slice(0, 16_000), truncated: content.length > 16_000 };
      }
      if (call.function.name === "mcp_call") {
        const connectorId = stringArg(args.connectorId);
        const toolName = stringArg(args.toolName);
        const toolArgs = args.arguments;
        if (!connectorId || !toolName || !toolArgs || typeof toolArgs !== "object" || Array.isArray(toolArgs)) return { error: "INVALID_MCP_CALL" };
        if(connectorId===SCHEDULE_CONNECTOR_ID){
          if(!scheduleTools().tools.some(tool=>tool.name===toolName))return {error:'TOOL_NOT_ALLOWED'};
          return {connectorId,toolName,result:await executeTool({...call,function:{...call.function,name:toolName,arguments:JSON.stringify(toolArgs)}},generationId,context,toolMessageId,nativeRequestId)};
        }
        if (connectorId === TILES3D_CONNECTION_ID) return {connectorId,toolName,result:await executeTiles3dConnectionTool(toolName,toolArgs as Record<string,unknown>)};
        if (connectorId === AI_SCHEDULE_ID) return {connectorId,toolName,result:await executeAiScheduleTool(conversationId,toolName,toolArgs as Record<string,unknown>,`${generationId}:${call.id}`,context)};
        if (connectorId === BACKGROUND_COMMAND_ID) return {connectorId,toolName,result:await executeBackgroundCommandTool(conversationId,toolName,toolArgs as Record<string,unknown>,`${generationId}:${call.id}`)};
        if (connectorId === AGENT_TASK_ID) return {connectorId,toolName,result:await executeAgentTaskTool(conversationId,toolName,toolArgs as Record<string,unknown>,`${generationId}:${call.id}`)};
        if (connectorId === MEMORY_ID) return {connectorId,toolName,result:await executeMemoryTool(conversationId,toolName,toolArgs as Record<string,unknown>)};
        if (connectorId === DATA_DOWNLOAD_ID) {
          if (!dataDownloadTools().tools.some(tool=>tool.name===toolName)) return {error:"TOOL_NOT_ALLOWED"};
          return {connectorId,toolName,result:await executeTool({...call,function:{...call.function,name:toolName,arguments:JSON.stringify(toolArgs)}},generationId,context,toolMessageId,nativeRequestId)};
        }
        if (connectorId === "builtin-data-schedules") return {connectorId,toolName,result:await executeDataScheduleTool(conversationId,toolName,toolArgs as Record<string,unknown>,`${generationId}:${call.id}`)};
        if (connectorId === "builtin-cache") return {connectorId,toolName,result:await executeCacheTool(toolName,toolArgs as Record<string,unknown>)};
        if (connectorId === DATA_INPUT_ID) {
          return await runDataTool(toolName, toolArgs as Record<string, unknown>,nativeRequestId);
        }
        if (connectorId === SOURCE_CREATOR_ID) {
          if (toolName === "lookup_boundary" || toolName === "lookup_boundaries") { boundaryRef.current = null; setBoundary(null); }
          const result = await api.sourceCreatorCall(toolName, toolArgs as Record<string, unknown>);
          if (toolName === "lookup_boundary" || toolName === "lookup_boundaries" || toolName === "wayback_changes") {
            return { connectorId, kind: "builtin", toolName, result: await attachBoundaryLookup(conversationId, toolName, result, attachRange) };
          }
          return { connectorId, kind: "builtin", toolName, result };
        }
        return { connectorId, toolName, result: await api.mcpCall(connectorId, toolName, toolArgs as Record<string, unknown>, `${generationId}:${call.id}`, conversationId) };
      }
      if (call.function.name === "mcp_result_export") {
        const executionId=stringArg(args.executionId);
        if(!executionId||typeof (args.jsonPointer??"")!=="string")return {error:"INVALID_MCP_RESULT_REFERENCE"};
        return await api.mcpResultExport(executionId,conversationId,String(args.jsonPointer??""));
      }
      if (call.function.name === "mcp_result_read") {
        const executionId = stringArg(args.executionId);
        const offset = args.offset;
        if (!executionId || !Number.isSafeInteger(offset) || (offset as number) < 1) return { error: "INVALID_MCP_RESULT_PAGE" };
        const offered = context.some(message => {
          if (message.role !== "tool" || !message.content) return false;
          try {
            const data = JSON.parse(message.content) as { result?: { executionId?: string; nextOffset?: number } };
            return data.result?.executionId === executionId && data.result.nextOffset === offset;
          } catch { return false; }
        });
        if (!offered) return { error: "MCP_RESULT_PAGE_NOT_OFFERED" };
        return { executionId, result: await api.mcpResultRead(executionId, offset as number) };
      }
      if (call.function.name === "source_configure") {
        const draft = sourceRegistrationDraft(args);
        if (!draft) return { error: "INVALID_SOURCE_CONFIGURATION" };
        return configureSource(draft);
      }
      if (call.function.name === "source_registration_prepare") {
        const draft = sourceRegistrationDraft(args);
        return draft ? { prepared: true, saved: false, requiresUserReview: true, draft } : { error: "INVALID_SOURCE_DRAFT" };
      }
      if (call.function.name === "workspace_status") {
        const current = await api.workspaceGet(conversationId);
        applyWorkspace(current);
        return { name: current.directory.split(/[\\/]/).filter(Boolean).at(-1), outputCrs:current.outputCrs ?? null, permission: current.permission, defaultOutput: "此工作区中的新文件夹", canStartWithoutPlanConfirmation: current.permission === "fullAccess", currentTime: new Date().toISOString(), timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone };
      }
      if (call.function.name === "workspace_boundaries_list") {
        return { files: await api.workspaceBoundariesList(conversationId) };
      }
      if (call.function.name === "workspace_boundary_use") {
        const relativePath = args.relativePath;
        if (typeof relativePath !== "string" || relativePath.length < 1 || relativePath.length > 240) return { error: "INVALID_BOUNDARY_PATH" };
        const found = await api.workspaceBoundaryUse(conversationId, relativePath);
        await attachRange(found);
        return { ...rangeSummary(boundaryRef.current!), source: "selected workspace" };
      }
      if (dataInputTools().tools.some(tool => tool.name === call.function.name)) return await runDataTool(call.function.name, args,nativeRequestId);
      if (call.function.name === "us_county_boundary") {
        const stateFips = stringArg(args.stateFips);
        const countyName = stringArg(args.countyName);
        if (!stateFips || !countyName) return { error: "INVALID_BOUNDARY_QUERY" };
        const found = await api.usCountyBoundary(stateFips, countyName);
        await attachRange(found);
        return { ...rangeSummary(boundaryRef.current!), source: "U.S. Census Bureau TIGERweb Counties 2026" };
      }
      if (call.function.name === "boundaries_list") return { boundaries: await api.boundariesList(conversationId), activeBoundaryId: boundaryRef.current?.boundaryId ?? null };
      if (call.function.name === "schedules_list") return {schedules:await api.schedulesList(conversationId),runs:await api.schedulesRuns(conversationId)};
      if (call.function.name === "schedules_cancel_run") {const runs=await api.schedulesRuns(conversationId);if(!runs.some(run=>run.runId===args.runId))return {error:'SCHEDULE_NOT_IN_CONVERSATION'};return await api.schedulesCancelRun(String(args.runId));}
      if (call.function.name === "schedules_create") {if(!await ownsPlan(String(args.planId)))return {error:'PLAN_NOT_IN_CONVERSATION'};return await api.schedulesCreate(conversationId,String(args.planId),String(args.name),String(args.nextRunAt),typeof args.repeatSeconds==='number'?args.repeatSeconds:null,typeof args.maxRetries==='number'?args.maxRetries:2,`${generationId}:${call.id}`);}
      if (call.function.name === "schedules_set_enabled") return await api.schedulesSetEnabled(String(args.scheduleId),args.enabled===true,typeof args.nextRunAt==='string'?args.nextRunAt:undefined);
      if (call.function.name === "boundaries_combine") {
        if (!Array.isArray(args.boundaryIds) || !args.boundaryIds.length || !args.boundaryIds.every(id => typeof id === "string")) return { error: "INVALID_BOUNDARY_SELECTION" };
        const combined = await api.boundariesCombine(conversationId, args.boundaryIds as string[], stringArg(args.name) ?? undefined);
        await attachRange(combined);
        return rangeSummary(combined);
      }
      if (call.function.name === "plan_imagery_batch") {
        const result = await planImagery(args, conversationId, `${generationId}:${call.id}`, boundaryRef.current, true);
        for (const item of result.plans) {
          assertPlanAvailable(localStateStore, accountId, conversationId, item.stored.planId);
          rememberPlan(item.stored, { userMessageId, toolMessageId, dataName: item.rangeName });
        }
        setSavedBoundaries(await api.boundariesList(conversationId));
        const permission = (await api.workspaceGet(conversationId)).permission;
        return { mode: args.mode, plans: result.plans.map(item => ({ ...compactPlan(item.stored, permission), name: defaultPlanTitle(item.rangeName, item.stored.plan.sourceName) })), errors: result.errors };
      }
      if (call.function.name === "plan_imagery") {
        const toolExecutionId = `${generationId}:${call.id}`;
        const previous = await api.plansForToolExecution(toolExecutionId);
        if (previous) {
          assertPlanAvailable(localStateStore, accountId, conversationId, previous.planId);
          rememberPlan(previous);
          return compactPlan(previous, (await api.workspaceGet(conversationId)).permission);
        }
        const result = await planImagery(args, conversationId, toolExecutionId, boundaryRef.current);
        if (!result.plans[0]) return { error: result.errors[0]?.error ?? "PLAN_NOT_CREATED" };
        const { stored: plan, rangeName } = result.plans[0];
        rememberPlan(plan, { userMessageId, toolMessageId, dataName: rangeName });
        return compactPlan(plan, (await api.workspaceGet(conversationId)).permission);
      }
      if (call.function.name === "plans_get") {
        const id = stringArg(args.planId);
        if (!id || !await ownsPlan(id)) return { error: "PLAN_NOT_IN_CONVERSATION" };
        assertPlanAvailable(localStateStore, accountId, conversationId, id);
        const stored = await api.plansGet(id);
        return stored ? compactPlan(stored, (await api.workspaceGet(conversationId)).permission) : { error: "PLAN_NOT_FOUND" };
      }
      if (call.function.name === "jobs_list") {
        const jobs = await api.jobsList();
        const active = await api.jobsActive();
        const scheduledIds=(await api.schedulesRuns(conversationId)).map(run=>run.planId);
        return { jobs: jobs.filter(job => planIdsRef.current.includes(job.planId)||scheduledIds.includes(job.planId)).map(job => ({ jobId: job.jobId, planId: job.planId, state: jobExecutionState(job, active.includes(job.jobId)), ledgerState: job.state, workerActive: active.includes(job.jobId), createdAt: job.createdAt })) };
      }
      if (call.function.name === "jobs_start") {
        const id = stringArg(args.planId);
        if (!id || !await ownsPlan(id)) return { error: "PLAN_NOT_IN_CONVERSATION" };
        const started = await withPlanTaskLock(accountId ?? '', conversationId, id, async () => {
          assertPlanAvailable(localStateStore, accountId, conversationId, id);
          return startPlanJob(api, id, conversationId, `${generationId}:${call.id}`);
        });
        if ("error" in started) return started;
        onJobStarted(started.job,conversationId);
        return started.result;
      }
      if (call.function.name === "jobs_get") {
        const id = stringArg(args.jobId);
        if (!id) return { error: "INVALID_JOB_ID" };
        const job = await api.jobsGet(id);
        if (!job || !await ownsPlan(job.planId)) return { error: "JOB_NOT_IN_CONVERSATION" };
        const [events, active, stored] = await Promise.all([api.jobsEvents(id, 0), api.jobsActive(), api.plansGet(job.planId)]);
        return jobStatusFacts(job, active.includes(id), events, stored?.plan.totalTiles ?? 0);
      }
      if (call.function.name === "jobs_events") {
        const id = stringArg(args.jobId);
        if (!id) return { error: "INVALID_JOB_ID" };
        const job = await api.jobsGet(id);
        if (!job || !await ownsPlan(job.planId)) return { error: "JOB_NOT_IN_CONVERSATION" };
        const [events, active, stored] = await Promise.all([api.jobsEvents(id, 0), api.jobsActive(), api.plansGet(job.planId)]);
        return { ...jobStatusFacts(job, active.includes(id), events, stored?.plan.totalTiles ?? 0), events: events.slice(-10).map(event => ({ state: event.state, occurredAt: event.occurredAt, errorCode: event.errorCode, completedTiles: event.completedTiles, totalTiles: event.totalTiles })) };
      }
      if (call.function.name === "artifacts_inspect") {
        const id = stringArg(args.jobId);
        if (!id) return { error: "INVALID_JOB_ID" };
        const job = await api.jobsGet(id);
        if (!job || !await ownsPlan(job.planId)) return { error: "JOB_NOT_IN_CONVERSATION" };
        if (!job || (job.state !== "completed" && job.state !== "partial")) return { error: "JOB_NOT_COMPLETED" };
        const manifest = await api.artifactsInspect(id);
        return artifactResultForModel(id, manifest);
      }
      return { error: "TOOL_NOT_ALLOWED" };
    } catch (cause) {
      if (runtimeCompatibilityFailure(cause)) throw runtimeUpdateError();
      return { error: cause && typeof cause === "object" && "code" in cause && typeof cause.code === "string" ? cause.code : "LOCAL_TOOL_ERROR", message: errorMessage(cause) };
    }
  }
  function appendDisplay(item: DisplayMessage) {
    displayRef.current = [...displayRef.current, item];
    setDisplay(displayRef.current);
  }
  async function trackBackgroundJob(job: Pick<Job, "jobId" | "planId">) {
    const id = `background-job-${job.jobId}`;
    if (displayRef.current.some(item => item.backgroundJob?.jobId === job.jobId)) return;
    const stored = await api.plansGet(job.planId);
    if (!stored || displayRef.current.some(item => item.backgroundJob?.jobId === job.jobId)) return;
    appendDisplay({ id, role: "tool", content: `后台下载 · ${stored.plan.sourceName}`, backgroundJob: {
      jobId: job.jobId, planId: job.planId, sourceName: stored.plan.sourceName, totalTiles: stored.plan.totalTiles,
      zoomLevels: stored.plan.spec.zoomLevels, outputFormats: stored.plan.spec.outputFormats,
    } });
  }
  async function openBackgroundJob(id: string) {
    try {
      const job = await api.jobsGet(id);
      if (job && planIdsRef.current.includes(job.planId)) onOpenJob?.(job);
    } catch (cause) { setError(errorMessage(cause)); }
  }
  useEffect(() => {
    if (selectedJob && planIds.includes(selectedJob.planId) && backgroundRunning(selectedJob.state))
      void trackBackgroundJob(selectedJob).catch(cause => setError(errorMessage(cause)));
  }, [selectedJob?.jobId, conversationId, planIds.join(",")]);
  function replaceDisplay(id: string, change: Partial<DisplayMessage>) {
    displayRef.current = displayRef.current.map(item => item.id === id ? { ...item, ...change } : item);
    setDisplay(displayRef.current);
  }
  function removeDisplay(id: string) {
    displayRef.current = displayRef.current.filter(item => item.id !== id);
    setDisplay(displayRef.current);
  }
  function removeTransientGeneration(generationId: string) {
    displayRef.current = displayRef.current.filter(item => item.id !== `stream-${generationId}` && !item.id.startsWith(`tool-${generationId}-`));
    setDisplay(displayRef.current);
  }
  async function releasePending() {
    clearPending(chatStore(), conversationId);
    await flushLocalState();
    setPendingId("");
    setPendingNeedsReview(false);
  }
  async function commitFinalGeneration(generationId: string, context: AgentMessage[]) {
    const compacted = boundedContext(context);
    contextCompressedRef.current ||= JSON.stringify(compacted).length < JSON.stringify(context).length;
    setContextCompressed(contextCompressedRef.current);
    const completed = { engine, ...(engine === "codex" ? { codexContext: codexContext ?? undefined } : {}), messages: compacted, display: displayRef.current, planId: planIdRef.current || undefined, planIds: planIdsRef.current, contextCompressed: contextCompressedRef.current, lastInputTokens: lastInputTokensRef.current ?? undefined };
    commitPending(chatStore(), conversationId, generationId, completed);
    await flushLocalState();
    const updated = persistCompletedChat(chatStore(), { conversationId, ...completed, workspaceDirectory: workspace?.directory, updatedAt: new Date().toISOString() });
    setChatRecords(updated);
    await releasePending();
  }
  async function handleGenerationFailure(cause: unknown) {
    const saved = readPending(chatStore())?.[conversationId];
    if (saved) removeTransientGeneration(saved.generationId);
    const rejectedForQuota = cause && typeof cause === "object" && "code" in cause && cause.code === "QUOTA_EXCEEDED";
    if (rejectedForQuota) {
      if (saved) { setMessages(saved.messages); await commitFinalGeneration(saved.generationId, saved.messages); }
      else await releasePending();
    } else if(saved?.engine==='codex'&&outputFailureCode(errorMessage(cause))){
      const observed=await api.agentGenerationGet(saved.generationId).catch(()=>null);
      if(modelResponseIssue(observed)){await persistQuestionTranscript();await releasePending();setError('');void api.agentUsage().then(setUsage).catch(()=>{});return;}
      else setPendingNeedsReview(true);
    } else setPendingNeedsReview(!!saved);
    setError(errorMessage(cause));
    void api.agentUsage().then(setUsage).catch(() => {});
  }
  async function requestGeneration(context: AgentMessage[], activeBoundary: BoundaryImport | null, visible?: DisplayMessage[]) {
    if (!status.userId) throw new Error("GeoD 账号状态未确认，请重新检查登录状态。");
    const currentWorkspace = await api.workspaceGet(conversationId);
    applyWorkspace(currentWorkspace);
    const permissionContext = workspacePermissionContext(context, currentWorkspace.permission, currentWorkspace.outputCrs);
    const requestContext = boundedContext(permissionContext);
    contextCompressedRef.current ||= JSON.stringify(requestContext).length < JSON.stringify(permissionContext).length;
    setContextCompressed(contextCompressedRef.current);
    const generationId = crypto.randomUUID();
    savePending(chatStore(), { conversationId, generationId, userId: status.userId, messages: requestContext, display: visible ?? displayRef.current, boundary: activeBoundary, boundaryRequired: !!activeBoundary });
    await flushLocalState();
    setPendingId(generationId);
    setPendingNeedsReview(false);
    setLiveActivity("正在思考下一步…");
    let streamedText = "";
    const entryId = `stream-${generationId}`;
    const generation = await api.agentGenerateStream(generationId, conversationId, requestContext, event => {
      if (event.type === "content_delta") {
        streamedText += event.data.text;
        setLiveActivity("正在生成回复…");
        if (displayRef.current.some(item => item.id === entryId)) replaceDisplay(entryId, { content: streamedText });
        else appendDisplay({ id: entryId, role: "assistant", phase: "progress", content: streamedText, streaming: true });
      } else if (event.type === "tool_start") {
        const previewId = `tool-${generationId}-${event.data.index}`;
        if (!displayRef.current.some(item => item.id === previewId)) appendDisplay({ id: previewId, role: "tool", toolName: event.data.name, toolStatus: "running", content: `正在准备工具：${event.data.name}` });
        setLiveActivity(`正在准备工具：${event.data.name}`);
      }
    });
    await api.agentUsage().then(setUsage).catch(() => {});
    return generation;
  }
  async function finishGeneration(first: Generation, startingContext: AgentMessage[]) {
    let context = startingContext;
    let generation = first;
    for (let round = 0; round < 12; round++) {
      if (generation.state === "failed") removeTransientGeneration(generation.generationId);
      if (generation.state === "failed") { await releasePending(); setError("该模型请求已失败，额度已按网关记录处理。可以继续提问。"); return; }
      if (generation.state === "settled" && !generation.result) { await releasePending(); setError("上游用量已核对，但原回答不可恢复。可以继续提问。"); return; }
      if (generation.state !== "settled" || !generation.result) {
        removeTransientGeneration(generation.generationId);
        setPendingId(generation.generationId);
        setPendingNeedsReview(true);
        setError(`模型请求状态：${generation.state}。已保留请求编号，可稍后核对。`);
        return;
      }
      const result = generation.result;
      displayRef.current = displayRef.current.filter(item => !item.id.startsWith(`tool-${generation.generationId}-`) || result.toolCalls.some((call, index) => item.id === `tool-${generation.generationId}-${index}` && item.toolName === call.function.name));
      setDisplay(displayRef.current);
      const reply = result.content?.trim();
      const streamId = `stream-${generation.generationId}`;
      if (reply) {
        if (displayRef.current.some(item => item.id === streamId)) replaceDisplay(streamId, { phase: result.toolCalls.length ? "progress" : "final", content: reply, streaming: false });
        else appendDisplay({ id: crypto.randomUUID(), role: "assistant", phase: result.toolCalls.length ? "progress" : "final", content: reply });
      } else {
        removeDisplay(streamId);
        if (!result.toolCalls.length) appendDisplay({ id: crypto.randomUUID(), role: "assistant", phase: "final", content: "模型没有返回可展示的内容，请再描述一次目标。" });
      }
      context = [...context, { role: "assistant", content: result.content, ...(result.toolCalls.length ? { tool_calls: result.toolCalls } : {}) }];
      setMessages(context);
      if (!result.toolCalls.length) { await commitFinalGeneration(generation.generationId, context); return; }
      let needsUserReview = false;
      let needsMcpReconcile = false;
      let handoff: ReturnType<typeof backgroundHandoff> = null;
      for (const [index, call] of result.toolCalls.entries()) {
        const previewId = `tool-${generation.generationId}-${index}`;
        const toolEntryId = displayRef.current.some(item => item.id === previewId) ? previewId : crypto.randomUUID();
        if (toolEntryId === previewId) replaceDisplay(toolEntryId, { content: `正在调用工具：${call.function.name}` });
        else appendDisplay({ id: toolEntryId, role: "tool", toolName: call.function.name, toolStatus: "running", content: `正在调用工具：${call.function.name}` });
        setLiveActivity(`正在调用工具：${call.function.name}`);
        const output = needsMcpReconcile ? { error: "SKIPPED_AFTER_MCP_UNKNOWN" }
          : needsUserReview ? { error: "SKIPPED_FOR_USER_REVIEW" }
            : await executeTool(call, generation.generationId, context, toolEntryId);
        context = [...context, { role: "tool", tool_call_id: call.id, content: JSON.stringify(output) }];
        setMessages(context);
        replaceDisplay(toolEntryId, { ...toolDisplay(call.function.name, output), details: JSON.stringify({ arguments: call.function.arguments, result: output }, null, 2) });
        const background = backgroundHandoff(call.function.name, output);
        if (background) { handoff = background; removeDisplay(toolEntryId); }
        if (output && typeof output === "object" && "requiresUserReview" in output && output.requiresUserReview === true) needsUserReview = true;
        if (call.function.name === "mcp_call" && output && typeof output === "object" && "error" in output &&
          (output.error === "MCP_RESULT_UNKNOWN" || output.error === "MCP_EXECUTION_CONFLICT")) needsMcpReconcile = true;
      }
      if (needsMcpReconcile) {
        appendDisplay({ id: crypto.randomUUID(), role: "assistant", phase: "final", content: "MCP 工具的执行结果不明确，已停止后续自动操作。请到连接器对应的服务核对结果，再告诉我如何继续。" });
        await commitFinalGeneration(generation.generationId, context);
        return;
      }
      if (userInputGate.current.cancelled) { await commitFinalGeneration(generation.generationId, context); return; }
      if (Number.isSafeInteger(generation.inputTokens) && (generation.inputTokens ?? -1) >= 0) {
        lastInputTokensRef.current = generation.inputTokens!;
        setLastInputTokens(generation.inputTokens!);
      }
      if (needsUserReview) {
         appendDisplay({ id: crypto.randomUUID(), role: "assistant", phase: "final", content: "待确认的接入或图源草稿已放在对话中。核对后点击卡片上的按钮，我会继续任务。" });
        await commitFinalGeneration(generation.generationId, context);
        return;
      }
      if (handoff) {
        const job = await api.jobsGet(handoff.jobId).catch(() => null);
        if (job) onJobStarted(job,conversationId);
        await trackBackgroundJob(job ?? handoff);
      }
      if (round === 11) { appendDisplay({ id: crypto.randomUUID(), role: "assistant", phase: "final", content: "本轮工具处理已达到上限。当前结果已保留，可以继续让我处理这项任务。" }); await commitFinalGeneration(generation.generationId, context); return; }
      userInputGate.current.freshModelRound();
      generation = await requestGeneration(context, boundaryRef.current);
    }
  }
  async function checkPending() {
    if (!pendingId || busy) return;
    setPendingNeedsReview(false);
    setBusy(true); setError("");
    try {
      const saved = readPending(chatStore())?.[conversationId];
      if (!saved || saved.generationId !== pendingId) throw new Error("未找到本机请求记录，无法安全重试。请保留当前对话并检查任务记录。");
      const humanRequests=(saved.display ?? []).filter(item=>item.role==="user").map(item=>item.content);
      userInputGate.current.reset(humanRequests.at(-1) ?? "", humanRequests.slice(0,-1));
      if (saved.userId && saved.userId !== status.userId) throw new Error("此请求属于另一个 GeoD 账号，请切回原账号后核对。");
      if (saved.engine === "codex") {
        const generation = await api.agentGenerationGet(saved.generationId);
        if (["reserved", "streaming", "pending_reconcile"].includes(generation.state)) throw new Error("模型请求还在核对中，请稍后检查。已完成的本机工具不会自动重复执行。");
        setMessages(saved.messages);
        await releasePending();
        setError("模型请求已核对。Codex 原执行已停止，可以继续提问；本机任务以后台状态为准。");
        return;
      }
      if (saved.committed) {
        const updated = restorePendingChats(chatStore(), chatRecords);
        setChatRecords(updated);
        setMessages(saved.committed.messages);
        setContextCompressed(!!saved.committed.contextCompressed); contextCompressedRef.current = !!saved.committed.contextCompressed;
        setLastInputTokens(saved.committed.lastInputTokens ?? null); lastInputTokensRef.current = saved.committed.lastInputTokens ?? null;
        displayRef.current = saved.committed.display;
        setDisplay(displayRef.current);
        planIdRef.current = saved.committed.planId ?? "";
        setPlanId(planIdRef.current);
        planIdsRef.current = saved.committed.planIds ?? (planIdRef.current ? [planIdRef.current] : []);
        setPlanIds(planIdsRef.current);
        setPendingId("");
        return;
      }
      const activeBoundary = pendingBoundary(saved);
      boundaryRef.current = activeBoundary; setBoundary(activeBoundary);
      let generation: Generation;
      try { generation = await api.agentGenerationGet(pendingId); }
      catch (cause) {
        if (!saved.userId || saved.userId !== status.userId || !cause || typeof cause !== "object" || !("code" in cause) || cause.code !== "GENERATION_NOT_FOUND") throw cause;
        generation = await api.agentGenerate(pendingId, conversationId, modelMessagesWithoutArtifactPaths(saved.messages));
      }
      await finishGeneration(generation, saved.messages);
      void api.agentUsage().then(setUsage).catch(() => {});
    }
    catch (cause) { await handleGenerationFailure(cause); }
    finally { setBusy(false); }
  }
  async function send(value: string,queuedImages?:ImageAttachment[],fromQueue=false,queuedDocuments?:DocumentAttachment[],inputCrsChoice?:ReturnType<typeof crsFromAnswers>) {
    const text = value.trim()||(documents.length?"请阅读这些文档。":images.length?"请查看这些图片。":"");
    if (text && sending.current && engine === "codex" && codexRun.current) {
      if(followupMode==="queue"||images.length||documents.length){
        if(queuedInputs.length>=20){setError("消息队列最多暂存 20 条，请先移除或等待发送。");return;}
        const item={id:crypto.randomUUID(),text,images:images.length?images:undefined,documents:documents.length?documents:undefined,createdAt:new Date().toISOString()};changeQueue(chat=>({...chat,queuedInputs:[...(chat.queuedInputs??[]),item]}));setDraft("");setImages([]);setDocuments([]);return;
      }
      try { humanRequestRevision.current++; await rememberHumanCrsPreference(text); await api.codexCommand(codexRun.current, { type: "steer", text }); setDraft(""); }
      catch (cause) { setError(errorMessage(cause)); }
      return;
    }
    if (!text || sending.current || session.get("pendingId","") || session.get("imagesBusy",false) || session.get("documentsBusy",false) || status.state !== "connected") return;
    const attachments=queuedImages??images;const attachedDocuments=queuedDocuments??documents;if(!fromQueue){setImages([]);setDocuments([]);}
    sending.current = true; setBusy(true); setLiveActivity("正在思考下一步…"); setError(""); if(!fromQueue)setDraft("");
    setChatRecords(current => current.map(chat => chat.conversationId === conversationId ? { ...chat, updatedAt: new Date().toISOString() } : chat));
    const visible = [...displayRef.current, { id: crypto.randomUUID(), role: "user" as const, content: boundary ? `${text}\n已附加边界：${boundary.name} · ${boundary.polygonCount} 个面` : text, ...(attachments.length?{images:attachments}:{}),...(attachedDocuments.length?{documents:attachedDocuments}:{}) }];
    userInputGate.current.reset(text, displayRef.current.filter(item=>item.role==="user").map(item=>item.content));
    humanRequestRevision.current++;
    displayRef.current = visible;
    setDisplay(visible);
    if(inputCrsChoice)exportCrsChoice.current={...inputCrsChoice,userMessageId:visible.at(-1)?.id};
    try {
      await ensureExportRuntime(api.runtimeCapabilities);
      await rememberHumanCrsPreference(text, visible.at(-1)?.id);
      const installed = await api.extensionsList();
      const activeBoundary = boundaryRef.current;
      const history=session.get<AgentMessage[]>("messages",[]);
      const modelText = modelUserText(text, activeBoundary) + documentContext(attachedDocuments) + continueTaskContext(text,visible) + (engine === "codex" ? "" : skillDiscoveryText(installed.skills));
      const context: AgentMessage[] = [...history, { role: "user", content: modelText, ...(attachments.length?{images:attachments}:{}),...(attachedDocuments.length?{documents:attachedDocuments}:{}) }];
      setMessages(context);
      if (engine === "codex") await sendWithCodex(modelText, history, context, activeBoundary,attachments,attachedDocuments);
      else await finishGeneration(await requestGeneration(context, activeBoundary, visible), context);
      void api.agentUsage().then(setUsage).catch(() => {});
    } catch (cause) { changeQueue(chat=>({...chat,queuePaused:true}));await handleGenerationFailure(cause); }
    finally {
      cancelInputRequests(); sending.current = false; setBusy(false);
      window.setTimeout(()=>{
        const chat=chatRecordsRef.current.find(chat=>chat.conversationId===conversationId);
        const next=chat?.queuedInputs?.[0];
        if(!next||chat?.queuePaused||sending.current||session.get("pendingId",""))return;
        changeQueue(chat=>({...chat,queuedInputs:chat.queuedInputs?.filter(item=>item.id!==next.id)}));void send(next.text,next.images??[],true,next.documents??[]);
      },100);
    }
  }

  async function sendWithCodex(input: string, history: AgentMessage[], initial: AgentMessage[], activeBoundary: BoundaryImport | null,attachments:ImageAttachment[]=[],attachedDocuments:DocumentAttachment[]=[]) {
    const runId = crypto.randomUUID(); codexRun.current = runId;
    let current = initial;
    let lastGenerationId: string | null = null;
    let toolStopReason: "review" | "unknown" | null = null;
    let currentTokens: CodexTokenUsage | null = codexContext;
    const replyId = (id: string) => `codex-${runId}-${id}`;
    function onEvent(event: CodexEvent) {
      if (event.type === "stage") { setLiveActivity(event.message); return; }
      if (event.type === "steered") { appendDisplay({ id: crypto.randomUUID(), role: "user", content: event.text }); current = [...current, { role: "user", content: event.text }]; return; }
      if (event.type === "commandError") { setError(event.message); return; }
      if (event.type !== "event") return;
      const params = event.params;
      if (event.method === "thread/tokenUsage/updated") {
        const usage = params.tokenUsage as { last: CodexTokenUsage; modelContextWindow: number | null };
        currentTokens = { inputTokens: usage.last.inputTokens, outputTokens: usage.last.outputTokens, cachedInputTokens: usage.last.cachedInputTokens, modelContextWindow: usage.modelContextWindow };
        setCodexContext(currentTokens); setLastInputTokens(currentTokens.inputTokens); lastInputTokensRef.current = currentTokens.inputTokens;
      } else {
        const reduced = reduceCodexItems(displayRef.current, runId, event.method, params);
        if (reduced !== displayRef.current) { displayRef.current = reduced; setDisplay(reduced); }
        if (event.method === "item/agentMessage/delta") setLiveActivity("正在生成回复…");
        else if (event.method.startsWith("item/reasoning")) setLiveActivity("正在思考下一步…");
        else if (event.method === "thread/compacted") setLiveActivity("上下文已压缩，继续处理…");
      }
    }
    try {
      const result = await runCodexTurn(runId, conversationId, input, history, {
        onEvent,
        onRequest: async request => {
          if (request.method !== "item/tool/requestUserInput") return waitForUserInput(request);
          const questions = inputQuestions(request.params.questions);
          const accepted=reusableInputReply(questions,displayRef.current,[...displayRef.current].reverse().find(item=>item.role==='user')?.id);
          if(accepted)return accepted;
          userInputGate.current.begin();
          const value = await waitForUserInput(request);
          if(isDetachedUserInput(value)){userInputGate.current.waiting=false;return {answers:{}};}
          const reply = validatedInputReply(questions, value);
          userInputGate.current.finish(questions, reply);
        await rememberCrsAnswer(questions,reply);
          return reply ?? { answers: {} };
        },
        onModel: async (generationId, context) => {
          userInputGate.current.freshModelRound();
          savePending(chatStore(), { engine: "codex", conversationId, generationId, userId: status.userId, messages: context, display: displayRef.current, boundary: activeBoundary, boundaryRequired: !!activeBoundary });
          await flushLocalState();
          lastGenerationId = generationId; current = context; setMessages(current);
          setPendingId(generationId); setPendingNeedsReview(false); setLiveActivity("正在等待模型响应…");
        },
        onGeneration: generation => {
          if (generation.inputTokens != null) { lastInputTokensRef.current = generation.inputTokens; setLastInputTokens(generation.inputTokens); }
        },
        execute: async (call, executionId, context,nativeRequestId) => {
          const id = replyId(call.id);
          appendDisplay({ id, turnId: runId, role: "tool", toolName: call.function.name, toolStatus: "running", content: `正在调用工具：${call.function.name}`, details: call.function.arguments });
          setLiveActivity(`正在调用工具：${call.function.name}`);
          const output = toolStopReason ? { error: toolStopReason === "review" ? "SKIPPED_FOR_USER_REVIEW" : "SKIPPED_AFTER_MCP_UNKNOWN" } : await executeTool(call, executionId, context, id,nativeRequestId);
          replaceDisplay(id, { ...toolDisplay(call.function.name, output), details: JSON.stringify({ arguments: JSON.parse(call.function.arguments), result: output }, null, 2) });
          current = [...current, { role: "assistant", content: null, tool_calls: [call] }, { role: "tool", tool_call_id: call.id, content: JSON.stringify(output) }];
          setMessages(current);
          const handoff = backgroundHandoff(call.function.name, output);
          if (handoff) {
            removeDisplay(id); const job = await api.jobsGet(handoff.jobId).catch(() => null);
            if (job) onJobStarted(job,conversationId);
            await trackBackgroundJob(job ?? handoff);
          }
          if (output && typeof output === "object") {
            if ("requiresUserReview" in output && output.requiresUserReview) toolStopReason = "review";
            if ("error" in output && ["MCP_RESULT_UNKNOWN", "MCP_EXECUTION_CONFLICT"].includes(String(output.error))) toolStopReason = "unknown";
          }
          return { result: output };
        },
      },attachments,attachedDocuments);
      const interrupted = result.status === "interrupted";
      if (interrupted) {
        changeQueue(chat=>({...chat,queuePaused:true}));
        displayRef.current = displayRef.current.map(item => item.id.startsWith(`codex-${runId}-`) ? { ...item, streaming: false, ...(item.toolStatus === "running" ? { toolStatus: "attention" as const } : {}) } : item); setDisplay(displayRef.current);
        appendDisplay(turnOutcomeMessage(runId,{status:'interrupted',message:"本轮回复已停止。已经启动的本机任务可在后台状态中查看。"}));
      }
      if (result.text) current = [...current, { role: "assistant", content: result.text }];
      const completed: SavedChat = { conversationId, engine: "codex", messages: current, display: displayRef.current, planId: planIdRef.current || undefined, planIds: planIdsRef.current, workspaceDirectory: workspace?.directory, lastInputTokens: lastInputTokensRef.current ?? undefined, codexContext: currentTokens ?? undefined, updatedAt: new Date().toISOString(),queuePaused:interrupted?true:undefined };
      setMessages(completed.messages);
      if (lastGenerationId) commitPending(chatStore(), conversationId, lastGenerationId, completed);
      await flushLocalState();
      setChatRecords(persistCompletedChat(chatStore(), completed)); await releasePending();
      await flushLocalState();
    } catch(cause) {
      displayRef.current=displayRef.current.map(item=>item.id.startsWith(`codex-${runId}-`)?{...item,streaming:false,...(item.toolStatus==='running'?{toolStatus:'attention' as const}:{})}:item);
      setDisplay(displayRef.current);
      const message=errorMessage(cause),code=outputFailureCode(message);
      appendDisplay(turnOutcomeMessage(runId,{status:code?'incomplete':'failed',message,code,generationId:lastGenerationId??undefined}));
      await persistQuestionTranscript();
      throw cause;
    } finally {
      displayRef.current = displayRef.current.map(item => item.id.startsWith(`codex-${runId}-`) ? { ...item, streaming: false, ...(item.toolStatus === "running" ? { toolStatus: "attention" as const } : {}) } : item);
      setDisplay(displayRef.current); codexRun.current = null;
      if (connectionResolve.current) finishConnectionAuthentication({ error: { code: "INPUT_CANCELLED", message: "数据库认证已取消" } });
      cancelInputRequests();
    }
  }

  const groupDirectory = (chat: SavedChat) => chat.workspaceDirectory || defaultWorkspaceDirectory || "默认工作区";
  const directories = [...new Set(chatRecords.filter(chat=>!chat.archived).map(groupDirectory))].filter(directory => !workspaceList.hidden.includes(directory));
  const composer = <>
    {documentPasswordRequest&&<DocumentPasswordDialog key={documentPasswordRequest.id} request={documentPasswordRequest}/>}
    {audioSetupOpen&&<AudioSetupDialog hasFiles={pendingAudioFiles.length>0} onClose={()=>setAudioSetupOpen(false)} onReady={()=>{setAudioSetupOpen(false);const files=pendingAudioFiles;setPendingAudioFiles([]);if(files.length)void attachAudio(files).catch(cause=>setError(errorMessage(cause)));}}/>}
    {reviewAudio&&<AudioTranscriptDialog conversationId={conversationId} file={reviewAudio} onClose={()=>setReviewAudio(null)} onSaved={updated=>setDocuments(current=>current.map(file=>file.id===updated.id?updated:file))}/>}
    <SqlConnectionDialog open={Boolean(sqlAuthentication)} conversationId={conversationId} initial={sqlAuthentication} onSaved={value=>finishSqlAuthentication(value)} onOpenChange={value=>{if(!value&&sqlResolve.current)finishSqlAuthentication({error:{code:"INPUT_CANCELLED",message:"数据库认证已取消"}});}}/>
    <DataInputPanel key={conversationId} open={dataInputOpen} initialRequest={initialDataInput} initialConnection={connectionAuthentication} onConnection={connectionAuthentication ? value => finishConnectionAuthentication({ connection: { id: value.connection.id, name: value.connection.name }, layers: value.layers, tables: value.tables, mcp: value.mcp, readOnly: true }) : undefined} onOpenChange={value => { setDataInputOpen(value); if (!value) { setInitialDataInput(null); if (connectionResolve.current) finishConnectionAuthentication({ error: { code: "INPUT_CANCELLED", message: "数据库认证已取消" } }); } }} conversationId={conversationId} onBoundary={found => { void attachRange(found).catch(cause => setError(errorMessage(cause))); }} />
    <BoundaryPicker items={savedBoundaries} active={boundary} disabled={busy || !!pendingId} onSelect={async id => { await attachRange(await api.boundariesGet(conversationId, id)); }} onCombine={async ids => { await attachRange(await api.boundariesCombine(conversationId, ids)); }} onClear={() => { boundaryRef.current = null; setBoundary(null); }} onError={cause => setError(errorMessage(cause))}/>
    {queuedInputs.length>0&&<section className="message-queue" aria-label={t("待发送消息")}><div className="message-queue-head"><span>{queuedInputs.length} {t(" 条待发送")}{queuePaused?t(" · 已暂停"):""}</span><Button variant="ghost" size="sm" onClick={()=>changeQueue(chat=>({...chat,queuePaused:!chat.queuePaused}))}>{queuePaused?t("继续发送"):t("暂停")}</Button></div><div className="message-queue-items">{queuedInputs.map(item=><div key={item.id} className="message-queue-item"><span>{item.text}</span><Button variant="ghost" size="icon" aria-label={t("移除待发送消息：{0}", {"0": item.text.slice(0,20)})} onClick={()=>changeQueue(chat=>({...chat,queuedInputs:chat.queuedInputs?.filter(q=>q.id!==item.id)}))}><X size={14}/></Button></div>)}</div></section>}
    <div className="agent-composer">
      <input ref={imageFileInput} type="file" accept={imageAccept} multiple hidden aria-label={t("选择图片附件")} onChange={event=>{const files=Array.from(event.target.files??[]);event.target.value="";void attachImages(files).catch(cause=>setError(errorMessage(cause)));}}/>
      <input ref={documentFileInput} type="file" accept={documentAccept} multiple hidden aria-label={t("选择文档附件")} onChange={event=>{const files=Array.from(event.target.files??[]);event.target.value="";void attachDocuments(files).catch(cause=>setError(errorMessage(cause)));}}/>
      <input ref={audioFileInput} type="file" accept={audioAccept} multiple hidden aria-label={t("选择音频附件")} onChange={event=>{const files=Array.from(event.target.files??[]);event.target.value="";void attachAudio(files).catch(cause=>setError(errorMessage(cause)));}}/>
      <div className="composer-images"><ImageAttachments images={images} onRemove={id=>setImages(current=>current.filter(image=>image.id!==id))}/>{imagesBusy&&<small role="status">{t("正在添加图片…")}</small>}</div>
      <div className="composer-documents"><DocumentAttachments documents={documents} onReview={setReviewAudio} onRemove={busy?undefined:id=>{setDocuments(current=>current.filter(file=>file.id!==id));void api.documentAttachmentDiscard(conversationId,id).catch(cause=>setError(errorMessage(cause)));}}/>{documentsBusy&&(audioBusy?<div className="composer-audio-status" role="status"><Loader2 size={14} className="animate-spin"/><span>{t("正在本机转写音频…")}</span><Button variant="ghost" size="sm" onClick={()=>audioCancels.current.get(conversationId)?.()}>{t("取消转写")}</Button></div>:<small role="status">{t("正在读取文档…")}</small>)}</div>
      {aiModels.error && <div className="ai-channel-error" role="alert"><CircleAlert size={15}/><span>{aiModels.error}</span><Button variant="ghost" size="sm" onClick={() => onMainViewChange("models")}>{t("检查模型配置")}</Button></div>}
      <PromptInput
        value={draft}
        onValueChange={setDraft}
        hasAttachments={images.length>0||documents.length>0}
        onSubmit={value => void send(value)}
        models={[{ value: modelValue("hosted", "hosted"), label: t("GeoD 托管"), shortLabel: t("GeoD 托管"), disabled: !codexAvailable || busy || aiModels.loading }, ...availableAIChannels(aiModels.list).flatMap(channel => channel.models.map(model => ({ value: modelValue(channel.id, model.id), label: `${channel.name} · ${model.name}${channel.id.startsWith("sponsor:") ? ` · ${t("赞助")}` : ""}`, shortLabel: channel.id.startsWith("sponsor:") ? `${model.name} · ${t("赞助")}` : model.name, disabled: busy || aiModels.loading || !codexAvailable }))), ...(aiModels.selection.channelId !== "hosted" && !availableAIChannels(aiModels.list).some(c => c.id === aiModels.selection.channelId && c.models.some(m => m.id === aiModels.selection.modelId)) ? [{ value: modelValue(aiModels.selection.channelId, aiModels.selection.modelId), label: t(!SPONSORED_CHANNELS_VISIBLE&&aiModels.selection.channelId.startsWith("sponsor:")?"已保存的模型 · 请选择":"原模型不可用 · 请选择"), shortLabel: t(!SPONSORED_CHANNELS_VISIBLE&&aiModels.selection.channelId.startsWith("sponsor:")?"已保存的模型":"模型不可用"), disabled: true }] : []), { value: "manage-models", label: t("模型与渠道…"), icon: <Bot size={15}/> }, { value: "legacy", label: t("GeoD 托管 · 兼容引擎"), disabled: busy }]}
        model={engine === "legacy" ? "legacy" : modelValue(aiModels.selection.channelId, aiModels.selection.modelId)}
        onModelChange={value => { if (value === "manage-models") { onMainViewChange("models"); return; } if (value === "legacy") { changeEngine(value); return; } if (busy || aiModels.loading) return; const [channelId, modelId] = JSON.parse(value) as string[]; void aiModels.select(channelId, modelId).then(() => { changeEngine("codex"); setCodexContext(null); }).catch(cause => setError(errorMessage(cause))); }}
        loading={busy && (engine === "codex" || !!codexRequest)}
        allowSteer={engine === "codex" && !!codexRun.current}
        loadingSubmitLabel={followupMode==="queue"?"加入消息队列":"补充指令"}
        onStop={engine === "codex" || codexRequest ? () => { userInputGate.current.cancelled = true; cancelInputRequests(true); void api.mcpRequestsCancel(conversationId).catch(cause=>setError(errorMessage(cause))); if (connectionResolve.current) finishConnectionAuthentication({ error: { code: "INPUT_CANCELLED", message: "数据库认证已取消" } }); if(sqlResolve.current)finishSqlAuthentication({error:{code:"INPUT_CANCELLED",message:"数据库认证已取消"}}); if (codexRun.current) void api.codexCommand(codexRun.current, { type: "interrupt" }).catch(cause => setError(errorMessage(cause))); } : undefined}
        onPaste={pasteIntoComposer}
        placeholder={t("描述需求，添加图片、数据网址或矢量范围")}
        aria-label={t("发送给 GeoD Agent")}
        disabled={imagesBusy || documentsBusy || aiModels.loading || (engine !== "codex" && busy) || (!!pendingId && !busy) || !workspace || status.state !== "connected"}
        minRows={2}
        maxRows={6}
        className="geod-prompt-input"
        actions={[{value:"image",label:"添加图片",description:"截图、照片或图表",icon:<Plus size={17}/>,disabled:engine!=="codex"||imagesBusy},{value:"document",label:"添加文档或扫描件",description:"PDF、Office、文本或扫描图片",icon:<File size={17}/>,disabled:engine!=="codex"||documentsBusy},{value:"audio",label:"添加音频",description:"音频文件，在本机转写成文字",icon:<AudioLines size={17}/>,disabled:engine!=="codex"||documentsBusy},{value:"audio-settings",label:"音频转写设置",icon:<Settings size={17}/>},{value:"data",label:"添加数据范围",description:"矢量文件、在线数据或数据库",icon:<MapTrifold size={17}/>}]}
        onAction={action=>{if(action==="image")imageFileInput.current?.click();else if(action==="document")documentFileInput.current?.click();else if(action==="audio")audioFileInput.current?.click();else if(action==="audio-settings"){setPendingAudioFiles([]);setAudioSetupOpen(true);}else{setInitialDataInput(null);setDataInputOpen(true);}}}
        toolbarContent={<div className="composer-controls">
          <MorphPopover open={permissionMenuOpen} onOpenChange={setPermissionMenuOpen}>
            <MorphPopoverTrigger>
              <button type="button" className={`composer-permission-trigger${workspace?.permission === "fullAccess" ? " full-access" : ""}`} disabled={!workspace || busy} aria-label={t("工作区权限：{0}，点击切换", {"0": workspace?.permission === "fullAccess" ? "完全访问" : "每次确认"})}>
                {workspace?.permission === "fullAccess" ? <ShieldCheck size={16} /> : <ShieldAlert size={16} />}
                <span>{workspace?.permission === "fullAccess" ? t("完全访问") : t("每次确认")}</span><ChevronDown size={14} />
              </button>
            </MorphPopoverTrigger>
            <MorphPopoverContent side="top" align="start" className="composer-permission-menu">
              <strong>{t("工作区权限")}</strong>
              <button type="button" aria-pressed={workspace?.permission === "confirmEach"} onClick={() => { setPermissionMenuOpen(false); void changePermission("confirmEach"); }}><ShieldCheck size={17} /><span><b>{t("每次确认")}</b><small>{t("涉及写入的操作会请求确认")}</small></span></button>
              <button type="button" aria-pressed={workspace?.permission === "fullAccess"} onClick={() => { setPermissionMenuOpen(false); void changePermission("fullAccess"); }}><ShieldAlert size={17} /><span><b>{t("完全访问")}</b><small>{t("允许 Agent 在当前工作区执行操作")}</small></span></button>
            </MorphPopoverContent>
          </MorphPopover>
          <ContextWindow usage={contextUsage} compressedBefore={contextCompressed} lastInputTokens={lastInputTokens} codex={engine === "codex" ? { usage: codexContext } : undefined} />
          {busy&&engine==="codex"&&<MorphPopover open={followupMenuOpen} onOpenChange={setFollowupMenuOpen}><MorphPopoverTrigger><button type="button" className="composer-followup-trigger" aria-label={t("发送方式：{0}", {"0": followupMode==="queue"?"排队":"补充"})}>{followupMode==="queue"?t("排队"):t("补充")}<ChevronDown size={13}/></button></MorphPopoverTrigger><MorphPopoverContent side="top" align="end" className="composer-permission-menu"><strong>{t("发送后续消息")}</strong><button type="button" aria-pressed={followupMode==="queue"} onClick={()=>{setFollowupMode("queue");setFollowupMenuOpen(false);}}><span><b>{t("排队")}</b><small>{t("当前回复结束后开始下一轮")}</small></span></button><button type="button" aria-pressed={followupMode==="steer"} onClick={()=>{setFollowupMode("steer");setFollowupMenuOpen(false);}}><span><b>{t("补充指令")}</b><small>{t("立即补充到正在处理的请求")}</small></span></button></MorphPopoverContent></MorphPopover>}
        </div>}
      />
    </div>
  </>;
  return <><aside className="conversation-sidebar" aria-label={t("按工作区组织的对话列表")}>
    <div className="conversation-sidebar-head">
      <UiTooltip content={t("新对话")} side="right"><Button aria-label={t("新对话")} className="sidebar-new-chat" variant="ghost" size="sm" whileHover={undefined} onClick={() => { onMainViewChange("conversation"); if (accountId) void newChat(); }} disabled={creatingConversation}><NewChat size={17} />{t("新对话")}</Button></UiTooltip>
      <UiTooltip content={t("定时任务")} side="right"><Button aria-label={t("定时任务")} className="sidebar-schedules" aria-current={mainView === "schedules" ? "page" : undefined} variant="ghost" size="sm" whileHover={undefined} onClick={() => onMainViewChange("schedules")}><Clock3 size={17}/>{t("定时任务")}</Button></UiTooltip>
      <UiTooltip content={t("图源管理")} side="right"><Button aria-label={t("图源管理")} className={`sidebar-source ${mainView === "sources" ? "active" : ""}`} aria-current={mainView === "sources" ? "page" : undefined} variant="ghost" size="sm" whileHover={undefined} onClick={() => onOpenSources()}><MapTrifold size={17} />{t("图源管理")}</Button></UiTooltip>
      <UiTooltip content={t("模型与渠道")} side="right"><Button aria-label={t("模型与渠道")} className="sidebar-models" aria-current={mainView === "models" ? "page" : undefined} variant="ghost" size="sm" whileHover={undefined} onClick={() => onMainViewChange("models")}><Bot size={17}/>{t("模型与渠道")}</Button></UiTooltip>
      <UiTooltip content={t("技能与连接器")} side="right"><Button aria-label={t("技能与连接器")} className={`sidebar-extensions ${extensionStoreOpen ? "active" : ""}`} variant="ghost" size="sm" whileHover={undefined} aria-current={extensionStoreOpen ? "page" : undefined} onClick={() => onMainViewChange("extensions")}><PuzzlePiece size={17} />{t("技能与连接器")}</Button></UiTooltip>
      <UiTooltip content={t("添加工作区")} side="right"><Button aria-label={t("添加工作区")} className="workspace-create" variant="ghost" size="sm" whileHover={undefined} onClick={() => void addWorkspace()} disabled={busy || !accountId}><FolderPlus size={17} />{t("添加工作区")}</Button></UiTooltip>
    </div>
    <div className="conversation-list"><div className="workspace-list-heading"><span>{t("工作区 ")}{directories.length}</span><UiTooltip content={t("搜索会话 · Ctrl+K")}><button type="button" className="conversation-history-trigger" aria-label={t("搜索会话")} onClick={()=>setHistoryOpen(true)}><Search size={15}/></button></UiTooltip></div>{directories.map(directory => {
      const collapsed = closedGroups.includes(directory);
      const chats = orderedConversations(chatRecords.filter(chat => !chat.archived&&groupDirectory(chat) === directory));
      const visible=chats.slice(0,visibleConversations[directory]??20);
      const selected=chats.find(chat=>chat.conversationId===conversationId);
      if(selected&&!visible.includes(selected))visible.push(selected);
      return <div className="workspace-group" key={directory}>
        <div className="workspace-group-title">
          <UiTooltip content={displayPath(directory)} side="right" align="start">
            <button type="button" className="workspace-collapse" aria-label={`${collapsed ? "展开" : "收起"}${workspaceLabel(directory)}`} aria-description={displayPath(directory)} aria-expanded={!collapsed} onClick={() => setClosedGroups(current => current.includes(directory) ? current.filter(item => item !== directory) : [...current, directory])}>{collapsed ? <Folder size={16} aria-hidden="true" /> : <FolderOpen size={16} aria-hidden="true" />}<span>{workspaceLabel(directory)}</span><em>{chats.length}</em></button>
          </UiTooltip>
          <MorphPopover open={workspaceMenu === directory} onOpenChange={next => setWorkspaceMenu(next ? directory : null)}>
            <MorphPopoverTrigger><button type="button" className="workspace-more" aria-label={t("{0}的更多操作", {"0": workspaceLabel(directory)})} disabled={busy}><DotsThree size={19} /></button></MorphPopoverTrigger>
            <MorphPopoverContent side="bottom" align="end" radius={10} className="workspace-menu">
              <button type="button" onClick={() => void openWorkspaceFolder(chats[0].conversationId)}><FolderOpen size={17} />{t("打开文件夹")}</button>
              <button type="button" onClick={() => { setWorkspaceMenu(null); setRenameDirectory(directory); setRenameDraft(workspaceLabel(directory)); }}><PencilSimple size={17} />{t("重命名")}</button>
              <button type="button" className="workspace-menu-remove" disabled={directory === defaultWorkspaceDirectory || directory === "默认工作区"} onClick={() => { setWorkspaceMenu(null); setRemoveDirectory(directory); }}><Trash size={17} />{t("从列表中移除")}</button>
            </MorphPopoverContent>
          </MorphPopover>
          <UiTooltip content={t("在此工作区新建对话")} side="right">
            <button type="button" className="workspace-add" aria-label={t("在{0}新建对话", {"0": workspaceLabel(directory)})} disabled={creatingConversation || !accountId} onClick={() => void newChat(directory === "默认工作区" ? defaultWorkspaceDirectory || undefined : directory)}><Plus size={15} /></button>
          </UiTooltip>
        </div>
        <motion.div className="workspace-conversations" role="group" aria-label={t("{0}的会话", {"0": workspaceLabel(directory)})} aria-hidden={collapsed} inert={collapsed} initial={false} animate={{ height: collapsed ? 0 : "auto", opacity: collapsed ? 0 : 1 }} transition={{ height: { duration: reduceMotion ? 0 : .22, ease: [.22, 1, .36, 1] }, opacity: { duration: reduceMotion ? 0 : .16 } }}>
          {visible.map(chat => <ConversationRow key={chat.conversationId} chat={chat} active={mainView==="conversation"&&chat.conversationId===conversationId} running={runningIds.includes(chat.conversationId)} time={chatTime(chat,clock)} onSelect={()=>selectChat(chat)} onAction={action=>void conversationAction(chat,action).catch(cause=>setError(errorMessage(cause)))}/>)}
          {chats.length>visible.length&&<button type="button" className="conversation-load-more" onClick={()=>setVisibleConversations(current=>({...current,[directory]:(current[directory]??20)+20}))}>{t("加载更多")}</button>}
        </motion.div>
      </div>;
    })}</div>
    {legacyImportReady && <div className="conversation-legacy-import"><p>{t("发现旧版未归属账号的本机对话。")}</p><button type="button" onClick={importOlderChats} disabled={busy}>{t("导入到当前账号")}</button></div>}
    <AccountMenu open={accountMenuOpen} onOpenChange={setAccountMenuOpen} connected={status.state === "connected"} userId={status.userId} profile={auth.profile} profileError={auth.profileError} onProfileRefresh={auth.refreshProfile} usage={usage} busy={busy||runningIds.length>0} theme={theme} onModels={() => onMainViewChange("models")} onNetwork={onOpenNetwork} onCache={onOpenCache} onTheme={onToggleTheme} onLogout={() => void logout()} telemetryEnabled={downloadTelemetry.enabled} onTelemetry={downloadTelemetry.toggle}/>
  </aside><section className={`agent-panel agent-primary ${emptyConversation ? "agent-start" : ""}`} aria-label={t("GeoD Agent 智能助手")} hidden={mainView !== "conversation"}>
    <div className="agent-header"><strong>{currentChat?chatTitle(currentChat):t("新对话")}</strong>{engine==="codex"&&display.some(m=>m.role==="assistant"&&m.phase!=="progress")&&<UiTooltip content={t("复制已完成的对话，创建独立分支")}><Button variant="ghost" size="icon" aria-label={t("创建会话分支")} disabled={busy||!!pendingId||!workspace} onClick={()=>void forkChat()}><GitBranch size={16}/></Button></UiTooltip>}</div>
    {error && <div className="agent-error" role="alert"><CircleAlert size={16} />{localize(error)}</div>}
    {(status.error || auth.error) && <div className="agent-error" role="alert"><CircleAlert size={16} />{localize(status.error || auth.error)}</div>}
    {emptyConversation ? <div className="agent-start-screen"><div className="agent-start-content"><div className="agent-start-heading"><h1>{t("需要什么地理数据？")}</h1><p>{t("影像、矢量或三维数据，描述范围和用途即可。")}</p></div>{composer}</div></div> : desktopAvailable && status.state === "connected" && <>
      <ChatTranscript openInputId={openInputId} onOpenInput={setOpenInputId} onInputReply={replyToInput} onInputDraft={updateInputDraft} canAnswerInput={id=>{const request=displayRef.current.find(item=>item.id===id)?.userInput;if(request?.resolution?.kind==='existingPlanCrs'&&inputOrigin(displayRef.current,[...displayRef.current].reverse().find(m=>m.role==='user')?.id)!==request.userMessageId)return false;return !!request&&(codexRequestResolve.current.has(request.requestId)||!busy&&!sending.current);}} planTitles={planTitles} afterEntry={id => {
        const group = (planAnchors[id] ?? []).flatMap(planId => {
          const task = ownedTasks.find(item => item.stored.planId === planId);
          return task ? [{ ...task, title: presentations[planId].title }] : [];
        });
        return <TranscriptTaskGroup key={`tasks-${id}`} tasks={group} permission={workspace?.permission} onOpen={onTaskGroupSelect}/>;
      }} backgroundJobs={backgroundJobs} onOpenJob={id => void openBackgroundJob(id)} conversationId={conversationId} messages={display} busy={busy || extensionApprovalBusy} activeTurnId={codexRun.current} activity={liveActivity} onContinueTurn={()=>{if(!busy&&!pendingId&&!sending.current)void send('继续刚才的任务');}} canContinueTurn={!busy&&!pendingId&&!sending.current} onReviewSource={draft => onOpenSources(draft, conversationId)} onApproveExtension={proposal => void approveExtension(proposal)} onConfigureExtension={(old,next)=>{displayRef.current=displayRef.current.map(item=>item.extensionProposal?.id===old.id?{...item,content:`已连接 MCP · ${next.name}，等待确认启用`,extensionProposal:next}:item);setDisplay(displayRef.current);void persistQuestionTranscript().catch(cause=>setError(errorMessage(cause)));}}>
        {codexRequest && <CodexRequestCard key={codexRequest.requestId} request={codexRequest} respond={value => { codexRequestResolve.current.get(codexRequest.requestId)?.(value); codexRequestResolve.current.delete(codexRequest.requestId); setCodexRequests(previous => previous.filter(item => item.requestId !== codexRequest.requestId)); if (codexRequest.method === "item/tool/requestUserInput" && !Object.keys((value as {answers?:object})?.answers ?? {}).length) { userInputGate.current.cancelled = true; if (codexRun.current) void api.codexCommand(codexRun.current, { type: "interrupt" }).catch(cause => setError(errorMessage(cause))); } }} />}
        {gisInstallRequest&&<GisInstallCard key={gisInstallRequest.requestId} request={gisInstallRequest} onInstall={()=>void gisInstallFlow.current.install()} onCancel={cancelGisInstall}/>}
        <McpRequestQueue conversationId={conversationId} accountId={accountId}/>
        {pendingId && pendingNeedsReview && !busy && <div className="agent-recovery-note" role="status"><CircleAlert size={17} /><span>{t("上次请求尚未确认结果，可检查状态后继续。")}</span><Button variant="ghost" size="sm" onClick={checkPending}>{t("检查状态")}</Button></div>}
      </ChatTranscript>
      {backgroundNotice?.job && <div className="background-job-notice" role="status"><span>{t("后台影像任务")}{localize(backgroundStateLabels[backgroundNotice.job.state])}。{backgroundNotice.job.state === "completed" ? t("成果已核验，可在任务面板查看。") : t("可在任务面板查看详情。")}</span><UiTooltip content={t("关闭通知")}><Button variant="ghost" size="icon" aria-label={t("关闭后台任务通知")} onClick={() => setBackgroundNotice(null)}><X size={16}/></Button></UiTooltip></div>}
      {composer}
    </>}
  </section>
    <ConversationHistory open={historyOpen} onOpenChange={setHistoryOpen} chats={chatRecords} currentId={conversationId} runningIds={runningIds} onSelect={selectChat} onAction={(chat,action)=>void conversationAction(chat,action).catch(cause=>setError(errorMessage(cause)))} onImport={importChat}/>
    {conversationEditor&&<ConversationEditor key={`${conversationEditor.mode}-${conversationEditor.chat.conversationId}`} chat={conversationEditor.chat} mode={conversationEditor.mode} running={runningIds.includes(conversationEditor.chat.conversationId)} onClose={()=>setConversationEditor(null)} onSave={title=>{changeConversation(conversationEditor.chat,{title});setConversationEditor(null);}} onDelete={()=>void deleteConversation(conversationEditor.chat).catch(cause=>setError(errorMessage(cause)))}/>}
    <Dialog.Root open={renameDirectory !== null} onOpenChange={next => { if (!next) setRenameDirectory(null); }}>
      <Dialog.Portal><Dialog.Overlay className="permission-dialog-overlay" /><Dialog.Content className="permission-dialog workspace-edit-dialog">
        <Dialog.Title>{t("重命名工作区")}</Dialog.Title>
        <Dialog.Description>{t("仅修改侧边栏名称，文件夹路径和已有对话不会变化。")}</Dialog.Description>
        <input autoFocus aria-label={t("工作区名称")} maxLength={64} value={renameDraft} onChange={event => setRenameDraft(event.target.value)} onKeyDown={event => { if (event.key === "Enter") saveWorkspaceName(); }} />
        <div className="permission-dialog-actions"><Dialog.Close asChild><Button variant="outline">{t("取消")}</Button></Dialog.Close><Button disabled={!renameDraft.trim()} onClick={saveWorkspaceName}>{t("保存名称")}</Button></div>
      </Dialog.Content></Dialog.Portal>
    </Dialog.Root>
    <Dialog.Root open={removeDirectory !== null} onOpenChange={next => { if (!next) setRemoveDirectory(null); }}>
      <Dialog.Portal><Dialog.Overlay className="permission-dialog-overlay" /><Dialog.Content className="permission-dialog workspace-edit-dialog">
        <Dialog.Title>{t("从列表中移除工作区？")}</Dialog.Title>
        <Dialog.Description>「{removeDirectory ? workspaceLabel(removeDirectory) : ""}{t("」及其对话会从侧边栏隐藏。本机文件、任务和对话记录不会删除；重新添加同一文件夹即可恢复。")}</Dialog.Description>
        <div className="permission-dialog-actions"><Dialog.Close asChild><Button variant="outline">{t("取消")}</Button></Dialog.Close><Button disabled={busy} onClick={() => void hideWorkspace().catch(cause => setError(errorMessage(cause)))}>{t("从列表中移除")}</Button></div>
      </Dialog.Content></Dialog.Portal>
    </Dialog.Root>
    <Dialog.Root open={fullAccessDialogOpen} onOpenChange={setFullAccessDialogOpen}>
      <Dialog.Portal><Dialog.Overlay className="permission-dialog-overlay" /><Dialog.Content className="permission-dialog">
        <div className="permission-dialog-icon"><ShieldAlert size={22} /></div>
        <Dialog.Title>{t("允许完全访问当前工作区？")}</Dialog.Title>
        <Dialog.Description>{t("启用后，GeoD Agent 可以在当前工作区创建下载任务和成果文件，包括影像、矢量与三维数据。本机会核对任务参数、资源用量和保存路径。")}</Dialog.Description>
        <div className="permission-dialog-path"><FolderOpen size={15} /><span>{workspace ? displayPath(workspace.directory) : ""}</span></div>
        <p>{t("此权限仅对当前对话生效，可随时切回“每次确认”。")}</p>
        <div className="permission-dialog-actions"><Dialog.Close asChild><Button variant="outline">{t("取消")}</Button></Dialog.Close><Button onClick={() => void confirmFullAccess()} disabled={busy}>{t("确认允许完全访问")}</Button></div>
      </Dialog.Content></Dialog.Portal>
    </Dialog.Root>
    <ExtensionStorePage active={extensionStoreOpen} conversationId={conversationId} />
    <SchedulesPage active={mainView === "schedules"} accountId={accountId} conversations={chatRecords.map(chat => ({ conversationId: chat.conversationId, title: chatTitle(chat) }))} currentConversationId={conversationId} onOpenConversation={id => { const chat = chatRecords.find(chat => chat.conversationId === id); if (chat) selectChat(chat); }} onManageDownload={id => { const chat = chatRecords.find(chat => chat.conversationId === id); if (chat) { selectChat(chat); requestScheduleFocus(id); } }}/>
  </>;
}
