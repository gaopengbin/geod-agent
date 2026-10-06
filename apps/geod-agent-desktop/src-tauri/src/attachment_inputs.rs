//! Conversation-scoped local documents, referenced by IDs rather than private paths.
use crate::{services, workspace_error, AppError};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{fs, path::{Component,Path,PathBuf}, process::Stdio, sync::OnceLock, time::Duration};
use tauri::{AppHandle, Manager};
use tokio::io::AsyncWriteExt;
use uuid::Uuid;

const MAX_BYTES: usize = 32 * 1024 * 1024;
const MAX_TEXT_BYTES: u64 = 8 * 1024 * 1024;
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DocumentAttachment {
    pub id: String,
    pub conversation_id: String,
    pub name: String,
    pub extension: String,
    pub kind: String,
    pub bytes: usize,
    pub sha256: String,
    pub text_sha256: String,
    pub characters: usize,
    pub units: usize,
    pub unit_label: String,
    pub excerpt: String,
    pub truncated: bool,
    pub warnings: Vec<String>,
    #[serde(default,skip_serializing_if="Option::is_none")]
    pub transcript_edited: Option<bool>,
    #[serde(default,skip_serializing_if="Option::is_none")]
    pub ocr_pages: Option<Vec<usize>>,
    #[serde(default,skip_serializing_if="Option::is_none")]
    pub ocr_engine: Option<String>,
}
#[derive(Clone, Serialize, Deserialize)]
struct Record { attachment: DocumentAttachment, published: bool }
fn err(code: &'static str, message: &str) -> AppError { workspace_error(code, message) }
fn owner(app: &AppHandle) -> Result<String, AppError> {
    services::current_user_id(&app.state::<services::ServiceState>()).map_err(|e|err(e.code,&e.message))
}
fn folder(app: &AppHandle, owner: &str, conversation: &str) -> Result<PathBuf, AppError> {
    Uuid::parse_str(conversation).map_err(|_|err("ATTACHMENT_INPUT", "附件对话标识无效"))?;
    let root = app.path().app_data_dir().map_err(|_|err("ATTACHMENT_STORAGE", "无法读取附件保存位置"))?
        .join("chat-attachments").join(format!("{:x}",Sha256::digest(format!("{owner}:{conversation}")))[..32].to_string());
    fs::create_dir_all(&root).map_err(|_|err("ATTACHMENT_STORAGE", "无法准备附件保存位置"))?;
    Ok(root)
}
fn record(app: &AppHandle, owner: &str, conversation: &str, id: &str) -> Result<(PathBuf, Record), AppError> {
    Uuid::parse_str(id).map_err(|_|err("ATTACHMENT_NOT_FOUND", "未找到此文档附件"))?;
    let root = folder(app,owner,conversation)?;
    let path = root.join(format!("{id}.json"));
    if fs::metadata(&path).map_err(|_|err("ATTACHMENT_NOT_FOUND", "文档附件已丢失"))?.len()>64*1024 {
        return Err(err("ATTACHMENT_INVALID", "附件记录已损坏"));
    }
    let mut value: Record = serde_json::from_slice(&fs::read(path).map_err(|_|err("ATTACHMENT_NOT_FOUND", "文档附件已丢失"))?)
        .map_err(|_|err("ATTACHMENT_INVALID", "附件记录已损坏"))?;
    if value.attachment.kind=="audio"{
        let edited=value.attachment.warnings.iter().any(|warning|warning=="TRANSCRIPTION_EDITED");
        value.attachment.transcript_edited.get_or_insert(edited);
        value.attachment.warnings.retain(|warning|warning!="MACHINE_TRANSCRIPTION"&&warning!="TRANSCRIPTION_EDITED");
    }
    if value.attachment.id != id || value.attachment.conversation_id != conversation {
        return Err(err("ATTACHMENT_NOT_FOUND", "未找到当前对话的文档附件"));
    }
    Ok((root,value))
}
fn save_record(root: &std::path::Path, value: &Record) -> Result<(), AppError> {
    let destination=root.join(format!("{}.json",value.attachment.id));
    let pending=root.join(format!("{}.{}.pending",value.attachment.id,Uuid::new_v4()));
    fs::write(&pending,serde_json::to_vec(value).map_err(|_|err("ATTACHMENT_STORAGE", "无法保存附件记录"))?)
        .and_then(|_|fs::rename(&pending,destination)).map_err(|_|{let _=fs::remove_file(pending);err("ATTACHMENT_STORAGE", "无法保存附件记录")})
}
pub(crate) fn parser_root(app: &AppHandle) -> Result<PathBuf, AppError> {
    static VERIFIED:OnceLock<PathBuf>=OnceLock::new();
    const MANIFEST:&str=include_str!("../resources/documents/manifest.json");
    if let Some(root)=VERIFIED.get(){return Ok(root.clone());}
    let mut roots=vec![];
    // Development reads the prepared source resources, including hot parser updates.
    if cfg!(debug_assertions){roots.push(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources/documents"));}
    if let Ok(root)=app.path().resource_dir(){roots.push(root.join("document-runtime"));}
    if let Some(root)=std::env::current_exe().ok().and_then(|path|path.parent().map(|p|p.to_owned())){roots.push(root.join("document-runtime"));}
    let root=roots.into_iter().find(|root|root.join("manifest.json").is_file()&&root.join("pypdf/__init__.py").is_file())
        .ok_or_else(||err("ATTACHMENT_RUNTIME", "内置文档解析环境缺失，请修复应用"))?;
    let invalid=||err("ATTACHMENT_RUNTIME","内置文档解析环境校验失败，请修复应用");
    if fs::read(root.join("manifest.json")).map_err(|_|invalid())?!=MANIFEST.as_bytes(){return Err(invalid());}
    let manifest:Value=serde_json::from_str(MANIFEST).map_err(|_|invalid())?;
    let files=manifest["files"].as_object().filter(|files|!files.is_empty()).ok_or_else(invalid)?;
    for(name,expected)in files{
        if Path::new(name).components().any(|part|!matches!(part,Component::Normal(_))){return Err(invalid());}
        let bytes=fs::read(root.join(name)).map_err(|_|invalid())?;
        if expected.as_str()!=Some(format!("{:x}",Sha256::digest(bytes)).as_str()){return Err(invalid());}
    }
    let _=VERIFIED.set(root.clone());Ok(root)
}
fn parse_error(code: &str) -> AppError {
    match code {
        "ATTACHMENT_FORMAT"=>err("ATTACHMENT_FORMAT", "支持 PDF、Office、文本和扫描图片"),
        "ATTACHMENT_TEXT_ENCODING"=>err("ATTACHMENT_TEXT_ENCODING", "不支持文档声明的文本编码，请另存为 UTF-8 后添加"),
        "ATTACHMENT_OFFICE_RUNTIME"=>err("ATTACHMENT_OFFICE_RUNTIME", "内置 Office 解析环境缺失，请修复应用"),
        "ATTACHMENT_OCR_RUNTIME"=>err("ATTACHMENT_OCR_RUNTIME", "内置扫描识别环境缺失，请修复应用"),
        "ATTACHMENT_PASSWORD_REQUIRED"=>err("ATTACHMENT_PASSWORD_REQUIRED", "请输入文档密码以继续读取"),
        "ATTACHMENT_PASSWORD_INCORRECT"=>err("ATTACHMENT_PASSWORD_INCORRECT", "文档密码不正确，请重试"),
        "ATTACHMENT_PASSWORD_INPUT"=>err("ATTACHMENT_PASSWORD_INPUT", "文档密码格式无效"),
        "ATTACHMENT_PASSWORD_UNSUPPORTED"=>err("ATTACHMENT_PASSWORD_UNSUPPORTED", "此文档的加密方式暂不支持"),
        "ATTACHMENT_CONTENT_LIMIT"=>err("ATTACHMENT_CONTENT_LIMIT", "文档内容超过本机解析容量，请拆分后添加"),
        _=>err("ATTACHMENT_DOCUMENT_INVALID", "文档内容已损坏或无法识别"),
    }
}
#[tauri::command]
pub(crate) async fn document_attachment_add(app: AppHandle, conversation_id: String, name: String, base64: String, password: Option<String>) -> Result<DocumentAttachment,AppError> {
    if password.as_ref().is_some_and(|value|value.len()>4096){return Err(parse_error("ATTACHMENT_PASSWORD_INPUT"));}
    let owner=owner(&app)?;let root=folder(&app,&owner,&conversation_id)?;
    let name=name.chars().filter(|c|!c.is_control()&&!matches!(c,'/'|'\\')).take(160).collect::<String>();
    let extension=name.rsplit_once('.').map(|(_,ext)|ext.to_ascii_lowercase()).unwrap_or_default();
    if !["pdf","doc","xls","ppt","docx","xlsx","pptx","txt","md","csv","json","xml","log","png","jpg","jpeg","webp","bmp","tif","tiff"].contains(&extension.as_str()){return Err(parse_error("ATTACHMENT_FORMAT"));}
    if base64.len()>MAX_BYTES*4/3+8{return Err(err("ATTACHMENT_LIMIT", "单个文档不能超过 32 MB"));}
    let bytes=STANDARD.decode(base64).map_err(|_|err("ATTACHMENT_INPUT", "文档附件数据无效"))?;
    if bytes.is_empty()||bytes.len()>MAX_BYTES{return Err(err("ATTACHMENT_LIMIT", "文档为空或超过 32 MB"));}
    let id=Uuid::new_v4().to_string();let file=root.join(format!("{id}.attachment"));
    let metadata=(bytes.len(),format!("{:x}",Sha256::digest(&bytes)));
    let parser=parser_root(&app)?;
    let scans=matches!(extension.as_str(),"pdf"|"png"|"jpg"|"jpeg"|"webp"|"bmp"|"tif"|"tiff");
    let ocr=if scans{let handle=app.clone();Some(tauri::async_runtime::spawn_blocking(move||crate::ocr_runtime::root(&handle)).await.map_err(|_|parse_error("ATTACHMENT_OCR_RUNTIME"))??)}else{None};
    let legacy=matches!(extension.as_str(),"doc"|"xls"|"ppt");
    let office=if legacy{let handle=app.clone();Some(tauri::async_runtime::spawn_blocking(move||crate::legacy_office_runtime::root(&handle)).await.map_err(|_|parse_error("ATTACHMENT_OFFICE_RUNTIME"))??)}else{None};
    fs::write(&file,bytes).map_err(|_|err("ATTACHMENT_STORAGE", "无法保存文档附件"))?;
    let parsed=async {
        let temporary=if legacy{Some(tempfile::tempdir().map_err(|_|err("ATTACHMENT_STORAGE","无法准备文档解析位置"))?)}else{None};
        let mut command=if let Some(root)=office{
            let mut command=crate::legacy_office_runtime::command(&root,temporary.as_ref().unwrap().path());
            #[cfg(debug_assertions)]eprintln!("Office reader resource path: {}",root.display());
            command.arg(crate::legacy_office_runtime::java_path(&file)).arg(&extension);command
        }else{
            let mut command=crate::python_runtime::command(include_str!("attachment_worker.py"))?;
            command.arg(&file).arg(&extension).arg(parser);if let Some(root)=ocr{command.arg(root);}command
        };
        command.arg("--password-stdin").stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(if legacy{Stdio::piped()}else{Stdio::null()}).kill_on_drop(true);
        // Passwords stay in this local pipe; never use argv, environment or a file.
        let request=serde_json::to_vec(&json!({"password":password})).map_err(|_|parse_error("ATTACHMENT_PASSWORD_INPUT"))?;
        let output=tokio::time::timeout(Duration::from_secs(if scans{180}else{60}),async{
            let mut child=command.spawn()?;
            if let Some(mut input)=child.stdin.take(){input.write_all(&request).await?;}
            child.wait_with_output().await
        }).await
            .map_err(|_|err("ATTACHMENT_TIMEOUT", "文档解析超时，请拆分后添加"))?
            .map_err(|_|err("ATTACHMENT_RUNTIME", "无法启动内置文档解析环境"))?;
        if output.stdout.len()>MAX_TEXT_BYTES as usize{return Err(parse_error("ATTACHMENT_CONTENT_LIMIT"));}
        let value:Value=serde_json::from_slice(&output.stdout).map_err(|_|{
            if legacy{
                #[cfg(debug_assertions)]eprintln!("Office reader process failure: {:?}; {}",output.status,String::from_utf8_lossy(&output.stderr));
                err("ATTACHMENT_OFFICE_RUNTIME","内置 Office 解析环境启动失败，请修复应用")
            }else{parse_error("ATTACHMENT_DOCUMENT_INVALID")}
        })?;
        if !output.status.success()||value["ok"]!=true{return Err(parse_error(value["error"].as_str().unwrap_or("")));}
        let text=value["text"].as_str().ok_or_else(||parse_error("ATTACHMENT_DOCUMENT_INVALID"))?;
        if services::current_user_id(&app.state::<services::ServiceState>()).map_err(|e|err(e.code,&e.message))?!=owner{
            return Err(err("ATTACHMENT_OWNER_CHANGED","账号已切换，请重新添加此文档"));
        }
        let attachment=DocumentAttachment{id:id.clone(),conversation_id,name,extension,kind:value["kind"].as_str().unwrap_or("text").into(),bytes:metadata.0,sha256:metadata.1,
            text_sha256:format!("{:x}",Sha256::digest(text.as_bytes())),characters:text.chars().count(),units:value["units"].as_u64().unwrap_or(0) as usize,unit_label:value["unitLabel"].as_str().unwrap_or("files").into(),
            excerpt:text.chars().take(200).collect(),truncated:value["truncated"]==true,warnings:value["warnings"].as_array().into_iter().flatten().filter_map(|v|v.as_str().map(str::to_owned)).collect(),transcript_edited:None,
            ocr_pages:serde_json::from_value(value["ocrPages"].clone()).ok(),ocr_engine:value["ocrEngine"].as_str().map(str::to_owned)};
        fs::write(root.join(format!("{id}.text")),text).map_err(|_|err("ATTACHMENT_STORAGE", "无法保存解析内容"))?;
        save_record(&root,&Record{attachment:attachment.clone(),published:false})?;
        Ok(attachment)
    }.await;
    if parsed.is_err(){for suffix in ["attachment","text","json"]{let _=fs::remove_file(root.join(format!("{id}.{suffix}")));}}
    parsed
}
pub(crate) fn save_transcript(app:&AppHandle,expected_owner:&str,conversation_id:String,name:String,bytes:Vec<u8>,text:String,seconds:usize)->Result<DocumentAttachment,AppError>{
    let current_owner=owner(app)?;
    if current_owner!=expected_owner{return Err(err("ATTACHMENT_OWNER_CHANGED","账号已切换，请重新添加此音频"));}
    let root=folder(app,&current_owner,&conversation_id)?;
    let name=name.chars().filter(|c|!c.is_control()&&!matches!(c,'/'|'\\')).take(160).collect::<String>();
    let extension=name.rsplit_once('.').map(|(_,ext)|ext.to_ascii_lowercase()).unwrap_or_default();
    let id=Uuid::new_v4().to_string();let mut warnings=vec![];if text.is_empty(){warnings.push("AUDIO_NO_SPEECH".into());}
    let attachment=DocumentAttachment{id:id.clone(),conversation_id,name,extension,kind:"audio".into(),bytes:bytes.len(),sha256:format!("{:x}",Sha256::digest(&bytes)),text_sha256:format!("{:x}",Sha256::digest(text.as_bytes())),characters:text.chars().count(),units:seconds,unit_label:"seconds".into(),excerpt:text.chars().take(200).collect(),truncated:false,warnings,transcript_edited:Some(false),ocr_pages:None,ocr_engine:None};
    let saved=(||{
        fs::write(root.join(format!("{id}.attachment")),bytes).and_then(|_|fs::write(root.join(format!("{id}.text")),&text)).and_then(|_|fs::write(root.join(format!("{id}.transcript")),&text)).map_err(|_|err("ATTACHMENT_STORAGE","无法保存音频转写结果"))?;
        save_record(&root,&Record{attachment:attachment.clone(),published:false})?;Ok(attachment)
    })();
    if saved.is_err(){for suffix in ["attachment","text","transcript","json"]{let _=fs::remove_file(root.join(format!("{id}.{suffix}")));}}
    saved
}
#[tauri::command]
pub(crate) fn audio_attachment_draft(app:AppHandle,conversation_id:String,id:String)->Result<Value,AppError>{
    let owner=owner(&app)?;let(root,record)=record(&app,&owner,&conversation_id,&id)?;
    if record.published||record.attachment.kind!="audio"{return Err(err("ATTACHMENT_NOT_FOUND","未找到当前草稿中的音频附件"));}
    let file=root.join(format!("{id}.text"));
    if fs::metadata(&file).map_err(|_|err("ATTACHMENT_NOT_FOUND","转写内容已丢失"))?.len()>1024*1024{return Err(err("ATTACHMENT_INVALID","转写内容大小异常"));}
    let text=fs::read_to_string(file).map_err(|_|err("ATTACHMENT_INVALID","转写内容无法读取"))?;
    if format!("{:x}",Sha256::digest(text.as_bytes()))!=record.attachment.text_sha256{return Err(err("ATTACHMENT_INVALID","转写内容已变化，请重新添加附件"));}
    Ok(json!({"attachment":record.attachment,"text":text,"untrustedContent":true}))
}
#[tauri::command]
pub(crate) fn audio_attachment_edit(app:AppHandle,conversation_id:String,id:String,text:String)->Result<DocumentAttachment,AppError>{
    let owner=owner(&app)?;let(root,mut record)=record(&app,&owner,&conversation_id,&id)?;
    if record.published||record.attachment.kind!="audio"{return Err(err("ATTACHMENT_ALREADY_SENT","此音频已发送，不能修改原转写内容"));}
    if text.len()>1024*1024{return Err(err("ATTACHMENT_LIMIT","转写内容过长，请拆分音频后添加"));}
    record.attachment.text_sha256=format!("{:x}",Sha256::digest(text.as_bytes()));record.attachment.characters=text.chars().count();record.attachment.excerpt=text.chars().take(200).collect();record.attachment.warnings=vec![];record.attachment.transcript_edited=Some(true);
    let pending=root.join(format!("{id}.text.pending"));
    fs::write(&pending,text).and_then(|_|fs::rename(&pending,root.join(format!("{id}.text")))).map_err(|_|err("ATTACHMENT_STORAGE","无法保存转写修改"))?;
    save_record(&root,&record)?;Ok(record.attachment)
}
#[tauri::command]
pub(crate) fn document_attachment_discard(app:AppHandle,conversation_id:String,id:String)->Result<(),AppError>{
    let owner=owner(&app)?;let(root,record)=record(&app,&owner,&conversation_id,&id)?;
    if record.published{return Err(err("ATTACHMENT_ALREADY_SENT","此附件已发送，不能删除原文件"));}
    for suffix in ["attachment","text","transcript","json"]{let path=root.join(format!("{id}.{suffix}"));if path.exists(){fs::remove_file(path).map_err(|_|err("ATTACHMENT_STORAGE","无法清理附件草稿"))?;}}Ok(())
}
pub(crate) fn publish(app:&AppHandle,owner:&str,conversation:&str,ids:&[String])->Result<(),AppError>{
    if ids.len()>8{return Err(err("ATTACHMENT_LIMIT", "每轮最多附加 8 个文档"));}
    let mut records=vec![];let mut total=0usize;
    for id in ids{let (root,record)=record(app,owner,conversation,id)?;total+=record.attachment.bytes;records.push((root,record));}
    if total>64*1024*1024{return Err(err("ATTACHMENT_LIMIT", "本轮文档总大小不能超过 64 MB"));}
    for (root,mut record) in records{if !record.published{record.published=true;save_record(&root,&record)?;}}
    Ok(())
}
#[tauri::command]
pub(crate) fn document_attachments_list(app:AppHandle,conversation_id:String)->Result<Vec<DocumentAttachment>,AppError>{
    let owner=owner(&app)?;let root=folder(&app,&owner,&conversation_id)?;let mut items=vec![];
    for entry in fs::read_dir(root).map_err(|_|err("ATTACHMENT_STORAGE", "无法读取文档附件"))?{
        let entry=entry.map_err(|_|err("ATTACHMENT_STORAGE", "无法读取文档附件"))?;
        if entry.path().extension().is_none_or(|extension|extension!="json"){continue;}
        let id=entry.path().file_stem().and_then(|stem|stem.to_str()).unwrap_or("").to_string();
        let (_,record)=record(&app,&owner,&conversation_id,&id)?;
        if record.published{items.push(record.attachment);}
    }
    items.sort_by(|a,b|a.name.cmp(&b.name));Ok(items)
}
#[tauri::command]
pub(crate) async fn document_attachment_read(app:AppHandle,conversation_id:String,id:String,offset:Option<usize>,limit:Option<usize>)->Result<Value,AppError>{
    let owner=owner(&app)?;let offset=offset.unwrap_or(0);let limit=limit.unwrap_or(12000);
    if limit==0||limit>24000{return Err(err("ATTACHMENT_INPUT", "单次读取长度须为 1 至 24000 个字符"));}
    tauri::async_runtime::spawn_blocking(move||{
        let (root,record)=record(&app,&owner,&conversation_id,&id)?;
        if !record.published{return Err(err("ATTACHMENT_NOT_FOUND", "此附件尚未发送到当前对话"));}
        let path=root.join(format!("{id}.text"));
        if fs::metadata(&path).map_err(|_|err("ATTACHMENT_NOT_FOUND", "解析内容已丢失"))?.len()>MAX_TEXT_BYTES{return Err(err("ATTACHMENT_INVALID", "解析内容大小异常"));}
        let text=fs::read_to_string(path).map_err(|_|err("ATTACHMENT_INVALID", "解析内容无法读取"))?;
        if format!("{:x}",Sha256::digest(text.as_bytes()))!=record.attachment.text_sha256{return Err(err("ATTACHMENT_INVALID", "解析内容已变化，请重新添加附件"));}
        let total=text.chars().count();if offset>total{return Err(err("ATTACHMENT_INPUT", "读取位置超出附件内容"));}
        let chunk:String=text.chars().skip(offset).take(limit).collect();let next=offset+chunk.chars().count();
        Ok(json!({"attachment":record.attachment,"text":chunk,"offset":offset,"nextOffset":if next<total{Some(next)}else{None},"complete":next>=total,"available":total>0,"untrustedContent":true}))
    }).await.map_err(|_|err("ATTACHMENT_INVALID", "附件读取失败"))?
}
pub(crate) fn clone_documents(app:&AppHandle,owner:&str,source:&str,target:&str,ids:&[String])->Result<Vec<DocumentAttachment>,AppError>{
    if ids.len()>200{return Err(err("ATTACHMENT_LIMIT", "分支附件数量超过当前容量"));}
    let destination=folder(app,owner,target)?;let mut copies=vec![];let mut seen=std::collections::HashSet::new();
    let result=(||{
        for id in ids{if !seen.insert(id){continue;}let (root,mut record)=record(app,owner,source,id)?;
            if destination.join(format!("{id}.json")).exists(){return Err(err("ATTACHMENT_STORAGE", "分支附件已存在"));}
            record.attachment.conversation_id=target.into();copies.push(record.attachment.clone());
            for suffix in ["attachment","text"]{fs::copy(root.join(format!("{id}.{suffix}")),destination.join(format!("{id}.{suffix}"))).map_err(|_|err("ATTACHMENT_STORAGE", "无法复制分支附件"))?;}
            let transcript=root.join(format!("{id}.transcript"));if transcript.is_file(){fs::copy(transcript,destination.join(format!("{id}.transcript"))).map_err(|_|err("ATTACHMENT_STORAGE","无法复制分支转写记录"))?;}
            save_record(&destination,&record)?;
        }
        Ok(copies.clone())
    })();
    if result.is_err(){for copy in copies{for suffix in ["attachment","text","transcript","json"]{let _=fs::remove_file(destination.join(format!("{}.{suffix}",copy.id)));}}}
    result
}
