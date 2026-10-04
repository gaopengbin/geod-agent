"""Exercise the actual pinned GDAL writer and reopen its GeoPackage output."""
import json
from pathlib import Path
import runpy
import sys

import pyogrio

root = Path(sys.argv[1]).resolve()
root.mkdir(parents=True, exist_ok=True)
worker = runpy.run_path(str(Path(__file__).resolve().parents[1] / "apps/geod-agent-desktop/src-tauri/src/online_export_worker.py"))
features = [
    {"type": "Feature", "id": "point-1", "properties": {"fid": 51, "名称": "测点甲", "enabled": True, "nullable": None, "nested": {"array": [1, "乙"]}, "geometry": "original property"}, "geometry": {"type": "Point", "coordinates": [116.2, 39.7]}},
    {"type": "Feature", "id": 2, "properties": {"fid": 52, "名称": "道路乙", "enabled": None, "nullable": 12, "nested": [1, 2], "geometry": "line property"}, "geometry": {"type": "LineString", "coordinates": [[116.2, 39.7], [116.25, 39.75]]}},
    {"type": "Feature", "id": "area-3", "properties": {"fid": 53, "名称": "范围丙", "enabled": False, "nullable": 13, "nested": None, "geometry": "area property"}, "geometry": {"type": "Polygon", "coordinates": [[[116.1,39.6],[116.3,39.6],[116.3,39.8],[116.1,39.8],[116.1,39.6]],[[116.15,39.65],[116.15,39.67],[116.17,39.67],[116.17,39.65],[116.15,39.65]]]}},
]
report = {"pass": False, "kind": "actual pinned GDAL writer; labelled local attribute fixtures", "cases": []}
try:
    source = root / "fixture.geojson"
    source.write_text(json.dumps({"type": "FeatureCollection", "features": features}, ensure_ascii=False), encoding="utf-8")
    request = {"inputPath": str(source), "directory": str(root), "outputs": ["geojson", "gpkg"], "maxFeatures": 3, "expectedFeatures": 3}
    result = worker["export"](request)
    actual = json.loads((root / "features.geojson").read_text(encoding="utf-8"))
    assert actual["features"] == features
    gpkg = pyogrio.read_dataframe(root / "features.gpkg", layer="features", read_geometry=False)
    assert list(gpkg["fid"]) == [51,52,53] and list(gpkg["名称"]) == ["测点甲","道路乙","范围丙"]
    assert json.loads(gpkg["nested"].iloc[0]) == features[0]["properties"]["nested"]
    assert list(gpkg["geometry"]) == [f["properties"]["geometry"] for f in features]
    assert result["geometryTypes"] == ["LineString","Point","Polygon"]
    report["cases"].append({"name":"GeoJSON exact attributes/IDs and actual GPKG mixed geometry, null/boolean/Unicode/reserved/nested fields", "pass":True, "manifest":result})
    empty = root / "empty"
    empty.mkdir(exist_ok=True)
    result = worker["export"]({**request,"directory":str(empty),"bounds":[0,0,1,1]})
    assert result["featureCount"] == 0 and pyogrio.read_info(empty / "features.gpkg",layer="features",force_feature_count=True)["features"] == 0
    report["cases"].append({"name":"Empty selected snapshot remains valid GeoJSON and GeoPackage", "pass":True})
    report["pass"] = True
except Exception as error:
    report["cases"].append({"name":"actual writer", "pass":False, "error":str(error), "type":type(error).__name__})
    raise
finally:
    (root / "acceptance.json").write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding="utf-8")
    print(json.dumps({"pass":report["pass"],"cases":report["cases"]},ensure_ascii=False))
