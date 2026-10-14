// UI-only fixture: no account, provider, budget or credential mutations.
import {createRoot} from 'react-dom/client';
import {AIChannelsPage} from '../src/ai-channels-page';
import {aiChannels,type AIChannelList} from '../src/ai-channels';
import {contextSettings,type ContextSettingsView} from '../src/context-settings';
import {TooltipProvider} from '../src/ui-tooltip';
import '../src/styles.css';import '../src/theme.css';import '../src/workspace.css';
const theme=new URLSearchParams(location.search).get('theme')??'light';document.documentElement.dataset.theme=theme;
const list:AIChannelList={default:{channelId:'hosted',modelId:'hosted'},usage:[],channels:[{id:'fixture',name:'我的模型渠道',baseUrl:'https://api.example.com/v1',protocol:'chatCompletions',enabled:true,keyConfigured:true,revision:'fixture',billingScope:'personal',models:[{id:'fixture-model',name:'DeepSeek',contextWindow:128000,maxOutputTokens:4096,inputModalities:['text'],thinking:null}]}]};
aiChannels.list=async()=>list;
let view:ContextSettingsView={preferences:{contextWindowTokens:null,autoCompactPercent:90},model:'deepseek-v4-flash-0731',modelContextWindow:128000,maxOutputTokens:4096,effectiveContextWindow:128000,autoCompactTokenLimit:115200,spending:{budgetCredits:null,spentCredits:102.02,recordedRequests:24,unknownRequests:1}};
const qa={reads:0,saves:0};Object.assign(window,{channelsLayoutQa:qa});
contextSettings.get=async()=>{qa.reads++;return structuredClone(view);};
contextSettings.set=async(_owner,_conversation,preferences,budgetCredits)=>{qa.saves++;view={...view,preferences,spending:{...view.spending!,budgetCredits}};return structuredClone(view);};
createRoot(document.getElementById('root')!).render(<TooltipProvider><div style={{display:'grid',gridTemplateColumns:'min(17vw,220px) minmax(0,1fr)',height:'100dvh'}}><aside className="conversation-sidebar" style={{padding:16}}>GeoD Agent</aside><AIChannelsPage active accountId="layout-fixture" conversationId="fixture" onReturn={()=>{}}/></div></TooltipProvider>);
