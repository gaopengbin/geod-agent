import {useState} from 'react';
import {api,errorMessage,type StoredPlan} from './api';
import {t} from './i18n';
import {Button} from '@/components/motion/button/base';
import {Loader2} from './icons';

/** Probe the task's actual source and extent without a model call or another job. */
export function ImageryNetworkFailure({stored,onOpenNetwork}:{stored:StoredPlan;onOpenNetwork?:()=>void}){
 const [checking,setChecking]=useState(false),[result,setResult]=useState('');
 async function check(){
  if(checking)return;
  const grid=stored.plan.tileGrids[0];if(!grid)return;
  setChecking(true);setResult('');
  let timer:ReturnType<typeof setTimeout>;
  try{
   await Promise.race([api.mapPreviewTile(stored.plan.spec.sourceId,null,grid.zoom,Math.floor((grid.xMin+grid.xMax)/2),Math.floor((grid.yMin+grid.yMax)/2)),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject({code:'SOURCE_NETWORK'}),30_000);})]);
   setResult(t('该任务范围内的影像瓦片连接测试通过，可以尝试重试下载。'));
  }catch(cause){setResult(t('图源连接测试失败：{0}',{'0':errorMessage(cause)}));}
  finally{clearTimeout(timer!);setChecking(false);}
 }
 return <section className="task-network-failure" aria-label={t('图源网络故障')}>
  <p role="alert">{t('未能连接到影像图源（SOURCE_NETWORK）。')}</p>
  <p>{t('已创建任务的下载不消耗 AI Credits。请检查图源服务或网络代理，再重试下载。')}</p>
  <div className="task-actions"><Button size="sm" variant="secondary" disabled={checking} onClick={()=>void check()}>{checking&&<Loader2 size={14} className="animate-spin"/>}{checking?t('检测中…'):t('检测图源连接')}</Button>{onOpenNetwork&&<Button size="sm" variant="ghost" onClick={onOpenNetwork}>{t('网络与代理')}</Button>}</div>
  {result&&<p role="status">{result}</p>}
 </section>;
}
