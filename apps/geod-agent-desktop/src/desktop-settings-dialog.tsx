import {useEffect,useRef,useState} from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import {Button} from '@/components/motion/button/base';
import {Download,Loader2,RefreshCw,X} from './icons';
import {api,errorMessage,type DesktopSettings,type DesktopUpdate,type DesktopUpdateProgress,type DesktopBackup} from './api';
import {snapshotLocalRecords} from './local-state';
import {t,localize,getLocale} from './i18n';
import './desktop-settings.css';

export const DESKTOP_SETTINGS_OPEN='geod:desktop-settings-open';
export const DESKTOP_UPDATE_AVAILABLE='geod:desktop-update-available';
let announcedUpdate: DesktopUpdate|null=null;
export const getAnnouncedDesktopUpdate=()=>announcedUpdate;
export function announceDesktopUpdate(update:DesktopUpdate){
  announcedUpdate=update.state==='available'||update.state==='ready'?update:null;
  window.dispatchEvent(new CustomEvent(DESKTOP_UPDATE_AVAILABLE,{detail:announcedUpdate}));
}
function Toggle({checked,disabled,label,onChange}:{checked:boolean;disabled?:boolean;label:string;onChange:()=>void}){
  return <button type="button" role="switch" aria-checked={checked} aria-label={label} disabled={disabled} className="desktop-settings-switch" onClick={onChange}><span/></button>;
}
export function DesktopSettingsDialog({onClose}:{onClose:()=>void}){
  const [settings,setSettings]=useState<DesktopSettings|null>(null),[update,setUpdate]=useState<DesktopUpdate|null>(getAnnouncedDesktopUpdate);
  const [progress,setProgress]=useState<DesktopUpdateProgress|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const [backup,setBackup]=useState<DesktopBackup|null>(null);
  const [backingUp,setBackingUp]=useState(false);
  const recordsSection=useRef<HTMLElement>(null);
  useEffect(()=>{if(backup)recordsSection.current?.scrollIntoView({block:'nearest'});},[backup]);
  useEffect(()=>{let disposed=false;void api.desktopSettings().then(value=>{if(!disposed)setSettings(value);}).catch(cause=>{if(!disposed)setError(errorMessage(cause));});return()=>{disposed=true;};},[]);
  const run=async(action:()=>Promise<void>)=>{setBusy(true);setError('');try{await action();}catch(cause){setError(errorMessage(cause));setProgress(null);}finally{setBusy(false);}};
  const check=()=>run(async()=>{setProgress(null);const current=await api.desktopUpdateCheck();setUpdate(current);announceDesktopUpdate(current);setSettings(await api.desktopSettings());});
  const download=()=>run(async()=>{if(!update?.version)return;const verified=await api.desktopUpdateDownload(update.version,setProgress);const current={...update,...verified};setUpdate(current);announceDesktopUpdate(current);});
  const install=()=>run(async()=>{if(!update?.version)return;await api.desktopUpdateInstall(update.version,await snapshotLocalRecords());});
  const saveRecords=()=>run(async()=>{setBackup(null);setBackingUp(true);try{setBackup(await api.desktopBackupCreate(await snapshotLocalRecords()));}finally{setBackingUp(false);}});
  const percentage=progress?.total?Math.min(100,Math.round((progress.downloaded??0)/progress.total*100)):undefined;
  return <Dialog.Root open onOpenChange={open=>{if(!open&&!busy)onClose();}}><Dialog.Portal><Dialog.Overlay className="permission-dialog-overlay"/>
    <Dialog.Content className="permission-dialog desktop-settings-dialog" onEscapeKeyDown={event=>{if(busy)event.preventDefault();}} onPointerDownOutside={event=>{if(busy)event.preventDefault();}}>
      <div className="dialog-heading"><Dialog.Title>{t('应用设置')}</Dialog.Title><Button variant="ghost" size="icon" disabled={busy} aria-label={t('关闭应用设置')} onClick={onClose}><X size={17}/></Button></div>
      <Dialog.Description>{t('管理此设备的启动与应用更新。')}</Dialog.Description>
      <div className="desktop-settings-scroll">
      {!settings&&!error?<div className="desktop-settings-loading"><Loader2 size={16} className="animate-spin"/>{t('正在读取应用设置…')}</div>:null}
      {settings&&<>
        <section className="desktop-settings-section"><h3>{t('启动')}</h3><div className="desktop-settings-row"><div><strong>{t('登录系统后在后台运行')}</strong><p>{t('自动启动本机后台，继续定时任务；再次打开窗口可查看原有任务。')}</p></div><Toggle label={t('登录系统后在后台运行')} checked={settings.autostart} disabled={busy} onChange={()=>void run(async()=>setSettings(await api.desktopAutostart(!settings.autostart)))}/></div></section>
        <section className="desktop-settings-section"><div className="desktop-settings-section-head"><h3>{t('应用更新')}</h3><span>{settings.development?t('开发版 · {0}',{'0':settings.version}):`v${settings.version}`}</span></div>
          <div className="desktop-settings-row"><div><strong>{t('自动检查更新')}</strong><p>{t('启动应用时检查新版本，安装由你决定。')}</p></div><Toggle label={t('自动检查更新')} checked={settings.automaticUpdateChecks} disabled={busy} onChange={()=>void run(async()=>setSettings(await api.desktopUpdatePreferences(!settings.automaticUpdateChecks)))}/></div>
          <div className="desktop-update-state" role="status">
            {settings.development&&<p>{t('当前开发版使用热更新，无需反复安装。')}</p>}
            {!settings.updateConfigured?<p>{t('正式更新渠道尚未发布。')}</p>:!update?<p>{settings.lastUpdateCheck?t('上次检查：{0}',{'0':new Date(settings.lastUpdateCheck).toLocaleString(getLocale())}):t('可检查是否有可用更新。')}</p>:update.state==='upToDate'?<p>{t('已是最新版本。')}</p>:update.state==='unconfigured'?<p>{t('正式更新渠道尚未发布。')}</p>:<><strong>{t('可用更新 · {0}',{'0':update.version})}</strong>{update.notes&&<p className="desktop-update-notes">{update.notes}</p>}{update.state==='ready'&&<p className="desktop-update-verified">{t('更新已下载并通过签名验证。')}</p>}</>}
            {progress&&update?.state!=='ready'&&<><div className="desktop-update-progress" role="progressbar" aria-label={t('更新下载进度')} aria-valuenow={percentage} aria-valuemin={0} aria-valuemax={100}><span style={{width:percentage===undefined?'25%':`${percentage}%`}}/></div><small>{progress.phase==='verifying'?t('正在验证更新…'):t('正在下载更新…')}{percentage!==undefined?` ${percentage}%`:''}</small></>}
          </div>
          <div className="desktop-update-actions"><Button variant="outline" size="sm" disabled={busy||!settings.updateConfigured} onClick={()=>void check()}><RefreshCw size={14}/>{t('检查更新')}</Button>{update?.state==='available'&&<Button size="sm" disabled={busy} onClick={()=>void download()}><Download size={14}/>{t('下载更新')}</Button>}{update?.state==='ready'&&!settings.development&&<Button size="sm" disabled={busy} onClick={()=>void install()}>{t('重启并安装')}</Button>}{busy&&!backingUp&&<Loader2 size={16} className="animate-spin"/>}</div>
        </section>
        <section ref={recordsSection} className="desktop-settings-section"><h3>{t('本机记录')}</h3><div className="desktop-settings-row"><p className="desktop-backup-description">{t('保存会话、任务和设置副本；工作区文件继续保留在原位置。')}</p><Button variant="outline" size="sm" disabled={busy} onClick={()=>void saveRecords()}>{backingUp?<Loader2 size={14} className="animate-spin"/>:<Download size={14}/>} {backingUp?t('正在备份…'):t('备份记录')}</Button></div>{backup&&<div className="desktop-backup-result" role="status"><strong>{t('已备份 {0} 项记录',{'0':backup.records.toLocaleString(getLocale())})}</strong><code title={backup.path}>{backup.path}</code></div>}</section>
      </>}
      {error&&<p role="alert" className="form-error">{localize(error)}</p>}
      </div>
      <div className="permission-dialog-actions"><Button disabled={busy} onClick={onClose}>{t('完成')}</Button></div>
    </Dialog.Content>
  </Dialog.Portal></Dialog.Root>;
}
