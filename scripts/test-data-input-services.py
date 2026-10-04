"""Additional live WFS, OGC Features and PostGIS read-only checks."""
import json
import os
from pathlib import Path
import urllib.parse
import urllib.request
import uuid
import psycopg

root = Path(__file__).resolve().parents[1]
conversation = "data-services-test-" + str(uuid.uuid4())
report = []

def read(url):
    body = {"command": "data_input_read", "args": {"conversationId": conversation, "request": {"url": url}}}
    request = urllib.request.Request("http://127.0.0.1:1421/rpc", json.dumps(body).encode(), {"Content-Type": "application/json"})
    response = json.load(urllib.request.urlopen(request, timeout=190))
    if response.get("error"):
        raise RuntimeError(response["error"])
    value = response["value"]
    assert value.get("boundary"), value
    boundary = value["boundary"]
    return {"bounds": boundary["bounds"], "polygonCount": boundary["polygonCount"]}

wfs = "https://ahocevar.com/geoserver/wfs?" + urllib.parse.urlencode({"service": "WFS", "version": "1.0.0", "request": "GetFeature", "typeName": "topp:states", "outputFormat": "application/json", "CQL_FILTER": "STATE_NAME='Virginia'", "srsName": "EPSG:4326"})
try:
    result = read(wfs)
    assert -84 < result["bounds"][0] < -75 and result["polygonCount"] > 0
    report.append({"case": "real WFS GetFeature Virginia", "pass": True, "url": wfs, **result})
except Exception as error:
    report.append({"case": "real WFS GetFeature Virginia", "pass": False, "error": str(error)})

try:
    # Discover an actual feature ID from the official demo rather than invent one.
    catalogue = "https://demo.pygeoapi.io/master/collections/lakes/items?f=json&limit=1"
    proxy = urllib.request.build_opener(urllib.request.ProxyHandler({"https": "http://127.0.0.1:10808"}))
    sample = json.load(proxy.open(catalogue, timeout=45))
    id = sample["features"][0]["id"]
    url = "https://demo.pygeoapi.io/master/collections/lakes/items/" + urllib.parse.quote(str(id), safe="") + "?f=json"
    report.append({"case": "real OGC API Features lake", "pass": True, "discoveredFrom": catalogue, "url": url, **read(url)})
except Exception as error:
    report.append({"case": "real OGC API Features lake", "pass": False, "error": str(error)})

try:
    password = (Path(os.environ["TEMP"]) / "geod-postgis-test/test-password.txt").read_text().strip()
    blocked = False
    with psycopg.connect(host="127.0.0.1", port=55437, dbname="postgres", user="geod_test", password=password, sslmode="disable", options="-c default_transaction_read_only=on -c statement_timeout=15000") as connection:
        try:
            connection.execute("INSERT INTO input_polygons(name,geom) SELECT 'write must be blocked',geom FROM input_polygons LIMIT 1")
        except psycopg.errors.ReadOnlySqlTransaction:
            blocked = True
            connection.rollback()
    assert blocked, "Read-only test unexpectedly allowed an insert"
    report.append({"case": "PostGIS same connection options reject INSERT", "pass": True, "sqlState": "25006"})
except Exception as error:
    report.append({"case": "PostGIS same connection options reject INSERT", "pass": False, "error": str(error)})

out = {"conversationId": conversation, "cases": report}
(root / "docs/implementation/evidence/data-input-services-2026-10-01.json").write_text(json.dumps(out, ensure_ascii=False, indent=2), encoding="utf-8")
print(json.dumps(out, ensure_ascii=False, indent=2), flush=True)
assert all(row["pass"] for row in report)
