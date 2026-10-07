"""Real isolated skill components, GIS files, MCP calls and base document reads."""
from pathlib import Path
import hashlib, importlib.util, json, os, subprocess, tempfile, zipfile

ROOT=Path(__file__).resolve().parents[1];native=ROOT/'apps/geod-agent-desktop/src-tauri'
evidence=ROOT/'artifacts/slim-skills-20261006';evidence.mkdir(exist_ok=True)
catalog=json.loads((ROOT/'vendor/gis-components.json').read_text())
extractor=native/'src/gis_component_worker.py'
spec=importlib.util.spec_from_file_location('component_extract',extractor);module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
python=native/'resources/python/python.exe';packages={};checks=[]
env={k:v for k,v in os.environ.items() if k.upper() in {'SYSTEMROOT','WINDIR','TEMP','TMP','USERPROFILE','APPDATA','LOCALAPPDATA'}}
env.update(PATH=str(Path(os.environ['SYSTEMROOT'])/'System32'),PYTHONHOME='Z:/missing-python',PYTHONPATH='Z:/missing-packages')
def run(code,paths=(),data=None,cwd=None):
    prefix='import sys;sys.dont_write_bytecode=True;sys.path[:0]='+repr([str(p) for p in paths])+'\n'
    result=subprocess.run([str(python),'-I','-X','utf8','-c',prefix+code],input=data,capture_output=True,text=True,encoding='utf-8',env=env,cwd=cwd,timeout=90)
    if result.returncode:raise AssertionError(result.stderr+result.stdout)
    return result.stdout
with tempfile.TemporaryDirectory(prefix='gis-acceptance-',dir=evidence) as temporary:
    root=Path(temporary)
    for p in catalog['components']:
        archive=ROOT/'artifacts/gis-components-1'/p['filename']
        assert hashlib.file_digest(archive.open('rb'),'sha256').hexdigest()==p['sha256']
        target=root/p['id'];target.mkdir();module.extract(archive,target,p['id'],p['manifestSha256']);packages[p['id']]=target
        checks.append('extract '+p['id'])
    for name,paths,code in [('vector',[packages['gis-common'],packages['gis-vector']],'import geopandas,pyogrio,pyproj,shapely;import importlib.util;assert importlib.util.find_spec("rasterio") is None;print("vector-only imports")'),('raster',[packages['gis-common'],packages['gis-raster']],'import rasterio,numpy;import importlib.util;assert importlib.util.find_spec("geopandas") is None;print("raster-only imports")')]:
        run(code,paths);checks.append(name+' independent imports')
    workspace=root/'workspace';workspace.mkdir()
    source={'type':'FeatureCollection','features':[{'type':'Feature','properties':{'name':'accepted'},'geometry':{'type':'Polygon','coordinates':[[[0,0],[2,0],[2,2],[0,2],[0,0]]]}}]}
    (workspace/'range.geojson').write_text(json.dumps(source))
    normalized=json.loads(run((native/'src/data_input_worker.py').read_text(),data=json.dumps({'paths':[str(workspace/'range.geojson')]})))
    assert normalized['geojson']['features'][0]['geometry']==source['features'][0]['geometry'];checks.append('base GeoJSON without GIS')
    docs=native/'resources/documents'
    document=workspace/'plain.docx'
    with zipfile.ZipFile(document,'w') as z:z.writestr('word/document.xml','<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>SLIM-DOC-MARKER</w:t></w:r></w:p></w:body></w:document>')
    script=(native/'src/attachment_worker.py').read_text().split("if __name__ == '__main__':")[0]
    output=run(script+f'\nprint(json.dumps(parse(Path({str(document)!r}),"docx",Path({str(docs)!r}))))')
    assert 'SLIM-DOC-MARKER' in json.loads(output)['text'];checks.append('modern Office without Java/GIS/OCR')
    paths=[packages['gis-common'],packages['gis-vector']]
    worker=(native/'src/gis_worker.py').read_text()
    calls=[('vector_info',{'uri':'range.geojson'}),('vector_convert',{'uri':'range.geojson','output':'range.gpkg','driver':'GPKG'}),('vector_clip',{'uri':'range.gpkg','output':'clip.geojson','bounds':[0,0,1,1]}),('vector_buffer',{'uri':'range.gpkg','output':'buffer.gpkg','distance':0.1}),('vector_simplify',{'uri':'range.gpkg','output':'simple.gpkg','tolerance':0.01}),('vector_reproject',{'uri':'range.gpkg','output':'mercator.gpkg','dst_crs':'EPSG:3857'})]
    for name,args in calls:
        result=json.loads(run(worker+'\nprint(json.dumps(gis_operation('+repr(name)+','+repr(args)+')))',paths,cwd=workspace));assert result.get('feature_count')==1;checks.append(name)
    raster_paths=[packages['gis-common'],packages['gis-raster']]
    run('import numpy as np,rasterio;from rasterio.transform import from_origin\nwith rasterio.open("source.tif","w",driver="GTiff",width=32,height=32,count=1,dtype="uint16",crs="EPSG:4326",transform=from_origin(0,2,0.01,0.01)) as f:f.write(np.arange(1024,dtype="uint16").reshape(32,32),1)',raster_paths,cwd=workspace)
    for name,args in [('raster_info',{'uri':'source.tif'}),('raster_stats',{'uri':'source.tif'}),('raster_convert',{'uri':'source.tif','output':'cog.tif','options':{'driver':'COG','compression':'deflate'}}),('raster_reproject',{'uri':'source.tif','output':'projected.tif','dst_crs':'EPSG:3857','resampling':'nearest'})]:
        result=json.loads(run(worker+'\nprint(json.dumps(gis_operation('+repr(name)+','+repr(args)+')))',raster_paths,cwd=workspace))
        if name=='raster_stats':assert result['bands'][0]['mean']==511.5
        checks.append(name)
    schemas=(native/'src/gis-tools.json').read_text()
    mcp_env=dict(env,GEOD_GIS_SCHEMAS=schemas,GEOD_GIS_TOOLS=json.dumps(['vector_info']))
    prefix='import sys;sys.path[:0]='+repr([str(p) for p in paths])+'\n'
    requests=[{'jsonrpc':'2.0','id':1,'method':'initialize','params':{'protocolVersion':'2025-06-18'}},{'jsonrpc':'2.0','id':2,'method':'tools/list'},{'jsonrpc':'2.0','id':3,'method':'tools/call','params':{'name':'vector_info','arguments':{'uri':'range.gpkg'}}},{'jsonrpc':'2.0','id':4,'method':'tools/call','params':{'name':'vector_clip','arguments':{}}}]
    result=subprocess.run([str(python),'-I','-X','utf8','-c',prefix+worker+'\n'+(native/'src/gdal_stdio.py').read_text()],input='\n'.join(json.dumps(r) for r in requests)+'\n',capture_output=True,text=True,encoding='utf-8',cwd=workspace,env=mcp_env,timeout=60)
    assert result.returncode==0,result.stderr
    responses=[json.loads(line) for line in result.stdout.splitlines()];assert {t['name'] for t in responses[1]['result']['tools']}=={'vector_info','store_justification'};assert responses[2]['result']['isError'] is False;assert responses[3]['result']['isError'] is True;checks.append('MCP discovery and uninstalled tools denied')
    outside=root/'outside.geojson';outside.write_text(json.dumps(source))
    result=run(worker+f'\ntry:gis_operation("vector_info",{{"uri":{str(outside)!r}}})\nexcept ValueError:print("DENIED")',paths,cwd=workspace);assert 'DENIED' in result;checks.append('workspace boundary denial')
    malformed=root/'bad.zip'
    with zipfile.ZipFile(malformed,'w') as z:z.writestr('../escape.py','bad');z.writestr('manifest.json','{}')
    stage=root/'bad-stage';stage.mkdir()
    try:module.extract(malformed,stage,'gis-common',hashlib.sha256(b'{}').hexdigest());raise AssertionError('Bad archive accepted')
    except (ValueError,KeyError):checks.append('bad archive rejected')
report={'passed':True,'checks':checks,'count':len(checks),'isolatedInterpreter':True,'modelCalls':0,'installedIntoUserProfile':False}
(evidence/'python-acceptance.json').write_text(json.dumps(report,indent=2))
print(json.dumps(report,indent=2))
