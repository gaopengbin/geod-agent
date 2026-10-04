import {useEffect,useState} from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import * as Select from '@radix-ui/react-select';
import {Button} from '@/components/motion/button/base';
import {AudioLines,Check,ChevronDown,Download,Loader2,Trash,X} from './icons';
import {api,errorMessage,type AudioSettings,type AudioDownloadProgress,type DocumentAttachment} from './api';
import {t,localize,getLocale} from './i18n';
import './audio-attachments.css';

export const audioAccept='.wav,.mp3,.m4a,.ogg,.flac,.webm,.aac,.opus';
export function pcmWave(samples:Float32Array):Uint8Array{
  const result=new Uint8Array(44+samples.length*2),view=new DataView(result.buffer);
  const label=(offset:number,text:string)=>{for(let n=0;n<text.length;n++)result[offset+n]=text.charCodeAt(n);};
  label(0,'RIFF');view.setUint32(4,result.length-8,true);label(8,'WAVE');label(12,'fmt ');view.setUint32(16,16,true);view.setUint16(20,1,true);view.setUint16(22,1,true);view.setUint32(24,16000,true);view.setUint32(28,32000,true);view.setUint16(32,2,true);view.setUint16(34,16,true);label(36,'data');view.setUint32(40,samples.length*2,true);
  samples.forEach((sample,index)=>{const value=Math.max(-1,Math.min(1,Number.isFinite(sample)?sample:0));view.setInt16(44+index*2,Math.round(value*(value<0?32768:32767)),true);});return result;
}
const encoded=(file:Blob)=>new Promise<string>((resolve,reject)=>{const reader=new FileReader();reader.onerror=()=>reject(new Error('无法读取音频文件'));reader.onload=()=>resolve(String(reader.result).split(',')[1]);reader.readAsDataURL(file);});
export async function decodeAudioFile(file:File):Promise<Uint8Array>{
  if(!file.size||file.size>32*1024*1024)throw new Error('音频为空或超过 32 MB');
  const context=new AudioContext();let audio:AudioBuffer;
  try{audio=await context.decodeAudioData(await file.arrayBuffer());}catch{throw new Error('无法解码此音频，请转为 WAV、MP3 或 FLAC 后再添加');}finally{await context.close();}
  if(!Number.isFinite(audio.duration)||audio.duration<=0)throw new Error('音频文件没有可读取的内容');
  if(audio.duration>600)throw new Error('单个音频最长 10 分钟，请拆分后添加');
  const offline=new OfflineAudioContext(1,Math.ceil(audio.duration*16000),16000),source=offline.createBufferSource();source.buffer=audio;source.connect(offline.destination);source.start();
  return pcmWave((await offline.startRendering()).getChannelData(0));
}
export async function audioFiles(files:File[],conversationId:string,onRequest:(id:string)=>void,cancelled:()=>boolean,onAttachment?:(file:DocumentAttachment)=>void):Promise<DocumentAttachment[]>{
  const attachments:DocumentAttachment[]=[];
  try{for(const file of files){if(cancelled())throw new Error('音频转写已取消');const wave=await decodeAudioFile(file);if(cancelled())throw new Error('音频转写已取消');const id=crypto.randomUUID();onRequest(id);
    const original=await encoded(file),normalized=await encoded(new Blob([wave.buffer as ArrayBuffer],{type:'audio/wav'}));if(cancelled())throw new Error('音频转写已取消');
    const attached=await api.audioAttachmentAdd(conversationId,id,file.name,original,normalized);if(cancelled()){await api.documentAttachmentDiscard(conversationId,attached.id);throw new Error('音频转写已取消');}attachments.push(attached);onAttachment?.(attached);
  }return attachments;}finally{onRequest('');}
}
function Choice({id,label,value,options,onChange,disabled}:{id:string;label:string;value:string;options:{value:string;label:string}[];onChange:(value:string)=>void;disabled?:boolean}){
  return <div className="field"><span className="field-label" id={id}>{label}</span><Select.Root value={value} onValueChange={onChange} disabled={disabled}><Select.Trigger className="select-trigger" aria-labelledby={id}><Select.Value/><Select.Icon><ChevronDown size={15}/></Select.Icon></Select.Trigger><Select.Portal><Select.Content className="select-content" position="popper" sideOffset={6} collisionPadding={8}><Select.Viewport>{options.map(option=><Select.Item className="select-item" value={option.value} key={option.value}><Select.ItemText>{option.label}</Select.ItemText><Select.ItemIndicator className="select-item-indicator"><Check size={14}/></Select.ItemIndicator></Select.Item>)}</Select.Viewport></Select.Content></Select.Portal></Select.Root></div>;
}
const size=(bytes:number)=>`${Math.ceil(bytes/1048576).toLocaleString(getLocale())} MB`;
export function AudioSetupDialog({onClose,onReady,hasFiles=false}:{onClose:()=>void;onReady:()=>void;hasFiles?:boolean}){
  const[settings,setSettings]=useState<AudioSettings|null>(null),[model,setModel]=useState('base'),[language,setLanguage]=useState('auto'),[busy,setBusy]=useState(false),[error,setError]=useState(''),[progress,setProgress]=useState<AudioDownloadProgress|null>(null);
  useEffect(()=>{let disposed=false;void api.audioSettings().then(value=>{if(disposed)return;setSettings(value);setModel(value.model);setLanguage(value.language);}).catch(cause=>{if(!disposed)setError(errorMessage(cause));});return()=>{disposed=true;};},[]);
  useEffect(()=>{if(!settings?.downloading)return;let disposed=false;const timer=window.setInterval(()=>{void api.audioSettings().then(value=>{if(!disposed)setSettings(value);}).catch(()=>{});},700);return()=>{disposed=true;window.clearInterval(timer);};},[Boolean(settings?.downloading)]);
  const current=settings?.models.find(item=>item.id===model),downloading=Boolean(settings?.downloading)||busy&&progress!==null,percent=progress?Math.min(100,Math.round(progress.downloaded/progress.total*100)):settings?.downloading?Math.min(100,Math.round(settings.downloading.downloaded/settings.downloading.total*100)):null;
  const run=async(action:()=>Promise<void>)=>{if(busy)return;setBusy(true);setError('');try{await action();}catch(cause){setError(errorMessage(cause));}finally{setBusy(false);setProgress(null);setSettings(await api.audioSettings().catch(()=>null));}};
  return <Dialog.Root open onOpenChange={open=>{if(!open)onClose();}}><Dialog.Portal><Dialog.Overlay className="dialog-backdrop"/><Dialog.Content className="dialog audio-setup-dialog">
    <div className="dialog-head"><div><Dialog.Title>{t('本机音频转写')}</Dialog.Title><Dialog.Description>{t('先在此设备转成文字，再将转写内容交给 AI。')}</Dialog.Description></div><Button variant="ghost" size="icon" aria-label={t('关闭音频设置')} onClick={onClose}><X size={18}/></Button></div>
    <div className="dialog-body">
      {!settings?<p role="status">{error?localize(error):t('正在读取转写设置…')}</p>:<>
        <Choice id="audio-model-label" label={t('转写模型')} value={model} disabled={busy||Boolean(settings.downloading)} onChange={setModel} options={settings.models.map(item=>({value:item.id,label:`${t(item.id==='base'?'标准模型':'轻量模型')} · ${size(item.bytes)}`}))}/>
        <p className="audio-model-description">{t('模型下载后可离线使用。标准模型识别更稳，轻量模型占用更少。')}</p>
        <Choice id="audio-language-label" label={t('音频语言')} value={language} disabled={busy} onChange={setLanguage} options={[{value:'auto',label:t('自动识别')},{value:'zh',label:t('中文')},{value:'en',label:'English'},{value:'ja',label:'日本語'},{value:'ko',label:'한국어'},{value:'fr',label:'Français'},{value:'de',label:'Deutsch'},{value:'es',label:'Español'},{value:'ru',label:'Русский'},{value:'it',label:'Italiano'},{value:'pt',label:'Português'},{value:'ar',label:'العربية'},{value:'hi',label:'हिन्दी'}]}/>
        <div className="audio-model-state" role="status"><AudioLines size={18}/><div><strong>{downloading?t('正在准备转写模型…'):current?.available?t('模型已下载'):t('首次使用需要下载模型')}</strong><small>{t('音频文件保存在此设备，不会上传给转写服务。')}</small>{percent!==null&&<><div className="desktop-update-progress" role="progressbar" aria-label={t('转写模型下载进度')} aria-valuenow={percent} aria-valuemin={0} aria-valuemax={100}><span style={{width:`${percent}%`}}/></div><small>{progress?.phase==='verifying'?t('正在验证模型…'):`${percent}%`}</small></>}</div></div>
        <p className="audio-transcript-notice">{t('机器转写可能有误字，可在发送前查看和修改。')}</p>
        {error&&<p role="alert" className="form-error">{localize(error)}</p>}
      </>}
    </div>
    <div className="dialog-actions">
      {downloading?<Button variant="outline" onClick={()=>void api.audioModelCancel().catch(cause=>setError(errorMessage(cause)))}>{t('取消下载')}</Button>:current?.available?<Button variant="ghost" size="sm" disabled={busy} onClick={()=>void run(async()=>setSettings(await api.audioModelRemove(model)))}><Trash size={14}/>{t('删除模型')}</Button>:null}
      {current?.available?<Button disabled={busy||Boolean(settings?.downloading)} onClick={()=>void run(async()=>{await api.audioSettingsSet(model,language);onReady();})}>{busy&&<Loader2 size={15} className="animate-spin"/>}{hasFiles?t('保存并继续'):t('完成')}</Button>:<Button disabled={!settings||busy||Boolean(settings.downloading)} onClick={()=>void run(async()=>{setProgress({phase:'downloading',downloaded:0,total:current?.bytes??1});setSettings(await api.audioModelDownload(model,setProgress));})}>{busy?<Loader2 size={15} className="animate-spin"/>:<Download size={15}/>} {t('下载模型')}</Button>}
    </div>
  </Dialog.Content></Dialog.Portal></Dialog.Root>;
}
export function AudioTranscriptDialog({conversationId,file,onClose,onSaved}:{conversationId:string;file:DocumentAttachment;onClose:()=>void;onSaved:(file:DocumentAttachment)=>void}){
  const[text,setText]=useState(''),[initial,setInitial]=useState<string|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false);
  useEffect(()=>{let disposed=false;void api.audioAttachmentDraft(conversationId,file.id).then(value=>{if(!disposed){setText(value.text);setInitial(value.text);}}).catch(cause=>{if(!disposed)setError(errorMessage(cause));});return()=>{disposed=true;};},[conversationId,file.id]);
  const save=async()=>{setBusy(true);setError('');try{if(text!==initial)onSaved(await api.audioAttachmentEdit(conversationId,file.id,text));onClose();}catch(cause){setError(errorMessage(cause));}finally{setBusy(false);}};
  return <Dialog.Root open onOpenChange={open=>{if(!open&&!busy)onClose();}}><Dialog.Portal><Dialog.Overlay className="dialog-backdrop"/><Dialog.Content className="dialog audio-transcript-dialog"><div className="dialog-head"><div><Dialog.Title>{t('转写内容')}</Dialog.Title><Dialog.Description>{file.name}</Dialog.Description></div><Button variant="ghost" size="icon" disabled={busy} aria-label={t('关闭转写内容')} onClick={onClose}><X size={18}/></Button></div><div className="dialog-body"><p className="audio-transcript-notice">{t('检查地名、数字和术语，修改会用于本次发送；原音频保持不变。')}</p><textarea aria-label={t('音频转写内容')} value={text} disabled={initial===null||busy} onChange={event=>setText(event.target.value)} spellCheck={false} maxLength={1000000}/>{error&&<p className="form-error" role="alert">{localize(error)}</p>}</div><div className="dialog-actions"><Button variant="outline" disabled={busy} onClick={onClose}>{t('取消')}</Button><Button disabled={initial===null||busy} onClick={()=>void save()}>{busy&&<Loader2 size={15} className="animate-spin"/>}{t('保存转写')}</Button></div></Dialog.Content></Dialog.Portal></Dialog.Root>;
}
