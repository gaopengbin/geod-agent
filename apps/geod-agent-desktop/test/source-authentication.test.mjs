import { test } from "node:test";
import assert from "node:assert/strict";
import ts from "typescript";
import { readFileSync } from "node:fs";
const catalog=JSON.parse(readFileSync(new URL("../../../contracts/source-presets.v1.json",import.meta.url),"utf8"));
const source=readFileSync(new URL("../src/source-presets.ts",import.meta.url),"utf8").replace(/import catalog from "\.\.\/\.\.\/\.\.\/contracts\/source-presets\.v1\.json";/,`const catalog = ${JSON.stringify(catalog)};`);
const code=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.ESNext}}).outputText;
const { tiandituPreset, separateUrlToken, rasterPreset }=await import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`);
test("pasted credential URL is separated while WMTS parameters and XYZ placeholders survive",()=>{
  const raw="https://t0.tianditu.gov.cn/img_w/wmts?LAYER=img&tk=local%2Bexample&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}";
  const parsed=separateUrlToken(raw);
  assert.equal(parsed.token,"local+example");assert.equal(parsed.parameter,"tk");assert.equal(parsed.url,"https://t0.tianditu.gov.cn/img_w/wmts?LAYER=img&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}");
  assert.throws(()=>separateUrlToken(raw+"&token=second"));
  assert.equal(separateUrlToken("https://tiles.example.org/{z}/{x}/{y}?session_key=local-example", "session_key").token,"local-example");
  assert.throws(()=>separateUrlToken(raw+"#fragment"));
});
test("Tianditu presets use credential-free standard Web Mercator tile templates",()=>{
  for(const layer of ["img","cia","vec","cva","cta"]){const p=tiandituPreset(layer);const u=new URL(p.source.urlTemplate);
    assert.equal(u.searchParams.get("TILEMATRIXSET"),"w");assert.equal(u.searchParams.get("LAYER"),layer);assert(!u.searchParams.has("tk"));assert.equal(p.authenticationParameter,"tk");
    assert.deepEqual(p.source.subdomains,["0","1","2","3","4","5","6","7"]);
  }
  assert.throws(()=>tiandituPreset("img_c"));
});

test("desktop presets retain coordinate frames and subdomain rotation in drafts",()=>{
  assert.equal(catalog.presets.length,13);
  for(const preset of catalog.presets){const draft=rasterPreset(preset.id);assert.equal(draft.source.urlTemplate,preset.urlTemplate);assert.deepEqual(draft.source.subdomains,preset.subdomains);assert.equal(draft.source.coordinateSystem,preset.coordinateSystem);}
  for(const id of ["google-map","gaode-map","gaode-satellite"])assert.equal(rasterPreset(id).source.coordinateSystem,"gcj02");
  assert.equal(rasterPreset("google-satellite").source.coordinateSystem,undefined);
  assert.equal(catalog.vectorPresets.length,2);
  assert(catalog.vectorPresets.find(p=>p.id==="mvt-openfreemap").tileJsonUrl);
  assert(!catalog.vectorPresets.some(p=>p.urlTemplate?.includes("20260429")));
});
