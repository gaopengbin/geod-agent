import assert from "node:assert/strict";
import test from "node:test";
import { taskGridLines, taskTileCoverage } from "../src/task-grid.ts";

const grid = {
  zoom: 2, columns: 2, rows: 2, tileCount: 4,
  pixelWidth: 512, pixelHeight: 512,
  actualBounds: [0, 0, 180, 85.0511287798066],
};

test("planned tile grid follows Web Mercator row boundaries", () => {
  const lines = taskGridLines([grid]).geometry.coordinates;
  assert.equal(lines.length, 6);
  assert.deepEqual(lines[1], [[90, grid.actualBounds[3]], [90, 0]]);
  assert.ok(Math.abs(lines[4][0][1] - 66.5132604431) < 1e-8);
});

test("tile coverage follows the worker's column then row order", () => {
  assert.equal(taskTileCoverage([grid], 0).geometry.coordinates.length, 0);
  const first = taskTileCoverage([grid], 1).geometry.coordinates;
  assert.equal(first.length, 1);
  assert.equal(first[0][0][0][0], 0);
  assert.equal(first[0][0][1][0], 90);
  assert.ok(Math.abs(first[0][0][2][1] - 66.5132604431) < 1e-8);
  const third = taskTileCoverage([grid], 3).geometry.coordinates;
  assert.equal(third.length, 2);
  assert.equal(third[0][0][2][1], 0);
  assert.equal(third[1][0][0][0], 90);
  assert.equal(taskTileCoverage([grid], 99).geometry.coordinates.length, 1);
});
