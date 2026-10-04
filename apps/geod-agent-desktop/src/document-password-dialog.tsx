import {useRef,useState} from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import {Button} from '@/components/motion/button/base';
import {File,X} from './icons';
import {t,localize} from './i18n';
import './document-attachments.css';

export interface DocumentPasswordRequest {
  id:string;
  name:string;
  error:string;
  respond:(password:string|null)=>void;
}

/** The password lives only in this mounted form and the pending local import. */
export function DocumentPasswordDialog({request}:{request:DocumentPasswordRequest}){
  const [password,setPassword]=useState('');
  const input=useRef<HTMLInputElement>(null);
  function finish(value:string|null){setPassword('');request.respond(value);}
  return <Dialog.Root open onOpenChange={open=>{if(!open)finish(null);}}><Dialog.Portal>
    <Dialog.Overlay className="dialog-backdrop"/>
    <Dialog.Content className="dialog document-password-dialog" onOpenAutoFocus={event=>{event.preventDefault();input.current?.focus();}}>
      <div className="dialog-head"><div><Dialog.Title>{t('读取加密文档')}</Dialog.Title><Dialog.Description>{t('输入打开此文件所需的密码。')}</Dialog.Description></div><Button type="button" variant="ghost" size="icon" aria-label={t('取消读取文档')} onClick={()=>finish(null)}><X size={18}/></Button></div>
      <form onSubmit={event=>{event.preventDefault();finish(password);}}>
        <div className="dialog-body">
          <div className="document-password-file"><File size={20} aria-hidden="true"/><span title={request.name}>{request.name}</span></div>
          <div className="field"><label htmlFor="document-password">{t('文档密码')}</label><input ref={input} id="document-password" name="document-password" type="password" autoComplete="off" spellCheck={false} maxLength={1024} value={password} onChange={event=>setPassword(event.target.value)} aria-invalid={!!request.error} aria-describedby={request.error?'document-password-error':'document-password-help'}/></div>
          {request.error&&<p id="document-password-error" role="alert" className="form-error">{localize(request.error)}</p>}
          <p id="document-password-help" className="document-password-help">{t('密码仅用于本机这次读取。提取的文字会保存为附件，并在发送后提供给 AI。')}</p>
        </div>
        <div className="dialog-actions"><Button type="button" variant="outline" onClick={()=>finish(null)}>{t('取消')}</Button><Button type="submit">{t('读取文档')}</Button></div>
      </form>
    </Dialog.Content>
  </Dialog.Portal></Dialog.Root>;
}
