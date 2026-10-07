import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync,existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {transform,get as getProjection} from 'ol/proj.js';
import {registerArtifactProjection} from '../src/artifact-projection.ts';

const evidence=fileURLToPath(new URL('../../../artifacts/export-crs-20261007/projection-definitions.json',import.meta.url));
test('map understands actual native CRS definitions and places exported pixels correctly',{skip:!existsSync(evidence)},()=>{
  for(const item of JSON.parse(readFileSync(evidence,'utf8'))){
    registerArtifactProjection(item.crs,item.definition);
    assert(getProjection(item.crs));
    const projected=transform(item.input,'EPSG:4326',item.crs);
    const tolerance=getProjection(item.crs).getUnits()==='degrees'?1e-8:1e-3;
    projected.forEach((value,i)=>assert(Math.abs(value-item.expected[i])<tolerance,`${item.crs}: ${value} != ${item.expected[i]}`));
    const restored=transform(projected,item.crs,'EPSG:4326');
    restored.forEach((value,i)=>assert(Math.abs(value-item.input[i])<1e-8));
  }
  assert.throws(()=>registerArtifactProjection('EPSG:30000'),/缺少成果投影定义/);
});
