import * as Dialog from "@radix-ui/react-dialog";
import { useRef, useState } from "react";
import { MorphPopover, MorphPopoverContent, MorphPopoverTrigger } from "@/components/motion/popover-morph";
import { Button } from "@/components/motion/button/base";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Archive, ArchiveRestore, DotsThree, ArrowDownToLine, PencilSimple, Pin, PinOff, Search, Trash, X, File } from "./icons";
import { t, getLocale } from "./i18n";
import type { SavedChat } from "./pending-generations";
import { conversationTitle, searchConversations } from "./conversation-history";
import { errorMessage } from "./app-error";

export type ConversationAction = "rename"|"pin"|"archive"|"restore"|"export-json"|"export-md"|"delete";
export function ConversationRow({ chat, active, time, running, onSelect, onAction }: {
  chat:SavedChat;active:boolean;time:string;running?:boolean;onSelect:()=>void;onAction:(action:ConversationAction)=>void;
}) {
  const [menu,setMenu]=useState(false);
  const title=chat.title||chat.display.find(message=>message.role==="user")?.content.slice(0,34)||t("新对话");
  const action=(value:ConversationAction)=>{setMenu(false);onAction(value);};
  return <div className={`conversation-row ${active?"is-active":""}`}>
    <button type="button" data-conversation-id={chat.conversationId} className={`conversation-item ${active?"active":""}`} aria-current={active?"page":undefined} onClick={onSelect} title={title}>
      {running?<span className="conversation-running-dot" aria-label={t("正在运行")}/>:chat.pinned?<Pin size={12} aria-label={t("置顶")}/>:null}
      <span>{title}</span>{time&&<time dateTime={chat.updatedAt}>{time}</time>}
    </button>
    <MorphPopover open={menu} onOpenChange={setMenu} className="conversation-more-anchor">
      <MorphPopoverTrigger><button type="button" className="conversation-more" aria-label={t("会话操作：{0}",{"0":title})}><DotsThree size={17}/></button></MorphPopoverTrigger>
      <MorphPopoverContent side="bottom" align="end" radius={10} className="workspace-menu conversation-menu">
        <button type="button" onClick={()=>action("rename")}><PencilSimple size={16}/>{t("重命名")}</button>
        <button type="button" onClick={()=>action("pin")}>{chat.pinned?<PinOff size={16}/>:<Pin size={16}/>} {t(chat.pinned?"取消置顶":"置顶")}</button>
        <button type="button" onClick={()=>action(chat.archived?"restore":"archive")}>{chat.archived?<ArchiveRestore size={16}/>:<Archive size={16}/>} {t(chat.archived?"取消归档":"归档")}</button>
        <button type="button" onClick={()=>action("export-json")}><ArrowDownToLine size={16}/>{t("导出 JSON")}</button>
        <button type="button" onClick={()=>action("export-md")}><File size={16}/>{t("导出 Markdown")}</button>
        <button type="button" className="workspace-menu-remove" disabled={running} onClick={()=>action("delete")}><Trash size={16}/>{t("删除会话")}</button>
      </MorphPopoverContent>
    </MorphPopover>
  </div>;
}

export function ConversationHistory({ open,onOpenChange,chats,currentId,onSelect,onAction,onImport,runningIds=[] }: {
  open:boolean;onOpenChange:(open:boolean)=>void;chats:SavedChat[];currentId:string;onSelect:(chat:SavedChat)=>void;
  onAction:(chat:SavedChat,action:ConversationAction)=>void;onImport:(file:File)=>Promise<void>;runningIds?:string[];
}) {
  const [query,setQuery]=useState(""),[archived,setArchived]=useState(false),[limit,setLimit]=useState(30),[error,setError]=useState("");
  const file=useRef<HTMLInputElement>(null);
  const matches=searchConversations(chats,query,archived);
  return <Dialog.Root open={open} onOpenChange={onOpenChange}><Dialog.Portal><Dialog.Overlay className="permission-dialog-overlay"/>
    <Dialog.Content className="permission-dialog conversation-history-dialog">
      <div className="dialog-heading"><Dialog.Title>{t("会话历史")}</Dialog.Title><Dialog.Close asChild><Button variant="ghost" size="icon" aria-label={t("关闭")}><X size={17}/></Button></Dialog.Close></div>
      <Dialog.Description className="sr-only">{t("搜索、管理或导入本机保存的会话。")}</Dialog.Description>
      <div className="conversation-search-input"><Search size={16}/><input autoFocus aria-label={t("搜索标题或对话内容")} placeholder={t("搜索标题或对话内容")} value={query} onChange={event=>{setQuery(event.target.value);setLimit(30);}}/></div>
      <div className="conversation-history-toolbar"><div role="tablist" aria-label={t("会话状态")}>
        <Button variant="ghost" size="sm" role="tab" aria-selected={!archived} onClick={()=>{setArchived(false);setLimit(30);}}>{t("全部会话")}</Button>
        <Button variant="ghost" size="sm" role="tab" aria-selected={archived} onClick={()=>{setArchived(true);setLimit(30);}}>{t("已归档")}</Button>
      </div><Button variant="ghost" size="sm" onClick={()=>file.current?.click()}><ArrowDownToLine size={14}/>{t("导入会话")}</Button>
      <input ref={file} hidden type="file" accept=".json,application/json" aria-label={t("选择会话 JSON 文件")} onChange={event=>{const chosen=event.target.files?.[0];event.target.value="";if(chosen)void onImport(chosen).then(()=>setError("")).catch(cause=>setError(errorMessage(cause)));}}/></div>
      {error&&<p role="alert" className="warning-text">{t(error)}</p>}
      <ScrollArea className="conversation-history-scroll"><div className="conversation-history-list">
        {!matches.length&&<p className="extension-empty-inline">{t("没有匹配的会话")}</p>}
        {matches.slice(0,limit).map(chat=><ConversationRow key={chat.conversationId} chat={chat} active={chat.conversationId===currentId} time={chat.updatedAt?new Date(chat.updatedAt).toLocaleDateString(getLocale()):""} running={runningIds.includes(chat.conversationId)} onSelect={()=>{onSelect(chat);onOpenChange(false);}} onAction={action=>onAction(chat,action)}/>)}
        {matches.length>limit&&<Button variant="ghost" size="sm" onClick={()=>setLimit(value=>value+30)}>{t("加载更多")}</Button>}
      </div></ScrollArea>
      <small className="conversation-history-count">{t("共 {0} 个会话",{"0":matches.length.toLocaleString(getLocale())})}</small>
    </Dialog.Content></Dialog.Portal></Dialog.Root>;
}

export function ConversationEditor({ chat,mode,running,onClose,onSave,onDelete }: {
  chat:SavedChat|null;mode:"rename"|"delete";running:boolean;onClose:()=>void;onSave:(title:string)=>void;onDelete:()=>void;
}) {
  const [draft,setDraft]=useState(chat?conversationTitle(chat):"");
  return <Dialog.Root open={!!chat} onOpenChange={open=>{if(!open)onClose();}}><Dialog.Portal><Dialog.Overlay className="permission-dialog-overlay"/>
    <Dialog.Content className="permission-dialog conversation-edit-dialog"><Dialog.Title>{t(mode==="rename"?"重命名会话":"删除本机对话记录？")}</Dialog.Title>
      <Dialog.Description>{mode==="delete"?t("成果文件和已启动的下载任务可继续在任务区管理。"):t("输入此会话的新名称。")}</Dialog.Description>
      {mode==="rename"?<input autoFocus aria-label={t("会话名称")} value={draft} maxLength={120} onChange={event=>setDraft(event.target.value)} onKeyDown={event=>{if(event.key==="Enter"&&!event.nativeEvent.isComposing&&draft.trim())onSave(draft.trim());}}/>:running?<p className="warning-text">{t("停止回复后可以删除此会话。")}</p>:<p>{chat?conversationTitle(chat):""}</p>}
      <div className="permission-dialog-actions"><Dialog.Close asChild><Button variant="outline">{t("取消")}</Button></Dialog.Close><Button disabled={mode==="rename"?!draft.trim():running} className={mode==="delete"?"danger-action":undefined} onClick={()=>mode==="rename"?onSave(draft.trim()):onDelete()}>{t(mode==="rename"?"保存名称":"删除会话")}</Button></div>
    </Dialog.Content></Dialog.Portal></Dialog.Root>;
}
