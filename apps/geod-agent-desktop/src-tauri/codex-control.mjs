/** One interrupt RPC per Core turn, including stop during turn/start and late repeats. */
export function createTurnInterrupt({getRun,cancel,rpc}) {
  return async function interrupt() {
    const active=getRun();if(!active||active.completed)return;
    if(!active.interrupt){active.interrupt=true;cancel();}
    if(!active.turnId)return;
    if(!active.interruptRequest)active.interruptRequest=rpc('turn/interrupt',{threadId:active.threadId,turnId:active.turnId}).catch(error=>{
      // Core can finish between observing the turn and processing its stop RPC.
      if(!/^no active turn to interrupt[.!]?$/i.test(String(error.message)))throw error;
    });
    return active.interruptRequest;
  };
}
