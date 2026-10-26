/** Host-owned operation IDs survive model call IDs and process recreation. */
export function nativeToolExecutionId(executionId:string,callId:string){
 return /^runtime-operation:[a-f0-9-]{36}$/i.test(executionId)?executionId:`${executionId}:${callId}`;
}
