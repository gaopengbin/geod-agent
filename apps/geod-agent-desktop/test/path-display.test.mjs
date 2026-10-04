import assert from "node:assert/strict";
import test from "node:test";
import { displayPath } from "../src/path-display.ts";

test("Windows extended drive path is shown as an ordinary path", () => {
  assert.equal(displayPath("\\\\?\\C:\\Users\\Administrator\\Documents\\GeoD Agent"), "C:\\Users\\Administrator\\Documents\\GeoD Agent");
});

test("Windows extended UNC path keeps its network share prefix", () => {
  assert.equal(displayPath("\\\\?\\UNC\\server\\share\\imagery.tif"), "\\\\server\\share\\imagery.tif");
});

test("normal paths and device paths are unchanged", () => {
  assert.equal(displayPath("G:\\code\\geod-agent"), "G:\\code\\geod-agent");
  assert.equal(displayPath("\\\\.\\COM1"), "\\\\.\\COM1");
});
