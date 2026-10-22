"""Exercise the managed exporter: shared edges, holes, islands and readback."""
from pathlib import Path
import sys,json,runpy,tempfile
import pyogrio
from shapely.geometry import Polygon,MultiPolygon
from shapely.ops import unary_union
export=runpy.run_path(str(Path(__file__).resolve().parents[1]/'apps/geod-agent-desktop/src-tauri/src/online_export_worker.py'))['export']
root=Path(tempfile.mkdtemp(prefix='geod-boundary-export-'))
polygons=[Polygon([(0,0),(2,0),(2,2),(0,2),(0,0)],holes=[[(.5,.5),(.5,1),(1,1),(1,.5),(.5,.5)]]),Polygon([(2,0),(3,0),(3,2),(2,2),(2,0)]),Polygon([(5,0),(6,0),(6,1),(5,1),(5,0)])]
geometry=MultiPolygon(polygons)
source=root/'boundary.geojson';source.write_text(json.dumps({'type':'FeatureCollection','features':[{'type':'Feature','properties':{'name':'adjacent areas and island'},'geometry':geometry.__geo_interface__}]}),encoding='utf8')
result=export({'inputPath':str(source),'directory':str(root),'outputs':['gpkg'],'maxFeatures':100,'expectedFeatures':1,'dissolve':True,'targetCrs':'EPSG:4326'})
actual=pyogrio.read_dataframe(root/'features.gpkg');assert len(actual)==1 and actual.geometry.iloc[0].is_valid and actual.geometry.iloc[0].equals(unary_union(polygons));assert len(actual.geometry.iloc[0].geoms)==2;assert sum(len(p.interiors) for p in actual.geometry.iloc[0].geoms)==1
assert actual.crs.to_epsg()==4326
print(json.dumps({'passed':True,'directory':str(root),'manifest':result}))
