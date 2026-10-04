import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useState } from "react";
import { desktopAvailable, errorMessage } from "./api";

export const AI_CHANNELS_CHANGED = "geod:ai-channels-changed";
// Keep the integration available for a later release; omit its beta UI for now.
export const SPONSORED_CHANNELS_VISIBLE = false;
export interface AIModel { id: string; name: string; contextWindow: number; maxOutputTokens: number; inputModalities: ("text" | "image")[]; thinking: "enabled" | "disabled" | "adaptive" | null }
export type AIProtocol = "responses" | "chatCompletions" | "anthropic" | "gemini";
export const protocolName=(protocol:AIProtocol)=>({responses:"Responses",chatCompletions:"Chat Completions",anthropic:"Claude Messages",gemini:"Gemini"})[protocol];
export interface AIChannel { id: string; name: string; baseUrl: string; protocol: AIProtocol; enabled: boolean; models: AIModel[]; keyConfigured: boolean; revision: string; billingScope: "personal" }
export interface AISelection { channelId: string; modelId: string }
export interface AIChannelUsage { channelId: string; model: string; inputTokens: number | null; outputTokens: number | null; requests: number; unknownUsageRequests: number }
export interface AISponsor {id:string;name:string;description:string;website:string|null;revision:string;enabled:boolean;protocol?:AIProtocol;startsAt?:string|null;endsAt?:string|null;models:AIModel[];billingScope:"sponsored";usage:{quotaEnforced:boolean;limitTokens:number|null;remainingTokens:number|null;committedTokens:number;reservedTokens:number;pendingReconcile:number;totalLimitTokens:number|null;budgetPeriod?:'month';periodStart?:string;periodEnd?:string;priorReservedTokens?:number}}
export interface AIChannelList { channels: AIChannel[]; sponsors?:AISponsor[];sponsorsUpdatedAt?:string|null;default: AISelection; usage: AIChannelUsage[] }
export type AIChannelDraft = Pick<AIChannel, "name" | "baseUrl" | "protocol" | "enabled" | "models"> & { id?: string; apiKey?: string };
export const aiChannels = {
  list: () => invoke<AIChannelList>("ai_channels_list"),
  sponsors:(force=false)=>invoke<{sponsors:AISponsor[];sponsorsUpdatedAt:string}>("ai_sponsors_refresh",{force}),
  openSponsorWebsite:(id:string)=>invoke<{opened:boolean}>("ai_sponsor_open_website",{id}),
  save: (draft: AIChannelDraft) => invoke<AIChannel>("ai_channel_save", { draft }),
  remove: (channelId: string) => invoke<void>("ai_channel_remove", { channelId }),
  models: (channelId: string) => invoke<{ models: { id: string }[]; catalogueReadable: boolean }>("ai_channel_models", { channelId }),
  probe: (baseUrl: string, apiKey?: string, channelId?: string, protocol?:AIProtocol) => invoke<{ models: { id: string }[]; catalogueReadable: boolean }>("ai_channel_probe", { probe: { baseUrl, apiKey, channelId,protocol } }),
  select: (conversationId: string, channelId: string, modelId: string) => invoke<AISelection>("ai_model_select", { conversationId, channelId, modelId }),
  selection: (conversationId: string, existingConversation = false) => invoke<AISelection>("ai_model_selection", { conversationId, existingConversation }),
};
export const notifyChannelsChanged = () => window.dispatchEvent(new Event(AI_CHANNELS_CHANGED));
export const modelValue = (channelId: string, modelId: string) => JSON.stringify([channelId, modelId]);
export function sponsorAvailability(sponsor:AISponsor,now=Date.now()){
  if(!sponsor.enabled)return 'disabled';
  if(sponsor.startsAt&&now<Date.parse(sponsor.startsAt))return 'scheduled';
  if(sponsor.endsAt&&now>=Date.parse(sponsor.endsAt))return 'ended';
  return 'active';
}
let budgetRefresh:Promise<unknown>|undefined;
/** Re-render at an activity boundary and fetch authoritative usage after a budget month. */
export function useSponsorClock(sponsors:AISponsor[]|undefined){
  const [now,setNow]=useState(Date.now);
  useEffect(()=>{
    const current=Date.now();
    if((sponsors??[]).some(s=>s.usage.budgetPeriod==='month'&&s.usage.periodEnd&&Date.parse(s.usage.periodEnd)<=current)){
      let active=true,timer:ReturnType<typeof setTimeout>|undefined;
      const refresh=budgetRefresh??=aiChannels.sponsors(true).finally(()=>{budgetRefresh=undefined});
      void refresh.then(()=>{if(active)notifyChannelsChanged()}).catch(()=>{if(active)timer=setTimeout(()=>setNow(Date.now()),30_000)});
      return()=>{active=false;clearTimeout(timer)};
    }
    const next=(sponsors??[]).flatMap(sponsor=>[sponsor.startsAt,sponsor.endsAt,sponsor.usage.periodEnd]).filter((value):value is string=>!!value).map(Date.parse).filter(at=>at>current).sort((a,b)=>a-b)[0];
    if(next===undefined)return;
    const timer=setTimeout(()=>setNow(Date.now()),Math.min(2_147_000_000,next-current+20));return()=>clearTimeout(timer);
  },[sponsors,now]);
}
export function availableAIChannels(list:AIChannelList|null){return [...(list?.channels??[]).filter(channel=>channel.enabled).map(channel=>({id:channel.id,name:channel.name,models:channel.models})),...(SPONSORED_CHANNELS_VISIBLE?list?.sponsors??[]:[]).filter(sponsor=>sponsorAvailability(sponsor)==='active'&&(!sponsor.usage.quotaEnforced||sponsor.usage.remainingTokens!==0)).map(sponsor=>({id:`sponsor:${sponsor.id}`,name:sponsor.name,models:sponsor.models}))];}
export function useAIModels(accountId: string | null, conversationId: string, existingConversation = false) {
  const [list, setList] = useState<AIChannelList | null>(null);
  const [selection, setSelection] = useState<AISelection>({ channelId: "hosted", modelId: "hosted" });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  useSponsorClock(SPONSORED_CHANNELS_VISIBLE?list?.sponsors:undefined);
  useEffect(() => {
    let active = true;
    setList(null); setError(""); setSelection({ channelId: "hosted", modelId: "hosted" });
    if (!desktopAvailable || !accountId || !conversationId) return;
    const refresh = async () => {
      setLoading(true);
      try { const [nextList, nextSelection] = await Promise.all([aiChannels.list(), aiChannels.selection(conversationId, existingConversation)]); if (active) { setList(nextList); setSelection(nextSelection); setError(""); } }
      catch (cause) { if (active) setError(errorMessage(cause)); }
      finally { if (active) setLoading(false); }
      if(SPONSORED_CHANNELS_VISIBLE)void aiChannels.sponsors().then(()=>aiChannels.list()).then(next=>{if(active)setList(next)}).catch(()=>{});
    };
    void refresh(); window.addEventListener(AI_CHANNELS_CHANGED, refresh);
    return () => { active = false; window.removeEventListener(AI_CHANNELS_CHANGED, refresh); };
  }, [accountId, conversationId, existingConversation]);
  const select = useCallback(async (channelId: string, modelId: string) => {
    setLoading(true); setError("");
    try { const next = await aiChannels.select(conversationId, channelId, modelId); setSelection(next); }
    catch (cause) { setError(errorMessage(cause)); throw cause; }
    finally { setLoading(false); }
  }, [conversationId]);
  return { list, selection, select, loading, error };
}
