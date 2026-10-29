import type {JobEvent}from './api';
import {t}from './i18n';
import {displayPath}from './path-display';
import {Button}from '@/components/motion/button/base';
const gb=(n:number)=>`${(n/1e9).toFixed(2)} GB`;
export function ImageryDiskFailure({event,onManageCache}:{event?:JobEvent;onManageCache?:()=>void}){
 const diagnostic=event?.failureDiagnostic;
 const report=diagnostic?.kind==='storage'?diagnostic.report:null;
 return <section className="task-network-failure" aria-label={t('存储空间检查')}>
  <p role="alert">{t('存储空间检查未通过，已下载瓦片保留。')}</p>
  {report&&<p>{t('以下为失败时的空间检查结果，重试会重新检查。')}</p>}
  {report?report.volumes.map((volume,i)=><div key={i}>
   <strong>{volume.locations.map(l=>t(l.role==='cache'?'瓦片缓存目录':'保存及导出临时目录')).join(' + ')} · {t(volume.sufficient?'通过':'空间不足')}</strong>
   <dl className="task-detail-list"><div><dt>{t('保守空间预算')}</dt><dd>{gb(volume.requiredBytes)}</dd></div><div><dt>{t('实际可用空间')}</dt><dd>{gb(volume.availableBytes)}</dd></div></dl>
   {volume.locations.map(l=><p className="task-full-path" key={l.path}>{displayPath(l.path)}</p>)}
  </div>):<p>{t('历史记录没有保留失败时的磁盘明细。请同时检查保存目录和缓存目录，不能只看保存盘的可用空间。')}</p>}
  <p>{t('缓存和成果可能在不同磁盘。调整不足的目录后，可重试原任务，无需重新规划。')}</p>
  {onManageCache&&<Button size="sm" variant="secondary" onClick={onManageCache}>{t('管理缓存位置')}</Button>}
 </section>;
}
