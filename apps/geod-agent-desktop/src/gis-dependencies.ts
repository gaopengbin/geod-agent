export interface GisRequirement {id:string;reason:string;requireTools:boolean}
export function gisRequirement(name:string,args:Record<string,unknown>,onFailure=false):GisRequirement|null {
  if(name==='plan_imagery'||name==='plan_imagery_batch'){
    const crs=(args.exportOptions as {targetCrs?:string}|undefined)?.targetCrs;
    return onFailure||crs&&crs!=='EPSG:3857'?{id:'gis-raster-convert',reason:'按已选坐标系导出影像',requireTools:false}:null;
  }
  if(name==='data_download_plan'&&args.kind!=='tiles3d'){
    return args.kind==='online'||onFailure||args.targetCrs&&args.targetCrs!=='EPSG:4326'?{id:'gis-vector-convert',reason:'读取并导出矢量数据',requireTools:false}:null;
  }
  if(onFailure&&name==='data_input_read')return{id:'gis-import',reason:'读取当前数据范围',requireTools:false};
  return null;
}

export function missingGisDependency(value:unknown,depth=0):boolean {
  if(depth>6)return false;
  if(typeof value==='string'){
    if(/^GIS_(SKILL_NOT_INSTALLED|COMPONENT_INVALID)$/.test(value))return true;
    if(value.trim().startsWith('{')){try{return missingGisDependency(JSON.parse(value),depth+1);}catch{/* Plain text is not an installation instruction. */}}
    return false;
  }
  if(!value||typeof value!=='object')return false;
  if(Array.isArray(value))return value.some(item=>missingGisDependency(item,depth+1));
  const v=value as Record<string,unknown>;
  return ['GIS_SKILL_NOT_INSTALLED','GIS_COMPONENT_INVALID'].includes(String(v.code))||[v.error,v.errors,v.result,v.cause].some(item=>missingGisDependency(item,depth+1));
}

export class GisDependencyGate {
  private active=false;
  async ensure<T extends {ready:boolean}>(prepare:()=>Promise<T>,ask:(offer:T)=>Promise<boolean>):Promise<'ready'|'cancelled'|'pending'> {
    if(this.active)return 'pending';
    this.active=true;
    try {const offer=await prepare();return offer.ready||await ask(offer)?'ready':'cancelled';}
    finally{this.active=false;}
  }
}
