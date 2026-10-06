import { useCallback, useEffect, useRef, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { Button } from '@/components/motion/button/base';
import { ScrollArea } from './components/ui/scroll-area';
import { Bell, CheckCheck, ChevronDown, ExternalLink, Loader2, RefreshCw, X } from './icons';
import { api, errorMessage, type AppMessage, type AppMessageFeed, type AppMessageText } from './api';
import { getLocale, localize, t } from './i18n';
import { DESKTOP_SETTINGS_OPEN } from './desktop-settings-dialog';
import { UiTooltip } from './ui-tooltip';
import './message-center.css';

const key = (owner:string) => `geod-agent-messages-1:${encodeURIComponent(owner)}`;
const messageText = (value:AppMessageText) => getLocale().startsWith('en') ? value.en ?? value.zh : value.zh;
function validFeed(value:unknown,owner:string):value is AppMessageFeed {
  if(!value||typeof value!=='object')return false;
  const next=value as AppMessageFeed;
  const validText=(text:AppMessageText)=>text&&typeof text.zh==='string'&&(text.en==null||typeof text.en==='string');
  return next.schemaVersion===1&&next.accountId===owner&&Number.isInteger(next.unreadCount)&&next.unreadCount>=0&&Array.isArray(next.items)&&next.items.length<=100&&next.items.every(item=>
    item&&typeof item.id==='string'&&Number.isInteger(item.revision)&&item.revision>0&&validText(item.title)&&validText(item.body)&&
    ['normal','important'].includes(item.priority)&&Number.isFinite(Date.parse(item.publishedAt))&&
    (item.expiresAt===null||Number.isFinite(Date.parse(item.expiresAt)))&&(item.readAt===null||typeof item.readAt==='string')&&
    (item.action===null||item.action&&['update','link'].includes(item.action.kind)&&validText(item.action.label)));
}
function cached(owner:string):{feed:AppMessageFeed|null;seen:string[]} {
  try {
    const raw=localStorage.getItem(key(owner));
    if(!raw||raw.length>1_500_000)return {feed:null,seen:[]};
    const data=JSON.parse(raw);
    return {feed:validFeed(data.feed,owner)?data.feed:null,seen:Array.isArray(data.seen)?data.seen.filter((item:unknown)=>typeof item==='string').slice(-500):[]};
  } catch {return {feed:null,seen:[]};}
}
export function MessageCenter({accountId,desktop}:{accountId:string|null;desktop:boolean}) {
  const [open,setOpen]=useState(false),[feed,setFeed]=useState<AppMessageFeed|null>(null),[loading,setLoading]=useState(false),[working,setWorking]=useState(false),[error,setError]=useState(''),[unreadOnly,setUnreadOnly]=useState(false),[expanded,setExpanded]=useState<string|null>(null),[toast,setToast]=useState<AppMessage|null>(null);
  const owner=useRef(accountId),seen=useRef<string[]>([]),pending=useRef(new Set<string>()),lastFetch=useRef(0);
  owner.current=accountId;
  const persist=(id:string,value:AppMessageFeed,ids:string[])=>{try{localStorage.setItem(key(id),JSON.stringify({feed:value,seen:ids.slice(-500)}));}catch{/* The online inbox remains usable if local storage is full. */}};
  const refresh=useCallback(async()=>{
    const id=accountId;
    if(!desktop||!id||pending.current.has(id))return;
    pending.current.add(id);setLoading(true);setError('');
    try {
      const next=await api.agentMessages();
      if(owner.current!==id)return;
      if(!validFeed(next,id))throw new Error(t('消息响应与当前账号不一致。'));
      setFeed(next);lastFetch.current=Date.now();
      const urgent=next.items.find(item=>item.priority==='important'&&!item.readAt&&!seen.current.includes(`${item.id}:${item.revision}`));
      if(urgent){seen.current=[...seen.current,`${urgent.id}:${urgent.revision}`].slice(-500);setToast(urgent);}
      persist(id,next,seen.current);
    } catch(cause) {if(owner.current===id)setError(errorMessage(cause));}
    finally {pending.current.delete(id);if(owner.current===id)setLoading(false);}
  },[accountId,desktop]);
  useEffect(()=>{
    setError('');setExpanded(null);setToast(null);setFeed(null);setWorking(false);setLoading(false);lastFetch.current=0;
    if(!accountId){seen.current=[];return;}
    const previous=cached(accountId);seen.current=previous.seen;setFeed(previous.feed);
    void refresh();
    const poll=()=>{if(!document.hidden&&Date.now()-lastFetch.current>=60_000)void refresh();};
    const timer=setInterval(poll,60_000);
    document.addEventListener('visibilitychange',poll);window.addEventListener('focus',poll);
    return()=>{clearInterval(timer);document.removeEventListener('visibilitychange',poll);window.removeEventListener('focus',poll);};
  },[accountId,refresh]);
  useEffect(()=>{if(!toast)return;const timer=setTimeout(()=>setToast(null),12_000);return()=>clearTimeout(timer);},[toast]);
  const markRead=async(ids:string[])=>{
    if(!accountId||working||!ids.length)return;
    const id=accountId;setWorking(true);setError('');
    try {
      const result=await api.agentMessagesRead(id,ids);
      if(owner.current!==id)return;
      if(result.accountId!==id)throw new Error(t('消息响应与当前账号不一致。'));
      setFeed(current=>{
        if(!current||current.accountId!==id)return current;
        const items=current.items.map(item=>ids.includes(item.id)?{...item,readAt:item.readAt??new Date().toISOString()}:item);
        const next={...current,items,unreadCount:items.filter(item=>!item.readAt).length};persist(id,next,seen.current);return next;
      });
    }catch(cause){if(owner.current===id)setError(errorMessage(cause));}
    finally{if(owner.current===id)setWorking(false);}
  };
  const action=async(item:AppMessage)=>{
    if(!item.action)return;
    if(item.action.kind==='update'){setOpen(false);window.dispatchEvent(new Event(DESKTOP_SETTINGS_OPEN));return;}
    try {const url=new URL(item.action.url??'');if(url.protocol!=='https:'||url.username||url.password)throw new Error(t('消息链接不可用。'));await api.agentMessageOpenLink(url.href);}catch(cause){setError(errorMessage(cause));}
  };
  const items=(feed?.accountId===accountId?feed.items:[]).filter(item=>(!item.expiresAt||Date.parse(item.expiresAt)>Date.now())&&(!unreadOnly||!item.readAt));
  const unread=feed?.accountId===accountId?feed.unreadCount:0;
  const show=()=>{setOpen(true);setToast(null);if(Date.now()-lastFetch.current>60_000)void refresh();};
  return <>
    <UiTooltip content={t('消息中心')} side="bottom"><Button variant="ghost" size="icon" className="app-message-trigger" aria-label={unread?t('消息中心，{0} 条未读',{'0':unread}):t('消息中心')} onClick={show}><Bell size={17}/>{unread>0&&<span className="app-message-dot" aria-hidden="true"/>}</Button></UiTooltip>
    {toast&&<div className="app-message-toast" role="status" onMouseDown={event=>event.stopPropagation()}><Bell size={17}/><div><strong>{messageText(toast.title)}</strong><p>{messageText(toast.body).slice(0,120)}</p><Button variant="ghost" size="sm" onClick={show}>{t('查看消息')}</Button></div><Button variant="ghost" size="icon" aria-label={t('关闭消息提醒')} onClick={()=>setToast(null)}><X size={15}/></Button></div>}
    <Dialog.Root open={open} onOpenChange={setOpen}><Dialog.Portal><Dialog.Overlay className="permission-dialog-overlay"/><Dialog.Content className="permission-dialog message-center-dialog" onMouseDown={event=>event.stopPropagation()}>
      <div className="dialog-heading"><Dialog.Title><Bell size={19}/>{t('消息中心')}{unread>0&&<span className="message-count">{unread}</span>}</Dialog.Title><Button variant="ghost" size="icon" aria-label={t('关闭消息中心')} onClick={()=>setOpen(false)}><X size={17}/></Button></div>
      <Dialog.Description>{t('产品更新、服务公告与账号通知。')}</Dialog.Description>
      <div className="message-center-toolbar"><div><Button variant="ghost" size="sm" aria-pressed={!unreadOnly} onClick={()=>setUnreadOnly(false)}>{t('全部消息')}</Button><Button variant="ghost" size="sm" aria-pressed={unreadOnly} onClick={()=>setUnreadOnly(true)}>{t('未读')}</Button></div><div><Button variant="ghost" size="sm" disabled={working||!unread} onClick={()=>void markRead((feed?.items??[]).filter(item=>!item.readAt).map(item=>item.id))}><CheckCheck size={15}/>{t('全部已读')}</Button><Button variant="ghost" size="icon" aria-label={t('刷新消息')} disabled={loading||!accountId||!desktop} onClick={()=>void refresh()}>{loading?<Loader2 size={16} className="animate-spin"/>:<RefreshCw size={16}/>}</Button></div></div>
      {error&&<p className="message-center-error" role="alert">{localize(error)}{feed&&` ${t('正在显示上次保存的消息。')}`}</p>}
      <ScrollArea className="message-center-scroll" style={{height:Math.min(420,Math.max(210,items.length*76+(expanded?180:0)))}}>
        {!accountId?<div className="message-center-empty"><Bell size={26}/><strong>{t('登录后查看消息')}</strong><p>{t('登录 GeoD 账号后，可接收公告并同步已读状态。')}</p></div>:loading&&!feed?<div className="message-center-empty"><Loader2 size={23} className="animate-spin"/>{t('正在加载消息…')}</div>:!items.length?<div className="message-center-empty"><Bell size={26}/><strong>{unreadOnly?t('没有未读消息'):t('暂无消息')}</strong><p>{t('有新的公告时，会在这里通知你。')}</p></div>:items.map(item=><article key={`${item.id}:${item.revision}`} className={`message-center-item ${item.readAt?'':'is-unread'}`}>
          <button type="button" className="message-center-summary" aria-expanded={expanded===item.id} onClick={()=>{setExpanded(expanded===item.id?null:item.id);if(!item.readAt)void markRead([item.id]);}}><span className="message-read-dot"/><span><strong>{messageText(item.title)}</strong><small>{new Date(item.publishedAt).toLocaleString(getLocale(),{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'})}{item.priority==='important'&&` · ${t('重要')}`}</small></span><ChevronDown size={16}/></button>
          {expanded===item.id&&<div className="message-center-body"><p>{messageText(item.body)}</p>{item.action&&<Button variant="outline" size="sm" onClick={()=>void action(item)}>{item.action.kind==='link'&&<ExternalLink size={14}/>} {messageText(item.action.label)}</Button>}</div>}
        </article>)}
      </ScrollArea>
    </Dialog.Content></Dialog.Portal></Dialog.Root>
  </>;
}
