//! Pinned, offline speech inference. Only transcript text enters the Agent context.
use crate::{attachment_inputs::{self,DocumentAttachment}, network, workspace_error, AppError};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::{Deserialize,Serialize};
use serde_json::{json,Value};
use sha2::{Digest,Sha256};
use std::{collections::HashMap, fs, io::{Read,Write}, path::{Path,PathBuf}, process::Stdio,
    sync::{atomic::{AtomicBool,Ordering},Arc,Mutex,OnceLock},time::Duration};
use tauri::{ipc::Channel,AppHandle,Manager};
use tokio::process::Command;
use uuid::Uuid;

const LOCK: &str = include_str!("../../../../vendor/audio/runtime-lock.json");
const MANIFEST: &str = include_str!("../resources/audio/manifest.json");
const MAX_AUDIO_BYTES: usize = 32*1024*1024;
static VERIFIED: OnceLock<PathBuf> = OnceLock::new();
static DOWNLOAD: Mutex<Option<DownloadJob>> = Mutex::new(None);
static TRANSCRIPTIONS: OnceLock<Mutex<HashMap<String,TranscriptionJob>>> = OnceLock::new();
static INFERENCE: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(1);
struct DownloadJob {id:String,cancel:Arc<AtomicBool>,downloaded:u64,total:u64}
struct TranscriptionJob {owner:String,conversation:String,cancel:Arc<AtomicBool>,active:bool,created:std::time::Instant}
fn prune_cancellations(jobs:&mut HashMap<String,TranscriptionJob>){jobs.retain(|_,job|job.active||job.created.elapsed()<Duration::from_secs(600));}
fn start_transcription(jobs:&mut HashMap<String,TranscriptionJob>,owner:&str,conversation:&str,request:&str)->Result<Arc<AtomicBool>,AppError>{
    prune_cancellations(jobs);
    if let Some(job)=jobs.get(request){
        if !job.active&&job.owner==owner&&job.conversation==conversation&&job.cancel.load(Ordering::Relaxed){jobs.remove(request);return Err(error("AUDIO_CANCELLED","音频转写已取消"));}
        return Err(error("AUDIO_BUSY","此音频请求仍在处理"));
    }
    let cancel=Arc::new(AtomicBool::new(false));jobs.insert(request.into(),TranscriptionJob{owner:owner.into(),conversation:conversation.into(),cancel:cancel.clone(),active:true,created:std::time::Instant::now()});Ok(cancel)
}
fn cancel_transcription(jobs:&mut HashMap<String,TranscriptionJob>,owner:&str,conversation:&str,request:&str){
    prune_cancellations(jobs);
    if let Some(job)=jobs.get(request){if job.owner==owner&&job.conversation==conversation{job.cancel.store(true,Ordering::Relaxed);}return;}
    if jobs.values().filter(|job|!job.active).count()>=256{if let Some(oldest)=jobs.iter().filter(|(_,job)|!job.active).min_by_key(|(_,job)|job.created).map(|(id,_)|id.clone()){jobs.remove(&oldest);}}
    jobs.insert(request.into(),TranscriptionJob{owner:owner.into(),conversation:conversation.into(),cancel:Arc::new(AtomicBool::new(true)),active:false,created:std::time::Instant::now()});
}
#[derive(Clone,Deserialize)]
struct Model {id:String,filename:String,bytes:u64,sha256:String}
#[derive(Deserialize)]
#[serde(rename_all="camelCase")]
struct RuntimeLock {model_revision:String,models:Vec<Model>}
#[derive(Default,Deserialize,Serialize)]
#[serde(rename_all="camelCase")]
struct Preferences {model:String,language:String}
fn error(code:&'static str,message:&str)->AppError {workspace_error(code,message)}
fn spec()->Result<RuntimeLock,AppError>{serde_json::from_str(LOCK).map_err(|_|error("AUDIO_RUNTIME_INVALID","音频转写配置无效"))}
fn selected_model(id:&str)->Result<Model,AppError>{spec()?.models.into_iter().find(|item|item.id==id).ok_or_else(||error("AUDIO_MODEL_INVALID","未找到此音频转写模型"))}
fn cache(app:&AppHandle)->Result<PathBuf,AppError>{
    let root=app.path().app_local_data_dir().map_err(|_|error("AUDIO_STORAGE","无法读取转写模型位置"))?.join("audio-models");
    fs::create_dir_all(&root).map_err(|_|error("AUDIO_STORAGE","无法准备转写模型位置"))?;Ok(root)
}
fn preferences(app:&AppHandle)->Result<Preferences,AppError>{
    let path=cache(app)?.join("settings.json");
    if !path.is_file(){return Ok(Preferences{model:"base".into(),language:"auto".into()});}
    if fs::metadata(&path).map_err(|_|error("AUDIO_STORAGE","无法读取转写设置"))?.len()>4096{return Err(error("AUDIO_CONFIG_INVALID","转写设置已损坏"));}
    let result:Preferences=serde_json::from_slice(&fs::read(path).map_err(|_|error("AUDIO_STORAGE","无法读取转写设置"))?).map_err(|_|error("AUDIO_CONFIG_INVALID","转写设置已损坏"))?;
    selected_model(&result.model)?;validate_language(&result.language)?;Ok(result)
}
fn validate_language(language:&str)->Result<(),AppError>{
    if !["auto","zh","en","ja","ko","fr","de","es","ru","it","pt","ar","hi"].contains(&language){return Err(error("AUDIO_LANGUAGE_INVALID","转写语言无效"));}Ok(())
}
fn hash(file:&Path)->Result<String,AppError>{
    let mut source=fs::File::open(file).map_err(|_|error("AUDIO_MODEL_MISSING","请先下载本地转写模型"))?;
    let mut digest=Sha256::new();let mut buffer=[0u8;65536];
    loop{let size=source.read(&mut buffer).map_err(|_|error("AUDIO_MODEL_INVALID","转写文件无法读取"))?;if size==0{break;}digest.update(&buffer[..size]);}Ok(format!("{:x}",digest.finalize()))
}
fn model_file(app:&AppHandle,id:&str)->Result<PathBuf,AppError>{
    let model=selected_model(id)?;let file=cache(app)?.join(&model.filename);
    if !file.is_file(){return Err(error("AUDIO_MODEL_MISSING","请先下载本地转写模型"));}
    if fs::metadata(&file).map_err(|_|error("AUDIO_STORAGE","无法读取转写模型"))?.len()!=model.bytes||hash(&file)?!=model.sha256{return Err(error("AUDIO_MODEL_INVALID","本地转写模型校验失败，请重新下载"));}Ok(file)
}
fn runtime(app:&AppHandle)->Result<PathBuf,AppError>{
    if let Some(root)=VERIFIED.get(){return Ok(root.clone());}
    let mut roots=vec![];
    if cfg!(debug_assertions){roots.push(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources/audio"));}
    if let Ok(root)=app.path().resource_dir(){roots.push(root.join("audio-runtime"));}
    let root=roots.into_iter().find(|root|root.join("manifest.json").is_file()).ok_or_else(||error("AUDIO_RUNTIME_MISSING","内置音频转写环境缺失，请修复应用"))?;
    if fs::read_to_string(root.join("manifest.json")).ok().as_deref()!=Some(MANIFEST){return Err(error("AUDIO_RUNTIME_INVALID","内置转写环境校验失败"));}
    let value:Value=serde_json::from_str(MANIFEST).map_err(|_|error("AUDIO_RUNTIME_INVALID","音频转写清单无效"))?;
    for(name,entry)in value["files"].as_object().ok_or_else(||error("AUDIO_RUNTIME_INVALID","音频转写清单无效"))?{
        if !Path::new(name).components().all(|part|matches!(part,std::path::Component::Normal(_)))||hash(&root.join(name))?!=entry["sha256"].as_str().unwrap_or(""){return Err(error("AUDIO_RUNTIME_INVALID","内置转写文件校验失败"));}
    }
    let _=VERIFIED.set(root.clone());Ok(root)
}
#[tauri::command]
pub(crate) fn audio_settings_get(app:AppHandle)->Result<Value,AppError>{
    let current=preferences(&app)?;let root=cache(&app)?;let lock=spec()?;
    let downloading=DOWNLOAD.lock().map_err(|_|error("AUDIO_BUSY","音频模型正在处理中"))?.as_ref().map(|job|json!({"id":job.id,"downloaded":job.downloaded,"total":job.total}));
    let models:Vec<_>=lock.models.into_iter().map(|model|{let available=fs::metadata(root.join(&model.filename)).is_ok_and(|info|info.len()==model.bytes);json!({"id":model.id,"bytes":model.bytes,"available":available})}).collect();
    Ok(json!({"model":current.model,"language":current.language,"models":models,"downloading":downloading,"engine":"whisper.cpp","engineVersion":"1.9.4","localOnly":true}))
}
#[tauri::command]
pub(crate) async fn audio_settings_set(app:AppHandle,model:String,language:String)->Result<Value,AppError>{
    validate_language(&language)?;
    let verify_app=app.clone();let verify_model=model.clone();
    tauri::async_runtime::spawn_blocking(move||model_file(&verify_app,&verify_model)).await.map_err(|_|error("AUDIO_MODEL_INVALID","转写模型校验失败"))??;
    let root=cache(&app)?;let pending=root.join("settings.pending");
    fs::write(&pending,serde_json::to_vec(&Preferences{model,language}).map_err(|_|error("AUDIO_STORAGE","无法保存转写设置"))?).and_then(|_|fs::rename(&pending,root.join("settings.json"))).map_err(|_|error("AUDIO_STORAGE","无法保存转写设置"))?;
    audio_settings_get(app)
}
struct DownloadGuard {id:String,pending:PathBuf}
impl Drop for DownloadGuard{fn drop(&mut self){let _=fs::remove_file(&self.pending);if let Ok(mut active)=DOWNLOAD.lock(){if active.as_ref().is_some_and(|job|job.id==self.id){*active=None;}}}}
#[tauri::command]
pub(crate) async fn audio_model_download(app:AppHandle,model_id:String,on_progress:Channel<Value>)->Result<Value,AppError>{
    let model=selected_model(&model_id)?;let root=cache(&app)?;let cancel=Arc::new(AtomicBool::new(false));
    {let mut active=DOWNLOAD.lock().map_err(|_|error("AUDIO_BUSY","音频模型正在处理中"))?;if active.is_some(){return Err(error("AUDIO_BUSY","已有转写模型正在下载"));}*active=Some(DownloadJob{id:model_id.clone(),cancel:cancel.clone(),downloaded:0,total:model.bytes});}
    let pending=root.join(format!("{}.pending",model.filename));let _guard=DownloadGuard{id:model_id.clone(),pending:pending.clone()};
    let url=format!("https://huggingface.co/ggerganov/whisper.cpp/resolve/{}/{}",spec()?.model_revision,model.filename);
    let proxy=network::proxy_for(&url).map_err(|_|error("AUDIO_DOWNLOAD_FAILED","无法读取模型下载网络设置"))?;
    let client=network::apply(reqwest::Client::builder().connect_timeout(Duration::from_secs(20)).timeout(Duration::from_secs(900)),proxy.as_deref()).map_err(|_|error("AUDIO_DOWNLOAD_FAILED","模型下载网络设置无效"))?.build().map_err(|_|error("AUDIO_DOWNLOAD_FAILED","无法准备转写模型下载"))?;
    let mut response=client.get(url).send().await.map_err(|_|error("AUDIO_DOWNLOAD_FAILED","转写模型下载失败，请检查网络后重试"))?.error_for_status().map_err(|_|error("AUDIO_DOWNLOAD_FAILED","转写模型下载服务暂不可用"))?;
    let mut file=fs::File::create(&pending).map_err(|_|error("AUDIO_STORAGE","无法保存转写模型"))?;let mut total=0u64;let mut digest=Sha256::new();let mut notified=std::time::Instant::now();
    loop{
        if cancel.load(Ordering::Relaxed){return Err(error("AUDIO_CANCELLED","转写模型下载已取消"));}
        let chunk=tokio::select!{chunk=response.chunk()=>chunk.map_err(|_|error("AUDIO_DOWNLOAD_FAILED","转写模型下载中断，请重试"))?,_=tokio::time::sleep(Duration::from_millis(200))=>{continue;}};
        let Some(chunk)=chunk else{break;};total+=chunk.len()as u64;if total>model.bytes{return Err(error("AUDIO_MODEL_INVALID","下载的转写模型大小异常"));}
        file.write_all(&chunk).map_err(|_|error("AUDIO_STORAGE","无法写入转写模型，请检查磁盘空间"))?;digest.update(&chunk);
        if let Ok(mut active)=DOWNLOAD.lock(){if let Some(job)=active.as_mut(){job.downloaded=total;}}
        if notified.elapsed()>Duration::from_millis(100){let _=on_progress.send(json!({"phase":"downloading","downloaded":total,"total":model.bytes}));notified=std::time::Instant::now();}
    }
    let _=on_progress.send(json!({"phase":"verifying","downloaded":total,"total":model.bytes}));
    if total!=model.bytes||format!("{:x}",digest.finalize())!=model.sha256{return Err(error("AUDIO_MODEL_INVALID","下载的转写模型校验失败，请重试"));}
    file.sync_all().map_err(|_|error("AUDIO_STORAGE","无法保存转写模型"))?;drop(file);
    if cancel.load(Ordering::Relaxed){return Err(error("AUDIO_CANCELLED","转写模型下载已取消"));}
    fs::rename(&pending,root.join(&model.filename)).map_err(|_|error("AUDIO_STORAGE","无法完成转写模型保存"))?;
    let _=on_progress.send(json!({"phase":"complete","downloaded":total,"total":model.bytes}));
    drop(_guard);audio_settings_get(app)
}
#[tauri::command]
pub(crate) fn audio_model_cancel()->Result<(),AppError>{
    if let Some(job)=DOWNLOAD.lock().map_err(|_|error("AUDIO_BUSY","音频模型正在处理中"))?.as_ref(){job.cancel.store(true,Ordering::Relaxed);}Ok(())
}
#[tauri::command]
pub(crate) fn audio_model_remove(app:AppHandle,model_id:String)->Result<Value,AppError>{
    let model=selected_model(&model_id)?;
    if DOWNLOAD.lock().map_err(|_|error("AUDIO_BUSY","音频模型正在处理中"))?.is_some()||TRANSCRIPTIONS.get().is_some_and(|jobs|jobs.lock().map(|jobs|jobs.values().any(|job|job.active)).unwrap_or(true)){return Err(error("AUDIO_BUSY","请等当前转写或下载结束后再删除模型"));}
    let file=cache(&app)?.join(model.filename);if file.exists(){fs::remove_file(file).map_err(|_|error("AUDIO_STORAGE","无法删除此转写模型"))?;}audio_settings_get(app)
}
fn wav_duration(bytes:&[u8])->Result<f64,AppError>{
    let invalid=||error("AUDIO_INVALID","音频数据无效，请重新添加文件");
    if bytes.len()<46||&bytes[..4]!=b"RIFF"||&bytes[8..12]!=b"WAVE"||&bytes[12..16]!=b"fmt "||&bytes[36..40]!=b"data"{return Err(invalid());}
    let u16_at=|offset|u16::from_le_bytes(bytes[offset..offset+2].try_into().unwrap());let u32_at=|offset|u32::from_le_bytes(bytes[offset..offset+4].try_into().unwrap());
    if u32_at(4)as usize!=bytes.len()-8||u32_at(16)!=16||u16_at(20)!=1||u16_at(22)!=1||u32_at(24)!=16000||u32_at(28)!=32000||u16_at(32)!=2||u16_at(34)!=16||u32_at(40)as usize!=bytes.len()-44||(bytes.len()-44)%2!=0{return Err(invalid());}
    let duration=(bytes.len()-44)as f64/32000.;if duration>600.{return Err(error("AUDIO_DURATION_LIMIT","单个音频最长 10 分钟，请拆分后添加"));}Ok(duration)
}
struct TranscriptionGuard {request:String,folder:PathBuf}
impl Drop for TranscriptionGuard{fn drop(&mut self){if let Some(jobs)=TRANSCRIPTIONS.get(){if let Ok(mut jobs)=jobs.lock(){jobs.remove(&self.request);}}for name in ["input.wav","output.txt"]{let _=fs::remove_file(self.folder.join(name));}let _=fs::remove_dir(&self.folder);}}
#[tauri::command]
pub(crate) fn audio_transcription_cancel(app:AppHandle,conversation_id:String,request_id:String)->Result<(),AppError>{
    let owner=crate::services::current_user_id(&app.state::<crate::services::ServiceState>()).map_err(|cause|error(cause.code,&cause.message))?;
    Uuid::parse_str(&conversation_id).and_then(|_|Uuid::parse_str(&request_id)).map_err(|_|error("AUDIO_INVALID","音频请求标识无效"))?;
    let mut jobs=TRANSCRIPTIONS.get_or_init(||Mutex::new(HashMap::new())).lock().map_err(|_|error("AUDIO_BUSY","音频正在转写"))?;
    cancel_transcription(&mut jobs,&owner,&conversation_id,&request_id);Ok(())
}
#[tauri::command]
pub(crate) async fn audio_attachment_add(app:AppHandle,conversation_id:String,request_id:String,name:String,base64:String,wav_base64:String)->Result<DocumentAttachment,AppError>{
    let owner=crate::services::current_user_id(&app.state::<crate::services::ServiceState>()).map_err(|cause|error(cause.code,&cause.message))?;
    Uuid::parse_str(&conversation_id).and_then(|_|Uuid::parse_str(&request_id)).map_err(|_|error("AUDIO_INVALID","音频请求标识无效"))?;
    let extension=name.rsplit_once('.').map(|(_,ext)|ext.to_ascii_lowercase()).unwrap_or_default();
    if !["wav","mp3","m4a","ogg","flac","webm","aac","opus"].contains(&extension.as_str()){return Err(error("AUDIO_FORMAT","请选择 WAV、MP3、M4A、OGG、FLAC 或 WebM 音频"));}
    if base64.len()>MAX_AUDIO_BYTES*4/3+8||wav_base64.len()>MAX_AUDIO_BYTES*4/3+8{return Err(error("AUDIO_LIMIT","单个音频不能超过 32 MB"));}
    let original=STANDARD.decode(base64).map_err(|_|error("AUDIO_INVALID","音频附件数据无效"))?;let wav=STANDARD.decode(wav_base64).map_err(|_|error("AUDIO_INVALID","转写音频数据无效"))?;
    if original.is_empty()||original.len()>MAX_AUDIO_BYTES{return Err(error("AUDIO_LIMIT","音频为空或超过 32 MB"));}let duration=wav_duration(&wav)?;
    let cancel={let mut jobs=TRANSCRIPTIONS.get_or_init(||Mutex::new(HashMap::new())).lock().map_err(|_|error("AUDIO_BUSY","音频正在转写"))?;start_transcription(&mut jobs,&owner,&conversation_id,&request_id)?};
    let folder=cache(&app)?.join(format!("transcribe-{request_id}"));let guard=TranscriptionGuard{request:request_id,folder:folder.clone()};
    fs::create_dir(&folder).map_err(|_|error("AUDIO_STORAGE","无法准备本机音频转写"))?;
    let result=async{
        let preferences=preferences(&app)?;let verify_app=app.clone();let selected=preferences.model.clone();
        let (runtime,model)=tauri::async_runtime::spawn_blocking(move||Ok::<_,AppError>((runtime(&verify_app)?,model_file(&verify_app,&selected)?))).await.map_err(|_|error("AUDIO_RUNTIME_INVALID","无法验证本机转写环境"))??;
        let permit=loop{if cancel.load(Ordering::Relaxed){return Err(error("AUDIO_CANCELLED","音频转写已取消"));}tokio::select!{permit=INFERENCE.acquire()=>break permit.map_err(|_|error("AUDIO_BUSY","音频转写环境正在关闭"))?,_=tokio::time::sleep(Duration::from_millis(100))=>continue}};
        fs::write(folder.join("input.wav"),wav).map_err(|_|error("AUDIO_STORAGE","无法保存本机转写音频"))?;
        let mut command=Command::new(runtime.join("whisper-cli.exe"));
        command.arg("-m").arg(model).arg("-f").arg(folder.join("input.wav")).arg("-l").arg(preferences.language)
            .args(["-ng","-t","4","-np","-nt","-otxt","-of"]).arg(folder.join("output")).env_clear().current_dir(runtime)
            .stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).kill_on_drop(true);
        for key in ["SYSTEMROOT","WINDIR","TEMP","TMP"]{if let Some(value)=std::env::var_os(key){command.env(key,value);}}
        #[cfg(windows)]command.creation_flags(0x0800_0000);
        let mut child=command.spawn().map_err(|_|error("AUDIO_RUNTIME_MISSING","无法启动内置音频转写环境"))?;
        let timeout=tokio::time::sleep(Duration::from_secs(900));tokio::pin!(timeout);
        let status=loop{if cancel.load(Ordering::Relaxed){let _=child.kill().await;return Err(error("AUDIO_CANCELLED","音频转写已取消"));}tokio::select!{status=child.wait()=>break status.map_err(|_|error("AUDIO_TRANSCRIPTION_FAILED","本机音频转写中断，请重试"))?,_=&mut timeout=>{let _=child.kill().await;return Err(error("AUDIO_TIMEOUT","音频转写超时，请拆分后添加"));},_=tokio::time::sleep(Duration::from_millis(100))=>continue}};
        drop(permit);
        let text_file=folder.join("output.txt");
        if !status.success()||fs::metadata(&text_file).map_or(true,|info|info.len()>1024*1024){return Err(error("AUDIO_TRANSCRIPTION_FAILED","音频转写失败，请检查文件后重试"));}
        let text=fs::read_to_string(text_file).map_err(|_|error("AUDIO_TRANSCRIPTION_FAILED","无法读取音频转写结果"))?;
        if cancel.load(Ordering::Relaxed){return Err(error("AUDIO_CANCELLED","音频转写已取消"));}
        attachment_inputs::save_transcript(&app,&owner,conversation_id,name,original,text.trim().to_owned(),duration.ceil()as usize)
    }.await;
    drop(guard);result
}

#[cfg(test)]
mod tests{
    use super::{wav_duration,start_transcription,cancel_transcription};
    use std::{collections::HashMap,sync::atomic::Ordering};
    fn wav(samples:usize)->Vec<u8>{let size=44+samples*2;let mut bytes=vec![0;size];bytes[..4].copy_from_slice(b"RIFF");bytes[4..8].copy_from_slice(&((size-8)as u32).to_le_bytes());bytes[8..16].copy_from_slice(b"WAVEfmt ");bytes[16..20].copy_from_slice(&16u32.to_le_bytes());bytes[20..22].copy_from_slice(&1u16.to_le_bytes());bytes[22..24].copy_from_slice(&1u16.to_le_bytes());bytes[24..28].copy_from_slice(&16000u32.to_le_bytes());bytes[28..32].copy_from_slice(&32000u32.to_le_bytes());bytes[32..34].copy_from_slice(&2u16.to_le_bytes());bytes[34..36].copy_from_slice(&16u16.to_le_bytes());bytes[36..40].copy_from_slice(b"data");bytes[40..44].copy_from_slice(&((samples*2)as u32).to_le_bytes());bytes}
    #[test]fn validates_pcm_and_duration_before_starting_native_decoder(){let mut value=wav(16000);assert_eq!(wav_duration(&value).unwrap(),1.);value[24]=0;assert_eq!(wav_duration(&value).unwrap_err().code,"AUDIO_INVALID");assert_eq!(wav_duration(&wav(16000*600+1)).unwrap_err().code,"AUDIO_DURATION_LIMIT");assert!(wav_duration(&[]).is_err());}
    #[test]fn cancellation_before_ipc_start_and_other_conversation_are_distinct(){let mut jobs=HashMap::new();cancel_transcription(&mut jobs,"owner","one","request");assert_eq!(start_transcription(&mut jobs,"owner","one","request").unwrap_err().code,"AUDIO_CANCELLED");let cancel=start_transcription(&mut jobs,"owner","one","active").unwrap();cancel_transcription(&mut jobs,"owner","two","active");assert!(!cancel.load(Ordering::Relaxed));cancel_transcription(&mut jobs,"other-owner","one","active");assert!(!cancel.load(Ordering::Relaxed));cancel_transcription(&mut jobs,"owner","one","active");assert!(cancel.load(Ordering::Relaxed));}
}
