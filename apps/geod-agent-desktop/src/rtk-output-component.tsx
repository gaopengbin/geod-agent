import {useEffect,useRef,useState} from 'react';
import {listen} from '@tauri-apps/api/event';
import {open} from '@tauri-apps/plugin-dialog';
import {Button} from '@/components/motion/button/base';
import {api,desktopAvailable,errorMessage,type RtkStatus,type RtkInstallProgress} from './api';
import {Loader2,Terminal} from './icons';
import {t,localize} from './i18n';

export function RtkOutputComponent({active}:{active:boolean}){
  const [item,setItem]=useState<RtkStatus|null>(null),[busy,setBusy]=useState(false),[cancelling,setCancelling]=useState(false),[error,setError]=useState(''),[progress,setProgress]=useState('');
  const current=useRef<string|null>(null),mounted=useRef(true),ownInstall=useRef(false);
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;};},[]);
  useEffect(()=>{if(active&&desktopAvailable)void api.rtkStatus().then(value=>{if(mounted.current){setItem(value);if(value.activeRequestId){current.current=value.activeRequestId;setBusy(true);setProgress(t('正在安装'));}}}).catch(e=>{if(mounted.current)setError(errorMessage(e));});},[active]);
  useEffect(()=>{if(!busy||!current.current||ownInstall.current)return;const timer=setInterval(()=>{void api.rtkStatus().then(value=>{if(!mounted.current)return;setItem(value);if(!value.activeRequestId){current.current=null;setBusy(false);setCancelling(false);setProgress('');}}).catch(e=>{if(mounted.current)setError(errorMessage(e));});},1000);return()=>clearInterval(timer);},[busy]);
  async function install(offline:boolean){
    let archive:string|null=null;
    if(offline){try{const selected=await open({multiple:false,directory:false,filters:[{name:'RTK ZIP',extensions:['zip']}],title:t('选择官方 RTK Windows 安装包')});if(typeof selected!=='string')return;archive=selected;}catch(e){setError(errorMessage(e));return;}}
    const requestId=crypto.randomUUID();current.current=requestId;ownInstall.current=true;setBusy(true);setError('');setProgress(t('检查组件'));let release:(()=>void)|undefined;
    try{
      release=await listen<RtkInstallProgress>('geod:rtk-install-progress',event=>{
        if(!mounted.current||event.payload.requestId!==current.current)return;const p=event.payload;
        setProgress(p.phase==='downloading'&&p.total>0?t('下载中 {0}%',{'0':Math.min(100,Math.floor(p.bytes/p.total*100))}):t(({checking:'检查组件',downloading:'连接下载服务',verifying:'校验安装包',installing:'正在安装',ready:'安装完成'} as Record<string,string>)[p.phase]??'正在安装'));
      });
      const value=await api.rtkInstall(requestId,archive);if(mounted.current)setItem(value);
    }catch(e){if(mounted.current){setError(errorMessage(e));try{const value=await api.rtkStatus();if(mounted.current)setItem(value);}catch{/* Keep the original installation error. */}}}
    finally{release?.();current.current=null;ownInstall.current=false;if(mounted.current){setBusy(false);setCancelling(false);setProgress('');}}
  }
  async function toggle(){if(!item)return;setBusy(true);setError('');try{setItem(await api.rtkSetEnabled(!item.enabled));}catch(e){setError(errorMessage(e));}finally{setBusy(false);}}
  async function cancel(){if(!current.current)return;setCancelling(true);try{await api.rtkInstallCancel(current.current);}catch(e){setError(errorMessage(e));setCancelling(false);}}
  return <section className="extension-catalog-section" aria-labelledby="rtk-components-title">
    <div className="extension-catalog-heading"><h3 id="rtk-components-title">{t('可选组件')}</h3><p>{t('按需安装，设置保存在当前账号。')}</p></div>
    <div className="extension-connector-grid"><article className="extension-tile rtk-output-tile" aria-busy={busy}>
      <div className="extension-tile-top"><span className="extension-tile-icon"><Terminal size={18}/></span><strong>{t('命令输出精简（RTK）')}</strong><span className={'extension-status'+(item?.enabled?' enabled':'')}>{t(item?(item.ready?(item.enabled?'已启用':'已停用'):item.installed?'需要修复':'未安装'):'加载中')}</span></div>
      <p className="extension-tile-description">{t('精简 Git、搜索和测试等命令返回模型的内容，减少输入消耗。原始输出保留在本机，失败和结构化数据保持原样。')}</p>
      {item&&<p className="extension-credential-label">RTK {item.version} · {item.downloadBytes>0?t('需下载 {0} MB',{'0':(item.downloadBytes/1_000_000).toFixed(1)}):t('组件已缓存')} · {t('安装后 {0} MB',{'0':(item.installedBytes/1_000_000).toFixed(1)})}</p>}
      {error&&<p className="extension-tile-error" role="alert">{localize(error)}</p>}
      {item&&!item.supported&&<p className="extension-credential-label">{t('此组件目前支持 Windows x64')}</p>}
      <div className="extension-tile-actions">
        {current.current?<><Button size="sm" variant="outline" disabled><Loader2 size={15} className="extension-spin"/>{cancelling?t('正在取消'):progress}</Button><Button size="sm" variant="ghost" disabled={cancelling} onClick={()=>void cancel()}>{t('取消安装')}</Button></>:item?.ready?<Button size="sm" variant="outline" disabled={busy} onClick={()=>void toggle()}>{t(item.enabled?'停用':'启用')}</Button>:<><Button size="sm" variant="outline" disabled={busy||!item?.supported||!desktopAvailable} onClick={()=>void install(false)}>{t(item?.installed?'修复组件':'安装组件')}</Button><Button size="sm" variant="ghost" disabled={busy||!item?.supported||!desktopAvailable} onClick={()=>void install(true)}>{t('从本地安装')}</Button></>}
      </div>
    </article></div>
  </section>;
}
