import assert from "node:assert/strict";
import test from "node:test";
import { backgroundHandoff, collapsePollingHistory, createBackgroundMonitor } from "../src/background-jobs.ts";

const job = (id, state) => ({ jobId: id, planId: `plan-${id}`, state, version: 1, createdAt: new Date().toISOString() });
test("old polling chatter folds without swallowing user requests, final answers or other tools", () => {
  const messages = [ { id: "user", role: "user", content: "下载北京影像" }, { id: "start", role: "tool", toolName: "jobs_start", content: "启动下载" },
    { id: "progress1", role: "assistant", phase: "progress", content: "查看进度。" }, { id: "get1", role: "tool", toolName: "jobs_get", content: "下载中" },
    { id: "events1", role: "tool", toolName: "jobs_events", content: "已下载4张" }, { id: "progress2", role: "assistant", phase: "progress", content: "继续跟踪。" },
    { id: "get2", role: "tool", toolName: "jobs_get", content: "下载中" }, { id: "map", role: "tool", toolName: "mcp_call", content: "加载地图" },
    { id: "final", role: "assistant", phase: "final", content: "已启动任务" }, { id: "user2", role: "user", content: "继续" } ];
  const original = JSON.stringify(messages), folded = collapsePollingHistory(messages);
  assert.deepEqual(folded.map(item => item.id), ["user", "start", "monitor-history-progress1", "map", "final", "user2"]);
  assert.equal(folded[2].monitorTrace.length, 5);
  assert.equal(JSON.stringify(messages), original);
});
test("running downloads hand off immediately; terminal state, errors and unrelated work do not", () => {
  for (const name of ["jobs_start", "jobs_get", "jobs_events"]) {
    assert.deepEqual(backgroundHandoff(name, job("a", "downloading")), { jobId: "a", planId: "plan-a", state: "downloading" });
    assert.equal(backgroundHandoff(name, job("a", "completed")), null);
    assert.equal(backgroundHandoff(name, { error: "APPROVAL_REQUIRED" }), null);
  }
  assert.equal(backgroundHandoff("plan_imagery", job("a", "queued")), null);
});

test("native monitoring updates one snapshot, reads incremental events and notifies completion once", async () => {
  let state = "downloading", reads = 0;
  const eventOffsets = [], updates = [], notices = [];
  const api = {
    async jobsGet(id) { reads++; return job(id, state); },
    async jobsEvents(id, offset) {
      eventOffsets.push(offset);
      return offset === 0 ? [{ jobId: id, seq: 1, state, completedTiles: 4, totalTiles: 600 }]
        : offset === 1 ? [{ jobId: id, seq: 2, state, completedTiles: 8, totalTiles: 600 }]
          : [{ jobId: id, seq: 3, state: "completed" }];
    },
  };
  const monitor = createBackgroundMonitor(api, ["a"], value => updates.push(value), value => notices.push(value));
  await monitor.poll(); await monitor.poll();
  assert.equal(updates.at(-1).a.completedTiles, 8);
  assert.equal(Object.keys(updates.at(-1)).length, 1);
  assert.equal(updates.at(-1).a.events.length, 0, "Tile checkpoints must not form a log list");
  state = "completed";
  await monitor.poll(); await monitor.poll();
  assert.deepEqual(eventOffsets, [0, 1, 2]);
  assert.equal(reads, 3, "Completed jobs stop polling");
  assert.equal(notices.length, 1);
  assert.equal(updates.at(-1).a.job.state, "completed");
  monitor.dispose();
  await monitor.poll();
  assert.equal(updates.length, 4, "Unmounted monitor stops publishing");
});

test("monitor cannot overlap native reads or publish after disposal", async () => {
  let resolve, reads = 0, published = 0;
  const monitor = createBackgroundMonitor({ async jobsGet(id) { reads++; await new Promise(done => { resolve = done; }); return job(id, "downloading"); }, async jobsEvents() { return []; } },
    ["a"], () => published++, () => assert.fail("No completion expected"));
  const first = monitor.poll(); await monitor.poll();
  assert.equal(reads, 1);
  monitor.dispose(); resolve(); await first;
  assert.equal(published, 0);
});

test("status failures retain the last progress and recover without creating messages", async () => {
  let fail = true, state = "downloading";
  const updates = [], notices = [];
  const monitor = createBackgroundMonitor({ async jobsGet(id) { if (fail) throw new Error("offline"); return job(id, state); },
    async jobsEvents() { return [{ jobId: "a", seq: 1, state, completedTiles: 20, totalTiles: 600 }]; } },
    ["a"], value => updates.push(value), value => notices.push(value));
  await monitor.poll(); assert.equal(updates.at(-1).a.job, null); assert.ok(updates.at(-1).a.connectionError);
  fail = false; await monitor.poll(); assert.equal(updates.at(-1).a.completedTiles, 20);
  fail = true; await monitor.poll(); assert.equal(updates.at(-1).a.completedTiles, 20);
  fail = false; state = "failed"; await monitor.poll(); await monitor.poll();
  assert.equal(notices.length, 1); assert.equal(updates.at(-1).a.connectionError, undefined);
  monitor.dispose();
});
test("incremental cache checks retain downloaded progress during a resumed job", async () => {
  let seq=0;const updates=[];
  const monitor=createBackgroundMonitor({jobsGet:async()=>job('a','downloading'),jobsActive:async()=>['a'],
    jobsEvents:async()=>[{seq:++seq,completedTiles:seq===1?448:seq===2?16:464,totalTiles:600}]},['a'],s=>updates.push(s),()=>{});
  await monitor.poll();await monitor.poll();
  assert.equal(updates.at(-1).a.completedTiles,448);assert.equal(updates.at(-1).a.checkingCache,true);
  await monitor.poll();assert.equal(updates.at(-1).a.completedTiles,464);assert.equal(updates.at(-1).a.checkingCache,false);
  monitor.dispose();
});
