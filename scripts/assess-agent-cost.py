"""Calculate cost estimates from actual settled provider usage, read-only."""
from collections import defaultdict
from pathlib import Path
import json
import os
import sqlite3

root=Path(__file__).resolve().parents[1]
paths=list(Path(os.environ["TEMP"]).glob("geod-desktop-gateway-*/gateway.sqlite"))
groups=defaultdict(list)
historical=[]
for path in paths:
    db=sqlite3.connect("file:"+path.as_posix()+"?mode=ro",uri=True)
    db.row_factory=sqlite3.Row
    columns={r["name"] for r in db.execute("PRAGMA table_info(model_generations)")}
    for record in db.execute("SELECT * FROM model_generations WHERE state='settled'"):
        row=dict(record)
        if row["conversation_id"].startswith("cost-test-") and "cached_input_tokens" in columns:
            groups[row["conversation_id"]].append(row)
        elif row["input_tokens"] is not None:
            historical.append({"input":row["input_tokens"],"output":row["output_tokens"]})
    db.close()
actual=json.loads((root/"docs/implementation/evidence/data-input-real-model-2026-10-01.json").read_text(encoding="utf-8"))
scenarios=[]
for test in actual["scenarios"]:
    rows=groups[test["conversationId"]]
    if not rows or any(r["cached_input_tokens"] is None for r in rows): raise RuntimeError("Live usage is incomplete")
    input=sum(r["input_tokens"] for r in rows)
    cache=sum(r["cached_input_tokens"] for r in rows)
    output=sum(r["output_tokens"] for r in rows)
    off=(cache*.02+(input-cache)*1+output*4)/1000000
    peak=off*2
    cold_peak=(input*2+output*8)/1000000
    scenarios.append({"scenario":test["scenario"],"passed":test["pass"],"modelRequests":len(rows),"inputTokens":input,"cachedInputTokens":cache,"outputTokens":output,"cacheRate":round(cache/input,4),"seconds":round(test["durationMs"]/1000,1),"estimatedOffPeakCny":round(off,6),"estimatedPeakCny":round(peak,6),"allCacheMissPeakStressCny":round(cold_peak,6)})
report={"date":"2026-10-01","model":"deepseek-flash","usageSource":"Local gateway SQLite settled requests; provider cache counters, not character estimates","priceSource":"https://api-docs.deepseek.com/zh-cn/quick_start/pricing/","unit":"CNY per 1M tokens","rates":{"offPeak":{"cachedInput":.02,"uncachedInput":1,"output":4},"peak":{"cachedInput":.04,"uncachedInput":2,"output":8}},"scenarios":scenarios,"historicalWithoutCacheDetails":{"requests":len(historical),"inputTokens":sum(r["input"] for r in historical),"outputTokens":sum(r["output"] for r in historical),"cannotPriceExactly":True},"limits":["4 short scenarios, one account, warm shared prefix; not production concurrency or long-context p95","Cost is a rate-based estimate, not a provider invoice","GIS conversion and tiles execute locally; no model cost while native job monitoring idles","No subscription, payment or quota policy changed"]}
(root/"docs/implementation/evidence/agent-cost-2026-10-01.json").write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding="utf-8")
print(json.dumps(report,ensure_ascii=False,indent=2))
