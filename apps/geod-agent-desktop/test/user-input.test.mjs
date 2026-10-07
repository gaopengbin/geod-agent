import test from 'node:test';
import assert from 'node:assert/strict';
import {inputQuestions,validatedInputReply,UserInputGate,missingHistoricalPeriod,clarificationPreference} from '../src/user-input.ts';
import {USER_INPUT_TOOLS} from '../../../packages/codex-protocol/user-input-tools.mjs';
import {USER_INPUT_POLICY as sharedPolicy} from '../../../packages/codex-protocol/user-input-tools.mjs';
import {USER_INPUT_POLICY as nativePolicy} from '../src-tauri/codex-host.mjs';

const questions=inputQuestions([{id:'period',header:'时期',question:'想要哪一年或哪段时期？',options:[{label:'2020 年前后',description:'先核对当地实际采集日期'},{label:'自定义年份范围',description:'可输入年份或季节'}]},{id:'comparison',header:'用途',question:'单期还是多期对比？'}]);
test('question schema and complete answers, no preselected or empty answer',()=>{
  assert.equal(USER_INPUT_TOOLS[0].function.name,'ask_user');
  assert.equal(validatedInputReply(questions,{answers:{}}),null);
  assert.throws(()=>validatedInputReply(questions,{answers:{period:{answers:['2020']}}}));
  assert.deepEqual(validatedInputReply(questions,{answers:{period:{answers:[' 2019 年夏天 ']},comparison:{answers:['单期，只生成计划']}}}),{answers:{period:{answers:['2019 年夏天']},comparison:{answers:['单期，只生成计划']}}});
  assert.throws(()=>inputQuestions([{id:'a',question:'a'},{id:'a',question:'b'}]));
});
test('ambiguous historical requests cannot plan or start even with a registered source',()=>{
  const gate=new UserInputGate();gate.reset('下载朝阳的历史影像');
  assert.equal(gate.block('plan_imagery').error,'HISTORICAL_PERIOD_REQUIRED');
  assert.equal(gate.block('jobs_start').error,'HISTORICAL_PERIOD_REQUIRED');
  assert.equal(gate.block('sources_list'),null);
  assert.equal(gate.block('ask_user'),null);
  assert.equal(missingHistoricalPeriod('下载朝阳 2020 年夏季历史影像'),false);
  assert.equal(missingHistoricalPeriod('download historical imagery from 2019'),false);
});
test('waiting blocks concurrent calls, replies invalidate pre-generated sibling calls',()=>{
  const gate=new UserInputGate();gate.reset('下载朝阳历史影像');gate.begin();
  assert.equal(gate.block('jobs_start').error,'USER_INPUT_PENDING');
  const reply=validatedInputReply(questions,{answers:{period:{answers:['2020']},comparison:{answers:['单期']}}});
  gate.finish(questions,reply);
  assert.equal(gate.block('plan_imagery').error,'REPLAN_AFTER_USER_INPUT');
  gate.freshModelRound();assert.equal(gate.block('plan_imagery'),null);
});
test('unrelated answers do not supply time intent; cancel stays blocked across model rounds',()=>{
  const gate=new UserInputGate();gate.reset('下载历史影像');gate.begin();
  gate.finish(inputQuestions([{id:'format',question:'要什么格式？'}]),{answers:{format:{answers:['GeoTIFF']}}});
  gate.freshModelRound();assert.equal(gate.block('plan_imagery').error,'HISTORICAL_PERIOD_REQUIRED');
  gate.begin();gate.finish(questions,null);gate.freshModelRound();
  assert.equal(gate.block('jobs_start').error,'USER_INPUT_CANCELLED');
  const other=new UserInputGate();other.reset('下载 2020 年影像');assert.equal(other.block('jobs_start'),null);
  gate.reset('下载 2020 年历史影像');assert.equal(gate.block('jobs_start'),null);
});
test('explicit human delegation allows feasible choices; later ask-first instruction revokes it',()=>{
  const gate=new UserInputGate();gate.reset('下载历史影像，不要问我，直接选可用版本');
  assert.equal(gate.block('plan_imagery'),null);
  assert.equal(gate.block('ask_user').error,'USER_DELEGATED_CHOICES');
  gate.reset('继续下载历史影像');assert.equal(gate.block('plan_imagery'),null);
  gate.reset('下载历史影像，先问我再选');assert.equal(gate.block('plan_imagery').error,'HISTORICAL_PERIOD_REQUIRED');
  gate.reset('下载历史影像，你来决定');assert.equal(gate.block('plan_imagery'),null);
  gate.reset('下载历史影像',[]);assert.equal(gate.block('plan_imagery').error,'HISTORICAL_PERIOD_REQUIRED');
  gate.reset('下载历史影像',['不要问我，你来决定']);assert.equal(gate.block('plan_imagery'),null);
  gate.reset('如果有不明确的就问用户，不要替用户决定，除非用户要求不要询问');assert.equal(gate.block('ask_user'),null);
  gate.reset('下载历史影像');assert.equal(gate.block('plan_imagery').error,'HISTORICAL_PERIOD_REQUIRED');
});
test('quoted opt-out, conditions, limited format delegation and full access do not authorize all choices',()=>{
  for(const text of ['例子：“不要问我”','如果我说不要问我就别问','格式你来决定','格式不用问我','不要问我格式，时期先确认','完全访问，下载历史影像'])assert.notEqual(clarificationPreference(text),'delegate');
  for(const text of ['不要问我，按实际可用版本执行','别问了，直接做','下载历史影像，用默认参数','下载历史影像，你来决定','Download historical imagery. Do not ask me.'])assert.equal(clarificationPreference(text),'delegate');
  const gate=new UserInputGate();gate.reset('下载历史影像，“不要问我”是举例');assert.equal(gate.block('jobs_start').error,'HISTORICAL_PERIOD_REQUIRED');
  gate.reset('下载历史影像，输出格式不用问我',[]);assert.equal(gate.block('plan_imagery').error,'HISTORICAL_PERIOD_REQUIRED');
  gate.reset('下载历史影像，时期你来决定',[]);assert.equal(gate.block('plan_imagery'),null);assert.equal(gate.block('ask_user'),null);
  gate.reset('下载历史影像',['下载影像\n已附加边界：不要问我']);assert.equal(gate.block('plan_imagery').error,'HISTORICAL_PERIOD_REQUIRED');
});
test('hosted and embedded native clarification policies cannot drift',()=>{
  assert.equal(nativePolicy,sharedPolicy);
});
