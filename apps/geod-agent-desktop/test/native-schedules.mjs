// Native scheduler acceptance: real tiles, SQLite records and injected HTTP failure.
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
const rpc = async (command, args = {}) => {
  const result = await (
    await fetch("http://127.0.0.1:1421/rpc", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ command, args }),
    })
  ).json();
  if (result.error) throw result.error;
  return result.value;
};
const path =
  "../../docs/implementation/evidence/native-schedules-2026-10-02.json";
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const records = [];
async function template(
  permission = "fullAccess",
  sourceId = "esri-world-imagery",
) {
  const conversationId = randomUUID(),
    directory = join(tmpdir(), `geod-schedule-${conversationId}`);
  mkdirSync(directory, { recursive: true });
  await rpc("workspace_set", { conversationId, directory, permission });
  const input = await rpc("data_input_read", {
    conversationId,
    request: {
      files: [
        {
          name: "范围.geojson",
          base64: readFileSync(
            join(tmpdir(), "geod-data-input-fixtures", "boundary.geojson"),
          ).toString("base64"),
        },
      ],
    },
  });
  const boundary = await rpc("boundaries_save", {
    conversationId,
    boundary: input.boundary,
  });
  const planned = await rpc("test_imagery_plan", {
    conversationId,
    executionId: randomUUID(),
    batch: false,
    arguments: {
      boundaryId: boundary.boundaryId,
      sourceId,
      zoom: 10,
      outputFormats: ["geotiff"],
    },
  });
  assert.equal(planned.errors.length, 0);
  return { conversationId, directory, plan: planned.plans[0].stored };
}
async function create(
  t,
  name,
  repeatSeconds = null,
  delay = 2500,
  maxRetries = 2,
) {
  return rpc("schedules_create", {
    conversationId: t.conversationId,
    planId: t.plan.planId,
    name,
    nextRunAt: new Date(Date.now() + delay).toISOString(),
    repeatSeconds,
    maxRetries,
    executionId: randomUUID(),
  });
}
async function wait(t, schedule, test, timeout = 120000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const runs = (
      await rpc("schedules_runs", { conversationId: t.conversationId })
    ).filter((run) => run.scheduleId === schedule.scheduleId);
    if (runs[0] && (await test(runs[0], runs))) return runs[0];
    await pause(400);
  }
  throw new Error("Schedule timed out: " + schedule.name);
}
async function verify(t, schedule, run) {
  assert.equal(run.state, "succeeded");
  assert(run.jobId);
  const manifest = await rpc("artifacts_inspect", { jobId: run.jobId });
  assert.equal(manifest.quality.status, "complete");
  assert.equal(manifest.quality.missingTiles, 0);
  const stored = await rpc("plans_get", { planId: run.planId });
  assert.notEqual(
    stored.plan.spec.outputDirectory,
    t.plan.plan.spec.outputDirectory,
  );
  const raster = await rpc("test_native_raster", { jobId: run.jobId });
  assert(raster.dataTile.nonzeroValues > 0);
  return {
    name: schedule.name,
    conversationId: t.conversationId,
    schedule,
    run,
    outputDirectory: stored.plan.spec.outputDirectory,
    quality: manifest.quality,
    raster,
  };
}
if (process.argv.includes("--prepare-restart")) {
  const report = JSON.parse(readFileSync(path, "utf8")),
    t = await template(),
    schedule = await create(t, "关闭期间补执行", 60, 15000);
  report.restart = { t, schedule, preparedAt: new Date().toISOString() };
  writeFileSync(path, JSON.stringify(report, null, 2));
  console.log(
    "Restart case prepared; close desktop before due time, reopen after due time.",
  );
} else if (process.argv.includes("--verify-restart")) {
  const report = JSON.parse(readFileSync(path, "utf8")),
    { t, schedule } = report.restart,
    run = await wait(t, schedule, (r) => r.state === "succeeded");
  await rpc("schedules_set_enabled", {
    scheduleId: schedule.scheduleId,
    enabled: false,
  });
  const runs = await rpc("schedules_runs", {
    conversationId: t.conversationId,
  });
  assert.equal(runs.length, 1);
  report.restart.result = await verify(t, schedule, run);
  report.restart.pass = true;
  report.pass = true;
  writeFileSync(path, JSON.stringify(report, null, 2));
  console.log("Restart catch-up PASS, one occurrence, one verified output.");
} else {
  const t = await template(),
    once = await create(t, "一次真实图源定时");
  records.push(
    await verify(t, once, await wait(t, once, (r) => r.state === "succeeded")),
  );
  assert.equal(
    (await rpc("schedules_runs", { conversationId: t.conversationId })).length,
    1,
  );
  console.log("Once PASS");
  const repeat = await create(t, "重复触发暂存", 60);
  const repeatRun = await wait(t, repeat, (r) => r.state === "succeeded");
  await rpc("schedules_set_enabled", {
    scheduleId: repeat.scheduleId,
    enabled: false,
  });
  records.push(await verify(t, repeat, repeatRun));
  console.log("Repeat + pause future triggers PASS");
  const review = await template("confirmEach"),
    pending = await create(review, "逐次确认待处理");
  const pendingRun = await wait(
    review,
    pending,
    (r) => r.state === "waiting_confirmation",
  );
  assert.equal(pendingRun.jobId, null);
  assert(pendingRun.planId);
  await rpc("schedules_cancel_run", { runId: pendingRun.runId });
  await pause(3500);
  assert.equal(
    (await rpc("schedules_runs", { conversationId: review.conversationId }))[0]
      .state,
    "cancelled",
  );
  records.push({
    name: pending.name,
    schedule: pending,
    run: pendingRun,
    cancelled: true,
    noJobStarted: true,
  });
  console.log("Confirmation + cancel PASS");
  const image = await rpc("map_preview_tile", {
    sourceId: "esri-world-imagery",
    z: 10,
    x: 842,
    y: 388,
  });
  const bytes = Buffer.from(
    image.includes(",") ? image.split(",")[1] : image,
    "base64",
  );
  assert(bytes.length > 100);
  let unavailable = true,
    failures = 0,
    successes = 0;
  const server = createServer((req, res) => {
    if (unavailable) {
      failures++;
      res.writeHead(503).end("Intentional local acceptance failure");
    } else {
      successes++;
      res.writeHead(200, { "content-type": "image/jpeg" }).end(bytes);
    }
  });
  await new Promise((resolve) => server.listen(15441, "127.0.0.1", resolve));
  let retry;
  try {
    const sourceId = "schedule-retry-" + randomUUID();
    await rpc("sources_save", {
      endpoint: {
        id: sourceId,
        name: "定时重试本地故障测试",
        attribution: "Esri tile replay in declared local fault fixture",
        license: "",
        urlTemplate: "http://127.0.0.1:15441/{z}/{x}/{y}.jpg",
        scheme: "XYZ",
        tileSize: 256,
        networkPolicy: "UserTrustedHttp",
        minIntervalMs: 0,
      },
      minZoom: 0,
      maxZoom: 18,
      replaceExisting: false,
    });
    retry = await template("fullAccess", sourceId);
    const schedule = await create(retry, "临时错误恢复", null, 2500, 1);
    const failed = await wait(retry, schedule, (r) => r.state === "retrying");
    assert.equal(failed.attempt, 1);
    assert.equal(failed.errorCode, "SOURCE_TEMPORARY");
    assert(failures > 0);
    unavailable = false;
    const recovered = await wait(
      retry,
      schedule,
      (r) => r.state === "succeeded",
    );
    assert.equal(recovered.attempt, 2);
    assert.equal(recovered.jobId, failed.jobId);
    assert(successes > 0);
    records.push({
      ...(await verify(retry, schedule, recovered)),
      failedRun: failed,
      http503Requests: failures,
      http200Requests: successes,
      declaredLocalFaultFixture: true,
    });
    console.log("Transient failure + retry same job PASS");
  } finally {
    server.close();
  }
  writeFileSync(
    path,
    JSON.stringify(
      { createdAt: new Date().toISOString(), records, preRestartPass: true },
      null,
      2,
    ),
  );
}
