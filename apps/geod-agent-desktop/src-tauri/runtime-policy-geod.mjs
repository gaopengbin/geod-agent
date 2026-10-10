// Versioned GeoD adapters: domain facts live here; the policy engine is generic.
export const ERROR_CLASSES={
 transient:{codes:['REGISTRY_UNAVAILABLE','CONNECTOR_UNAVAILABLE','RATE_LIMITED','NETWORK_TIMEOUT','NETWORK_ERROR','HTTP_429','HTTP_502','HTTP_503','HTTP_504'],pattern:'(?:_NETWORK_ERROR|_TIMEOUT|_RATE_LIMITED)$',condition:'service cooldown or availability',recovery:'backoff'},
 parameter:{codes:['TOOL_ARGUMENT_INVALID','INVALID_BOUNDARY_SELECTION','INVALID_JOB_ID','MCP_RESULT_EXPORT_INVALID','REPLAN_AFTER_USER_INPUT'],pattern:'^(?:INVALID_|.*_INVALID$|.*_ARGUMENT)',condition:'corrected arguments or current requirement revision',recovery:'repair'},
 permission:{codes:['APPROVAL_REQUIRED','USER_INPUT_REQUIRED','GIS_WRITE_REQUIRED','WORKSPACE_WRITE_REQUIRED','PERMISSION_DENIED'],pattern:'(?:_APPROVAL_REQUIRED|_PERMISSION_DENIED|_WRITE_REQUIRED)$',condition:'native approval or workspace permission revision',recovery:'wait'},
 authentication:{codes:['AUTH_REQUIRED','LOGIN_REQUIRED','ACCOUNT_CHANGED','MCP_AUTH_REQUIRED'],pattern:'(?:_AUTH_REQUIRED|_LOGIN_REQUIRED)$',condition:'native authentication revision',recovery:'wait'},
 capability:{codes:['TOOL_NOT_ALLOWED','TOOL_NOT_FOUND','SOURCE_TOOL_NOT_FOUND','IMAGE_UNSUPPORTED','MODEL_IMAGE_UNSUPPORTED','TOOL_SCHEMA_UNSUPPORTED','MCP_CANDIDATE_NOT_FOUND'],pattern:'(?:_UNSUPPORTED|_TOOL_NOT_FOUND)$',condition:'current capability or discovered contract revision',recovery:'discover-or-fallback'},
 unknownOutcome:{codes:['MCP_RESULT_UNKNOWN','OPERATION_RESULT_UNKNOWN','JOB_START_UNKNOWN','COMMAND_RESULT_UNKNOWN'],pattern:'(?:_RESULT_UNKNOWN|_OUTCOME_UNKNOWN)$',condition:'native operation reconciliation',recovery:'reconcile'},
 business:{codes:['SOURCE_UNAVAILABLE','PLAN_EXPIRED','PLAN_NOT_FOUND','QUOTA_EXCEEDED','OUTSIDE_COVERAGE','LICENSE_DENIED'],condition:'business object state',recovery:'state-or-alternative'},
 internal:{codes:['TOOL_INTERNAL_ERROR','TOOL_FAILED'],condition:'diagnosis or implementation repair',recovery:'diagnose'},
};
const tools={};
const group=(names,spec)=>{for(const name of names.split(' '))tools[name]={purpose:name,...spec};};
group('attachment_list attachment_read sql_connections_list sql_objects_search sql_query data_input_read data_connections_list data_layer_inspect workspace_status workspace_boundaries_list workspace_gis_files_list sources_list plans_get jobs_list jobs_get jobs_events artifacts_inspect extensions_list workspace_skills_list skill_catalog_search skill_source_inspect skill_read mcp_result_read agent_tasks_list agent_tasks_get agent_tasks_read_file data_download_list data_download_get data_download_inspect data_schedules_list cache_inventory cache_verify cache_maintenance_status tiles3d_connections_list tiles3d_connection_test schedules_list boundaries_list',{effect:'read'});
group('jobs_list jobs_get jobs_events data_download_list data_download_get agent_tasks_list agent_tasks_get schedules_list data_schedules_list cache_maintenance_status',{effect:'read',wait:true});
group('mcp_registry_search',{effect:'read',purpose:'connector-discovery',conditionScope:'mcp-registry'});
group('ask_user',{effect:'interactive'});
group('mcp_call',{effect:'external'});
group('worker_files_list worker_file_read',{effect:'read'});
group('runtime_tools_search',{effect:'read',purpose:'tool-discovery'});
group('runtime_context_read',{effect:'read',purpose:'context-discovery'});
group('worker_file_write',{effect:'external'});
group('background_command_list background_command_get agent_memory_list ai_schedules_list ai_schedules_run_events',{effect:'read',wait:true});
group('background_command_prepare background_command_start background_command_stop background_command_write agent_memory_save agent_memory_remove ai_schedules_create ai_schedules_set_enabled ai_schedules_cancel_run ai_schedules_retry_run',{effect:'external'});
group('source_configure source_registration_prepare sql_connection_connect data_connection_connect workspace_skill_import skill_connect mcp_connect gdal_connect tiles3d_connection_prepare',{effect:'prepare'});
group('plan_imagery plan_imagery_batch data_download_plan imagery_recovery_plan',{effect:'prepare'});
group('workspace_boundary_use us_county_boundary boundaries_combine mcp_result_export agent_tasks_spawn agent_tasks_cancel data_download_start data_download_cancel data_download_discard data_download_load schedules_cancel_run schedules_create schedules_set_enabled data_schedules_create data_schedules_set_enabled data_schedules_cancel_run cache_maintenance_cancel',{effect:'external'});
group('jobs_start',{effect:'external',purpose:'imagery-download-submit',resource:['planId'],conditionScope:'imagery-download-approval'});
export function completionEvidence(tool,args,result){
 if(['jobs_start','jobs_get','data_download_start','data_download_get'].includes(tool)){
  const done=result?.backgroundResult,id=tool.startsWith('jobs_')?result?.jobId:result?.taskId??result?.id;
  if(tool==='jobs_get'&&id!==args.jobId||tool==='data_download_get'&&id!==args.taskId)return false;
  return !!id&&(done?.jobId??done?.taskId)===id&&done.state==='completed'&&done.verified===true&&Array.isArray(done.artifact?.assets)&&done.artifact.assets.length>0&&done.artifact.assets.every(a=>a.bytes>0&&/^[a-f0-9]{64}$/i.test(a.sha256??''));
 }
 if(tool==='artifacts_inspect')return result?.jobId===args.jobId&&result?.quality?.status==='complete'&&result.quality.missingTiles===0&&Array.isArray(result.assets)&&result.assets.length>0&&result.assets.every(a=>a.bytes>0&&/^[a-f0-9]{64}$/i.test(a.sha256??''));
 if(tool==='data_download_inspect'){const assets=result?.manifest?.assets??result?.manifest?.resources;return (result?.taskId??result?.id)===args.taskId&&result.status==='completed'&&Array.isArray(assets)&&assets.length>0&&assets.every(a=>(a.bytes??a.size)>0&&/^[a-f0-9]{64}$/i.test(a.sha256??''));}
 return false;
}
export const GEOD_POLICY={version:1,transientRetries:2,retryDelayMs:150,maxRetryDelayMs:10000,cooldownMs:30000,stagnationThreshold:3,tools,nativeConnectors:['builtin-data-downloads','builtin-data-schedules','builtin-cache','builtin-background-commands','builtin-agent-tasks','builtin-agent-memory','builtin-ai-schedules','builtin-tiles3d-connections']};
