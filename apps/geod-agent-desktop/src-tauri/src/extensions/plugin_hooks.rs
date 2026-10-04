//! Reviewed plugin actions use Codex's own lifecycle and trust engine.
use super::*;
use serde_json::json;
use tauri::Manager;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Group {
    pub event: String,
    pub matcher: Option<String>,
    pub handlers: Vec<Value>,
}
const EVENTS: [&str;12]=["SessionStart","SessionEnd","UserPromptSubmit","PreToolUse","PermissionRequest","PostToolUse","PreCompact","PostCompact","SubagentStart","SubagentStop","Stop","Interrupt"];
pub(super) fn count(groups:&[Group])->usize {groups.iter().map(|group|group.handlers.len()).sum()}
fn invalid(message:&str)->AppError {error("PLUGIN_HOOK_INVALID",message)}

pub(super) fn parse(overlay:&Value,files:&BTreeMap<String,Vec<u8>>)->Result<Vec<Group>,AppError>{
    let sources=match overlay.get("hooks") {
        None=>if files.contains_key("hooks/hooks.json"){vec![Value::String("./hooks/hooks.json".into())]}else{vec![]},
        Some(Value::Array(items))=>items.clone(),
        Some(value)=>vec![value.clone()],
    };
    let mut result=Vec::new();
    for source in sources {
        let document=if let Some(path)=source.as_str(){plugin_package::json_file(files,&plugin_package::relative_path(path)?)?}else{source};
        let document=document.as_object().ok_or_else(||invalid("自动化配置须为对象或包内文件路径"))?;
        if document.keys().any(|key|!matches!(key.as_str(),"description"|"hooks")){return Err(invalid("自动化配置包含尚未支持的字段"));}
        let events=document.get("hooks").and_then(Value::as_object).ok_or_else(||invalid("自动化配置缺少 hooks 对象"))?;
        for (event,groups) in events {
            if !EVENTS.contains(&event.as_str()){return Err(invalid("自动化事件不属于当前 Codex 引擎支持的生命周期"));}
            for group in groups.as_array().ok_or_else(||invalid("自动化事件须包含匹配组数组"))? {
                let group=group.as_object().ok_or_else(||invalid("自动化匹配组须为对象"))?;
                if group.keys().any(|key|!matches!(key.as_str(),"matcher"|"hooks")){return Err(invalid("自动化匹配组包含尚未支持的字段"));}
                let matcher=match group.get("matcher"){None|Some(Value::Null)=>None,Some(Value::String(value))=>Some(value.clone()),_=>return Err(invalid("自动化 matcher 须为字符串"))};
                let handlers=group.get("hooks").and_then(Value::as_array).ok_or_else(||invalid("自动化匹配组缺少 hooks 数组"))?;
                for handler in handlers {
                    let handler=handler.as_object().ok_or_else(||invalid("自动化操作须为对象"))?;
                    let kind=handler.get("type").and_then(Value::as_str).unwrap_or("");
                    match kind {
                        "command"=>{
                            if handler.keys().any(|key|!matches!(key.as_str(),"type"|"command"|"commandWindows"|"command_windows"|"timeout"|"async"|"statusMessage"|"additionalContextLimit")){return Err(invalid("自动化命令包含尚未支持的字段"));}
                            if !handler.get("command").and_then(Value::as_str).is_some_and(|value|!value.trim().is_empty()&&!value.contains('\0')){return Err(invalid("自动化命令不能为空或包含无效字符"));}
                            if handler.get("async").is_some_and(|value|!value.is_boolean()){return Err(invalid("自动化 async 须为布尔值"));}
                        }
                        "mcp_tool"=>{
                            if event=="SessionEnd"{return Err(error("PLUGIN_COMPONENT_UNSUPPORTED","配套 Codex 引擎暂不支持 SessionEnd 的 MCP 自动化"));}
                            if handler.keys().any(|key|!matches!(key.as_str(),"type"|"server"|"tool"|"input"|"timeout"|"statusMessage")){return Err(invalid("MCP 自动化包含尚未支持的字段"));}
                            for key in ["server","tool"] {
                                if !handler.get(key).and_then(Value::as_str).is_some_and(|value|!value.trim().is_empty()&&value.len()<=256&&!value.contains(['\0','\n','\r'])){return Err(invalid("MCP 自动化须填写有效的服务和工具名称"));}
                            }
                            if let Some(input)=handler.get("input") {
                                if !input.is_object()||toml::Value::try_from(input).is_err(){return Err(invalid("MCP 自动化 input 须为兼容 TOML 的对象，不能包含 null"));}
                            }
                        }
                        _=>return Err(error("PLUGIN_COMPONENT_UNSUPPORTED","当前插件自动化支持 command 和 mcp_tool；prompt 和 agent Handler 尚未接入")),
                    }
                    for key in ["commandWindows","command_windows","statusMessage"] {
                        if handler.get(key).is_some_and(|value|!value.is_null()&&!value.is_string()){return Err(invalid("自动化命令和提示文字须为字符串"));}
                    }
                    for key in ["timeout","additionalContextLimit"] {
                        if handler.get(key).is_some_and(|value|!value.is_null()&&value.as_u64().is_none()){return Err(invalid("自动化时间和内容限制须为非负整数"));}
                    }
                }
                if !handlers.is_empty(){result.push(Group{event:event.clone(),matcher,handlers:handlers.clone()});}
            }
        }
    }
    Ok(result)
}
pub(super) fn verified_root(state:&ExtensionState,record:&plugin_package::Record)->Result<PathBuf,AppError>{
    let root=plugin_package::package_root(state,&record.id)?;
    let canonical=root.canonicalize().map_err(|_|error("PLUGIN_READ_FAILED","已安装插件的资源目录不可读"))?;
    let actual=plugin_package::snapshot(&canonical)?.into_iter().map(|(path,bytes)|(path,format!("{:x}",Sha256::digest(bytes)))).collect::<BTreeMap<_,_>>();
    if actual!=record.resource_sha256{return Err(error("PLUGIN_CHANGED","插件资源已变化，请重新导入后审阅自动化"));}
    Ok(root)
}
pub(super) fn data_root(state:&ExtensionState,id:&str)->Result<PathBuf,AppError>{
    plugin_package::scoped_root(state,"plugin-data",id)
}
pub(super) fn export(state:&ExtensionState,store:&ExtensionStore)->Result<Vec<Value>,AppError>{
    let mut result=Vec::new();
    for record in store.plugins.iter().filter(|record|record.hooks_enabled&&record.hooks_reviewed_sha256.as_deref()==Some(&record.sha256)) {
        let root=verified_root(state,record)?;let data=data_root(state,&record.id)?;
        fs::create_dir_all(&data).map_err(|_|error("PLUGIN_STORAGE","无法准备插件自动化数据目录"))?;
        data_root(state,&record.id)?;
        for (index,group) in record.hooks.iter().enumerate() {
            result.push(json!({"pluginId":record.id,"sha256":record.sha256,"groupIndex":index,"serverBindings":record.mcp_server_ids,"pluginName":record.display_name,"packageRoot":root,"dataRoot":data,"event":group.event,"matcher":group.matcher,"handlers":group.handlers}));
        }
    }
    Ok(result)
}

#[derive(Deserialize)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
struct McpTarget { plugin_id:String, sha256:String, group_index:usize, handler_index:usize, connector_id:String }

fn mcp_target(state:&ExtensionState,owner:&str,target:&Value)->Result<(String,String,Duration),AppError>{
    let target:McpTarget=serde_json::from_value(target.clone()).map_err(|_|invalid("MCP 自动化运行目标无效"))?;
    let store=state.load()?;
    let record=store.plugins.iter().find(|record|record.id==target.plugin_id&&record.owner==owner).ok_or_else(||error("PLUGIN_NOT_FOUND","未找到当前账号的插件"))?;
    if !record.hooks_enabled||record.hooks_reviewed_sha256.as_deref()!=Some(&record.sha256)||target.sha256!=record.sha256 {return Err(error("PLUGIN_HOOK_DISABLED","插件自动化已停用或审阅版本已变化"));}
    verified_root(state,record)?;
    let group=record.hooks.get(target.group_index).ok_or_else(||invalid("MCP 自动化运行目标无效"))?;
    let handler=group.handlers.get(target.handler_index).ok_or_else(||invalid("MCP 自动化运行目标无效"))?;
    let server=handler["server"].as_str().unwrap_or("");let tool=handler["tool"].as_str().unwrap_or("");
    if handler["type"]!="mcp_tool"||record.mcp_server_ids.get(server)!=Some(&target.connector_id)||!record.connector_ids.contains(&target.connector_id){return Err(invalid("MCP 自动化运行目标与已审阅配置不一致"));}
    let timeout=handler["timeout"].as_u64();
    let seconds=if group.event=="Interrupt"{timeout.unwrap_or(1).clamp(1,3)}else{timeout.unwrap_or(600).clamp(1,900)};
    Ok((target.connector_id,tool.into(),Duration::from_secs(seconds)))
}

pub(crate) async fn call_mcp(app:&AppHandle,owner:&str,conversation:&str,execution_id:String,target:Value,arguments:Value,background:bool,cancelled:std::sync::Arc<std::sync::atomic::AtomicBool>,call_cancelled:std::sync::Arc<std::sync::atomic::AtomicBool>)->Result<Value,AppError>{
    let actual=services::current_user_id(&app.state::<services::ServiceState>()).map_err(|cause|error(cause.code,&cause.message))?;
    if actual!=owner{return Err(error("ACCOUNT_CHANGED","账号已切换，插件自动化已停止"));}
    let (id,tool,timeout)=mcp_target(&app.state::<ExtensionState>(),owner,&target)?;
    let result=tokio::time::timeout(timeout,async {
        tokio::select! {
            value=super::mcp_call(app.state(),app.clone(),app.state(),app.state(),id,tool,arguments,execution_id.clone(),Some(conversation.into()),Some(!background))=>value,
            _=async {loop {if cancelled.load(std::sync::atomic::Ordering::Acquire)||call_cancelled.load(std::sync::atomic::Ordering::Acquire){break;}tokio::time::sleep(Duration::from_millis(25)).await;}}=>Err(error("PLUGIN_HOOK_CANCELLED","插件自动化已停止，调用结果可能尚未确认")),
        }
    }).await.map_err(|_|error("MCP_RESULT_UNKNOWN","插件自动化超时，调用结果尚未确认；请核对服务状态"));
    crate::mcp_interaction::dismiss_scope(app,&execution_id);
    let output=result??;
    if let Some(code)=output["error"].as_str(){let code=match code {"MCP_RESULT_TOO_LARGE"=>"MCP_RESULT_TOO_LARGE","MCP_LEGACY_RESULT_TRUNCATED"=>"MCP_LEGACY_RESULT_TRUNCATED",_=>"MCP_RESULT_INVALID"};return Err(error(code,"插件自动化未取得完整 MCP 结果"));}
    if output["paged"]==true {
        // The ordinary chat tool pages large results. Lifecycle hooks need the
        // complete, already saved MCP text for Codex's own output parser.
        let state=app.state::<ExtensionState>();
        return state.load()?.mcp_calls.into_iter().find(|entry|entry.execution_id==execution_id&&entry.owner.as_deref()==Some(owner)).and_then(|entry|entry.result).ok_or_else(||error("MCP_RESULT_UNKNOWN","插件自动化结果尚未确认"));
    }
    Ok(output)
}
fn owned(state:&ExtensionState,services:&services::ServiceState,id:&str)->Result<plugin_package::Record,AppError>{
    let owner=services::current_user_id(services).map_err(|cause|error(cause.code,&cause.message))?;
    state.load()?.plugins.into_iter().find(|record|record.id==id&&record.owner==owner).ok_or_else(||error("PLUGIN_NOT_FOUND","未找到当前账号的插件"))
}
#[tauri::command]
pub(crate) fn plugin_hooks_preview(state:State<'_,ExtensionState>,services:State<'_,services::ServiceState>,id:String)->Result<Value,AppError>{
    let record=owned(&state,&services,&id)?;verified_root(&state,&record)?;
    Ok(json!({"id":record.id,"displayName":record.display_name,"sha256":record.sha256,"hooks":record.hooks,"enabled":record.hooks_enabled,"reviewed":record.hooks_reviewed_sha256.as_deref()==Some(&record.sha256)}))
}
#[tauri::command]
pub(crate) fn plugin_hooks_set_enabled(state:State<'_,ExtensionState>,services:State<'_,services::ServiceState>,id:String,expected_sha256:String,enabled:bool)->Result<Value,AppError>{
    let record=owned(&state,&services,&id)?;
    if record.sha256!=expected_sha256{return Err(error("PLUGIN_CHANGED","插件包在检查后发生变化，请重新检查"));}
    if enabled{verified_root(&state,&record)?;}
    let store=state.update(|store|{
        let found=store.plugins.iter_mut().find(|found|found.id==record.id&&found.owner==record.owner).ok_or_else(||error("PLUGIN_NOT_FOUND","此插件已移除"))?;
        if found.sha256!=expected_sha256{return Err(error("PLUGIN_CHANGED","插件包在检查后发生变化，请重新检查"));}
        found.hooks_enabled=enabled;
        if enabled{found.hooks_reviewed_sha256=Some(expected_sha256.clone());}else{found.hooks_reviewed_sha256=None;}
        Ok(())
    })?;
    Ok(plugin_package::summary(store.plugins.iter().find(|found|found.id==id).unwrap(),Some(&store)))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture(root:&Path){
        fs::create_dir_all(root.join("hooks")).unwrap();
        fs::write(root.join("plugin.json"),r#"{"name":"qa-hooks","version":"1.0.0"}"#).unwrap();
        fs::write(root.join("hooks/hooks.json"),r#"{"hooks":{"SessionStart":[{"matcher":"startup|resume","hooks":[{"type":"command","command":"node \"${PLUGIN_ROOT}/hooks/start.mjs\"","timeout":10,"additionalContextLimit":0}]}],"Stop":[{"hooks":[{"type":"command","command":"node \"${PLUGIN_ROOT}/hooks/start.mjs\"","async":true}]}]}}"#).unwrap();
        fs::write(root.join("hooks/start.mjs"),"console.log('actual fixture');").unwrap();
    }
    #[test]
    fn installed_commands_stay_off_until_review_and_are_owner_scoped(){
        let dir=tempfile::tempdir().unwrap();let source=dir.path().join("source");fixture(&source);
        let state=ExtensionState::new(dir.path().join("extensions.json"));
        let package=plugin_package::parse(&source,"one").unwrap();assert_eq!(count(&package.record.hooks),2);
        let hash=package.record.sha256.clone();let installed=plugin_package::install(&state,package,&hash,true).unwrap();
        assert_eq!(installed["hooksCount"],2);assert_eq!(installed["enabledHooks"],0);
        assert!(state.codex_bundle_owned(&dir.path().join("home"),"one").unwrap()["pluginHooks"].as_array().unwrap().is_empty());
        state.update(|store|{store.plugins[0].hooks_enabled=true;store.plugins[0].hooks_reviewed_sha256=Some(hash.clone());Ok(())}).unwrap();
        fs::remove_dir_all(&source).unwrap();
        let own=state.codex_bundle_owned(&dir.path().join("own"),"one").unwrap();assert_eq!(own["pluginHooks"].as_array().unwrap().len(),2);
        assert!(own["pluginHooks"][0]["packageRoot"].as_str().unwrap().contains(installed["id"].as_str().unwrap()));
        assert!(state.codex_bundle_owned(&dir.path().join("other"),"two").unwrap()["pluginHooks"].as_array().unwrap().is_empty());
        state.update(|store|{store.plugins[0].hooks_reviewed_sha256=Some("changed".into());Ok(())}).unwrap();
        assert!(state.codex_bundle_owned(&dir.path().join("own"),"one").unwrap()["pluginHooks"].as_array().unwrap().is_empty());
    }
    #[test]
    fn changed_installed_scripts_cannot_reuse_old_review(){
        let dir=tempfile::tempdir().unwrap();let source=dir.path().join("source");fixture(&source);
        let state=ExtensionState::new(dir.path().join("extensions.json"));
        let mut package=plugin_package::parse(&source,"one").unwrap();let hash=package.record.sha256.clone();
        package.record.hooks_enabled=true;package.record.hooks_reviewed_sha256=Some(hash.clone());
        let installed=plugin_package::install(&state,package,&hash,true).unwrap();
        let root=plugin_package::package_root(&state,installed["id"].as_str().unwrap()).unwrap();
        fs::write(root.join("hooks/start.mjs"),"changed after approval").unwrap();
        assert_eq!(state.codex_bundle_owned(&dir.path().join("own"),"one").unwrap_err().code,"PLUGIN_CHANGED");
    }
    #[test]
    fn inline_and_path_hooks_are_checked_without_silently_dropping_handlers(){
        let inline=json!({"hooks":{"UserPromptSubmit":[{"hooks":[{"type":"command","command":"echo ready","commandWindows":"echo windows"}]}]}});
        let overlay=json!({"hooks":[inline.clone()]});let files=BTreeMap::new();
        assert_eq!(count(&parse(&overlay,&files).unwrap()),1);
        assert_eq!(parse(&json!({"hooks":"./../outside.json"}),&files).unwrap_err().code,"PLUGIN_PATH_INVALID");
        let mut unknown=inline;unknown["hooks"]["UserPromptSubmit"][0]["hooks"][0]["type"]=json!("agent");
        assert_eq!(parse(&json!({"hooks":unknown}),&files).unwrap_err().code,"PLUGIN_COMPONENT_UNSUPPORTED");
        assert!(parse(&json!({"hooks":{"hooks":{"Unknown":[]}}}),&files).is_err());
        assert!(parse(&json!({"hooks":{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"echo ok","async":"yes"}]}]}}}),&files).is_err());
    }
    #[test]
    fn mcp_actions_require_reviewed_owned_bindings_and_keep_engine_compatible_input(){
        let dir=tempfile::tempdir().unwrap();let source=dir.path().join("source");fs::create_dir_all(source.join(".codex-plugin")).unwrap();
        fs::write(source.join(".codex-plugin/plugin.json"),r#"{"name":"qa-mcp-hooks","hooks":{"hooks":{"UserPromptSubmit":[{"hooks":[{"type":"mcp_tool","server":"notes","tool":"record","input":{"prompt":"${prompt}"},"timeout":7}]}]}}}"#).unwrap();
        fs::write(source.join(".mcp.json"),r#"{"mcpServers":{"notes":{"command":"node","args":["server.mjs"]}}}"#).unwrap();
        let state=ExtensionState::new(dir.path().join("extensions.json"));let package=plugin_package::parse(&source,"one").unwrap();let hash=package.record.sha256.clone();
        let installed=plugin_package::install(&state,package,&hash,true).unwrap();let store=state.load().unwrap();let record=&store.plugins[0];let group_index=record.hooks.iter().position(|group|group.event=="UserPromptSubmit").unwrap();
        let target=json!({"pluginId":installed["id"],"sha256":hash,"groupIndex":group_index,"handlerIndex":0,"connectorId":record.mcp_server_ids["notes"]});
        assert_eq!(mcp_target(&state,"one",&target).unwrap_err().code,"PLUGIN_HOOK_DISABLED");
        state.update(|store|{store.plugins[0].hooks_enabled=true;store.plugins[0].hooks_reviewed_sha256=Some(hash.clone());Ok(())}).unwrap();
        let (_,tool,timeout)=mcp_target(&state,"one",&target).unwrap();assert_eq!(tool,"record");assert_eq!(timeout,Duration::from_secs(7));
        assert_eq!(mcp_target(&state,"two",&target).unwrap_err().code,"PLUGIN_NOT_FOUND");
        let mut changed=target.clone();changed["connectorId"]=json!("other-plugin");assert_eq!(mcp_target(&state,"one",&changed).unwrap_err().code,"PLUGIN_HOOK_INVALID");
        changed=target;changed["sha256"]=json!("changed");assert_eq!(mcp_target(&state,"one",&changed).unwrap_err().code,"PLUGIN_HOOK_DISABLED");
        let files=BTreeMap::new();let invalid=json!({"hooks":{"hooks":{"Stop":[{"hooks":[{"type":"mcp_tool","server":"notes","tool":"record","input":{"value":null}}]}]}}});assert_eq!(parse(&invalid,&files).unwrap_err().code,"PLUGIN_HOOK_INVALID");
        let unsupported=json!({"hooks":{"hooks":{"SessionEnd":[{"hooks":[{"type":"mcp_tool","server":"notes","tool":"record"}]}]}}});assert_eq!(parse(&unsupported,&files).unwrap_err().code,"PLUGIN_COMPONENT_UNSUPPORTED");
    }
}
