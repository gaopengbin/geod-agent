//! Native fulfilment for Codex dynamic tools when no desktop view is present.
use crate::{
    boundary_inputs, data_inputs, extensions, online_inputs, open_store, read_workspace, services,
    source_creator, workspace_error, AppError, AppState,
};
use serde::{de::DeserializeOwned, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

fn field<T: DeserializeOwned>(a: &Value, key: &str) -> Result<T, AppError> {
    serde_json::from_value(a.get(key).cloned().unwrap_or(Value::Null))
        .map_err(|_| workspace_error("TOOL_INPUT_INVALID", format!("参数 {key} 无效")))
}
fn encode<T: Serialize>(v: T) -> Result<Value, AppError> {
    serde_json::to_value(v).map_err(|_| workspace_error("TOOL_RESULT_INVALID", "工具结果编码失败"))
}
fn range(v: Value) -> Value {
    json!({"boundaryId":v["boundaryId"],"name":v["name"],"bounds":v["bounds"],"polygonCount":v["polygonCount"],"attachedToDesktopPlan":true})
}
fn compact_command(mut record: crate::background_commands::Record) -> Result<Value, AppError> {
    let mut truncated = false;
    for stream in [&mut record.stdout, &mut record.stderr] {
        if let Some(text) = stream {
            if text.chars().count() > 12000 {
                *text = text.chars().rev().take(12000).collect::<String>().chars().rev().collect();
                truncated = true;
            }
        }
    }
    let mut value = encode(record)?;
    value["outputExcerptTruncated"] = json!(truncated);
    Ok(value)
}
pub(crate) async fn execute(
    app: &AppHandle,
    conversation: &str,
    tool: &str,
    a: Value,
    key: &str,
) -> Result<Value, AppError> {
    if !a.is_object() {
        return Err(workspace_error("TOOL_INPUT_INVALID", "工具参数需要对象"));
    }
    let state = app.state::<AppState>();
    let services = app.state::<services::ServiceState>();
    let workspace = read_workspace(app, &state, &services, conversation)?;
    services::current_user_id(&services).map_err(|e| workspace_error(e.code, e.message))?;
    macro_rules! f {
        ($key:literal) => {
            field(&a, $key)?
        };
    }
    match tool {
        "attachment_list"=>encode(crate::attachment_inputs::document_attachments_list(app.clone(),conversation.into())?),
        "attachment_read"=>crate::attachment_inputs::document_attachment_read(app.clone(),conversation.into(),f!("id"),f!("offset"),f!("limit")).await,
        "agent_tasks_spawn" => encode(crate::agent_tasks::spawn(app,conversation.into(),key.into(),serde_json::from_value(a).map_err(|_|workspace_error("AGENT_INPUT","子任务参数无效"))?)?),
        "agent_tasks_list" => crate::agent_tasks::list(app,conversation.into()),
        "agent_tasks_get" => crate::agent_tasks::get(app,conversation.into(),f!("taskId")),
        "agent_tasks_read_file" => crate::agent_tasks::read_file(app,conversation.into(),f!("taskId"),f!("path")),
        "agent_tasks_cancel" => encode(crate::agent_tasks::cancel(app,conversation.into(),f!("taskId"))?),
        "agent_memory_list" => crate::agent_memory::agent_memory_list(app.clone(),conversation.into(),f!("query"),f!("offset")),
        "agent_memory_save" => encode(crate::agent_memory::agent_memory_save(app.clone(),conversation.into(),serde_json::from_value(a).map_err(|_|workspace_error("MEMORY_INVALID","记忆参数无效"))?)?),
        "agent_memory_remove" => crate::agent_memory::agent_memory_remove(app.clone(),conversation.into(),f!("id"),f!("expectedRevision")),
        "background_command_prepare" => encode(crate::background_commands::prepare(app, conversation.into(), key.into(), serde_json::from_value(a).map_err(|_| workspace_error("COMMAND_INPUT_INVALID", "后台命令参数无效"))?)?),
        "background_command_list" => encode(crate::background_commands::list(app, conversation.into(), f!("offset"))?),
        "background_command_get" => compact_command(crate::background_commands::get(app, conversation.into(), f!("commandId"))?),
        "background_command_start" => compact_command(crate::background_commands::start(app, conversation.into(), f!("commandId"), f!("planHash"), false)?),
        "background_command_stop" => compact_command(crate::background_commands::stop(app, conversation.into(), f!("commandId"))?),
        "background_command_write" => crate::background_commands::write(app, conversation.into(), f!("commandId"), f!("input"), a["closeStdin"].as_bool().unwrap_or(false)),
        "ai_schedules_create" => encode(crate::ai_schedules::ai_schedules_create(
            app.clone(),
            conversation.into(),
            f!("name"),
            f!("prompt"),
            f!("nextRunAt"),
            f!("repeatSeconds"),
            key.into(),
            None,
        )?),
        "ai_schedules_list" => {
            crate::ai_schedules::ai_schedules_list(app.clone(), conversation.into())
        }
        "ai_schedules_set_enabled"
        | "ai_schedules_cancel_run"
        | "ai_schedules_retry_run"
        | "ai_schedules_run_events" => {
            let overview =
                crate::ai_schedules::ai_schedules_list(app.clone(), conversation.into())?;
            if tool == "ai_schedules_set_enabled" {
                if !overview["schedules"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|s| s["scheduleId"] == a["scheduleId"])
                {
                    return Err(workspace_error(
                        "SCHEDULE_NOT_IN_CONVERSATION",
                        "定时任务不属于当前会话",
                    ));
                }
                return encode(crate::ai_schedules::ai_schedules_set_enabled(
                    app.clone(),
                    f!("scheduleId"),
                    f!("enabled"),
                    f!("nextRunAt"),
                )?);
            }
            if !overview["runs"]
                .as_array()
                .unwrap()
                .iter()
                .any(|r| r["runId"] == a["runId"])
            {
                return Err(workspace_error(
                    "RUN_NOT_IN_CONVERSATION",
                    "执行记录不属于当前会话",
                ));
            }
            match tool {
                "ai_schedules_cancel_run" => encode(crate::ai_schedules::ai_schedules_cancel_run(
                    app.clone(),
                    f!("runId"),
                )?),
                "ai_schedules_retry_run" => encode(crate::ai_schedules::ai_schedules_retry_run(
                    app.clone(),
                    f!("runId"),
                )?),
                _ => crate::ai_schedules::ai_schedules_run_events(app.clone(), f!("runId")),
            }
        }
        "workspace_status" => Ok(
            json!({"name":std::path::Path::new(&workspace.directory).file_name().map(|s|s.to_string_lossy()),"permission":workspace.permission,"canStartWithoutPlanConfirmation":workspace.permission==crate::WorkspacePermission::FullAccess,"currentTime":chrono::Utc::now(),"background":true}),
        ),
        "workspace_boundaries_list" => Ok(
            json!({"files":crate::workspace_boundaries_list(app.clone(),state,services,conversation.into())?}),
        ),
        "workspace_gis_files_list" => Ok(
            json!({"files":crate::workspace_gis_files_list(app.clone(),state,services,conversation.into())?}),
        ),
        "workspace_skills_list" => Ok(
            json!({"skills":crate::workspace_skills_list(app.clone(),state,services,conversation.into())?}),
        ),
        "sources_list" => {
            let all = serde_json::to_value(crate::sources_list(state)?).unwrap();
            Ok(
                json!({"sources":all.as_array().unwrap().iter().map(|s|json!({"id":s["id"],"name":s["displayName"],"minZoom":s["minZoom"],"maxZoom":s["maxZoom"],"attribution":s["attribution"]})).collect::<Vec<_>>()}),
            )
        }
        "boundaries_list" => {
            Ok(json!({"boundaries":boundary_inputs::boundaries_list(state,conversation.into())?}))
        }
        "boundaries_combine" => Ok(range(encode(boundary_inputs::boundaries_combine(
            state,
            conversation.into(),
            f!("boundaryIds"),
            f!("name"),
        )?)?)),
        "workspace_boundary_use" => {
            let found = crate::workspace_boundary_use(
                app.clone(),
                state.clone(),
                services,
                conversation.into(),
                f!("relativePath"),
            )?;
            Ok(range(encode(boundary_inputs::boundaries_save(
                state,
                conversation.into(),
                found,
            )?)?))
        }
        "data_connections_list" => {
            let all = encode(data_inputs::data_connections_list(app.clone(), services)?)?;
            Ok(
                json!({"connections":all.as_array().unwrap().iter().map(|c|json!({"id":c["id"],"name":c["name"],"readOnly":true})).collect::<Vec<_>>()}),
            )
        }
        "online_connections_list" => {
            let all = encode(online_inputs::online_connections_list(
                app.clone(),
                services,
            )?)?;
            Ok(
                json!({"connections":all.as_array().unwrap().iter().map(|c|json!({"id":c["id"],"name":c["name"]})).collect::<Vec<_>>()}),
            )
        }
        "online_services_discover" => {
            online_inputs::online_services_discover(
                app.clone(),
                f!("url"),
                f!("onlineConnectionId"),
            )
            .await
        }
        "data_connection_connect" => {
            let mut value=data_inputs::data_connection_connect(app.clone(), conversation.into(), a).await?;
            value.as_object_mut().unwrap().remove("authentication");
            if matches!(value["error"]["code"].as_str(),Some("INPUT_AUTH_REQUIRED"|"INPUT_TLS_FAILED"|"INPUT_TLS_KEY_PASSWORD_REQUIRED"|"INPUT_TLS_KEY_PASSWORD_INCORRECT"|"INPUT_TLS_BUNDLE_PASSWORD_REQUIRED"|"INPUT_TLS_BUNDLE_OPEN_FAILED"|"INPUT_TLS_BUNDLE_INVALID"|"INPUT_TLS_INVALID")){
                value["error"]=json!({"code":"USER_INPUT_REQUIRED","message":"请在应用的数据库连接中配置认证信息和证书后重试后台任务"});
            }
            Ok(value)
        }
        "sql_connections_list"=>{
            let value=crate::sql_connections::sql_connections_list(app.clone())?;
            Ok(json!({"connections":value["connections"].as_array().into_iter().flatten().map(|connection|json!({"id":connection["id"],"name":connection["name"],"kind":connection["kind"],"readOnly":true})).collect::<Vec<_>>()}))
        }
        "sql_connection_connect"=>{
            let mut value=crate::sql_connections::sql_connection_connect(app.clone(),conversation.into(),a).await?;
            // Background tasks cannot prompt for new credentials.
            value.as_object_mut().unwrap().remove("authentication");
            if matches!(value["error"]["code"].as_str(),Some("INPUT_AUTH_REQUIRED"|"INPUT_AUTH_CONFIG"|"INPUT_TLS_FAILED"|"INPUT_TLS_KEY_PASSWORD_REQUIRED"|"INPUT_TLS_KEY_PASSWORD_INCORRECT"|"INPUT_TLS_BUNDLE_PASSWORD_REQUIRED"|"INPUT_TLS_BUNDLE_OPEN_FAILED"|"INPUT_TLS_BUNDLE_INVALID"|"INPUT_TLS_INVALID")){value["error"]=json!({"code":"USER_INPUT_REQUIRED","message":"请在应用的数据库连接中配置认证信息和证书后重试后台任务"});}
            if !value["connection"].is_null(){let connection=value["connection"].clone();value["connection"]=json!({"id":connection["id"],"name":connection["name"],"kind":connection["kind"],"readOnly":true});}
            Ok(value)
        }
        "sql_objects_search"=>{
            let id=f!("connectionId");let mut request=a;request.as_object_mut().unwrap().remove("connectionId");
            crate::sql_connections::sql_objects_search(app.clone(),id,request).await
        }
        "sql_query"=>crate::sql_connections::sql_query(app.clone(),f!("connectionId"),f!("sql")).await,
        "data_layer_inspect" => {
            let selection=serde_json::from_value(json!({"bounds":a["bounds"],"maxFeatures":a["maxFeatures"],"filters":a.get("filters").cloned().unwrap_or(json!([]))})).map_err(|_|workspace_error("INPUT_INVALID","筛选参数无效"))?;
            data_inputs::data_layer_inspect(
                app.clone(),
                f!("connectionId"),
                f!("layer"),
                f!("limit"),
                Some(selection),
            )
            .await
        }
        "data_input_read" => {
            let input = serde_json::from_value(a)
                .map_err(|_| workspace_error("INPUT_INVALID", "数据参数无效"))?;
            let mut result =
                data_inputs::data_input_read(app.clone(), conversation.into(), input).await?;
            if !result["boundary"].is_null() {
                let found = serde_json::from_value(result["boundary"].clone())
                    .map_err(|_| workspace_error("INPUT_INVALID", "读取范围无效"))?;
                result["boundary"] = range(encode(boundary_inputs::boundaries_save(
                    state,
                    conversation.into(),
                    found,
                )?)?);
            }
            Ok(result)
        }
        "skill_read" => {
            Ok(json!({"name":a["name"],"content":extensions::skill_read(app.state(),app.state(),f!("name"))?}))
        }
        "extensions_list" => discover(app, conversation, a["query"].as_str().unwrap_or("")).await,
        "mcp_call" => {
            let id: String = f!("connectorId");
            let name: String = f!("toolName");
            let arguments: Value = f!("arguments");
            if matches!(id.as_str(), "builtin-openlayers-mcp" | "builtin-cesium-mcp") {
                return Err(workspace_error(
                    "VIEW_REQUIRED",
                    "地图操作需要打开桌面窗口；后台没有地图视图",
                ));
            }
            if id == "builtin-data-input" {
                return Box::pin(execute(app, conversation, &name, arguments, key)).await;
            }
            if id == "builtin-data-downloads"
                || id == "builtin-schedules"
                || id == "builtin-data-schedules"
                || id == "builtin-cache"
                || id == "builtin-ai-schedules"
                || id == "builtin-background-commands"
                || id == "builtin-agent-memory"
                || id == "builtin-agent-tasks"
            {
                return Box::pin(execute(app, conversation, &name, arguments, key)).await;
            }
            if id == extensions::SOURCE_CREATOR_ID {
                let value =
                    source_creator::source_creator_call(app.state(), name.clone(), arguments)
                        .await?;
                let result = attach_lookup(app, conversation, &name, value)?;
                return Ok(
                    json!({"connectorId":id,"kind":"builtin","toolName":name,"result":result}),
                );
            }
            Ok(
                json!({"connectorId":id,"toolName":name,"result":extensions::mcp_call(app.state(),app.clone(),state,services,id,name,arguments,key.into(),Some(conversation.into()),None).await?}),
            )
        }
        "mcp_result_read" => Ok(
            json!({"executionId":a["executionId"],"result":extensions::mcp_result_read(app.state(),services,f!("executionId"),f!("offset"))?}),
        ),
        "plan_imagery" | "plan_imagery_batch" => {
            plan(app, conversation, &a, key, tool == "plan_imagery_batch")
        }
        "plans_get" => {
            let id: String = f!("planId");
            assert_plan(app, conversation, &id)?;
            let saved = open_store(&state)?
                .get_plan(&id)?
                .ok_or_else(|| workspace_error("PLAN_NOT_FOUND", "计划不存在"))?;
            Ok(compact_plan(&saved, workspace.permission))
        }
        "jobs_start" => {
            if workspace.permission != crate::WorkspacePermission::FullAccess {
                return Err(workspace_error(
                    "APPROVAL_REQUIRED",
                    "当前工作区要求确认下载计划",
                ));
            }
            let id: String = f!("planId");
            assert_plan(app, conversation, &id)?;
            let saved = crate::jobs_for_plan(state.clone(), id.clone())?;
            let reused = saved.is_some();
            let job = if let Some(job) = saved {
                if !crate::jobs_active(state.clone()).contains(&job.job_id)
                    && matches!(
                        job.state,
                        geod_task_engine::ledger::JobState::Downloading
                            | geod_task_engine::ledger::JobState::Paused
                            | geod_task_engine::ledger::JobState::Failed
                    )
                {
                    crate::jobs_resume(state, job.job_id)?
                } else {
                    job
                }
            } else {
                crate::jobs_start_auto(
                    app.clone(),
                    state,
                    services,
                    id,
                    conversation.into(),
                    key.into(),
                )?
            };
            Ok(
                json!({"jobId":job.job_id,"planId":job.plan_id,"state":job.state,"reused":reused,"background":true}),
            )
        }
        "jobs_list" => {
            let jobs = crate::jobs_list(state.clone())?;
            let active = crate::jobs_active(state);
            let jobs:Vec<_>=jobs.into_iter().filter(|j|assert_plan(app,conversation,&j.plan_id).is_ok()).map(|j|json!({"jobId":j.job_id,"planId":j.plan_id,"state":j.state,"workerActive":active.contains(&j.job_id)})).collect();
            Ok(json!({"jobs":jobs}))
        }
        "jobs_get" | "jobs_events" | "artifacts_inspect" => {
            let id: String = f!("jobId");
            let job = open_store(&state)?
                .get_job(&id)?
                .ok_or_else(|| workspace_error("JOB_NOT_FOUND", "任务不存在"))?;
            assert_plan(app, conversation, &job.plan_id)?;
            if tool == "artifacts_inspect" {
                let mut result = encode(crate::artifacts_inspect(state, id)?)?;
                result.as_object_mut().unwrap().remove("outputDirectory");
                return Ok(result);
            }
            let events = crate::jobs_events(state.clone(), id.clone(), 0)?;
            let active = crate::jobs_active(state);
            let total = open_store(&app.state())?
                .get_plan(&job.plan_id)?
                .map(|p| p.plan.total_tiles)
                .unwrap_or(0);
            Ok(
                json!({"jobId":id,"planId":job.plan_id,"state":job.state,"workerActive":active.contains(&id),"completedTiles":events.iter().filter_map(|e|e.completed_tiles).max().unwrap_or(0),"totalTiles":total,"events":events.into_iter().rev().take(10).collect::<Vec<_>>()}),
            )
        }
        "data_download_plan" => {
            let kind: String = f!("kind");
            let title: String = f!("name");
            let boundary = if let Some(id) = a["boundaryId"].as_str() {
                Some(boundary_inputs::boundaries_get(
                    state.clone(),
                    conversation.into(),
                    id.into(),
                )?)
            } else {
                None
            };
            let bounds = boundary
                .as_ref()
                .map(|b| json!(b.summary.bounds))
                .unwrap_or(a["bounds"].clone());
            let url = a["sourceUrl"]
                .as_str()
                .unwrap_or("https://maps.mail.ru/osm/tools/overpass/api/interpreter");
            let request = if kind == "tiles3d" {
                let mut spec = json!({});
                if let Some(url) = a["sourceUrl"].as_str() {
                    spec["tilesetUrl"] = json!(url);
                }
                if let Some(id) = a["connectionId"].as_str() {
                    spec["connectionId"] = json!(id);
                }
                if !bounds.is_null() {
                    spec["bounds"] = bounds.clone();
                }
                if let Some(b) = &boundary {
                    spec["boundary"] = json!(b.geometry);
                }
                json!({"kind":"tiles3d","spec":spec})
            } else if kind=="online"{
                let mut spec=json!({"outputs":a.get("outputFormats").cloned().unwrap_or(json!(["geojson","gpkg"])),"maxFeatures":a.get("maxFeatures").cloned().unwrap_or(json!(10000)),"pageSize":a.get("pageSize").cloned().unwrap_or(json!(500))});
                for key in ["sourceUrl","onlineConnectionId","layer","sourceCrs"]{if let Some(value)=a.get(key){spec[key]=value.clone();}}
                if !bounds.is_null(){spec["bounds"]=bounds.clone();}
                if let Some(b)=&boundary{spec["boundary"]=json!(b.geometry);}
                json!({"kind":"online","spec":spec})
            } else if matches!(kind.as_str(), "mvt" | "osm") {
                if kind == "mvt" && a["sourceUrl"].as_str().is_none() {
                    return Err(workspace_error(
                        "DATA_PLAN_INVALID",
                        "请提供 MVT 数据服务地址",
                    ));
                }
                let source = if kind == "mvt" {
                    json!({"type":"mvt","id":"agent-mvt","name":title,"urlTemplate":url,"scheme":"xyz","layers":a.get("layers").cloned().unwrap_or(json!([]))})
                } else {
                    json!({"type":"osm","id":"openstreetmap","name":title,"endpoint":url,"tags":a.get("tags").cloned().unwrap_or(json!([]))})
                };
                let mut spec = json!({"source":source,"bounds":bounds,"zoomLevels":a.get("zoomLevels").cloned().unwrap_or(json!([])),"outputs":a.get("outputFormats").cloned().unwrap_or(json!(["geojson","gpkg"])),"allowPartial":a.get("allowPartial").cloned().unwrap_or(json!(false))});
                if let Some(b) = &boundary {
                    spec["boundary"] = json!(b.geometry);
                }
                json!({"kind":"vector","spec":spec})
            } else {
                return Err(workspace_error(
                    "DATA_PLAN_INVALID",
                    "请选择矢量或三维数据类型",
                ));
            };
            let request = serde_json::from_value(request)
                .map_err(|_| workspace_error("DATA_PLAN_INVALID", "数据下载参数无效"))?;
            let task = crate::data_jobs::data_download_plan(
                app.clone(),
                state,
                services,
                conversation.into(),
                title,
                key.into(),
                request,
            )?;
            let mut result = compact_data(&task);
            result["permission"] = json!(workspace.permission);
            result["requiresPlanConfirmation"] =
                json!(workspace.permission != crate::WorkspacePermission::FullAccess);
            result["bounds"] = bounds;
            Ok(result)
        }
        "data_download_list" => Ok(
            json!({"tasks":crate::data_jobs::data_download_list(app.clone(),state,services,conversation.into())?.iter().map(compact_data).collect::<Vec<_>>()}),
        ),
        "data_download_get" => Ok(compact_data(&crate::data_jobs::data_download_get(
            app.clone(),
            state,
            services,
            conversation.into(),
            f!("taskId"),
        )?)),
        "data_download_start" => Ok(compact_data(&crate::data_jobs::data_download_start_auto(
            app.clone(),
            state,
            services,
            conversation.into(),
            f!("taskId"),
            f!("planHash"),
        )?)),
        "data_download_cancel" => Ok(compact_data(&crate::data_jobs::data_download_cancel(
            app.clone(),
            state,
            services,
            conversation.into(),
            f!("taskId"),
        )?)),
        "data_download_discard" => Ok(compact_data(&crate::data_jobs::data_download_discard(
            app.clone(),
            state,
            services,
            conversation.into(),
            f!("taskId"),
        )?)),
        "data_download_inspect" => Ok(compact_data(&crate::data_jobs::data_download_inspect(
            app.clone(),
            state,
            services,
            conversation.into(),
            f!("taskId"),
        )?)),
        "schedules_list" => Ok(
            json!({"schedules":crate::schedules::schedules_list(state.clone(),services.clone(),conversation.into())?,"runs":crate::schedules::schedules_runs(state,services,conversation.into())?}),
        ),
        "schedules_create" => {
            let id: String = f!("planId");
            assert_plan(app, conversation, &id)?;
            encode(crate::schedules::schedules_create(
                app.clone(),
                state,
                services,
                conversation.into(),
                id,
                f!("name"),
                f!("nextRunAt"),
                f!("repeatSeconds"),
                f!("maxRetries"),
                key.into(),
            )?)
        }
        "cache_inventory" => {
            encode(crate::cache_management::cache_inventory(state, services).await?)
        }
        "data_download_load"
        | "source_configure"
        | "source_registration_prepare"
        | "skill_connect"
        | "mcp_connect"
        | "gdal_connect"
        | "workspace_skill_import"
        | "tiles3d_connection_prepare" => Err(workspace_error(
            "USER_INPUT_REQUIRED",
            "此操作需要桌面中的连接、授权或预览操作",
        )),
        _ => Err(workspace_error(
            "BACKGROUND_TOOL_UNSUPPORTED",
            format!("后台尚未接入工具 {tool}"),
        )),
    }
}
fn assert_plan(app: &AppHandle, conversation: &str, id: &str) -> Result<(), AppError> {
    let services = app.state::<services::ServiceState>();
    let state = app.state::<AppState>();
    let owner =
        services::current_user_id(&services).map_err(|e| workspace_error(e.code, e.message))?;
    let workspace = read_workspace(app, &state, &services, conversation)?;
    crate::imagery_recovery::assert_plan_owner(
        &state,
        &owner,
        conversation,
        std::path::Path::new(&workspace.directory),
        id,
    )
}
fn compact_data(task: &crate::data_jobs::DataTask) -> Value {
    let manifest=task.manifest.as_ref().map(|m|{
        let files=m["assets"].as_array().or_else(||m["resources"].as_array()).cloned().unwrap_or_default();
        let fields=m["fields"].as_array().map(|v|v.iter().take(100).cloned().collect::<Vec<_>>());
        let encodings=m["fieldEncodings"].as_object().map(|v|v.iter().take(100).map(|(k,v)|(k.clone(),v.clone())).collect::<serde_json::Map<String,Value>>());
        json!({"bounds":m["bounds"],"featureCount":m["featureCount"],"sourceFeatureCount":m["sourceFeatureCount"],"geometryTypes":m["geometryTypes"],"sourceLayer":m["sourceLayer"],"outputCrs":m["outputCrs"],"fields":fields,"fieldsTruncated":m["fields"].as_array().is_some_and(|v|v.len()>100),"fieldEncodings":encodings,"quality":m["quality"],"failureCount":m["failures"].as_array().map(Vec::len),"warnings":m["warnings"].as_array().map(|v|v.iter().take(10).cloned().collect::<Vec<_>>()).unwrap_or_default(),"dataTimestamp":m["dataTimestamp"],"fileCount":files.len(),"assets":files.iter().take(20).map(|f|json!({"kind":f["kind"],"bytes":f.get("bytes").or_else(||f.get("size")),"sha256":f["sha256"]})).collect::<Vec<_>>(),"assetsTruncated":files.len()>20})
    });
    json!({"taskId":task.id,"kind":task.kind,"title":task.title,"status":task.status,"planHash":task.plan_hash,"progress":task.progress,"error":task.error,"outputLocation":"当前工作区中的新目录","createdAt":task.created_at,"updatedAt":task.updated_at,"manifest":manifest})
}
fn compact_plan(
    p: &geod_task_engine::ledger::StoredPlan,
    permission: crate::WorkspacePermission,
) -> Value {
    json!({"planId":p.plan_id,"planHash":p.plan.plan_hash,"source":p.plan.source_name,"bounds":p.plan.spec.bounds,"zoomLevels":p.plan.spec.zoom_levels,"outputFormats":p.plan.spec.output_formats,"totalTiles":p.plan.total_tiles,"requiredFreeDiskBytes":p.plan.required_free_disk_bytes,"permission":permission,"requiresPlanConfirmation":permission!=crate::WorkspacePermission::FullAccess,"outputLocation":"当前本机工作区中的新文件夹"})
}
fn plan(
    app: &AppHandle,
    conversation: &str,
    a: &Value,
    key: &str,
    batch: bool,
) -> Result<Value, AppError> {
    let state = app.state::<AppState>();
    let services = app.state::<services::ServiceState>();
    let source_id: String = field(a, "sourceId")?;
    let source = open_store(&state)?
        .get_registered_source(&source_id)?
        .ok_or_else(|| workspace_error("SOURCE_NOT_FOUND", "图源不存在"))?;
    let selectors = [
        a.get("zoomLevels").is_some_and(|v| !v.is_null()),
        a.get("zoom").is_some_and(|v| !v.is_null()),
        a.get("zoomMin").is_some_and(|v| !v.is_null())
            || a.get("zoomMax").is_some_and(|v| !v.is_null()),
    ];
    if selectors.iter().filter(|v| **v).count() != 1 {
        return Err(workspace_error("INPUT_INVALID", "请提供一种缩放参数"));
    }
    let levels = if selectors[0] {
        field::<Vec<u8>>(a, "zoomLevels")?
    } else if selectors[1] {
        vec![field(a, "zoom")?]
    } else {
        let min: u8 = field(a, "zoomMin")?;
        let max: u8 = field(a, "zoomMax")?;
        if min > max || max > 22 {
            return Err(workspace_error("INPUT_INVALID", "缩放区间无效"));
        }
        (min..=max).collect()
    };
    if levels.is_empty() || levels.len() > 23 || levels.iter().any(|v| *v > 22) {
        return Err(workspace_error("INPUT_INVALID", "缩放级别无效"));
    }
    let mut ranges = Vec::new();
    if batch {
        let ids: Vec<String> = field(a, "boundaryIds")?;
        if ids.is_empty() || ids.len() > 32 {
            return Err(workspace_error("INPUT_INVALID", "请选择 1 到 32 个范围"));
        }
        if a["mode"] == "merge" {
            ranges.push(Some(boundary_inputs::boundaries_combine(
                state.clone(),
                conversation.into(),
                ids,
                field(a, "name")?,
            )?));
        } else if a["mode"] == "split" {
            for id in ids {
                ranges.push(Some(boundary_inputs::boundaries_get(
                    state.clone(),
                    conversation.into(),
                    id,
                )?));
            }
        } else {
            return Err(workspace_error("INPUT_INVALID", "批量模式无效"));
        }
    } else {
        ranges.push(if let Some(id) = a["boundaryId"].as_str() {
            Some(boundary_inputs::boundaries_get(
                state.clone(),
                conversation.into(),
                id.into(),
            )?)
        } else {
            None
        });
    }
    let workspace = read_workspace(app, &state, &services, conversation)?;
    let mut result = Vec::new();
    for (i, range) in ranges.into_iter().enumerate() {
        let directory = crate::output_directory_suggest(
            app.clone(),
            state.clone(),
            services.clone(),
            conversation.into(),
        )?;
        let mut options = a.get("exportOptions").cloned().unwrap_or(json!({}));
        if let Some(ids) = a.get("overlaySourceIds") {
            let ids: Vec<String> = serde_json::from_value(ids.clone())
                .map_err(|_| workspace_error("INPUT_INVALID", "注记参数无效"))?;
            let store = open_store(&state)?;
            options["overlaySources"] = json!(ids
                .into_iter()
                .map(|id| store
                    .get_registered_source(&id)?
                    .map(|s| json!({"sourceId":id,"configRevision":s.descriptor.config_revision}))
                    .ok_or_else(|| workspace_error("SOURCE_NOT_FOUND", "注记图源不存在")))
                .collect::<Result<Vec<_>, AppError>>()?);
        }
        let mut spec = json!({"schemaVersion":"0.1","kind":"imagery","sourceId":source_id,"bounds":range.as_ref().map(|r|json!(r.summary.bounds)).unwrap_or(a["bounds"].clone()),"zoomLevels":levels,"outputFormats":a["outputFormats"],"exportOptions":options,"outputDirectory":directory,"limits":{"maxTiles":1000000,"maxDecodedRgbaBytes":1099511627776u64}});
        if let Some(range) = &range {
            spec["boundary"] = json!(range.geometry);
        }
        let spec = serde_json::from_value(spec)
            .map_err(|_| workspace_error("INPUT_INVALID", "影像计划参数无效"))?;
        let saved = crate::plans_create(
            app.clone(),
            state.clone(),
            services.clone(),
            conversation.into(),
            spec,
            format!("{key}:{i}"),
        )?;
        let mut compact = compact_plan(&saved, workspace.permission);
        compact["name"] = range
            .map(|r| r.summary.name)
            .map(Value::String)
            .unwrap_or(json!(source.descriptor.display_name));
        result.push(compact);
    }
    Ok(if batch {
        json!({"plans":result,"errors":[]})
    } else {
        result.into_iter().next().unwrap_or(Value::Null)
    })
}
fn attach_lookup(
    app: &AppHandle,
    conversation: &str,
    tool: &str,
    mut value: Value,
) -> Result<Value, AppError> {
    if tool == "lookup_boundaries" {
        if let Some(items) = value["items"].as_array_mut() {
            for item in items {
                *item = attach_lookup(app, conversation, "lookup_boundary", item.clone())?;
            }
        }
    } else if matches!(tool, "lookup_boundary" | "wayback_changes") && !value["boundary"].is_null()
    {
        let boundary = serde_json::from_value(value["boundary"].take())
            .map_err(|_| workspace_error("INPUT_INVALID", "范围结果无效"))?;
        let saved = range(encode(boundary_inputs::boundaries_save(
            app.state(),
            conversation.into(),
            boundary,
        )?)?);
        for (key, val) in saved.as_object().unwrap() {
            value[key] = val.clone();
        }
        value.as_object_mut().unwrap().remove("boundary");
    }
    Ok(value)
}
async fn discover(app: &AppHandle, conversation: &str, query: &str) -> Result<Value, AppError> {
    let installed = encode(extensions::extensions_list(app.state(), app.state())?)?;
    let mut connectors = Vec::new();
    for connector in installed["connectors"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|c| c["enabled"] == true)
    {
        let id = connector["id"].as_str().unwrap_or("");
        let result = extensions::mcp_tools(
            app.state(),
            app.clone(),
            app.state(),
            app.state(),
            id.into(),
            Some(conversation.into()),
        )
        .await;
        if let Ok(mut list) = result {
            list["connectorId"] = json!(id);
            connectors.push(list);
        }
    }
    if let Ok(list) = source_creator::source_creator_tools(app.state()) {
        connectors.push(list);
    }
    let mut list = json!({"connectorId":"builtin-data-input","name":"文件 / 在线数据 / 数据库","tools":[]});
    let definitions: Value = serde_json::from_str(include_str!("../codex-tools.json")).unwrap();
    list["tools"]=json!(definitions.as_array().unwrap().iter().filter(|t|matches!(t["function"]["name"].as_str(),Some("data_input_read"|"data_layer_inspect"|"data_connections_list"|"data_connection_connect"|"sql_connections_list"|"sql_connection_connect"|"sql_objects_search"|"sql_query"))).map(|t|json!({"name":t["function"]["name"],"description":t["function"]["description"],"inputSchema":t["function"]["parameters"]})).collect::<Vec<_>>());
    connectors.push(list);
    for (id, name, prefix) in [
        ("builtin-agent-memory", "偏好与记忆", "agent_memory_"),
        ("builtin-agent-tasks", "独立子任务 Agent", "agent_tasks_"),
        ("builtin-background-commands", "后台命令", "background_command_"),
        ("builtin-ai-schedules", "AI 定时执行", "ai_schedules_"),
        (
            "builtin-data-downloads",
            "矢量与三维数据下载",
            "data_download_",
        ),
        ("builtin-schedules", "定时影像下载", "schedules_"),
    ] {
        let tools:Vec<_>=definitions.as_array().unwrap().iter().filter(|t|t["function"]["name"].as_str().is_some_and(|n|n.starts_with(prefix))).map(|t|json!({"name":t["function"]["name"],"description":t["function"]["description"],"inputSchema":t["function"]["parameters"]})).collect();
        connectors.push(json!({"connectorId":id,"name":name,"tools":tools}));
    }
    let needle = query.to_lowercase();
    let terms: Vec<_> = needle.split_whitespace().collect();
    let registered_apps:Vec<_>=installed["registeredApps"].as_array().into_iter().flatten().filter(|app|terms.is_empty()||terms.iter().any(|term|app.to_string().to_lowercase().contains(term))).collect();
    let referenced:Vec<_>=registered_apps.iter().filter(|app|app["route"]=="bundledMcp"&&app["enabled"]==true).filter_map(|app|app["connectorId"].as_str()).collect();
    if !terms.is_empty() {
        connectors.retain(|c| {
            let haystack = c.to_string().to_lowercase();
            terms.iter().any(|term| haystack.contains(term))||c["connectorId"].as_str().is_some_and(|id|referenced.contains(&id))
        });
    }
    Ok(
        json!({"skills":installed["skills"].as_array().into_iter().flatten().filter(|s|s["enabled"]==true).collect::<Vec<_>>(),"connectors":connectors,"registeredApps":registered_apps,"desktopMapAvailable":false}),
    )
}
