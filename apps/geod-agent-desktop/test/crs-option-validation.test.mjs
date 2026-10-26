import test from 'node:test';import assert from 'node:assert/strict';
import {crsOptionIssues,crsQuestionConflict} from '../src/crs-option-validation.ts';
const question=(label,description='',extra={})=>[{id:'target_crs',header:'坐标系',question:'成果使用什么投影？',options:[{label,description}],...extra}];
test('a model-proposed EPSG code and central meridian must agree with the local authority reference',()=>{
 const conflict=crsQuestionConflict(question('EPSG:4547 CGCS2000 CM117','中央经线 117°E，推荐'));
 assert.equal(conflict.error,'CRS_OPTION_CONFLICT');assert.equal(conflict.issues.length,1);
 assert.equal(conflict.issues[0].actualCentralMeridian,114);assert.match(conflict.issues[0].authorityName,/114E/);
 assert.equal(crsQuestionConflict(question('EPSG:4548 CGCS2000 CM117','中央经线 117°E')),null);
 assert.equal(crsQuestionConflict(question('EPSG:4547 CM114')),null);
});
test('the check covers other projections and western meridians without choosing a replacement',()=>{
 const bad=crsOptionIssues(question('EPSG:32618 UTM 18N','central meridian 72W'));
 assert.equal(bad[0].actualCentralMeridian,-75);assert.equal(bad[0].claimedCentralMeridian,-72);
 assert.equal(crsQuestionConflict(question('EPSG:32618 UTM18N CM75W')),null);
 assert.equal(crsQuestionConflict(question('EPSG:32650 CM 117E')),null);
});
test('unknown and comparative options remain unknown; unrelated, secret and correct options are not blocked',()=>{
 for(const q of [question('EPSG:9999 CM117'),question('EPSG:4326 经纬度'),question('EPSG:4547 与 EPSG:4548 CM117'),question('EPSG:4547 CM117','',{id:'source',header:'图源',question:'用什么图源？'}),question('EPSG:4547 CM117','',{isSecret:true})])assert.equal(crsQuestionConflict(q),null);
});
