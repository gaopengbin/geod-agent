"""Real GDAL fixtures and conversion checks (no mocks). Run in pinned GIS env."""
import importlib.util
import json
import os
from pathlib import Path
import zipfile
import geopandas as gpd
from shapely.geometry import Polygon, Point

root = Path(__file__).resolve().parents[1]
folder = Path(os.environ["TEMP"]) / "geod-data-input-fixtures"
folder.mkdir(exist_ok=True)
spec = importlib.util.spec_from_file_location("data_input_worker", root / "apps/geod-agent-desktop/src-tauri/src/data_input_worker.py")
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)
polygon = Polygon([(116.1,39.6),(116.3,39.6),(116.3,39.8),(116.1,39.8),(116.1,39.6)], [[(116.15,39.65),(116.2,39.65),(116.2,39.7),(116.15,39.7),(116.15,39.65)]])
frame = gpd.GeoDataFrame({"name": ["北京测试范围"]}, geometry=[polygon], crs="EPSG:4326")
cases = []
for extension, driver in [("geojson","GeoJSON"),("shp","ESRI Shapefile"),("gpkg","GPKG"),("sqlite","SQLite"),("kml","KML"),("gml","GML"),("fgb","FlatGeobuf")]:
    path = folder / f"boundary.{extension}"
    if path.exists(): path.unlink()
    projected = frame.to_crs(3857) if extension in ("shp","gpkg","sqlite","fgb") else frame
    projected.to_file(path, driver=driver, engine="pyogrio")
    cases.append({"name":extension, "paths":[str(path)]})
with zipfile.ZipFile(folder / "shapefile.zip", "w") as archive:
    for path in folder.glob("boundary.*"):
        if path.suffix.lower() in (".shp", ".shx", ".dbf", ".prj", ".cpg"): archive.write(path, "shape/" + path.name)
cases.append({"name":"shapefile ZIP", "paths":[str(folder/"shapefile.zip")]})
with zipfile.ZipFile(folder/"boundary.kmz", "w") as archive: archive.write(folder/"boundary.kml", "doc.kml")
cases.append({"name":"KMZ", "paths":[str(folder/"boundary.kmz")]})
(folder/"boundary.wkt").write_text("SRID=4326;"+polygon.wkt,encoding="utf-8")
(folder/"boundary.csv").write_text('name,wkt\n北京,"'+polygon.wkt+'"\n',encoding="utf-8")
cases += [{"name":"EWKT", "paths":[str(folder/"boundary.wkt")]},{"name":"CSV WKT", "paths":[str(folder/"boundary.csv")],"sourceCrs":"EPSG:4326"}]
multi = folder/"multi.gpkg"
if multi.exists(): multi.unlink()
frame.to_file(multi,layer="polygons",driver="GPKG",engine="pyogrio")
gpd.GeoDataFrame({"name":["point"]}, geometry=[Point(116.2,39.7)], crs=4326).to_file(multi,layer="points",driver="GPKG",engine="pyogrio")
cases += [{"name":"multi layer selection", "paths":[str(multi)],"expectSelection":True}, {"name":"multi polygon selected", "paths":[str(multi)],"layer":"polygons"}, {"name":"point rejection", "paths":[str(multi)],"layer":"points","expectError":"INPUT_NOT_POLYGON"}]
(folder/"missing-crs.wkt").write_text(polygon.wkt,encoding="utf-8")
cases.append({"name":"missing CRS", "paths":[str(folder/"missing-crs.wkt")],"expectError":"INPUT_CRS_REQUIRED"})
with zipfile.ZipFile(folder/"unsafe.zip","w") as archive: archive.writestr("../escape.geojson",frame.to_json())
cases.append({"name":"ZIP traversal rejection","paths":[str(folder/"unsafe.zip")],"expectError":"INPUT_ARCHIVE_INVALID"})
checks=[]
for case in cases:
    try:
        result=worker.run(case)
        if case.get("expectError"): raise AssertionError("expected rejection")
        if case.get("expectSelection"):
            assert result["selectionRequired"] and len(result["layers"])==2
            checks.append({"case":case["name"],"pass":True,"layers":result["layers"]})
            continue
        imported=gpd.GeoDataFrame.from_features(result["geojson"]["features"],crs=4326)
        assert max(abs(a-b) for a,b in zip(imported.total_bounds,[116.1,39.6,116.3,39.8]))<1e-6
        assert len(imported.geometry.iloc[0].interiors)==1, "polygon hole lost"
        checks.append({"case":case["name"],"pass":True,"bounds":list(imported.total_bounds),"holeCount":1,"sourceCrs":result["sourceCrs"]})
    except worker.InputError as error:
        checks.append({"case":case["name"],"pass":error.code==case.get("expectError"),"code":error.code,"message":error.message})
    except Exception as error:
        checks.append({"case":case["name"],"pass":False,"error":str(error)})
report={"fixtureDirectory":str(folder),"gdalVersion":worker.pyogrio.__gdal_version_string__,"cases":checks}
(root/"docs/implementation/evidence/data-input-formats-2026-10-01.json").write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding="utf-8")
print(json.dumps(report,ensure_ascii=False,indent=2))
assert all(check["pass"] for check in checks)
