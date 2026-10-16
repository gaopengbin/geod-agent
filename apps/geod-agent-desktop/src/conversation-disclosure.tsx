import {AnimatePresence,motion,useReducedMotion} from 'motion/react';
import type {ReactNode} from 'react';
export function ConversationDisclosure({open,id,className,children}:{open:boolean;id:string;className?:string;children:ReactNode}){
  const reduce=useReducedMotion()??false;
  return <AnimatePresence initial={false}>{open&&<motion.div id={id} className={className} initial={{height:0,opacity:0}} animate={{height:'auto',opacity:1}} exit={{height:0,opacity:0}} transition={reduce?{duration:0}:{duration:.18,ease:'easeOut'}} style={{overflow:'hidden'}}>{children}</motion.div>}</AnimatePresence>;
}
