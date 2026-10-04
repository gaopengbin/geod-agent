import { t } from "./i18n";
// i18n: presentation strings migrated
import {useEffect,useState} from "react";
import {api,errorMessage,type ImageAttachment} from "./api";
import {Button} from "@/components/motion/button/base";
import {X} from "./icons";
import "./image-attachments.css";
export const imageAccept="image/png,image/jpeg,image/webp,image/gif";
export function imageFiles(files:File[],conversationId:string):Promise<ImageAttachment[]>{
  if(files.length>8)return Promise.reject(new Error("每轮最多附加 8 张图片"));
  return files.reduce<Promise<ImageAttachment[]>>(async(previous,file)=>{
    const uploaded=await previous;
    if(file.size>10*1024*1024)throw new Error("单张图片不能超过 10 MB");
    const base64=await new Promise<string>((resolve,reject)=>{const reader=new FileReader();reader.onerror=()=>reject(new Error("无法读取图片"));reader.onload=()=>resolve(String(reader.result).split(',')[1]);reader.readAsDataURL(file);});
    return [...uploaded,await api.imageAttachmentAdd(conversationId,file.name,base64)];
  },Promise.resolve([]));
}
function Thumbnail({image,onRemove}:{image:ImageAttachment;onRemove?:()=>void}){
  const [source,setSource]=useState("");const [error,setError]=useState("");
  useEffect(()=>{let active=true;void api.imageAttachmentPreview(image.conversationId,image.id).then(value=>{if(active)setSource(value);}).catch(cause=>{if(active)setError(errorMessage(cause));});return()=>{active=false;};},[image.conversationId,image.id]);
  return <figure className="chat-image-thumbnail" title={error||`${image.name} · ${image.width} × ${image.height}`}>
    {source?<img src={source} alt={image.name}/>:<span>{error?t("预览不可用"):t("读取图片…")}</span>}
    <figcaption>{image.name}</figcaption>
    {onRemove&&<Button variant="secondary" size="icon" aria-label={t("移除图片 {0}", {"0": image.name})} onClick={onRemove} whileHover={undefined}><X size={13}/></Button>}
  </figure>;
}
export function ImageAttachments({images,onRemove}:{images:ImageAttachment[];onRemove?:(id:string)=>void}){
  if(!images.length)return null;
  return <div className="chat-image-attachments" aria-label={t("图片附件")}>{images.map(image=><Thumbnail key={image.id} image={image} onRemove={onRemove?()=>onRemove(image.id):undefined}/>)}</div>;
}
