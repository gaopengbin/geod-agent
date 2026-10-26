import test from 'node:test';import assert from 'node:assert/strict';
import {inputOrigin,reusableInputReply} from '../src/user-input-records.ts';
import {knownCrsChoice} from '../src/export-crs-input.ts';

test('credential save continuation retains the actual human task and its answers after serialization',()=>{
 const question={id:'resolution',header:'分辨率',question:'下载级别？',options:[{label:'Z16'}]};
 const messages=[{id:'human',role:'user',content:'下载这个范围，GeoTIFF，EPSG:4326，LZW'},
  {id:'answer',role:'tool',content:'已回答',userInput:{status:'answered',questions:[question],reply:{answers:{resolution:{answers:['Z16']}}},userMessageId:'human'}},
  {id:'resume',role:'user',content:'我已在本机补全图源认证，请继续刚才任务。',resumeOfUserMessageId:'human'}];
 const restored=JSON.parse(JSON.stringify(messages));
 assert.equal(inputOrigin(restored,'resume'),'human');assert.equal(knownCrsChoice(restored,'resume',null).crs,'EPSG:4326');
 assert.deepEqual(reusableInputReply([question],restored,'resume'),{answers:{resolution:{answers:['Z16']}}});
 assert.equal(inputOrigin([...restored,{id:'other',role:'user',content:'另一个任务'}],'other'),'other');
});
test('invalid or forward continuation references cannot attach to another task',()=>{
 const messages=[{id:'first',role:'user',content:'普通请求',resumeOfUserMessageId:'later'},{id:'later',role:'user',content:'独立请求',resumeOfUserMessageId:'missing'}];
 assert.equal(inputOrigin(messages,'first'),'first');assert.equal(inputOrigin(messages,'later'),'later');
});
