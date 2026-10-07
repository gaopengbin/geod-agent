"""Real coordinate transforms in the isolated bundled interpreter and split GIS packages."""
from pathlib import Path
import hashlib, importlib.util, json, os, subprocess, tempfile
ROOT=Path(__file__).resolve().parents[1]
native=ROOT/'apps/geod-agent-desktop/src-tauri'
evidence=ROOT/'artifacts/export-crs-20261007';evidence.mkdir(parents=True,exist_ok=True)
python=native/'resources/python/python.exe'
spec=importlib.util.spec_from_file_location('extract',native/'src/gis_component_worker.py');module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
catalog=json.loads((ROOT/'vendor/gis-components.json').read_text())
env={k:v for k,v in os.environ.items() if k in {'SYSTEMROOT','WINDIR','TEMP','TMP','USERPROFILE','APPDATA','LOCALAPPDATA'}}
env.update(PATH=str(Path(os.environ['SYSTEMROOT'])/'System32'))
checks=[];definitions=[]
with tempfile.TemporaryDirectory(prefix='runtime-',dir=evidence) as temporary:
    root=Path(temporary);packages={}
    for p in catalog['components']:
        archive=ROOT/'artifacts/gis-components-1'/p['filename']
        assert hashlib.file_digest(archive.open('rb'),'sha256').hexdigest()==p['sha256']
        target=root/p['id'];target.mkdir();module.extract(archive,target,p['id'],p['manifestSha256']);packages[p['id']]=target
    def run(code,request=None,components=('gis-common','gis-raster')):
        prefix='import sys;sys.dont_write_bytecode=True;sys.path[:0]='+repr([str(packages[c]) for c in components])+'\n'
        value=subprocess.run([str(python),'-I','-X','utf8','-c',prefix+code],input=json.dumps(request) if request is not None else None,capture_output=True,text=True,encoding='utf-8',env=env,cwd=root,timeout=120)
        assert value.returncode==0,value.stderr+value.stdout
        return json.loads(value.stdout) if request is not None else value.stdout
    worker=(native/'src/export_crs_worker.py').read_text(encoding='utf-8')
    run('''import numpy as np,rasterio
from rasterio.transform import from_bounds
from rasterio.enums import ColorInterp
from rasterio.warp import transform_bounds
box=transform_bounds('EPSG:4326','EPSG:3857',116.38,39.89,116.48,39.98)
for name,count,dtype in [('rgba',4,'uint8'),('dem',1,'float32')]:
    with rasterio.open(name+'.tif','w',driver='GTiff',width=64,height=64,count=count,dtype=dtype,crs='EPSG:3857',transform=from_bounds(*box,64,64),nodata=-9999 if name=='dem' else None) as f:
        f.write(np.full((count,64,64),30 if name=='rgba' else 123.5,dtype=dtype))
        if name=='rgba':
            alpha=np.full((64,64),255,dtype='uint8');alpha[:12]=0;f.write(alpha,4);f.colorinterp=(ColorInterp.red,ColorInterp.green,ColorInterp.blue,ColorInterp.alpha)
from rasterio.shutil import copy
copy('rgba.tif','rgba.png',driver='PNG')
from pathlib import Path
Path('rgba.png.aux.xml').unlink(missing_ok=True)
''')
    for filename,crs in [('rgba.tif','EPSG:4326'),('dem.tif','EPSG:32650'),('rgba.png','EPSG:4490')]:
        result=run(worker,{'path':str(root/filename),'bounds':[116.38,39.89,116.48,39.98],'targetCrs':crs,'options':{'compression':'none','resampling':'nearest','generateSidecars':True}})
        assert 'error' not in result,result
        assert result['width']>0 and result['height']>0
        expected=json.loads(run("import json;from rasterio.warp import transform; print(json.dumps(transform('EPSG:4326',"+repr(crs)+",[116.4],[39.9])))"))
        definitions.append({'crs':crs,'definition':result['crsDefinition'],'input':[116.4,39.9],'expected':[expected[0][0],expected[1][0]]})
        checks.append(filename+' -> '+crs)
    run('''import rasterio,numpy as np
with rasterio.open('rgba.tif') as f:
    assert str(f.crs)=='EPSG:4326' and f.count==4 and f.compression is None
    assert (f.read(4)==0).any() and (f.read(4)==255).any()
    assert f.bounds.left<116.39 and f.bounds.right>116.47
with rasterio.open('dem.tif') as f:
    assert str(f.crs)=='EPSG:32650' and f.nodata==-9999 and f.dtypes==('float32',)
    values=f.read(1);assert np.all(values[values!=-9999]==123.5)
''');checks+=['real pixel coordinates and alpha preserved','DEM values/NoData preserved','uncompressed output']
    assert (root/'rgba.pgw').exists() and (root/'rgba.prj').exists();checks.append('projected PNG world file and CRS definition')
    result=run(worker,{'validateOnly':True,'raster':True,'targetCrs':'EPSG:30000'});assert 'error' in result;checks.append('unknown EPSG rejected')
    result=run(worker,{'validateOnly':True,'raster':True,'targetCrs':'EPSG:4979'});assert 'error' in result;checks.append('3D CRS cannot silently become a 2D export')
    collection={'type':'FeatureCollection','features':[{'type':'Feature','properties':{'name':'test','nested':{'x':1}},'geometry':{'type':'Point','coordinates':[116.4,39.9]}}]}
    (root/'input.geojson').write_text(json.dumps(collection),encoding='utf-8')
    online=(native/'src/online_export_worker.py').read_text(encoding='utf-8')
    out=root/'online';out.mkdir()
    request={'inputPath':str(root/'input.geojson'),'directory':str(out),'outputs':['gpkg'],'targetCrs':'EPSG:32650','maxFeatures':100,'expectedFeatures':1}
    result=run(online,request,('gis-common','gis-vector'));assert result.get('outputCrs')=='EPSG:32650',result
    run('''import pyogrio
f=pyogrio.read_dataframe('online/features.gpkg');assert str(f.crs)=='EPSG:32650' and len(f)==1 and f.geometry.iloc[0].x>400000
''',components=('gis-common','gis-vector'));checks.append('online full-feature projected GPKG readback')
    # Exercise the separate MVT/OSM GeoPackage conversion worker as well.
    run("import pyogrio; f=pyogrio.read_dataframe('online/features.gpkg'); f.to_crs('EPSG:4326').to_file('vector.gpkg',driver='GPKG',layer='features')",components=('gis-common','gis-vector'))
    result=run(worker,{'kind':'vector','path':str(root/'vector.gpkg'),'targetCrs':'EPSG:4490'},('gis-common','gis-vector'));assert result.get('crs')=='EPSG:4490',result
    run("import pyogrio; f=pyogrio.read_dataframe('vector.gpkg'); assert str(f.crs)=='EPSG:4490' and f.iloc[0]['name']=='test' and len(f)==1",components=('gis-common','gis-vector'));checks.append('vector conversion preserves geometry and fields')
    request['outputs']=['gpkg','geojson'];result=run(online,request,('gis-common','gis-vector'));assert 'error' in result;checks.append('GeoJSON non-WGS84 rejected')
    test_env=dict(os.environ,CARGO_HTTP_PROXY='',GEOD_CRS_TEST_PYTHON=str(python),GEOD_CRS_TEST_WORKER=str(native/'src/export_crs_worker.py'),GEOD_CRS_TEST_PACKAGES=json.dumps([str(packages[c]) for c in ('gis-common','gis-raster')]))
    pipeline=subprocess.run(['cargo','test','--offline','--manifest-path',str(ROOT/'crates/geod-task-engine/Cargo.toml'),'--test','export_crs','--','--ignored','--nocapture'],cwd=ROOT,env=test_env,capture_output=True,text=True,encoding='utf-8',timeout=180)
    (evidence/'pipeline-test.log').write_text(pipeline.stdout+'\n'+pipeline.stderr,encoding='utf-8')
    assert pipeline.returncode==0,pipeline.stdout+pipeline.stderr
    checks+=['background native job downloads then reprojects and verifies before completion','pause during reprojection retains cache and resumes','restart verification checks target CRS against approved plan']
report={'passed':True,'checks':checks,'modelCalls':0,'isolatedInterpreter':True,'syntheticFixtures':True,'installedIntoUserProfile':False}
(evidence/'projection-definitions.json').write_text(json.dumps(definitions,ensure_ascii=False,indent=2),encoding='utf-8')
(evidence/'acceptance.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
print(json.dumps(report,ensure_ascii=False,indent=2))
