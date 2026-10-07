import {useState} from 'react';
import {Button} from '@/components/motion/button/base';
import {MorphPopover,MorphPopoverContent,MorphPopoverTrigger} from '@/components/motion/popover-morph';
import {DotsThree,Settings,Trash,ShieldCheck} from './icons';
import type {McpConnector} from './api';
import {t} from './i18n';
export function ConnectorActions({connector,busy,progress,onInspect,onToggle,onKey,onAuth,onRemove}:{connector:McpConnector;busy:boolean;progress?:'inspect'|'enable';onInspect:()=>void;onToggle:()=>void;onKey?:()=>void;onAuth?:()=>void;onRemove?:()=>void}){
 const [open,setOpen]=useState(false);
 function run(action:()=>void){setOpen(false);action();}
 return <div className="extension-tile-actions">
  <Button variant="ghost" size="sm" disabled={busy} onClick={onInspect}>{progress==='inspect'?t('读取中…'):t('查看工具')}</Button>
  <Button variant={connector.enabled?'secondary':'outline'} size="sm" disabled={busy} onClick={onToggle}>{progress==='enable'?t('正在测试…'):connector.enabled?t('停用'):t('启用')}</Button>
  {(onKey||onAuth||onRemove)&&<MorphPopover open={open} onOpenChange={setOpen}><MorphPopoverTrigger><Button type="button" variant="ghost" size="icon" className="extension-management-trigger" aria-label={t('{0}的更多操作',{'0':connector.name})} disabled={busy}><DotsThree size={18}/></Button></MorphPopoverTrigger><MorphPopoverContent side="bottom" align="end" radius={10} className="workspace-menu extension-management-menu">
   {onKey&&<button type="button" onClick={()=>run(onKey)}><Settings size={16}/>{t('配置 Key')}</button>}
   {onAuth&&<button type="button" onClick={()=>run(onAuth)}><ShieldCheck size={16}/>{connector.oauth?t('重新授权'):t('浏览器授权')}</button>}
   {onRemove&&<button type="button" className="workspace-menu-remove" onClick={()=>run(onRemove)}><Trash size={16}/>{t('移除连接器')}</button>}
  </MorphPopoverContent></MorphPopover>}
 </div>;
}
