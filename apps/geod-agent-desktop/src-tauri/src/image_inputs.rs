use crate::{services,AppError};
use base64::{engine::general_purpose::STANDARD,Engine};
use image::{ImageFormat,ImageReader};
use serde::{Deserialize,Serialize};
use sha2::{Digest,Sha256};
use std::{fs,io::Cursor,path::PathBuf};
use tauri::{AppHandle,Manager};
use uuid::Uuid;

const MAX_BYTES:usize=10*1024*1024;
const MAX_PIXELS:u64=32_000_000;
fn error(code:&'static str,message:&str)->AppError{AppError{code,message:message.into()}}
#[derive(Clone,Serialize,Deserialize)]
#[serde(rename_all="camelCase")]
pub(crate) struct ImageAttachment{pub id:String,pub conversation_id:String,pub name:String,pub mime_type:String,pub bytes:usize,pub width:u32,pub height:u32,pub sha256:String}
fn folder(app:&AppHandle,owner:&str)->Result<PathBuf,AppError>{
    let root=app.path().app_data_dir().map_err(|_|error("IMAGE_STORAGE","无法读取图片保存位置"))?.join("chat-images").join(format!("{:x}",Sha256::digest(owner.as_bytes())));
    fs::create_dir_all(&root).map_err(|_|error("IMAGE_STORAGE","无法准备图片保存位置"))?;Ok(root)
}
fn read(app:&AppHandle,owner:&str,conversation_id:&str,id:&str)->Result<(ImageAttachment,Vec<u8>),AppError>{
    Uuid::parse_str(id).map_err(|_|error("IMAGE_NOT_FOUND","未找到此图片附件"))?;
    let root=folder(app,owner)?;
    let metadata:ImageAttachment=serde_json::from_slice(&fs::read(root.join(format!("{id}.json"))).map_err(|_|error("IMAGE_NOT_FOUND","图片附件已丢失"))?).map_err(|_|error("IMAGE_INVALID","图片记录已损坏"))?;
    if metadata.conversation_id!=conversation_id||metadata.id!=id{return Err(error("IMAGE_NOT_FOUND","未找到当前对话的图片附件"));}
    let file=root.join(format!("{id}.image"));
    if fs::metadata(&file).map_err(|_|error("IMAGE_NOT_FOUND","图片附件已丢失"))?.len()>MAX_BYTES as u64{return Err(error("IMAGE_INVALID","图片附件大小异常"));}
    let bytes=fs::read(file).map_err(|_|error("IMAGE_NOT_FOUND","图片附件已丢失"))?;
    if format!("{:x}",Sha256::digest(&bytes))!=metadata.sha256{return Err(error("IMAGE_INVALID","图片附件内容已变化"));}Ok((metadata,bytes))
}
pub(crate) fn model_images(app:&AppHandle,owner:&str,conversation_id:&str,ids:&[String])->Result<Vec<String>,AppError>{
    if ids.len()>8{return Err(error("IMAGE_LIMIT","每轮最多附加 8 张图片"));}
    let mut total=0;ids.iter().map(|id|{let (metadata,bytes)=read(app,owner,conversation_id,id)?;total+=bytes.len();if total>24*1024*1024{return Err(error("IMAGE_LIMIT","本轮图片总大小超过 24 MB"));}Ok(format!("data:{};base64,{}",metadata.mime_type,STANDARD.encode(bytes)))}).collect()
}
pub(crate) fn clone_images(app:&AppHandle,owner:&str,source:&str,target:&str,ids:&[String])->Result<Vec<(String,ImageAttachment)>,AppError>{
    if ids.len()>200{return Err(error("IMAGE_LIMIT","分支图片数量超过当前容量"));}
    let root=folder(app,owner)?;let mut cloned=vec![];
    let result=(||{
        let mut seen=std::collections::HashSet::new();
        for id in ids{if !seen.insert(id){continue;}let (mut metadata,bytes)=read(app,owner,source,id)?;let next=Uuid::new_v4().to_string();metadata.id=next.clone();metadata.conversation_id=target.into();
            cloned.push((id.clone(),metadata.clone()));
            fs::write(root.join(format!("{next}.image")),bytes).and_then(|_|fs::copy(root.join(format!("{id}.preview")),root.join(format!("{next}.preview"))).map(|_|())).and_then(|_|fs::write(root.join(format!("{next}.json")),serde_json::to_vec(&metadata).unwrap())).map_err(|_|error("IMAGE_STORAGE","无法复制分支图片"))?;
        }
        Ok(())
    })();
    if let Err(e)=result{for (_,metadata) in &cloned{for extension in ["image","preview","json"]{let _=fs::remove_file(root.join(format!("{}.{extension}",metadata.id)));}}return Err(e);}
    Ok(cloned)
}
#[tauri::command]
pub(crate) async fn image_attachment_add(app:AppHandle,conversation_id:String,name:String,base64:String)->Result<ImageAttachment,AppError>{
    let owner=services::current_user_id(&app.state::<services::ServiceState>()).map_err(|e|error(e.code,&e.message))?;
    Uuid::parse_str(&conversation_id).map_err(|_|error("IMAGE_INVALID","对话标识无效"))?;
    if base64.len()>MAX_BYTES*4/3+8{return Err(error("IMAGE_LIMIT","单张图片不能超过 10 MB"));}
    tauri::async_runtime::spawn_blocking(move||{
        let bytes=STANDARD.decode(base64).map_err(|_|error("IMAGE_INVALID","图片数据无效"))?;
        if bytes.is_empty()||bytes.len()>MAX_BYTES{return Err(error("IMAGE_LIMIT","图片为空或超过 10 MB"));}
        let format=image::guess_format(&bytes).map_err(|_|error("IMAGE_INVALID","无法识别图片格式"))?;
        let mime_type=match format{ImageFormat::Png=>"image/png",ImageFormat::Jpeg=>"image/jpeg",ImageFormat::WebP=>"image/webp",ImageFormat::Gif=>"image/gif",_=>return Err(error("IMAGE_FORMAT","支持 PNG、JPEG、WebP 和 GIF 图片"))};
        let (width,height)=ImageReader::with_format(Cursor::new(&bytes),format).into_dimensions().map_err(|_|error("IMAGE_INVALID","无法读取图片尺寸"))?;
        if width==0||height==0||u64::from(width)*u64::from(height)>MAX_PIXELS{return Err(error("IMAGE_LIMIT","图片像素超过当前处理容量"));}
        let mut reader=ImageReader::with_format(Cursor::new(&bytes),format);let mut limits=image::Limits::default();limits.max_alloc=Some(256*1024*1024);reader.limits(limits);
        let decoded=reader.decode().map_err(|_|error("IMAGE_INVALID","图片内容已损坏或无法解码"))?;
        let id=Uuid::new_v4().to_string();
        let name=name.chars().filter(|c|!c.is_control()&&!matches!(c,'/'|'\\')).take(120).collect::<String>();
        let metadata=ImageAttachment{id:id.clone(),conversation_id,name:if name.is_empty(){"图片".into()}else{name},mime_type:mime_type.into(),bytes:bytes.len(),width,height,sha256:format!("{:x}",Sha256::digest(&bytes))};
        let root=folder(&app,&owner)?;
        let mut preview=Cursor::new(Vec::new());decoded.thumbnail(512,512).write_to(&mut preview,ImageFormat::Png).map_err(|_|error("IMAGE_INVALID","无法生成图片预览"))?;
        fs::write(root.join(format!("{id}.image")),bytes).and_then(|_|fs::write(root.join(format!("{id}.preview")),preview.into_inner())).and_then(|_|fs::write(root.join(format!("{id}.json")),serde_json::to_vec(&metadata).unwrap())).map_err(|_|error("IMAGE_STORAGE","无法保存图片附件"))?;
        Ok(metadata)
    }).await.map_err(|_|error("IMAGE_INVALID","图片处理失败"))?
}
#[tauri::command]
pub(crate) async fn image_attachment_preview(app:AppHandle,conversation_id:String,id:String)->Result<String,AppError>{
    let owner=services::current_user_id(&app.state::<services::ServiceState>()).map_err(|e|error(e.code,&e.message))?;
    tauri::async_runtime::spawn_blocking(move||{
        read(&app,&owner,&conversation_id,&id)?;
        let bytes=fs::read(folder(&app,&owner)?.join(format!("{id}.preview"))).map_err(|_|error("IMAGE_NOT_FOUND","无法读取图片预览"))?;
        Ok(format!("data:image/png;base64,{}",STANDARD.encode(bytes)))
    }).await.map_err(|_|error("IMAGE_INVALID","图片预览失败"))?
}
