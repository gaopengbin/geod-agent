// Keep the controller's loopback identity server responsive while native RPC
// waits for that same server. A synchronous child would deadlock token renewal.
import {spawn} from 'node:child_process';

export function runJsonProcess(command,args,input,{timeoutMs=65000,maxBytes=16*1024*1024}={}){
  return new Promise((resolve,reject)=>{
    const child=spawn(command,args,{windowsHide:true,stdio:['pipe','pipe','pipe']});
    const stdout=[],stderr=[];let bytes=0,failure;
    const timer=setTimeout(()=>{failure=Error('Native RPC helper timed out');child.kill();},timeoutMs);
    function collect(target,chunk){
      bytes+=chunk.length;
      if(bytes>maxBytes){failure=Error('Native RPC helper output exceeded its limit');child.kill();}
      else target.push(chunk);
    }
    child.stdout.on('data',chunk=>collect(stdout,chunk));
    child.stderr.on('data',chunk=>collect(stderr,chunk));
    child.stdin.on('error',error=>{failure??=error;});
    child.on('error',error=>{clearTimeout(timer);reject(error);});
    child.on('close',code=>{
      clearTimeout(timer);
      if(failure)return reject(failure);
      if(code!==0)return reject(Error('Native RPC helper failed: '+Buffer.concat(stderr).toString('utf8')));
      try{resolve(JSON.parse(Buffer.concat(stdout).toString('utf8')));}catch(error){reject(error);}
    });
    child.stdin.end(JSON.stringify(input));
  });
}
