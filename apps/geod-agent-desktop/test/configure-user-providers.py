"""Receive user-provided credentials on stdin; persist only via native vault APIs.
No credential is written to this script, evidence, or diagnostic output.
"""
import sys,json,urllib.request,urllib.error,getpass
from pathlib import Path

def rpc(command,args=None):
    req=urllib.request.Request('http://127.0.0.1:1421/rpc',data=json.dumps({'command':command,'args':args or {}}).encode(),headers={'Content-Type':'application/json'})
    result=json.load(urllib.request.urlopen(req,timeout=90))
    if 'error' in result:
        raise RuntimeError(result['error'].get('code','NATIVE_ERROR'))
    return result['value']

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self,*args,**kwargs): return None

secrets=json.loads(getpass.getpass('Credential payload (hidden): ') if sys.stdin.isatty() else sys.stdin.readline())
result={'savedSources':[],'ion':{}}
for source_id in ['tianditu-img-w','tianditu-cia-w']:
    stored=rpc('sources_get',{'sourceId':source_id})
    saved=rpc('sources_save',{'endpoint':stored['endpoint'],'minZoom':stored['descriptor']['minZoom'],'maxZoom':stored['descriptor']['maxZoom'],'replaceExisting':True,'credential':{'mode':'queryToken','parameter':'tk','token':secrets['tianditu']}})
    assert saved['credentialRefVersion']!='pending'
    assert secrets['tianditu'] not in json.dumps(rpc('sources_get',{'sourceId':source_id}))
    result['savedSources'].append(source_id)
    print(json.dumps({'sourceSaved':source_id}),flush=True)

if '--tianditu-only' in sys.argv:
    del secrets
    print('Tianditu credentials updated in native vault',flush=True)
    raise SystemExit(0)

proxy=rpc('network_get').get('effectiveProxy')
opener=urllib.request.build_opener(NoRedirect(),urllib.request.ProxyHandler({'https':proxy} if proxy else {}))
def ion(path):
    req=urllib.request.Request('https://api.cesium.com'+path,headers={'Authorization':'Bearer '+secrets['ion'],'Accept':'application/json'})
    try:
        with opener.open(req,timeout=35) as response:return response.status,json.load(response)
    except urllib.error.HTTPError as error:return error.code,{}
    except Exception as error:return type(error).__name__,{}

status,assets=ion('/v1/assets')
result['ion']['assetListStatus']=status
candidates=[a for a in assets.get('items',[]) if a.get('type')=='3DTILES' and a.get('status')=='COMPLETE']
result['ion']['availableAssets']=[{k:a.get(k) for k in ['id','name','type','bytes']} for a in candidates[:30]]
print(json.dumps({'assetListStatus':status,'availableAssets':result['ion']['availableAssets']},ensure_ascii=False),flush=True)
# The public OSM Buildings asset is suitable for a small spatial sample.
asset_id=96188
status,endpoint=ion('/v1/assets/96188/endpoint')
result['ion']['endpointStatus']=status
result['ion']['type']=endpoint.get('type')
if status==200 and endpoint.get('type')=='3DTILES':
    existing=rpc('tiles3d_connections_list')
    connection=next((c for c in existing if c.get('kind')=='cesiumIon' and c.get('assetId')==asset_id),None)
    if not connection:connection=rpc('tiles3d_connection_prepare',{'draft':{'name':'Cesium OSM Buildings','kind':'cesiumIon','assetId':asset_id,'requiredHeaders':[]}})
    saved=rpc('tiles3d_connection_save',{'connectionId':connection['id'],'token':secrets['ion']})
    assert saved['credentialReady']
    assert secrets['ion'] not in json.dumps(rpc('tiles3d_connections_list'))
    result['ion'].update({'connectionId':saved['id'],'assetId':asset_id,'credentialReady':True})
    try:result['ion']['test']=rpc('tiles3d_connection_test',{'connectionId':saved['id']})
    except Exception as error:result['ion']['testError']=str(error)
else:result['ion']['notSavedReason']='OSM Buildings endpoint did not return a usable 3D Tiles asset'
del secrets
Path('../../docs/implementation/evidence/user-provider-connections-2026-10-02.json').write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf-8')
print(json.dumps(result,ensure_ascii=False),flush=True)
