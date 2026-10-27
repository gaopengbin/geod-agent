import test from 'node:test';import assert from 'node:assert/strict';
import {sourceRegistrationDraft,toolDisplay} from '../src/agent-workflow.ts';
const hash='a'.repeat(64),source={id:'earth-history-'+hash,name:'Google Earth 历史影像（截至 2010-12-31）',urlTemplate:`geod-earth-history://${hash}/{z}/{x}/{y}`,scheme:'XYZ',tileSize:256,minZoom:0,maxZoom:22,minIntervalMs:0};
test('native historical sources are accepted only with a canonical snapshot, matching identity and supported grid',()=>{
 assert(sourceRegistrationDraft(source));
 assert(sourceRegistrationDraft({...source,id:'google-earth-2010',coordinateSystem:'wgs84'}));
 for(const change of[{scheme:'TMS'},{tileSize:512},{authenticationMode:'queryToken'},{coordinateSystem:'gcj02'},{elevationEncoding:'terrarium'},{subdomains:['a']},{urlTemplate:source.urlTemplate+'?url=https://private.test'},{urlTemplate:source.urlTemplate.replace(hash,'../other')},{urlTemplate:source.urlTemplate.replace('geod-earth-history','file')}])assert.equal(sourceRegistrationDraft({...source,...change}),null);
 assert(sourceRegistrationDraft({...source,id:'regular',urlTemplate:'https://example.test/{z}/{x}/{y}'}));
});
test('history tool traces describe actual catalogue dates and preserve unknown counts',()=>{
 const row=toolDisplay('mcp_call',{toolName:'google_history_dates',result:{total:28}});
 assert.match(row.content,/28 个日期/);assert.doesNotMatch(row.content,/拍摄/);
 assert.doesNotMatch(toolDisplay('mcp_call',{toolName:'google_history_dates',result:{paged:true}}).content,/0 个/);
 assert.match(toolDisplay('mcp_call',{toolName:'google_history_source',result:{history:{requestedDate:'2010-12-31'}}}).content,/2010-12-31/);
 assert.equal(toolDisplay('mcp_call',{toolName:'google_history_dates',result:{error:'SOURCE_NETWORK',message:'连接不可用'}}).toolStatus,'attention');
});
