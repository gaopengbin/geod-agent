"""Real GeoServer/PostGIS WFS responses consumed by GeoD's native importer."""
import json
from pathlib import Path
import urllib.parse
import urllib.request
import uuid

root = Path(__file__).resolve().parents[1]
conversation = "docker-wfs-native-" + str(uuid.uuid4())
report = []
base = "http://127.0.0.1:18083/geoserver/wfs"

def url(**overrides):
    values = {"service": "WFS", "version": "2.0.0", "request": "GetFeature", "typeNames": "geod:boundary", "srsName": "EPSG:4326", "outputFormat": "application/json"}
    values.update(overrides)
    return base + "?" + urllib.parse.urlencode(values)

def read(target):
    request = urllib.request.Request("http://127.0.0.1:1421/rpc", json.dumps({"command": "data_input_read", "args": {"conversationId": conversation, "request": {"url": target}}}).encode(), {"Content-Type": "application/json"})
    response = json.load(urllib.request.urlopen(request, timeout=190))
    return {"error": response["error"]} if response.get("error") else response["value"]

def check(name, target, count=1, error=None):
    try:
        value = read(target)
        if error:
            assert value.get("error", {}).get("code") == error, value
            details = {"code": error}
        else:
            boundary = value.get("boundary")
            assert boundary, value
            expected = [116.1,39.6,116.3 + (0.4 if count == 2 else 0),39.8]
            assert max(abs(a-b) for a,b in zip(boundary["bounds"], expected)) < 1e-6, boundary["bounds"]
            assert boundary["polygonCount"] == count and all(len(polygon) == 2 for polygon in boundary["geometry"]["polygons"]), boundary
            details = {"bounds": boundary["bounds"], "polygonCount": count, "holesPreserved": True}
        report.append({"case": name, "url": target, "pass": True, **details})
        print(name, "PASS", flush=True)
    except Exception as exception:
        report.append({"case": name, "url": target, "pass": False, "error": str(exception)})
        print(name, "FAIL", str(exception), flush=True)

check("WFS 2.0 GeoJSON", url())
check("WFS GeoJSON projected EPSG:3857", url(srsName="EPSG:3857"))
check("WFS 1.0 GML2", url(version="1.0.0", typeName="geod:boundary", outputFormat="GML2"))
check("WFS 2.0 GML3.2 latitude longitude axis order", url(srsName="urn:ogc:def:crs:EPSG::4326", outputFormat="application/gml+xml; version=3.2"))
check("WFS MultiPolygon", url(typeNames="geod:regions"), count=2)
check("WFS GeoJSON pagination rejected", url(typeNames="geod:many_regions",count="1"), error="INPUT_PAGED_RESULT")
check("WFS GML pagination rejected", url(typeNames="geod:many_regions",count="1",outputFormat="application/gml+xml; version=3.2"), error="INPUT_PAGED_RESULT")
check("WFS nonexistent layer error", url(typeNames="geod:does_not_exist"), error="INPUT_NETWORK_FAILED")
(root / "docs/implementation/evidence/docker-wfs-native-2026-10-01.json").write_text(json.dumps({"conversationId": conversation, "cases": report}, ensure_ascii=False, indent=2), encoding="utf-8")
print(f"{sum(row['pass'] for row in report)}/{len(report)} passed", flush=True)
assert all(row["pass"] for row in report)
