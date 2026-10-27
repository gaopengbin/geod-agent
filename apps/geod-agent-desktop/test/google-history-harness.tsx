import {createRoot} from 'react-dom/client';
import * as Tooltip from '@radix-ui/react-tooltip';
import {ChatTranscript} from '../src/chat-ui';
import {toolDisplay} from '../src/agent-workflow';
import {setLanguagePreferences} from '../src/i18n';
import {turnOutcomeMessage} from '../src/turn-outcome';
import {buildTaskFeedback} from '../src-tauri/task-feedback.mjs';
import type {DisplayMessage} from '../src/pending-generations';
import '../src/styles.css';import '../src/theme.css';import '../src/workspace.css';
const english=new URLSearchParams(location.search).get('lang')==='en';
setLanguagePreferences({language:english?'en':'zh-CN'});
const feedback=buildTaskFeedback({code:'SOURCE_PROTOCOL',english});
const messages:DisplayMessage[]=[
 {id:'human',role:'user',content:english?'Find Google Earth imagery on or before 2010-12-31.':'查询截至 2010-12-31 的谷歌历史影像。'},
 {id:'dates',role:'tool',...toolDisplay('mcp_call',{toolName:'google_history_dates',result:{total:23}})},
 {id:'source',role:'tool',...toolDisplay('mcp_call',{toolName:'google_history_source',result:{history:{requestedDate:'2010-11-08'}}})},
 turnOutcomeMessage('fixture',{status:'failed',code:'SOURCE_PROTOCOL',message:feedback.reason,feedback})];
createRoot(document.getElementById('root')!).render(<Tooltip.Provider><main className="agent-chat" style={{height:'100dvh',width:'100%',maxWidth:900,margin:'0 auto',padding:16}}><ChatTranscript conversationId="history-presentation-fixture" messages={messages} busy={false} activity=""/></main></Tooltip.Provider>);
document.documentElement.dataset.fixture='google-history-presentation';
