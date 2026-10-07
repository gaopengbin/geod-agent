import test from 'node:test';import assert from 'node:assert/strict';
import {repairSavedMcpHistory,knownSavedMcpAddress} from '../src/mcp-history-repair.ts';
import {userApprovedMcpUrl} from '../src/mcp-onboarding.ts';
const connector={id:'saved-amap',name:'高德地图 MCP',url:'https://mcp.amap.com/mcp',enabled:false,queryNames:['key']};
const human={id:'human',role:'user',content:'再看看呢'};
const failure={id:'failure',role:'tool',toolName:'mcp_connect',details:JSON.stringify({arguments:{url:connector.url},result:{error:'MCP_URL_NOT_USER_PROVIDED'}})};
const question={id:'question',role:'tool',userInput:{requestId:'ask',userMessageId:'human',userText:human.content,status:'pending',createdAt:'',questions:[{id:'url',header:'服务地址',question:'请选择高德 MCP 服务地址',options:[{label:connector.url,description:'official'},{label:'https://mcp.amap.com/sse',description:'unverified alternative'}]}]}};
test('redundant address question becomes an explained local fact; no user reply or automatic enabling is invented',()=>{
 const messages=[human,failure,question],fixed=repairSavedMcpHistory(messages,[connector]);assert.equal(fixed[2].userInput.status,'resolved');assert.equal(fixed[2].userInput.reply,undefined);assert.equal(fixed[2].userInput.resolution.connectorId,connector.id);assert.equal(fixed[1].extensionProposal.id,connector.id);assert.equal(fixed[1].details,failure.details);assert.equal(connector.enabled,false);
 assert.equal(userApprovedMcpUrl(fixed,human.id,connector.url),false);assert.strictEqual(repairSavedMcpHistory(fixed,[connector]),fixed);
});
test('new provider choices, different task, explicit replacement and missing saved connector stay unanswered',()=>{
 for(const messages of [[human,question],[human,failure,{...question,userInput:{...question.userInput,userMessageId:'other'}}],[human,failure,{...question,userInput:{...question.userInput,userText:'我要切换到自建高德MCP'}}]])assert.equal(repairSavedMcpHistory(messages,[connector]).at(-1).userInput.status,'pending');
 assert.equal(repairSavedMcpHistory([human,failure,question],[]).at(-1).userInput.status,'pending');
});
test('redundant MCP URL prompt returns real local facts, not a manufactured selected option',()=>{
 const known=knownSavedMcpAddress(question.userInput.questions,[connector],'再看看呢');assert.equal(known.connectorId,connector.id);assert.equal(known.enabled,false);assert.equal(known.answers,undefined);assert.equal(known.answeredBy,undefined);
 assert.equal(knownSavedMcpAddress(question.userInput.questions,[connector],'换成自建 MCP'),null);
 assert.equal(knownSavedMcpAddress(question.userInput.questions,[],'再看看呢'),null);
 const choices=[{...question.userInput.questions[0],question:'是否启用高德 MCP？',options:[{label:'启用',description:''},{label:'稍后',description:''}]}];assert.equal(knownSavedMcpAddress(choices,[connector],''),null);
 const unrelated=structuredClone(question.userInput.questions);unrelated[0].options[1].label='https://another.example/mcp';assert.equal(knownSavedMcpAddress(unrelated,[connector],''),null);
});
