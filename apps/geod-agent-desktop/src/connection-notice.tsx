import {useId,useState} from 'react';
import {AnimatePresence,motion,useReducedMotion} from 'motion/react';
import {ChevronDown,RefreshCw} from './icons';
import {Button} from './components/motion/button/base';
import {ConversationDisclosure} from './conversation-disclosure';
import {t} from './i18n';
import type {DisplayMessage} from './pending-generations';
export function ConnectionNotice({item}:{item:DisplayMessage}){
  const state=item.connection!;const [open,setOpen]=useState(false);const id=useId();const reduce=useReducedMotion()??false;
  return <div className="agent-connection-notice" role="status"><Button variant="ghost" size="sm" className="agent-connection-trigger" disabled={!state.details} aria-expanded={open} aria-controls={id} onClick={()=>setOpen(!open)}>
    <RefreshCw size={14} className={state.state==='reconnecting'?'is-reconnecting':''}/><span>{t(state.state==='reconnecting'?'正在重新连接':'连接暂不可用')}</span>
    {state.attempt!==undefined&&<span className="agent-reconnect-count"><AnimatePresence initial={false} mode="popLayout"><motion.span key={state.attempt} initial={{y:reduce?0:10,opacity:0}} animate={{y:0,opacity:1}} exit={{y:reduce?0:-10,opacity:0}} transition={{duration:reduce?0:.16}}>{state.attempt}</motion.span></AnimatePresence>{state.maxAttempts!==undefined?`/${state.maxAttempts}`:''}</span>}
    {!!state.details&&<ChevronDown size={13} className={open?'is-open':''}/>}</Button>
    <ConversationDisclosure open={open} id={id} className="agent-connection-details"><p>{state.details}</p></ConversationDisclosure>
  </div>;
}
