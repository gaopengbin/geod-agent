import assert from "node:assert/strict";
import test from "node:test";
import { artifactResultForModel, modelMessagesWithoutArtifactPaths } from "../src/model-artifacts.ts";

test("artifact facts sent to the model omit local file names and private warnings", () => {
  const manifest = {
    name: "local-bundle",
    bounds: [-77.05, 38.85, -77.04, 38.86],
    assets: [{ id: "raster", kind: "raster", role: "analysis", path: "C:\\Users\\Alice\\Private\\imagery.tif", bytes: 4914, sha256: "abc123", bounds: [-77.05, 38.85, -77.04, 38.86], width: 30, height: 38 }],
    quality: { status: "complete", missingTiles: 0, warnings: ["Local file C:\\Users\\Alice\\Private\\imagery.tif needs review"] },
    provenance: [{ source: "USGS NAIP", attribution: "USGS", retrievedAt: "2026-09-28T00:00:00Z" }],
  };
  const result = artifactResultForModel("job-1", manifest);
  assert.deepEqual(result.assets[0], { kind: "raster", role: "analysis", bytes: 4914, sha256: "abc123", bounds: manifest.bounds, width: 30, height: 38 });
  assert.equal(result.quality.warnings[0], "See the desktop results for a local verification warning");
  assert.doesNotMatch(JSON.stringify(result), /Alice|Private|imagery\.tif/);
});

test("older saved artifact tool results are filtered again before a model request", () => {
  const call = { id: "call-1", type: "function", function: { name: "artifacts_inspect", arguments: '{"jobId":"job-1"}' } };
  const context = [
    { role: "assistant", content: null, tool_calls: [call] },
    { role: "tool", tool_call_id: "call-1", content: JSON.stringify({
      jobId: "job-1", quality: { status: "complete", missingTiles: 0, warnings: [] },
      assets: [{ kind: "raster", role: "analysis", path: "C:\\Users\\Alice\\Private\\imagery.tif", bytes: 4, sha256: "abc", bounds: [0, 0, 1, 1] }],
      provenance: [],
    }) },
  ];
  const prepared = modelMessagesWithoutArtifactPaths(context);
  assert.doesNotMatch(JSON.stringify(prepared), /Alice|Private|imagery\.tif/);
  assert.equal(JSON.parse(prepared[1].content).assets[0].bytes, 4);
  assert.match(context[1].content, /Alice/);
  const truncated = modelMessagesWithoutArtifactPaths(context.slice(1));
  assert.doesNotMatch(JSON.stringify(truncated), /Alice|Private|imagery\.tif/);
});
