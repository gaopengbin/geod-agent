"""Native tools used by the Agent, starting without a saved connection."""
import json
import os
from pathlib import Path
import tempfile
import urllib.request
import uuid

root = Path(__file__).resolve().parents[1]
draft = json.loads((root / "infra/postgis-test/.secrets/reader-connection.json").read_text(encoding="utf-8"))
conversation = "agent-postgis-native-" + str(uuid.uuid4())
cases = []

def rpc(command, args):
    request = urllib.request.Request("http://127.0.0.1:1421/rpc", json.dumps({"command": command, "args": args}).encode(), {"Content-Type": "application/json"})
    result = json.load(urllib.request.urlopen(request, timeout=190))
    return {"error": result["error"]} if result.get("error") else result["value"]

def check(name, operation):
    value = operation()
    assert draft["password"] not in json.dumps(value, ensure_ascii=False), "Credential disclosure"
    cases.append({"case": name, "pass": True, "result": value})
    print(name, "PASS", flush=True)
    return value

def error(operation, code):
    value = operation()
    assert value.get("error", {}).get("code") == code, value
    return {"code": code}

with tempfile.TemporaryDirectory(prefix="geod-agent-postgis-") as directory:
    workspace = Path(directory)
    (workspace / "connection.json").write_text(json.dumps(draft, ensure_ascii=False), encoding="utf-8")
    (workspace / "invalid.json").write_text("[]", encoding="utf-8")
    rpc("workspace_set", {"conversationId": conversation, "directory": directory, "permission": "confirmEach"})
    def connect(request):
        return rpc("data_connection_connect", {"conversationId": conversation, "request": request})
    check("missing authentication opens native credentials flow", lambda: error(lambda: connect({key: value for key, value in draft.items() if key != "password"}), "INPUT_AUTH_REQUIRED"))
    check("configuration must be an object", lambda: error(lambda: connect({"credentialFile": "invalid.json"}), "INPUT_INVALID"))
    check("configuration cannot escape workspace", lambda: error(lambda: connect({"credentialFile": "../connection.json"}), "WORKSPACE_DENIED"))
    check("missing configuration returns an actionable error", lambda: error(lambda: connect({"credentialFile": "missing.json"}), "INPUT_NOT_FOUND"))
    value = check("Agent creates and tests a new connection", lambda: connect({"credentialFile": "connection.json", "name": "Agent native integration test"}))
    assert value.get("connection") and len(value["layers"]) == 13, value
    connection = value["connection"]["id"]
    try:
        def inspect(layer, limit=2):
            return rpc("data_layer_inspect", {"connectionId": connection, "layer": layer, "limit": limit})
        def attributes():
            value = inspect("demo.boundaries_3857.geom")
            assert value["featureCount"] == 1 and value["sourceCrs"] == "EPSG:3857", value
            assert value["sampleRecords"][0]["name"] == "北京测试范围", value
            assert "geom" not in value["sampleRecords"][0]
            assert any(c["name"] == "geom" and c["spatial"] for c in value["columns"])
            return value
        check("read real fields and Chinese attributes", attributes)
        def rls():
            value = inspect("demo.scoped_regions.geom")
            assert value["featureCount"] == 1 and len(value["sampleRecords"]) == 1, value
            return value
        check("attribute preview respects row-level permissions", rls)
        def large():
            value = inspect("demo.big_area.geom", 2)
            assert value["featureCount"] is None and value["featureCountLowerBound"] == 10001 and len(value["sampleRecords"]) == 2, value
            return {key: value[key] for key in ("featureCount", "featureCountLowerBound", "sampleLimit")}
        check("large layer reports a lower bound, not a false total", large)
        check("points are readable as data", lambda: inspect("demo.points.geom"))
        check("private layer remains inaccessible", lambda: error(lambda: inspect("hidden.private_area.geom"), "INPUT_LAYER_NOT_FOUND"))
        check("Agent attaches the new connection's polygon", lambda: rpc("data_input_read", {"conversationId": conversation, "request": {"connectionId": connection, "layer": "demo.boundaries_3857.geom"}}))
    finally:
        rpc("data_connection_remove", {"connectionId": connection})

Path(os.environ.get("GEOD_TEST_REPORT", str(root / "docs/implementation/evidence/agent-postgis-native-2026-10-01.json"))).write_text(json.dumps({"conversationId": conversation, "cases": cases}, ensure_ascii=False, indent=2), encoding="utf-8")
print(f"{len(cases)}/{len(cases)} passed", flush=True)
