"""Bounded provider diagnostics. User secrets enter via hidden prompt only."""
import getpass,json,urllib.request,urllib.error,urllib.parse,gzip,zlib,sys
secrets=json.loads(getpass.getpass('Credential payload (hidden): '))
class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self,*args,**kwargs):return None
def request(url,headers=None,proxy=True):
    opener=urllib.request.build_opener(NoRedirect(),urllib.request.ProxyHandler({'https':'http://127.0.0.1:7890'} if proxy else {}))
    try:
        response=opener.open(urllib.request.Request(url,headers=headers or {}),timeout=25)
    except urllib.error.HTTPError as e:response=e
    except Exception as e:return {'transportError':type(e).__name__},None
    body=response.read(20*1024*1024)
    info={'status':response.status,'contentType':response.headers.get('Content-Type'),'encoding':response.headers.get('Content-Encoding'),'bytes':len(body),'gzipMagic':body[:2]==b'\x1f\x8b'}
    if body[:2]==b'\x1f\x8b':body=gzip.decompress(body)
    try:obj=json.loads(body)
    except Exception:obj=None
    if obj is not None:info['jsonKeys']=list(obj)[:12]
    if response.status!=200 or (isinstance(obj,dict) and 'code' in obj):
        message=body.decode('utf-8',errors='replace')[:700]
        for secret in secrets.values():message=message.replace(secret,'[redacted]')
        info['message']=message
    return info,obj

for proxy in [True,False]:
    url='https://t0.tianditu.gov.cn/img_w/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=img&STYLE=default&TILEMATRIXSET=w&FORMAT=tiles&TILEMATRIX=15&TILEROW=12417&TILECOL=26977&tk='+secrets['tianditu']
    info,_=request(url,proxy=proxy);print(json.dumps({'tiandituProxy':proxy,**info},ensure_ascii=False),flush=True)
if '--tianditu-only' in sys.argv:raise SystemExit(0)
info,endpoint=request('https://api.cesium.com/v1/assets/96188/endpoint',{'Authorization':'Bearer '+secrets['ion']})
print(json.dumps({'ionEndpoint':info,'type':(endpoint or {}).get('type')},ensure_ascii=False),flush=True)
if endpoint:
    url=endpoint.get('url') or endpoint.get('options',{}).get('url')
    parsed=urllib.parse.urlsplit(url)
    print(json.dumps({'endpointHost':parsed.hostname,'endpointPath':parsed.path,'queryKeys':list(urllib.parse.parse_qs(parsed.query))}),flush=True)
    headers={'Authorization':'Bearer '+endpoint['accessToken']} if endpoint.get('accessToken') else {}
    info,obj=request(url,headers)
    print(json.dumps({'exactEndpoint':info,'version':(obj or {}).get('asset',{}).get('version'),'rootVolumeKeys':list((obj or {}).get('root',{}).get('boundingVolume',{}))}),flush=True)
