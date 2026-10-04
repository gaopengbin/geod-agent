import { chatPlanIds, pendingBoundary, type PendingGeneration, type SavedChat } from './pending-generations.ts';

type Listener = () => void;
const pendingNotifications=new Set<Set<Listener>>();
let notificationTimer:ReturnType<typeof setTimeout>|undefined;
function notify(listeners:Set<Listener>) {
  pendingNotifications.add(listeners);
  if(notificationTimer!==undefined)return;
  // One native stream callback can contain hundreds of deltas. Values and
  // dirty snapshots update immediately; React receives one notification per
  // event-loop turn instead of a synchronous render for every token.
  notificationTimer=setTimeout(()=>{
    notificationTimer=undefined;const pending=[...pendingNotifications];pendingNotifications.clear();
    for(const listeners of pending)for(const listener of listeners)listener();
  },0);
}
export class ConversationSession {
  readonly values = new Map<string, unknown>();
  private refs = new Map<string, {current:unknown}>();
  private listeners = new Set<Listener>();
  readonly accountId:string;
  readonly conversationId:string;
  private dirty:()=>void;
  constructor(accountId:string,conversationId:string,dirty:()=>void,seed:Record<string,unknown>={}) {
    this.accountId=accountId;this.conversationId=conversationId;this.dirty=dirty;
    for(const [key,value] of Object.entries(seed))this.values.set(key,value);
  }
  get<T>(key:string,initial:T|(()=>T)):T {
    if(!this.values.has(key))this.values.set(key,typeof initial==='function'?(initial as ()=>T)():initial);
    return this.values.get(key) as T;
  }
  set<T>(key:string,value:T|((previous:T)=>T)) {
    const previous=this.values.get(key) as T;
    const next=typeof value==='function'?(value as (previous:T)=>T)(previous):value;
    if(Object.is(previous,next))return;
    this.values.set(key,next);this.dirty();notify(this.listeners);
  }
  ref<T>(key:string,initial:T):{current:T} {
    if(!this.refs.has(key))this.refs.set(key,{current:initial});return this.refs.get(key) as {current:T};
  }
  subscribe=(listener:Listener)=>{this.listeners.add(listener);return()=>this.listeners.delete(listener);};
  snapshot():Partial<SavedChat> {
    const fields=['messages','display','pendingId','planId','planIds','contextCompressed','lastInputTokens','codexContext'] as const;
    const result:Record<string,unknown>={};
    for(const key of fields)if(this.values.has(key))result[key]=this.values.get(key)??undefined;
    const workspace=this.values.get('workspace') as {directory?:string}|null;
    if(workspace?.directory)result.workspaceDirectory=workspace.directory;
    return result as Partial<SavedChat>;
  }
}

export class ConversationSessions {
  private sessions=new Map<string,ConversationSession>();
  private listeners=new Set<Listener>();
  private revision=0;
  private dirtyKeys=new Set<string>();
  get(accountId:string,conversationId:string,seed:Record<string,unknown>|(()=>Record<string,unknown>)={}):ConversationSession {
    const key=JSON.stringify([accountId,conversationId]);
    if(!this.sessions.has(key))this.sessions.set(key,new ConversationSession(accountId,conversationId,()=>{
      this.dirtyKeys.add(key);this.revision++;notify(this.listeners);
    },typeof seed==='function'?seed():seed));
    return this.sessions.get(key)!;
  }
  takeDirty(accountId:string):ConversationSession[] {
    const found:ConversationSession[]=[];
    for(const key of this.dirtyKeys){const session=this.sessions.get(key)!;if(session.accountId===accountId){found.push(session);this.dirtyKeys.delete(key);}}
    return found;
  }
  running(accountId:string):ConversationSession[] {
    return [...this.sessions.values()].filter(session=>session.accountId===accountId&&session.get('busy',false));
  }
  forget(accountId:string,conversationId:string) {
    const key=JSON.stringify([accountId,conversationId]);this.sessions.delete(key);this.dirtyKeys.delete(key);
  }
  subscribe=(listener:Listener)=>{this.listeners.add(listener);return()=>this.listeners.delete(listener);};
  getRevision=()=>this.revision;
}

export function conversationSessionSeed(chat?:SavedChat,pending?:PendingGeneration):Record<string,unknown> {
  const saved=pending?.committed??chat;
  let boundary=null,boundaryError='';
  try{boundary=pending?pendingBoundary(pending):null;}catch(error){boundaryError=String(error instanceof Error?error.message:error);}
  return {messages:pending?.messages??saved?.messages??[],display:saved?.display??pending?.display??[],
    pendingId:pending&&!pending.committed?pending.generationId:chat?.pendingId??'',pendingNeedsReview:!!pending&&!pending.committed,
    planId:saved?.planId??'',planIds:saved?chatPlanIds(saved):[],planReady:!!saved?.planId,
    contextCompressed:!!saved?.contextCompressed,lastInputTokens:saved?.lastInputTokens??null,codexContext:saved?.codexContext??null,
    boundary,error:boundaryError};
}
