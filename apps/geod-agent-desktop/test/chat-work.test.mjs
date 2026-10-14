import test from 'node:test';
import assert from 'node:assert/strict';
import {groupWorkRecords, isTurnWork, uniqueDisplayMessages, projectWorkActivities, workRecordState} from '../src/chat-work.ts';

test('restored duplicate events render once with their latest content and stable position',()=>{
  const user={id:'u',role:'user',content:'下载'};
  const tool={id:'t',turnId:'turn',role:'tool',content:'读取中',toolStatus:'running'};
  const final={id:'f',role:'assistant',phase:'final',content:'完成'};
  const original=[user,tool,final,user,{...tool,content:'已读取',toolStatus:'success'},final];
  const unique=uniqueDisplayMessages(original);
  assert.deepEqual(unique.map(item=>item.id),['u','t','f']);
  assert.equal(unique[1].content,'已读取');
  assert.equal(groupWorkRecords(original)[1].items.length,1);
  assert.equal(original.length,6);
});

test('one turn folds reasoning, interleaved commentary and tools while final stays outside', () => {
 const messages = [
  {id:'user',role:'user',content:'下载河南的影像'},
  {id:'thought',turnId:'turn',role:'tool',itemType:'reasoning',content:'思考'},
  {id:'progress',turnId:'turn',role:'assistant',phase:'progress',content:'先检查工作区。'},
  {id:'tool',turnId:'turn',role:'tool',content:'检查工作区'},
  {id:'progress2',turnId:'turn',role:'assistant',phase:'progress',content:'现在读取边界。'},
  {id:'tool2',turnId:'turn',role:'tool',content:'查询边界'},
  {id:'final',turnId:'turn',role:'assistant',phase:'final',streaming:true,content:'已生成计划。'},
 ];
 const before = JSON.stringify(messages), entries = groupWorkRecords(messages);
 assert.equal(entries.length,3);
 assert.deepEqual(entries[1].items.map(item=>item.id),['thought','progress','tool','progress2','tool2']);
 assert.equal(entries[2].id,'final');
 assert.equal(JSON.stringify(messages),before);
});

test('action cards, background jobs and user steering stay visible outside the work block', () => {
 const entries = groupWorkRecords([
  {id:'a',turnId:'turn',role:'tool',content:'检查图源'},
  {id:'review',turnId:'turn',role:'tool',content:'核对配置',sourceDraft:{}},
  {id:'extension',role:'tool',content:'启用扩展',extensionProposal:{}},
  {id:'steer',role:'user',content:'只下载预览'},
  {id:'b',turnId:'turn',role:'assistant',phase:'progress',content:'已更新计划。'},
  {id:'job',role:'tool',content:'后台下载',backgroundJob:{}},
 ]);
 assert.equal(entries.filter(isTurnWork).length,1);
 assert.deepEqual(entries[0].items.map(item=>item.id),['a','b']);
 assert.deepEqual(entries.filter(entry=>!isTurnWork(entry)).map(item=>item.id),['review','extension','steer','job']);
});

test('completed and new turns remain separate, including restored legacy conversations', () => {
 const entries = groupWorkRecords([
  {id:'u1',role:'user',content:'下载'},
  {id:'p1',role:'assistant',phase:'progress',content:'开始检查。'},
  {id:'t1',role:'tool',content:'检查'},
  {id:'f1',role:'assistant',phase:'final',content:'完成'},
  {id:'u2',role:'user',content:'继续'},
  {id:'p2',role:'assistant',phase:'progress',content:'开始处理。'},
  {id:'t2',turnId:'new',role:'tool',content:'原生调用'},
  {id:'p3',turnId:'new',role:'assistant',phase:'progress',content:'处理中'},
 ]);
 const work = entries.filter(isTurnWork);
 assert.equal(work.length,2);
 assert.deepEqual(work.map(group=>group.items.map(item=>item.id)),[['p1','t1'],['p2','t2','p3']]);
 assert.equal(work[1].id,'new');
});

test('local work and resumed run IDs share one answer while active run remains identifiable',()=>{
 const entries=groupWorkRecords([
  {id:'u',role:'user',content:'下载故宫历史影像'},
  {id:'first',turnId:'run-a',role:'tool',content:'核对参数'},
  {id:'question',turnId:'run-a',role:'tool',content:'补充需求',userInput:{status:'pending'}},
  {id:'local',role:'tool',content:'核对已保存计划'},
  {id:'resume',turnId:'run-b',role:'assistant',phase:'progress',content:'继续生成计划'},
 ]);
 const groups=entries.filter(isTurnWork);
 assert.equal(groups.length,1);
 assert.deepEqual(groups[0].items.map(m=>m.id),['first','local','resume']);
 assert.deepEqual(groups[0].turnIds,['run-a','run-b']);
 assert(entries.some(m=>m.id==='question'));
});

test('completed question history moves into work records; pending questions never disappear',()=>{
 const rows=[
  {id:'u',role:'user',content:'下载'},
  {id:'work',turnId:'run',role:'tool',content:'思考'},
  {id:'answered',turnId:'run',role:'tool',content:'补充需求',userInput:{status:'answered',userMessageId:'u'}},
  {id:'pending',turnId:'run',role:'tool',content:'补充需求',userInput:{status:'pending',userMessageId:'u'}},
 ];
 assert(groupWorkRecords(rows).some(m=>m.id==='answered'));
 const before=JSON.stringify(rows);
 const completed=groupWorkRecords([...rows,{id:'final',turnId:'run',role:'assistant',phase:'final',content:'已准备13项任务'}]);
 assert.deepEqual(completed.filter(isTurnWork)[0].items.map(m=>m.id),['work','answered']);
 assert(completed.some(m=>m.id==='pending'));
 assert(!completed.some(m=>m.id==='answered'));
 assert.equal(JSON.stringify(rows),before);
});
test('historical polling trace remains inside the same completed turn', () => {
 const entries = groupWorkRecords([
  {id:'thought',role:'tool',turnId:'turn',content:'思考'},
  {id:'history',role:'tool',content:'早前任务监控',monitorTrace:[{id:'get',turnId:'turn',role:'tool',content:'查询进度'}]},
  {id:'final',turnId:'turn',role:'assistant',phase:'final',content:'完成'},
 ]);
 assert.equal(entries.filter(isTurnWork).length,1);
 assert.deepEqual(entries[0].items.map(item=>item.id),['thought','history']);
});

test('Codex activity projection coalesces adjacent exploration but preserves prose and execution boundaries',()=>{
 const rows=[
  {id:'note',role:'assistant',phase:'progress',content:'先检查配置'},
  {id:'source',role:'tool',toolName:'sources_list',toolStatus:'success',content:'图源列表'},
  {id:'read',role:'tool',itemType:'commandExecution',commandActions:[{type:'read',path:'boundary.geojson'}],content:'read boundary'},
  {id:'next-note',role:'assistant',phase:'progress',content:'再计算计划'},
  {id:'run',role:'tool',itemType:'commandExecution',commandActions:[{type:'unknown'}],content:'generate plan'},
  {id:'plan-a',role:'tool',toolName:'plan_imagery',content:'生成计划'},
  {id:'plan-b',role:'tool',toolName:'jobs_start',content:'开始下载'},
 ];
 const before=JSON.stringify(rows),groups=projectWorkActivities(rows,true);
 assert.deepEqual(groups.map(g=>[g.kind,g.items.map(i=>i.id)]),[['note',['note']],['exploration',['source','read']],['note',['next-note']],['record',['run']],['tools',['plan-a','plan-b']]]);
 assert.equal(JSON.stringify(rows),before);
});

test('exploration comes from contract metadata, never from command text or an apparent tool name',()=>{
 const groups=projectWorkActivities([
  {id:'bad-read',role:'tool',itemType:'commandExecution',content:'cat important.txt; remove-data',commandActions:[{type:'read'},{type:'unknown'}]},
  {id:'guess',role:'tool',toolName:'read_and_delete',content:'读取文件'},
  {id:'hint',role:'tool',itemType:'mcpToolCall',readOnlyHint:true,content:'自有工具'},
 ],false);
 assert.deepEqual(groups.map(g=>g.kind),['record','tools','exploration']);
});

test('empty and currently running reasoning do not create duplicate thinking rows; visible completed summaries survive',()=>{
 const rows=[{id:'empty',role:'tool',itemType:'reasoning',content:'思考'},
  {id:'live',role:'tool',itemType:'reasoning',toolStatus:'running',details:'服务返回的可见摘要',content:'思考'},
  {id:'done',role:'tool',itemType:'reasoning',toolStatus:'success',details:'已确认的可见摘要',content:'思考'}];
 assert.deepEqual(projectWorkActivities(rows,true).map(g=>g.id),['done']);
 assert.deepEqual(projectWorkActivities(rows,false).map(g=>g.id),['live','done']);
});

test('restored unknown work is not labelled successful and a stopped in-flight operation stays attention',()=>{
 assert.equal(workRecordState({role:'tool',content:'旧记录'},false),'recorded');
 assert.equal(workRecordState({role:'tool',toolStatus:'running'},true),'running');
 assert.equal(workRecordState({role:'tool',toolStatus:'running'},false),'attention');
 assert.equal(workRecordState({role:'tool',toolStatus:'attention'},true),'attention');
});

test('completion disclosure uses the actual final/outcome rather than an idle flag',()=>{
 const work={id:'op',role:'tool',turnId:'run',content:'处理'};
 assert.equal(groupWorkRecords([work])[0].outcome,undefined);
 assert.equal(groupWorkRecords([work,{id:'stream',role:'assistant',turnId:'run',phase:'final',streaming:true,content:'回复'}])[0].outcome,undefined);
 assert.equal(groupWorkRecords([work,{id:'final',role:'assistant',turnId:'run',phase:'final',content:'回复'}])[0].outcome,'completed');
 assert.equal(groupWorkRecords([work,{id:'stop',role:'tool',turnId:'run',turnOutcome:{status:'interrupted',message:'用户停止'}}])[0].outcome,'interrupted');
});
