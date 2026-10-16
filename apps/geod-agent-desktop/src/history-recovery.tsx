import {useEffect,useState} from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import {open} from '@tauri-apps/plugin-dialog';
import {Button} from '@/components/motion/button/base';
import {ScrollArea} from '@/components/ui/scroll-area';
import {api} from './api';
import {CircleAlert,CheckCircle2,Copy,FolderOpen,Loader2,RefreshCw,X} from './icons';
import {errorMessage} from './app-error';
import {t} from './i18n';
import type {HistoryInspection,HistoryRestoreReport,PlanRecoveryProblem} from './plan-reference-recovery';
import './history-recovery.css';

export function HistoryRecovery({conversationId,planIds,expectedDirectory,problem,onRecheck,onTasks}:{
  conversationId:string;planIds:string[];expectedDirectory?:string;problem:PlanRecoveryProblem|null;
  onRecheck:()=>Promise<PlanRecoveryProblem|null>;onTasks:()=>void;
}){
  const [opened,setOpened]=useState(false),[inspection,setInspection]=useState<HistoryInspection|null>(null);
  const [working,setWorking]=useState(false),[error,setError]=useState(''),[message,setMessage]=useState(''),[copied,setCopied]=useState(false);
  const [restored,setRestored]=useState<HistoryRestoreReport|null>(null);
  const idsKey=JSON.stringify(planIds);
  useEffect(()=>{
    if(!opened)return;let cancelled=false;setWorking(true);setError('');
    void api.imageryHistoryInspect(conversationId,JSON.parse(idsKey)).then(value=>{if(!cancelled)setInspection(value);})
      .catch(cause=>{if(!cancelled)setError(errorMessage(cause));}).finally(()=>{if(!cancelled)setWorking(false);});
    return()=>{cancelled=true;};
  },[opened,conversationId,idsKey]);
  const needsWorkspace=!!inspection&&(!inspection.workspaceBound||!inspection.workspaceAvailable);
  const directory=inspection?.workspaceDirectory||expectedDirectory;
  async function act(work:()=>Promise<void>){if(working)return;setWorking(true);setError('');setMessage('');setCopied(false);try{await work();}catch(cause){const code=(cause as {code?:string})?.code;setError(code==='WORKSPACE_INVALID'?t('未找到原文件夹，请连接原磁盘，或选择原来的文件夹。'):code==='WORKSPACE_IMMUTABLE'?t('所选文件夹与原工作区不同。请恢复原文件夹的位置；此会话的任务归属保持原样。'):errorMessage(cause));}finally{setWorking(false);}}
  async function check(){const remaining=await onRecheck();setInspection(await api.imageryHistoryInspect(conversationId,planIds));setMessage(remaining?t('检查已完成，仍有记录需要处理。'):t('任务记录已重新关联，可查看原任务和成果。'));}
  async function restoreWorkspace(select=false){
    const chosen=select?await open({directory:true,multiple:false,title:t('选择此历史会话的原工作区'),defaultPath:directory||undefined}):directory;
    if(typeof chosen!=='string')return;
    await api.workspaceSet(conversationId,chosen,'confirmEach');await check();
  }
  async function restoreRecords(){
    const result=await api.imageryHistoryRestore(conversationId,inspection?.recoverablePlanIds??[]);
    setRestored(result);
    await check();
    if(result.rejected?.length)setError(t('部分备份未通过恢复检查，原记录没有覆盖。请复制诊断信息以便进一步处理。'));
    else if(!result.restored.length)setMessage(t('没有需要补回的任务记录，请查看重新检查的结果。'));
  }
  async function copyDiagnostics(){
    const diagnostics={kind:'geod-history-recovery',conversationId,planIds,expectedDirectory,problem,inspection,restored};
    await navigator.clipboard.writeText(JSON.stringify(diagnostics,null,2));setCopied(true);
  }
  const blocked=problem?.codes.includes('PLAN_NOT_OWNED');
  const wrongWorkspace=problem?.codes.includes('WORKSPACE_DENIED');
  const storageProblem=problem?.codes.some(code=>code==='STORAGE_ERROR'||code==='HISTORY_RECOVERY');
  return <Dialog.Root open={opened} onOpenChange={next=>{if(!working)setOpened(next);}}>
    {problem&&<div className="history-recovery-notice" role="status"><CircleAlert size={16}/><span>{problem.count?t('{0} 项历史任务暂时不可用',{'0':problem.count}):t('此会话的工作区需要检查')}</span><Dialog.Trigger asChild><Button variant="ghost" size="sm">{t('检查并恢复')}</Button></Dialog.Trigger></div>}
    <Dialog.Portal>
      <Dialog.Overlay className="dialog-backdrop"/>
      <Dialog.Content className="dialog history-recovery-dialog">
        <div className="dialog-head"><div><Dialog.Title>{t('恢复历史任务')}</Dialog.Title><Dialog.Description>{t('检查工作区和本机备份，重新关联已有记录。恢复记录不会重新下载，也不会调用 AI。')}</Dialog.Description></div><Dialog.Close asChild><Button variant="ghost" size="icon" disabled={working} aria-label={t('关闭恢复窗口')}><X size={18}/></Button></Dialog.Close></div>
        <ScrollArea className="history-recovery-scroll"><div className="dialog-body">
          {working&&<p className="history-recovery-progress" role="status"><Loader2 size={16} className="animate-spin"/>{t('正在检查本机记录…')}</p>}
          {inspection&&<>
            {inspection.dataDirectoryRedirected&&<section className="history-recovery-section"><h3>{t('当前运行环境使用了另一处数据目录')}</h3><p>{t('请关闭此窗口，从 GeoD Agent 的安装目录直接启动应用，再打开原会话检查。原数据可能仍在原目录中。')}</p></section>}
            <section className="history-recovery-section"><h3>{needsWorkspace?t('先恢复原工作区'):t('原工作区可访问')}</h3>
              {directory?<code className="history-recovery-path">{directory}</code>:<p>{t('此会话没有保存工作区路径，请选择原来保存成果的文件夹。')}</p>}
              {needsWorkspace?<><p>{t('重新连接原磁盘或选择原文件夹后，可检查任务归属。恢复关联后使用“每次确认”，不会自动授权下载。')}</p><div className="history-recovery-actions">{directory&&<Button size="sm" disabled={working} onClick={()=>void act(()=>restoreWorkspace())}>{t('恢复原工作区')}</Button>}<Button variant="outline" size="sm" disabled={working} onClick={()=>void act(()=>restoreWorkspace(true))}>{t('选择原文件夹')}</Button></div></>:<Button variant="outline" size="sm" disabled={working} onClick={()=>void act(()=>api.workspaceOpenDirectory(conversationId))}><FolderOpen size={15}/>{t('打开原成果文件夹')}</Button>}
            </section>
            {problem&&!needsWorkspace&&<section className="history-recovery-section"><h3>{blocked?t('部分任务属于其他账号或会话'):wrongWorkspace?t('部分任务不属于当前工作区'):storageProblem?t('本机任务记录暂时无法读取'):inspection.recoverablePlanIds.length?t('本机备份中找到了任务记录'):t('当前未找到可恢复的匹配备份')}</h3>
              <p>{blocked?t('请切换到创建这些任务的账号和原会话查看。恢复操作不能改变任务归属。'):wrongWorkspace?t('请回到任务创建时的会话和原工作区查看，不能将它重新绑定到其他文件夹。'):storageProblem?t('请检查磁盘空间和文件夹访问权限，然后重新检查。复制诊断信息可帮助定位具体原因。'):inspection.recoverablePlanIds.length?t('仅补回缺失的计划、任务和进度记录；先保存当前账本快照，已有记录和成果文件保持原样。'):t('暂时无法补回缺失记录，不代表成果文件已删除。可先打开原成果文件夹；如仍需找回记录，复制诊断信息以便定位原数据或备份。')}</p>
              {!!inspection.recoverablePlanIds.length&&<Button size="sm" disabled={working||needsWorkspace||inspection.dataDirectoryRedirected} onClick={()=>void act(restoreRecords)}>{t('从本机备份恢复 {0} 项',{'0':inspection.recoverablePlanIds.length})}</Button>}
            </section>}
            {!problem&&<p className="history-recovery-success" role="status"><CheckCircle2 size={17}/>{t('已有任务已重新关联。')}</p>}
            {restored?.restored.length?<p>{t('恢复的是备份中的任务记录；成果完整性可在任务面板中核验。')}</p>:null}
            <details className="history-recovery-details"><summary>{t('查看诊断信息')}</summary><dl><dt>{t('当前数据文件')}</dt><dd>{inspection.actualDatabasePath}</dd><dt>{t('待检查的历史引用')}</dt><dd>{planIds.length}</dd><dt>{t('问题类型')}</dt><dd>{problem?.codes.join(', ')||t('无')}</dd>{restored?.snapshotPath&&<><dt>{t('恢复前快照')}</dt><dd>{restored.snapshotPath}</dd></>}</dl></details>
          </>}
          {error&&<p role="alert" className="form-error">{error}</p>}
          {message&&<p role="status">{message}</p>}
        </div></ScrollArea>
        <div className="dialog-actions history-recovery-footer"><Button variant="ghost" size="sm" disabled={working} onClick={()=>void act(copyDiagnostics)}><Copy size={15}/>{t(copied?'已复制诊断信息':'复制诊断信息')}</Button><div><Button variant="outline" size="sm" disabled={working} onClick={()=>void act(check)}><RefreshCw size={15}/>{t('重新检查')}</Button>{!problem&&<Button size="sm" disabled={working} onClick={()=>{setOpened(false);onTasks();}}>{t('查看已恢复任务')}</Button>}</div></div>
      </Dialog.Content>
    </Dialog.Portal></Dialog.Root>;
}
