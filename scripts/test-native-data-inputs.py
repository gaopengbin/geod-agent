"""Actual Tauri IPC integration (the local adapter must run on 1421)."""
import base64
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import threading
import urllib.request
import uuid

root=Path(__file__).resolve().parents[1]
fixture=Path(os.environ["TEMP"])/"geod-data-input-fixtures"
conversation="data-input-native-"+str(uuid.uuid4())
report=[]
def rpc(command,args=None):
    request=urllib.request.Request("http://127.0.0.1:1421/rpc",json.dumps({"command":command,"args":args or {}}).encode(),{"Content-Type":"application/json"})
    value=json.load(urllib.request.urlopen(request,timeout=190))
    if value.get("error"): raise RuntimeError(str(value["error"]))
    return value["value"]
def read(request): return rpc("data_input_read",{"conversationId":conversation,"request":request})
def file(name): return {"name":name,"base64":base64.b64encode((fixture/name).read_bytes()).decode()}
def check(name,request,expected=None):
    try:
        result=read(request)
        if expected:
            assert result.get("error",{}).get("code")==expected,result
        else:
            assert result.get("boundary"), result
            assert max(abs(a-b) for a,b in zip(result["boundary"]["bounds"],[116.1,39.6,116.3,39.8]))<1e-6
            assert len(result["boundary"]["geometry"]["polygons"][0])==2
        report.append({"case":name,"pass":True,"bounds":result.get("boundary",{}).get("bounds"),"code":result.get("error",{}).get("code")})
        print(name,"PASS",flush=True)
        return result
    except Exception as error:
        report.append({"case":name,"pass":False,"error":str(error)}); print(name,"FAIL",str(error),flush=True)
for ext in ["geojson","gpkg","sqlite","kml","gml","fgb","kmz","wkt"]:
    check("native "+ext,{"files":[file("boundary."+ext)]})
check("native SHP group",{"files":[file("boundary."+ext) for ext in ["shp","shx","dbf","prj","cpg"]]})
check("native ZIP",{"files":[file("shapefile.zip")]})
check("native CSV WKT",{"files":[file("boundary.csv")],"sourceCrs":"EPSG:4326"})
multi=read({"files":[file("multi.gpkg")]})
assert multi["selectionRequired"] and len(multi["layers"])==2
report.append({"case":"native multi layer list","pass":True})
check("native layer selected",{"handle":multi["handle"],"layer":"polygons"})
check("native point rejected",{"handle":multi["handle"],"layer":"points"},"INPUT_NOT_POLYGON")
missing=check("native CRS required",{"files":[file("missing-crs.wkt")]},"INPUT_CRS_REQUIRED")
check("native CRS supplied",{"handle":missing["handle"],"sourceCrs":"EPSG:4326"})
check("native ZIP traversal rejected",{"files":[file("unsafe.zip")]},"INPUT_ARCHIVE_INVALID")
geo=json.loads((fixture/"boundary.geojson").read_text(encoding="utf-8"))
class Handler(BaseHTTPRequestHandler):
    def log_message(self,*args): pass
    def do_GET(self):
        value=dict(geo)
        if self.path=="/paged": value["exceededTransferLimit"]=True
        if self.path=="/ogc-next": value["links"]=[{"rel":"next","href":"/next"}]
        data=json.dumps(value).encode()
        self.send_response(200); self.send_header("Content-Type","application/geo+json"); self.end_headers(); self.wfile.write(data)
server=ThreadingHTTPServer(("127.0.0.1",15438),Handler)
threading.Thread(target=server.serve_forever,daemon=True).start()
check("native online GeoJSON",{"url":"http://127.0.0.1:15438/data.geojson"})
for path in ["paged","ogc-next"]:
    try:
        read({"url":"http://127.0.0.1:15438/"+path})
        raise AssertionError("incomplete online result accepted")
    except RuntimeError as error:
        assert "INPUT_PAGED_RESULT" in str(error),error
        report.append({"case":"native pagination "+path,"pass":True})
server.shutdown()
public_url="https://sampleserver6.arcgisonline.com/arcgis/rest/services/Census/MapServer/3/query?where=STATE_NAME%3D%27Virginia%27&outFields=STATE_NAME&returnGeometry=true&outSR=4326&f=geojson"
try:
    public=read({"url":public_url})
    assert public.get("boundary"),public
    b=public["boundary"]
    assert -84<b["bounds"][0]<-75 and 35<b["bounds"][1]<40
    report.append({"case":"real ArcGIS Virginia query","pass":True,"url":public_url,"bounds":b["bounds"],"polygonCount":b["polygonCount"]})
except Exception as error: report.append({"case":"real ArcGIS Virginia query","pass":False,"error":str(error)})
password=(Path(os.environ["TEMP"])/"geod-postgis-test/test-password.txt")
if password.exists():
    connection=rpc("data_connection_save",{"draft":{"name":"GeoD integration test","host":"127.0.0.1","port":55437,"database":"postgres","user":"geod_test","password":password.read_text().strip(),"sslMode":"disable"}})
    assert "connection" in connection,connection
    id=connection["connection"]["id"]
    try:
        layers=read({"connectionId":id})["layers"]
        assert any(layer["name"]=="public.input_polygons.geom" for layer in layers)
        report.append({"case":"native PostGIS layer discovery","pass":True,"layers":layers})
        check("native PostGIS projected polygon",{"connectionId":id,"layer":"public.input_polygons.geom"})
        assert "password" not in json.dumps(rpc("data_connections_list"))
        report.append({"case":"native database credential privacy","pass":True})
    finally: rpc("data_connection_remove",{"connectionId":id})
else: report.append({"case":"native PostGIS","pass":False,"error":"Test PostgreSQL not started"})
out={"conversationId":conversation,"cases":report}
(root/"docs/implementation/evidence/data-input-native-2026-10-01.json").write_text(json.dumps(out,ensure_ascii=False,indent=2),encoding="utf-8")
print(json.dumps(out,ensure_ascii=False,indent=2))
assert all(row["pass"] for row in report)
