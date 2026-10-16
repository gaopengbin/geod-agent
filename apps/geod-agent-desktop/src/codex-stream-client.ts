export interface RunSnapshot<T>{status:string;result?:T|null;error?:{code?:string;message:string}|null;repliedRequestIds?:string[];pendingCallbacks?:StreamEvent[]}
export interface StreamEvent{sequence?:number;runId?:string}
export interface ConnectionStatus{state:'connected'|'reconnecting'|'unavailable';attempt?:number;details?:string}
/** Subscribe/replay only. This controller never starts a second turn or retries a tool. */
export function followNativeRun<T,E extends StreamEvent>(options:{
  runId:string;start?:(receive:(event:E)=>void)=>Promise<T>;reconnect:(after:number,receive:(event:E)=>void)=>Promise<RunSnapshot<T>>;
  onEvent:(event:E)=>void;onConnection:(status:ConnectionStatus)=>void;afterSequence?:number;
  tickMs?:number;silenceMs?:number;recoveryMs?:number;callTimeoutMs?:number;
  signal?:AbortSignal;
}):Promise<T>{
  return new Promise((resolve,reject)=>{
    let done=false,last=options.afterSequence??0,lastActivity=Date.now(),pending=false,firstFailure=0,attempt=0,nextAttempt=0,originalError:unknown,originalResult:T|undefined;
    const buffered=new Map<number,E>();
    const abort=()=>finish(options.signal?.reason??Error('连接已结束'));
    const finish=(error:unknown,value?:T)=>{if(done)return;done=true;clearInterval(timer);options.signal?.removeEventListener('abort',abort);error?reject(error):resolve(value as T);};
    const receive=(event:E)=>{
      if(done||event.runId&&event.runId!==options.runId)return;
      if(event.sequence===undefined){lastActivity=Date.now();options.onEvent(event);return;}
      if(event.sequence<=last)return;
      buffered.set(event.sequence,event);
      while(buffered.has(last+1)){const next=buffered.get(++last)!;buffered.delete(last);lastActivity=Date.now();options.onEvent(next);}
      if(buffered.size)nextAttempt=0;
    };
    const reconnect=async()=>{
      if(done||pending)return;pending=true;attempt++;if(originalResult===undefined)options.onConnection({state:'reconnecting',attempt});
      let timeout:ReturnType<typeof setTimeout>|undefined;
      try{
        const snapshot=await Promise.race([options.reconnect(last,receive),new Promise<never>((_,reject)=>{timeout=setTimeout(()=>reject(Error('连接检查超时')),options.callTimeoutMs??5000);})]);
        if(done)return;
        if(snapshot.result){options.onConnection({state:'connected'});finish(null,snapshot.result);return;}
        if(originalResult!==undefined){options.onConnection({state:'connected'});finish(null,originalResult);return;}
        if(snapshot.error){finish(Object.assign(new Error(snapshot.error.message),{code:snapshot.error.code}));return;}
        if(snapshot.status==='unavailable')throw Error('原执行暂时不可连接，已保存进度和请求记录。');
        for(const event of snapshot.pendingCallbacks??[])receive(event as E);
        firstFailure=0;attempt=0;lastActivity=Date.now();nextAttempt=lastActivity+(options.silenceMs??8000);options.onConnection({state:'connected'});
      }catch(error){
        if(done)return;
        if(originalResult!==undefined){finish(null,originalResult);return;}
        if((error as {code?:string})?.code==='CODEX_RUN_NOT_FOUND'&&originalError){finish(originalError);return;}
        firstFailure||=Date.now();nextAttempt=Date.now()+Math.min(8000,500*2**Math.min(attempt,4));
        options.onConnection({state:'reconnecting',attempt,details:error instanceof Error?error.message:String(error)});
        if(Date.now()-firstFailure>=(options.recoveryMs??60000)){
          options.onConnection({state:'unavailable',details:'原执行状态暂未确认，请重新连接后核对；未重发模型或工具请求。'});
          finish(Object.assign(Error('原执行连接暂未恢复，已保留部分回答和任务状态。'),{code:'CODEX_CONNECTION_UNKNOWN'}));
        }
      }finally{if(timeout)clearTimeout(timeout);pending=false;}
    };
    const timer=setInterval(()=>{if(Date.now()>=nextAttempt&&(buffered.size||Date.now()-lastActivity>=(options.silenceMs??8000)))void reconnect();},options.tickMs??500);
    options.signal?.addEventListener('abort',abort,{once:true});if(options.signal?.aborted){abort();return;}
    if(options.start)Promise.resolve().then(()=>options.start!(receive)).then(value=>{originalResult=value;void reconnect();},error=>{originalError=error;void reconnect();});else void reconnect();
  });
}
