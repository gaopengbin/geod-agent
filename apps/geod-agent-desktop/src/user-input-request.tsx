import {Button} from '@/components/motion/button/base';
import {CheckCircle2,ChevronDown,CircleAlert} from './icons';
import {t} from './i18n';
import {UserInputQuestionCard} from './user-input-card';
import type {UserInputDraft,UserInputRecord} from './user-input-records';
import {useState} from 'react';
import {errorMessage} from './app-error';
export function UserInputRequest({record,open,onOpen,onReply,onDraft,disabled=false}:{record:UserInputRecord;open:boolean;onOpen:(open:boolean)=>void;onReply:(value:unknown)=>Promise<void>;onDraft:(value:UserInputDraft)=>void;disabled?:boolean}){
 const pending=record.status==='pending';
 const planCrs=record.status==='resolved'&&record.resolution?.kind==='existingPlanCrs'?record.resolution:null;
 const [continuing,setContinuing]=useState(false),[resumeError,setResumeError]=useState('');
 async function continueRevision(){if(continuing)return;setContinuing(true);setResumeError('');try{await onReply({continueRevision:true});}catch(cause){setResumeError(errorMessage(cause));}finally{setContinuing(false);}}
 return <section className={'user-input-request'+(pending?' pending':'')} aria-label={t('会话问答')}>
  <Button variant="ghost" size="sm" pressScale={1} className="user-input-request-trigger" aria-expanded={open} onClick={()=>onOpen(!open)}>
   {pending?<CircleAlert size={16}/>:<CheckCircle2 size={16}/>}<span><strong>{record.questions.map(q=>q.header).join(' · ')}</strong><small>{t(pending?'待回答，点击打开':record.status==='answered'?'已回答，查看选择':planCrs?'已沿用原任务坐标系':record.status==='resolved'?'已有本机配置，无需回答':'已取消')}</small></span><ChevronDown size={15} className={open?'is-open':''}/>
  </Button>
  {open&&(pending?<div aria-disabled={disabled}>{disabled?<p className="user-input-deferred-note">{t('请等当前回复结束后，再回答这张历史问答卡。')}</p>:<UserInputQuestionCard questions={record.questions} draft={record.draft} onDraftChange={onDraft} respond={onReply}/>}</div>:planCrs?<div className="user-input-deferred-note"><p>{t('仅调整原任务的层级，沿用原计划的坐标系；没有设为会话默认。')}</p><strong>{planCrs.crs}</strong><p>{t('重复询问已结束，继续后重新生成调整计划，下载仍需确认。')}</p><Button variant="outline" size="sm" disabled={disabled||continuing} onClick={()=>void continueRevision()}>{t('继续调整计划')}</Button>{resumeError&&<p role="alert">{resumeError}</p>}</div>:record.status==='resolved'?<div className="user-input-deferred-note"><p>{t('已找到本机保存的连接器，复用其地址和认证配置；无需再次选择地址。')}</p>{record.resolution?.kind==='existingMcp'&&<><strong>{record.resolution.name}</strong><p>{record.resolution.url}</p></>}</div>:<dl className="user-input-answer-list">{record.questions.map(q=><div key={q.id}><dt>{q.question}</dt><dd>{record.reply?.answers[q.id]?.answers[0]??t('未回答')}</dd></div>)}</dl>)}
 </section>;
}
