import {Button} from '@/components/motion/button/base';
import {Download,Loader2,PuzzlePiece} from './icons';
import type {GisInstallProgress} from './api';
import type {GisInstallRequest} from './gis-install-flow';
import {t,localize} from './i18n';

export function gisInstallPhase(phase?:GisInstallProgress['phase']) {
  return t(phase==='downloading'?'正在下载组件…':phase==='verifying'?'正在核验组件…':phase==='installing'?'正在安装组件…':phase==='ready'?'安装完成':'正在检查组件…');
}
export function GisInstallCard({request,onInstall,onCancel}:{request:GisInstallRequest;onInstall:()=>void;onCancel:()=>void}) {
  const {offer,progress,busy,error}=request;
  const downloading=progress?.phase==='downloading'&&progress.total>0;
  const percent=downloading?Math.min(100,Math.round(progress.bytes/progress.total*100)):undefined;
  return <section className="gis-install-card" aria-label={t('安装所需技能')} aria-busy={busy}>
    <header><PuzzlePiece size={18}/><strong>{t('需要安装 {0}',{'0':t(offer.name)})}</strong><span>{t('GeoD 官方组件')}</span></header>
    <p>{t(request.reason)}{t('，安装后继续本次操作。')}</p>
    <div className="gis-install-size"><span>{offer.downloadBytes>0?t('需下载 {0} MB',{'0':(offer.downloadBytes/1_000_000).toFixed(1)}):t('依赖已缓存')}</span><span>{t('安装体积 {0} MB',{'0':(offer.installedBytes/1_000_000).toFixed(1)})}</span></div>
    {busy&&<div className="gis-install-status" role="status" aria-live="polite">
      <div><Loader2 size={14} className="extension-spin"/><span>{gisInstallPhase(progress?.phase)}</span>{downloading&&<span>{(progress.bytes/1_000_000).toFixed(1)} / {(progress.total/1_000_000).toFixed(1)} MB</span>}</div>
      <div className={'gis-install-meter'+(downloading?'':' indeterminate')} role="progressbar" aria-label={gisInstallPhase(progress?.phase)} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}><i style={downloading?{width:`${percent}%`}:undefined}/></div>
    </div>}
    {error&&<p className="gis-install-error" role="alert">{localize(error)}</p>}
    <footer><Button size="sm" pressScale={1} disabled={busy} onClick={onInstall}><Download size={15}/>{t(error?'重试安装':'下载安装并继续')}</Button><Button size="sm" variant="ghost" pressScale={1} onClick={onCancel}>{t(busy?'取消安装':'暂不安装')}</Button></footer>
  </section>;
}
