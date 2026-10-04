// Protocol parsing only. HTTP and credentials remain in the native process.
import {createInterface} from 'node:readline';
import {generateProvider} from './provider-adapter.mjs';

const lines=createInterface({input:process.stdin});
const emit=value=>process.stdout.write(JSON.stringify(value)+'\n');
let resolveHeaders,rejectHeaders,started=false,ended=false,failure=null,wake;
const queue=[];
const body={async *[Symbol.asyncIterator](){
  while(true){
    if(queue.length){const value=queue.shift();emit({type:'ack'});yield value;continue;}
    if(failure)throw new Error('Native transport failed');
    if(ended)return;
    await new Promise(resolve=>{wake=resolve;});
  }
}};
lines.on('line',line=>{
  let value;try{value=JSON.parse(line);}catch{process.exitCode=1;lines.close();return;}
  if(value.type==='headers')resolveHeaders?.({ok:value.status>=200&&value.status<300,status:value.status,headers:new Headers({'content-type':value.contentType??''}),body});
  if(value.type==='chunk'){queue.push(Buffer.from(value.data,'base64'));wake?.();wake=null;}
  if(value.type==='end'){ended=true;wake?.();wake=null;}
  if(value.type==='error'){failure=true;rejectHeaders?.(new Error('Native transport failed'));wake?.();wake=null;}
  if(value.type!=='start'||started)return;
  started=true;
  void generateProvider(value.snapshot,'native-managed',value.request,{
    generationId:value.generationId,
    fetchImpl:async(_url,options)=>{
      // The native owner validates and chooses the destination; no URL or key
      // returned by a subprocess is used to authorize an upstream request.
      const headers=new Promise((resolve,reject)=>{resolveHeaders=resolve;rejectHeaders=reject;});
      emit({type:'http',body:JSON.parse(options.body)});
      return headers;
    },
    onDelta:(part,text)=>emit({type:'delta',part,text}),
    onWire:(event,data)=>emit({type:'wire',event,data}),
  }).then(generation=>emit({type:'result',generation}),error=>emit({type:'failed',code:error.code??'PROVIDER_UNAVAILABLE',status:error.status??null})).finally(()=>{lines.close();process.stdin.destroy();});
});
lines.on('close',()=>{ended=true;wake?.();rejectHeaders?.(new Error('Native transport ended'));});
