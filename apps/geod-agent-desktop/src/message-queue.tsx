import { useRef, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { CornerDownRight, DotsThree, GripVertical, Loader2, PencilSimple, ChevronDown, X, Search, RefreshCw } from './icons';
import { Button } from '@/components/motion/button/base';
import { MorphPopover, MorphPopoverContent, MorphPopoverTrigger } from '@/components/motion/popover-morph';
import { UiTooltip } from './ui-tooltip';
import { ScrollArea } from './components/ui/scroll-area';
import { ImageAttachments } from './image-attachments';
import { DocumentAttachments } from './document-attachments';
import { queueLocked } from './queued-inputs';
import { t } from './i18n';
import type { QueuedInput } from './pending-generations';

export function MessageQueue({items,paused,sendingId,onSendNow,onRemove,onPausedChange,onEdit,onMove,onCheck,onEditDraft,canSendNow=true}: {
  items:QueuedInput[];paused:boolean;sendingId:string|null;
  canSendNow?:boolean;
  onSendNow:(item:QueuedInput)=>void;onRemove:(id:string)=>void;onPausedChange:(paused:boolean)=>void;
  onEdit?:(id:string,text:string)=>void;onMove?:(id:string,offset:number)=>void;onCheck?:(item:QueuedInput)=>void;onEditDraft?:(id:string,text:string|undefined)=>void;
}) {
  const reduce=useReducedMotion()??false;
  const [preview,setPreview]=useState<string|null>(null);
  const drag=useRef<{id:string;y:number;active:boolean}|null>(null);
  const [dragging,setDragging]=useState<string|null>(null);
  const selected=items.find(item=>item.id===preview);
  if(!items.length)return null;
  return <section className="message-queue" aria-label={t('待发送消息')}>
    {paused&&<div className="message-queue-paused"><span>{t('队列已暂停，待发送内容已保留')}</span><Button variant="ghost" size="sm" onClick={()=>onPausedChange(false)}>{t('继续发送')}</Button></div>}
    {!paused&&<div className="message-queue-head"><span>{items.length} {t('条待发送')}</span><Button variant="ghost" size="sm" onClick={()=>onPausedChange(true)}>{t('暂停队列')}</Button></div>}
    <ScrollArea className="message-queue-scroll"><div className="message-queue-items"><AnimatePresence initial={false}>{items.map((item,index)=>{
      const state=item.delivery?.state??(sendingId===item.id?'sending':'queued');
      const locked=queueLocked(item)||state==='sending';
      return <motion.div layout={!reduce} key={item.id} data-queue-id={item.id} className={`message-queue-entry is-${state} ${dragging===item.id?'is-reordering':''}`} initial={{opacity:0,height:0}} animate={{opacity:1,height:'auto'}} exit={{opacity:0,height:0}} transition={reduce?{duration:0}:{duration:.18,ease:'easeOut'}}>
        <div className="message-queue-item">
          <button type="button" className="message-queue-reorder" aria-label={t('排序待发送消息：{0}',{'0':item.text.slice(0,20)})} disabled={locked||!onMove} onKeyDown={event=>{if(event.key==='ArrowUp'||event.key==='ArrowDown'){event.preventDefault();onMove?.(item.id,event.key==='ArrowUp'?-1:1);}}} onPointerDown={event=>{if(event.button!==0)return;event.currentTarget.setPointerCapture(event.pointerId);drag.current={id:item.id,y:event.clientY,active:false};}} onPointerMove={event=>{
            const current=drag.current;if(!current||current.id!==item.id)return;
            if(!current.active&&Math.abs(event.clientY-current.y)<6)return;
            current.active=true;setDragging(item.id);
            const row=event.currentTarget.closest<HTMLElement>('[data-queue-id]'),parent=row?.parentElement;if(!row||!parent)return;
            const peers=[...parent.querySelectorAll<HTMLElement>('[data-queue-id]')],position=peers.indexOf(row),direction=event.clientY>row.getBoundingClientRect().bottom?1:event.clientY<row.getBoundingClientRect().top?-1:0;
            const peer=peers[position+direction];if(direction&&peer){const rect=peer.getBoundingClientRect();if(direction>0?event.clientY>rect.top+rect.height/2:event.clientY<rect.top+rect.height/2)onMove?.(item.id,direction);}
          }} onPointerUp={()=>{drag.current=null;setDragging(null);}} onPointerCancel={()=>{drag.current=null;setDragging(null);}}><GripVertical size={14} aria-hidden="true"/></button>
          <button type="button" className="message-queue-preview" onClick={()=>setPreview(item.id)} aria-label={t('查看待发送消息：{0}',{'0':item.text.slice(0,20)})}>{item.text}{!!(item.images?.length||item.documents?.length)&&<small> · {(item.images?.length??0)+(item.documents?.length??0)} {t('个附件')}</small>}</button>
          {state==='sending'?<span className="message-queue-sending" role="status"><Loader2 size={14}/><span>{t('发送中')}</span></span>:state==='outcome-unknown'?<Button variant="ghost" size="sm" className="message-queue-check" onClick={()=>onCheck?.(item)}><Search size={13}/>{t('检查送达')}</Button>:<UiTooltip content={state==='failed'?t('重试发送'):t('立即引导当前回复')}><Button variant="ghost" size="icon" disabled={!!sendingId||!canSendNow} aria-label={t('立即发送：{0}',{'0':item.text.slice(0,20)})} onClick={()=>onSendNow(item)}>{state==='failed'?<RefreshCw size={14}/>:<CornerDownRight size={14}/>}</Button></UiTooltip>}
          <UiTooltip content={t('移除待发送消息')}><Button variant="ghost" size="icon" disabled={locked} aria-label={t('移除待发送消息：{0}',{'0':item.text.slice(0,20)})} onClick={()=>onRemove(item.id)}><X size={14}/></Button></UiTooltip>
          <QueueMenu item={item} locked={locked} index={index} count={items.length} onPreview={()=>setPreview(item.id)} onEditDraft={onEditDraft} onMove={onMove}/>
        </div>
        {state==='outcome-unknown'&&<p className="message-queue-delivery-note">{t('送达结果待确认，请先检查，避免重复发送。')}</p>}
        {state==='failed'&&<p className="message-queue-delivery-note" role="status">{item.delivery?.message||t('发送未成功，内容已保留。')}</p>}
        {item.editDraft!==undefined&&<div className="message-queue-edit"><textarea aria-label={t('编辑待发送消息')} value={item.editDraft} onChange={event=>onEditDraft?.(item.id,event.target.value)} disabled={locked}/><div><Button variant="ghost" size="sm" onClick={()=>onEditDraft?.(item.id,undefined)}>{t('取消')}</Button><Button variant="outline" size="sm" disabled={locked||!item.editDraft.trim()} onClick={()=>onEdit?.(item.id,item.editDraft!)}>{t('保存修改')}</Button></div></div>}
      </motion.div>;
    })}</AnimatePresence></div></ScrollArea>
    <Dialog.Root open={!!selected} onOpenChange={open=>{if(!open)setPreview(null);}}><Dialog.Portal><Dialog.Overlay className="permission-dialog-overlay"/><Dialog.Content className="permission-dialog message-queue-dialog" aria-describedby={undefined}>
      <Dialog.Title>{t('待发送消息')}</Dialog.Title><Dialog.Close asChild><Button variant="ghost" size="icon" className="dialog-close" aria-label={t('关闭预览')}><X size={17}/></Button></Dialog.Close>
      <ScrollArea className="message-queue-full"><p>{selected?.text}</p>{selected?.images?.length?<ImageAttachments images={selected.images}/>:null}{selected?.documents?.length?<DocumentAttachments documents={selected.documents}/>:null}</ScrollArea>
    </Dialog.Content></Dialog.Portal></Dialog.Root>
  </section>;
}
function QueueMenu({item,locked,index,count,onPreview,onEditDraft,onMove}:{item:QueuedInput;locked:boolean;index:number;count:number;onPreview:()=>void;onEditDraft?:((id:string,text:string|undefined)=>void);onMove?:((id:string,offset:number)=>void)}){
  const [open,setOpen]=useState(false);
  const action=(run:()=>void)=>{setOpen(false);run();};
  return <MorphPopover open={open} onOpenChange={setOpen}><MorphPopoverTrigger><Button type="button" variant="ghost" size="icon" aria-label={t('待发送消息更多操作')}><DotsThree size={14}/></Button></MorphPopoverTrigger><MorphPopoverContent side="top" align="end" className="message-queue-menu">
    <Button variant="ghost" size="sm" onClick={()=>action(onPreview)}><Search size={14}/>{t('查看完整消息')}</Button>
    <Button variant="ghost" size="sm" disabled={locked||!onEditDraft} onClick={()=>action(()=>onEditDraft?.(item.id,item.text))}><PencilSimple size={14}/>{t('编辑消息')}</Button>
    <Button variant="ghost" size="sm" disabled={locked||index===0||!onMove} onClick={()=>action(()=>onMove?.(item.id,-1))}><ChevronDown size={14} style={{transform:'rotate(180deg)'}}/>{t('上移')}</Button>
    <Button variant="ghost" size="sm" disabled={locked||index===count-1||!onMove} onClick={()=>action(()=>onMove?.(item.id,1))}><ChevronDown size={14}/>{t('下移')}</Button>
  </MorphPopoverContent></MorphPopover>;
}
