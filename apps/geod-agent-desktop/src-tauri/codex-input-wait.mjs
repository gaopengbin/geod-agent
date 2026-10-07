/** User response time is unbounded; executable work still has a deadline. */
export function inputWaitDeadline(timeout,expire,{setTimer=setTimeout,clearTimer=clearTimeout}={}){
 let timer,closed=false,paused=false;
 const arm=()=>{if(timeout>0&&!closed&&!paused)timer=setTimer(()=>{closed=true;expire();},timeout);};
 arm();
 return {pause(waiting){if(closed)return;clearTimer(timer);timer=undefined;paused=waiting;if(!waiting)arm();},close(){closed=true;clearTimer(timer);}};
}
