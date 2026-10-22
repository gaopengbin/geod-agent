"""Independent readback of the GeoPackage produced by the real model task."""
from pathlib import Path
import json,hashlib
import pyogrio
from shapely.geometry import shape
from shapely.ops import unary_union
root=Path('artifacts/boundary-export-20261021');d=json.loads((root/'native-delivery.json').read_text(encoding='utf8'));task=d['task'];source=task['request']['spec']['sourceBoundary'];path=Path(task['outputDir'])/'features.gpkg'
frame=pyogrio.read_dataframe(path,layer='features');actual=frame.geometry.iloc[0]
expected=unary_union(shape({'type':'MultiPolygon','coordinates':source['geometry']['polygons']}))
assert len(source['inputIds'])==5 and len(frame)==1 and actual.is_valid and actual.equals(expected) and frame.crs.to_epsg()==4326
asset=next(a for a in task['manifest']['assets'] if a['kind']=='gpkg');assert hashlib.sha256(path.read_bytes()).hexdigest()==asset['sha256']
report={'passed':True,'path':str(path),'officialCountyInputs':len(source['inputIds']),'features':len(frame),'crs':frame.crs.to_string(),'geometry':actual.geom_type,'valid':actual.is_valid,'equalsSourceUnion':True,'polygonParts':len(actual.geoms) if actual.geom_type=='MultiPolygon' else 1,'holes':sum(len(p.interiors) for p in actual.geoms) if actual.geom_type=='MultiPolygon' else len(actual.interiors),'bytes':path.stat().st_size,'sha256':asset['sha256']}
(root/'independent-file-verification.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf8');print(json.dumps(report,ensure_ascii=False))
