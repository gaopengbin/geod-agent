import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { api } from "./api";
import { CodexRequestCard, type CodexRequest } from "./codex-request";

/** Native authenticated and stdio MCP requests retain their conversation owner. */
export function McpRequestQueue({conversationId,accountId}:{conversationId:string;accountId:string|null}){
  const[requests,setRequests]=useState<CodexRequest[]>([]);
  useEffect(()=>{
    setRequests([]);if(!accountId||!conversationId)return;
    let live=true,revision=0,unlisten:(()=>void)|undefined;
    const refresh=async()=>{const current=++revision;try{const value=await api.mcpPendingRequests(conversationId);if(live&&current===revision)setRequests(value);}catch{if(live&&current===revision)setRequests([]);}};
    void listen("geod:mcp-requests-changed",()=>void refresh()).then(stop=>{if(live){unlisten=stop;void refresh();}else stop();});
    return()=>{live=false;unlisten?.();};
  },[conversationId,accountId]);
  const request=requests[0];
  return request?<CodexRequestCard key={request.requestId} request={request} respond={async value=>{await api.mcpRequestReply(request.requestId,value);setRequests(previous=>previous.filter(item=>item.requestId!==request.requestId));}}/>:null;
}
