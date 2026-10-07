import {useEffect,useState} from 'react';
import {listen} from '@tauri-apps/api/event';
import {open} from '@tauri-apps/plugin-dialog';
import {Button} from '@/components/motion/button/base';
import {api,desktopAvailable,errorMessage,type GisSkill,type GisInstallProgress} from './api';
import {gisInstallPhase} from './gis-install-card';
import {Loader2,PuzzlePiece} from './icons';
import {t,localize} from './i18n';

export function GisSkills({active,revision,onChanged}:{active:boolean;revision:string;onChanged:()=>Promise<void>}){
  const [items,setItems]=useState<GisSkill[]>([]),[busy,setBusy]=useState<string|null>(null),[error,setError]=useState(''),[progress,setProgress]=useState('');
  async function refresh(){setItems(await api.gisSkillsList());}
  useEffect(()=>{if(active&&desktopAvailable)void refresh().catch(e=>setError(errorMessage(e)));},[active,revision]);
  useEffect(()=>{if(!busy)return;let disposed=false;let release:(()=>void)|undefined;void listen<GisInstallProgress>('geod:gis-install-progress',event=>{if(disposed||event.payload.featureId!==busy)return;const p=event.payload;setProgress(p.phase==='downloading'&&p.total>0?Math.min(100,Math.round(p.bytes/p.total*100))+'%':gisInstallPhase(p.phase));}).then(fn=>{if(disposed)fn();else release=fn;});return()=>{disposed=true;release?.();};},[busy]);
  async function install(item:GisSkill,offline:boolean){
    let directory:string|null=null;
    if(offline){const selected=await open({directory:true,multiple:false,title:t('选择 GIS 组件包目录')});if(typeof selected!=='string')return;directory=selected;}
    setBusy(item.id);setError('');setProgress('');
    try{await api.gisSkillInstall(item.id,directory);await refresh();await onChanged();}
    catch(e){setError(errorMessage(e));}finally{setBusy(null);setProgress('');}
  }
  return <section className="extension-catalog-section" aria-labelledby="gis-skills-title">
    <div className="extension-catalog-heading"><h3 id="gis-skills-title">{t('GIS 技能')}</h3><p>{t('按需安装，依赖在本机共享，已下载的组件不会重复下载。')}</p></div>
    {error&&<p className="extension-tile-error" role="alert">{localize(error)}</p>}
    <div className="extension-connector-grid">{items.map(item=><article className="extension-tile" key={item.id} aria-busy={busy===item.id}>
      <div className="extension-tile-top"><span className="extension-tile-icon"><PuzzlePiece size={18}/></span><strong>{t(item.name)}</strong><span className={'extension-status'+(item.installed&&item.enabled&&item.ready?' enabled':'')}>{t(item.installed?(item.ready?'已安装':'需要修复'):'未安装')}</span></div>
      <p className="extension-tile-description">{t(item.description)}</p>
      <p className="extension-credential-label">{item.downloadBytes>0?t('需下载 {0} MB',{'0':(item.downloadBytes/1_000_000).toFixed(1)}):t('依赖已缓存')}</p>
      <div className="extension-tile-actions">
        <Button size="sm" variant="outline" disabled={!!busy||!desktopAvailable} onClick={()=>void install(item,false)}>{busy===item.id?<><Loader2 size={15} className="extension-spin"/>{progress||t('正在安装…')}</>:t(item.installed?(item.ready?'重新启用':'修复'):'安装技能')}</Button>
        {!item.installed&&<Button size="sm" variant="ghost" disabled={!!busy||!desktopAvailable} onClick={()=>void install(item,true)}>{t('从本地安装')}</Button>}
      </div>
    </article>)}</div>
  </section>;
}
