const string = {type:'string'};
const tool = (name, description, properties={}, required=[]) => ({type:'function',function:{name,description,parameters:{type:'object',properties,required,additionalProperties:false}}});
export const MAINTENANCE_TOOLS = [
 tool('imagery_recovery_plan','Create a new immutable imagery recovery plan for a job in this conversation when the user asks. retryMissing reuses hash-verified cached tiles (including old valid tiles) and downloads only missing data; exportAvailable uses cached tiles without network and leaves missing areas blank. Original output is retained. Does not start downloading: fullAccess may use jobs_start; confirmEach waits for UI confirmation. The native layer rechecks ownership, source revisions and current workspace.',{jobId:string,mode:{type:'string',enum:['retryMissing','exportAvailable']}},['jobId','mode']),
 tool('data_schedules_create','Schedule a real vector/3D download task for later or periodically, only on user request. Every occurrence gets an independent output and fresh cache; current workspace permission is checked again at execution. App must be running. Missed periods coalesce into one run. nextRunAt is ISO-8601 with timezone; omit repeatSeconds for once.',{taskId:string,name:string,nextRunAt:string,repeatSeconds:{type:'integer',minimum:60,maximum:31536000}},['taskId','name','nextRunAt']),
 tool('data_schedules_list','Read this conversation’s vector/3D schedules and actual run states.'),
 tool('data_schedules_set_enabled','Pause/resume future occurrences on user request. Active downloads are unaffected. Supply a future nextRunAt when restarting a completed one-time schedule.',{scheduleId:string,enabled:{type:'boolean'},nextRunAt:string},['scheduleId','enabled']),
 tool('data_schedules_cancel_run','Cancel one actual vector/3D scheduled occurrence on user request. Future recurring triggers remain enabled.',{runId:string},['runId']),
 tool('cache_inventory','Read the native imagery cache inventory and current storage location. Cache availability is not proof that an output file exists.'),
 tool('cache_verify','Start a background read-only SHA and image-dimension verification of imagery caches when asked. Does not remove files or move storage. Returns operationId; UI shows progress, so do not continuously poll.'),
 tool('cache_maintenance_status','Read the actual status of a previously started cache verification.',{operationId:string},['operationId']),
 tool('cache_maintenance_cancel','Cancel an in-progress cache verification when requested.',{operationId:string},['operationId']),
];
