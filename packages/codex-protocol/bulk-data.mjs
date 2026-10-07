// Wire-only compaction of legacy MCP coordinate pages. The native receipt and
// original display history remain intact; no signed provider state is changed.
export const BULK_DATA_POLICY = 'Large geometry tool results are retained locally and marked bulkData with an executionId, metadata and exact jsonPointer references. Use mcp_result_export to materialize the original JSON or referenced field in the current workspace, then process that file with actual local tools or scripts. An empty jsonPointer exports the entire original result. This requires the current workspace write permission; do not bypass it. Embedded MCP content text containing JSON is decoded locally by the export tool. Never page through coordinate arrays, copy coordinates into reasoning, reconstruct geometry from a summary, simplify points or infer a source CRS. Keep reasoning concise and inspect actual source metadata before spatial processing. Local scripts must print only bounded metadata/file references, never the full geometry. For legacyGeometryPage results the original receipt remains available through the same export tool. Non-geometry pages may still be read when their actual content is needed. Reuse confirmed requirements after resuming; verify existing plans/jobs before creating or starting another download.';

export function compactGeometryToolOutput(output) {
  if (typeof output !== 'string') return output;
  let value; try { value = JSON.parse(output); } catch { return output; }
  if (!value || typeof value !== 'object') return output;
  const page = value.result ?? value;
  if (!page || page.paged !== true || typeof page.executionId !== 'string' || typeof page.content !== 'string') return output;
  // Match repeated numeric coordinate pairs, including JSON arrays and Amap's
  // semicolon polyline strings. A single bounding box must remain unaffected.
  const pairs = page.content.match(/[-+]?\d+(?:\.\d+)?(?:e[-+]?\d+)?\s*,\s*[-+]?\d+(?:\.\d+)?(?:e[-+]?\d+)?/gi) ?? [];
  if (pairs.length < 64) return output;
  const compact = {
    bulkData: true, legacyGeometryPage: true, executionId: page.executionId,
    totalChars: page.totalChars, retainedLocally: true, requiresLocalProcessing: true,
    exportTool: 'mcp_result_export',
    notice: 'This historical coordinate page is omitted from model context. The complete original MCP receipt remains on this device. Export its original JSON using executionId, then use local tools on that file. This is metadata, not the complete geometry or evidence that the whole result was reviewed.',
  };
  return JSON.stringify(value.result ? {...value,result:compact} : compact);
}

export function compactGeometryRequest(request) {
  return {...request,input:(request.input??[]).map(item => {
    if (!['function_call_output','custom_tool_call_output'].includes(item.type)) return item;
    if (typeof item.output === 'string') return {...item,output:compactGeometryToolOutput(item.output)};
    if (Array.isArray(item.output)) return {...item,output:item.output.map(part =>
      ['input_text','output_text','text'].includes(part.type) && typeof part.text === 'string'
        ? {...part,text:compactGeometryToolOutput(part.text)} : part)};
    return item;
  })};
}

export function compactGeometryHistory(messages) {
  return (messages??[]).map(message=>message.role==='tool'&&typeof message.content==='string'
    ? {...message,content:compactGeometryToolOutput(message.content)} : message);
}

/** Embedded maps return inline GeoJSON, unlike external MCP paged receipts. */
export function hasBulkGeometry(value) {
  let points=0;
  const count=v=>{if(!Array.isArray(v))return;if(v.length>=2&&v.every(n=>typeof n==='number'&&Number.isFinite(n)))points++;else v.forEach(count);};
  const visit=(v,key='')=>{
    if(points>=64)return;
    if(['coordinates','positions'].includes(key)&&Array.isArray(v)){count(v);return;}
    if(Array.isArray(v))v.forEach(child=>visit(child));
    else if(v&&typeof v==='object')Object.entries(v).forEach(([name,child])=>visit(child,name));
    else if(key==='text'&&typeof v==='string'){try{visit(JSON.parse(v));}catch{}}
  };
  visit(value);return points>=64;
}
export async function persistEmbeddedGeometryRequest(request,save) {
  const calls=new Map();let changed=false;const input=[];
  for(const item of request.input??[]){
    if(item.type==='function_call'&&item.name==='mcp_call'){try{calls.set(item.call_id,JSON.parse(item.arguments));}catch{}}
    if(item.type!=='function_call_output'||typeof item.output!=='string'){input.push(item);continue;}
    const call=calls.get(item.call_id);
    if(!call||!['builtin-openlayers-mcp','builtin-cesium-mcp'].includes(call.connectorId)){input.push(item);continue;}
    let parsed;try{parsed=JSON.parse(item.output);}catch{input.push(item);continue;}
    const result=parsed.result??parsed;
    if(result?.bulkData||!hasBulkGeometry(result)){input.push(item);continue;}
    // Failure stops this request; never claim a reference exists before saving it.
    const summary=await save({connectorId:call.connectorId,toolName:call.toolName,arguments:call.arguments??{},callId:item.call_id,result});
    if(!summary?.bulkData||typeof summary.executionId!=='string')throw new Error('LOCAL_GEOMETRY_NOT_SAVED');
    input.push({...item,output:JSON.stringify(parsed.result?{...parsed,result:summary}:summary)});changed=true;
  }
  return changed?{...request,input}:request;
}

export async function persistEmbeddedGeometryHistory(messages,save) {
 const input=[];const outputs=new Map();
 (messages??[]).forEach((message,index)=>{
  if(message.role==='assistant')for(const call of message.tool_calls??[])input.push({type:'function_call',name:call.function?.name,call_id:call.id,arguments:call.function?.arguments});
  if(message.role==='tool'&&typeof message.content==='string'&&message.tool_call_id){outputs.set(input.length,index);input.push({type:'function_call_output',call_id:message.tool_call_id,output:message.content});}
 });
 const request={input},next=await persistEmbeddedGeometryRequest(request,save);if(next===request)return messages;
 const result=[...messages];for(const [i,index]of outputs)if(next.input[i]!==input[i])result[index]={...messages[index],content:next.input[i].output};return result;
}
