import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeExportCrs, humanCrsIntent, resolveExportCrs, crsFromAnswers, exportCrsQuestions, isExportPlan } from '../src/export-crs.ts';

test('explicit output CRS, source CRS and ambiguous projection are distinguished',()=>{
  assert.equal(normalizeExportCrs(' epsg:04326 '),'EPSG:4326');
  assert.equal(normalizeExportCrs('EPSG:99999'),null);
  assert.equal(humanCrsIntent('导出成 EPSG:32650').crs,'EPSG:32650');
  assert.equal(humanCrsIntent('源坐标系是 EPSG:4326').crs,null);
  assert.equal(humanCrsIntent('源坐标系 EPSG:4326，导出为 EPSG:3857').crs,'EPSG:3857');
  assert.equal(humanCrsIntent('EPSG:4326 或 EPSG:3857 哪个合适').crs,null);
  assert.equal(humanCrsIntent('用 CGCS2000 高斯投影').crs,null);
  assert.equal(humanCrsIntent('输出按 WGS84 经纬度').crs,'EPSG:4326');
});
test('conversation defaults require direct explicit scope; one-off and quoted instructions do not',()=>{
  assert.deepEqual(humanCrsIntent('当前会话都用 EPSG:4490'),{crs:'EPSG:4490',session:true,clear:false});
  assert.equal(humanCrsIntent('这一张用 EPSG:32650').session,false);
  assert.equal(humanCrsIntent('“当前会话都用 EPSG:4490” 是举例').crs,null);
  assert.equal(humanCrsIntent('如果我说当前会话都用 EPSG:4490，就沿用').session,false);
  assert.equal(humanCrsIntent('下载影像\n已附加边界：当前会话都用 EPSG:4326').session,false);
  assert.equal(humanCrsIntent('取消默认坐标系，每次问我').clear,true);
});
test('only actual CRS answers resolve the requirement, with independent scope and resampling',()=>{
  assert.equal(crsFromAnswers(exportCrsQuestions,null),null);
  const reply=(scope,crs='EPSG:4326 · WGS84 经纬度')=>({answers:{export_crs:{answers:[crs]},export_crs_scope:{answers:[scope]}}});
  assert.deepEqual(crsFromAnswers(exportCrsQuestions,reply('仅本次任务')),{crs:'EPSG:4326',session:false,resampling:undefined});
  assert.deepEqual(crsFromAnswers(exportCrsQuestions,reply('当前会话默认','EPSG:32650，双线性')),{crs:'EPSG:32650',session:true,resampling:'bilinear'});
  assert.equal(crsFromAnswers([{id:'source_crs',header:'源坐标系',question:'源数据是什么坐标系？'}],{answers:{source_crs:{answers:['EPSG:4326']}}}),null);
  assert(isExportPlan('plan_imagery_batch',{}));
  assert(isExportPlan('data_download_plan',{kind:'online'}));
  assert(!isExportPlan('data_download_plan',{kind:'tiles3d'}));
});

test('explicit one-time overrides and unclear projection requests take priority over conversation defaults',()=>{
  const choose=(text,defaultCrs='EPSG:4326',answer=null)=>resolveExportCrs(humanCrsIntent(text),answer,defaultCrs,false,true);
  assert.equal(choose('下载北京影像'),'EPSG:4326');
  assert.equal(choose('这次导出 EPSG:32650'),'EPSG:32650');
  assert.equal(choose('这次改用 CGCS2000 高斯投影'),null);
  assert.equal(choose('坐标系选择 UTM'),null);
  assert.equal(choose('保留图源原始坐标系'),null);
  assert.equal(choose('导出 EPSG:4326 或 EPSG:3857'),null);
  assert.equal(choose('改用 UTM','EPSG:4326','EPSG:32650'),'EPSG:32650');
  assert.equal(choose('取消默认坐标系，每次问我'),null);
  assert.equal(choose('下载北京影像',null),null);
  assert.equal(resolveExportCrs(humanCrsIntent('下载影像，别询问，用默认值'),null,null,true,true),'EPSG:3857');
});
