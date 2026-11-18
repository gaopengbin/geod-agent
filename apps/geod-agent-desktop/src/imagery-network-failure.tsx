import {useState} from 'react';
import {api,errorMessage,type StoredPlan,type JobEvent} from './api';
import {t} from './i18n';
import {Button} from '@/components/motion/button/base';
import {Loader2} from './icons';

const networkMessages={
 timeout:'等待图源响应超时。',
 tls:'与图源建立安全连接失败。',
 dns:'无法解析图源域名。',
 proxy:'连接图源时代理失败。',
 connect:'无法建立到图源或代理的连接。',
 response_body:'读取图源返回的瓦片时连接中断。',
 request:'图源请求中断，具体连接原因未知。',
} as const;

/** Probe the task's actual source and extent without a model call or another job. */
export function ImageryNetworkFailure({stored,onOpenNetwork,failure}:{stored:StoredPlan;onOpenNetwork?:()=>void;failure?:JobEvent}){
 const rejected=['SOURCE_UNAUTHORIZED','SOURCE_CREDENTIAL_REJECTED','TILE_ACCESS_DENIED'].includes(failure?.errorCode??'');
 const limited=failure?.errorCode==='SOURCE_RATE_LIMITED';
 const diagnostic=failure?.failureDiagnostic;
 const access=diagnostic?.kind==='sourceAccess'?diagnostic:null;
 const network=diagnostic?.kind==='network'?diagnostic.cause:null;
 const [checking,setChecking]=useState(false),[result,setResult]=useState('');
 async function check(){
  if(checking)return;
  const grid=stored.plan.tileGrids[0];if(!grid)return;
  const failedIndex = failure?.diagnostic?.failed_source ?? 0;
  const spec = stored.plan.spec;
  const sourceId = access?.sourceId || (failedIndex > 0 ? spec.exportOptions?.overlaySources?.[failedIndex - 1]?.sourceId : spec.sourceId);
  if (!sourceId) {
   setResult(t('无法识别失败的图层，请查看原任务的图源设置。'));
   return;
  }
  setChecking(true);setResult('');
  let timer:ReturnType<typeof setTimeout>;
  try{
   await Promise.race([api.mapPreviewTile(sourceId,null,grid.zoom,Math.floor((grid.xMin+grid.xMax)/2),Math.floor((grid.yMin+grid.yMax)/2)),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject({code:'SOURCE_NETWORK'}),30_000);})]);
   setResult(rejected?t('单张瓦片连接测试通过；批量下载还需核对接口权限及访问限制。'):t('该任务范围内的影像瓦片连接测试通过，可以尝试重试下载。'));
  }catch(cause){setResult(t('图源连接测试失败：{0}',{'0':errorMessage(cause)}));}
  finally{clearTimeout(timer!);setChecking(false);}
 }
 return <section className="task-network-failure" aria-label={t('图源网络故障')}>
  <p role="alert">{limited?t('图源限制了下载频率（HTTP 429）。'):rejected?t('图源拒绝了下载请求。'):t(network?networkMessages[network]: '未能连接到影像图源（SOURCE_NETWORK）。')}{access&&` HTTP ${access.httpStatus} · ${access.host}`}</p>
  <p>{limited?t('请等待图源恢复后重试此任务。已有缓存会按原任务参数复用。'):rejected?t('请核对下载接口地址、对应服务授权和网络出口。在线预览与批量下载的请求条件可能不同；现有任务和缓存已保留。'):t('已创建任务的下载不消耗 AI Credits。请检查图源服务或网络代理，再重试下载。')}</p>
  {!limited&&<div className="task-actions"><Button size="sm" variant="secondary" disabled={checking} onClick={()=>void check()}>{checking&&<Loader2 size={14} className="animate-spin"/>}{checking?t('检测中…'):t('检测图源连接')}</Button>{onOpenNetwork&&<Button size="sm" variant="ghost" onClick={onOpenNetwork}>{t('网络与代理')}</Button>}</div>}
  {result&&<p role="status">{result}</p>}
 </section>;
}
