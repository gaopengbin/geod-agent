import {useRef,useState} from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import {Button} from '@/components/motion/button/base';
import {Loader2,X} from './icons';
import {api,errorMessage,type McpConnector,type McpToolList} from './api';
import {mcpProvider} from './mcp-provider-presets';
import type {ExtensionProposal} from './pending-generations';
import {t} from './i18n';
import './mcp-key-dialog.css';
import {configureMcpKey} from './mcp-key-config';
import {configureProviderCredential} from './mcp-provider-key-config';

export async function configureAmapKey(name:string,key:string,conversationId:string,client=api){
 return configureMcpKey(name,key,conversationId,client);
}

/** Keys stay inside this local form/native credential adapter, never in transcript or model arguments. */
export function McpKeyDialog({proposal,conversationId,onClose,onConnected,configure}:{proposal:ExtensionProposal;conversationId:string;onClose:()=>void;onConnected:(connector:McpConnector,tools:McpToolList)=>void;configure?:typeof configureAmapKey}){
 const [key,setKey]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState('');const input=useRef<HTMLInputElement>(null);
 const provider=mcpProvider(proposal.detail);
 async function submit(){if(busy||!provider)return;setBusy(true);setError('');
  try{const result=await (configure?configure(proposal.name,key,conversationId):configureProviderCredential(proposal.detail,proposal.name,key,conversationId,api));setKey('');onConnected(result.connector,result.tools);onClose();}
  catch(cause){setKey('');setError(errorMessage(cause));input.current?.focus();}finally{setBusy(false);}
 }
 function close(){if(busy)return;setKey('');onClose();}
 if(!provider)return null;
 return <Dialog.Root open onOpenChange={open=>{if(!open)close();}}><Dialog.Portal><Dialog.Overlay className="dialog-backdrop"/><Dialog.Content className="dialog mcp-key-dialog" onOpenAutoFocus={e=>{e.preventDefault();input.current?.focus();}} onEscapeKeyDown={e=>{if(busy)e.preventDefault();}} onPointerDownOutside={e=>{if(busy)e.preventDefault();}}>
  <div className="dialog-head"><div><Dialog.Title>{t(provider.title)}</Dialog.Title><Dialog.Description>{t(provider.description)}</Dialog.Description></div><Button type="button" variant="ghost" size="icon" aria-label={t('关闭连接配置')} disabled={busy} onClick={close}><X size={18}/></Button></div>
  <form onSubmit={e=>{e.preventDefault();void submit();}}><div className="dialog-body">
   <div className="mcp-key-endpoint"><strong>{t('官方服务地址')}</strong><span>{provider.url}</span></div>
   <div className="field"><label htmlFor="mcp-provider-key">{t(provider.label)}</label><input id="mcp-provider-key" ref={input} type="password" autoComplete="off" spellCheck={false} maxLength={provider.maxLength} value={key} disabled={busy} onChange={e=>setKey(e.target.value)} aria-describedby="mcp-key-help" aria-invalid={!!error}/></div>
   <p id="mcp-key-help" className="mcp-key-help">{t(provider.help)} <a href={provider.docs} target="_blank" rel="noreferrer">{t('查看申请说明')}</a></p>
   {error&&<p className="form-error" role="alert">{error}</p>}
  </div><div className="dialog-actions"><Button type="button" variant="outline" disabled={busy} onClick={close}>{t('稍后配置')}</Button><Button type="submit" disabled={busy||!key.trim()}>{busy?<><Loader2 size={16} className="animate-spin"/>{t('正在测试…')}</>:t('保存并测试')}</Button></div></form>
 </Dialog.Content></Dialog.Portal></Dialog.Root>;
}
