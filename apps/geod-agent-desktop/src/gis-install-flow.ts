import type {GisInstallOffer,GisInstallProgress} from './api';
export interface GisInstallRequest {
  requestId:string; offer:GisInstallOffer; reason:string;
  busy:boolean; error?:string; progress?:GisInstallProgress;
}
export interface GisInstallAdapter {
  install:(id:string,requestId:string)=>Promise<unknown>;
  cancel:(requestId:string)=>Promise<unknown>;
  subscribe:(progress:(value:GisInstallProgress)=>void)=>Promise<()=>void>;
  change:(request:GisInstallRequest|null)=>void;
  installed:(offer:GisInstallOffer)=>void;
  failure:(cause:unknown)=>void;
  errorMessage:(cause:unknown)=>string;
}
/** Keeps the original tool suspended; changing visible chats never loses its installer. */
export class GisInstallFlow {
  private request:GisInstallRequest|null=null;
  private resolve:((accepted:boolean)=>void)|null=null;
  private readonly adapter:GisInstallAdapter;
  constructor(adapter:GisInstallAdapter){this.adapter=adapter;}
  ask(offer:GisInstallOffer,reason:string):Promise<boolean> {
    if(this.request)throw new Error('GIS installation already pending');
    return new Promise(resolve=>{
      this.resolve=resolve;
      this.update({requestId:crypto.randomUUID(),offer,reason,busy:false});
    });
  }
  private update(request:GisInstallRequest|null){this.request=request;this.adapter.change(request);}
  private finish(accepted:boolean){const resolve=this.resolve;this.resolve=null;this.update(null);resolve?.(accepted);}
  cancel(){
    const request=this.request;if(!request)return;
    this.finish(false);
    if(request.busy)void this.adapter.cancel(request.requestId).catch(this.adapter.failure);
  }
  async install(){
    const request=this.request;if(!request||request.busy)return;
    this.update({...request,busy:true,error:undefined,progress:undefined});
    let release:(()=>void)|undefined;
    try{
      release=await this.adapter.subscribe(progress=>{
        if(progress.requestId!==request.requestId||progress.featureId!==request.offer.id||this.request?.requestId!==request.requestId)return;
        this.update({...this.request,progress});
      });
      // A stop during listener registration must not initiate a native download.
      if(this.request?.requestId!==request.requestId)return;
      await this.adapter.install(request.offer.id,request.requestId);
      if(this.request?.requestId!==request.requestId)return;
      this.adapter.installed(request.offer);this.finish(true);
    }catch(cause){
      if(this.request?.requestId===request.requestId)this.update({...request,busy:false,error:this.adapter.errorMessage(cause)});
    }finally{release?.();}
  }
}
