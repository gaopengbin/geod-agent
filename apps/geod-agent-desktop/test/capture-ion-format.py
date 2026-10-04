"""Capture one authorized, bounded 3D format sample, never URLs or credentials."""
import getpass,json,urllib.request,urllib.parse,gzip,math,struct,hashlib
from pathlib import Path
token=getpass.getpass('Ion token (hidden): ')
class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self,*args,**kwargs):return None
opener=urllib.request.build_opener(NoRedirect(),urllib.request.ProxyHandler({'https':'http://127.0.0.1:7890'}))
def get(url,token):
    with opener.open(urllib.request.Request(url,headers={'Authorization':'Bearer '+token}),timeout=25) as r:
        assert r.status==200
        data=r.read(16*1024*1024+1);assert len(data)<=16*1024*1024
        if data[:2]==b'\x1f\x8b':data=gzip.decompress(data)
        assert len(data)<=32*1024*1024
        return data
endpoint=json.loads(get('https://api.cesium.com/v1/assets/96188/endpoint',token));del token
url=endpoint['url'];credential=endpoint['accessToken'];origin=urllib.parse.urlsplit(url).netloc;query=urllib.parse.urlsplit(url).query
def child(base,path):
    u=urllib.parse.urlsplit(urllib.parse.urljoin(base,path));assert u.scheme=='https' and u.netloc==origin
    values=urllib.parse.parse_qs(query)
    values.update(urllib.parse.parse_qs(u.query))
    return urllib.parse.urlunsplit((u.scheme,u.netloc,u.path,urllib.parse.urlencode(values,doseq=True),''))
bounds=[116.456,39.910,116.461,39.915]
def intersects(node):
    region=node.get('boundingVolume',{}).get('region')
    if not region:return True
    west,south,east,north=map(math.degrees,region[:4])
    return not(east<bounds[0] or west>bounds[2] or north<bounds[1] or south>bounds[3])
pending=[url];count=0;found=False
while pending and count<64 and not found:
    current=pending.pop(0);data=get(current,credential);count+=1
    if data[:4] in [b'b3dm',b'glTF',b'cmpt',b'pnts']:
        offset=28+sum(struct.unpack_from('<4I',data,12)) if data[:4]==b'b3dm' else 0
        chunks=[];cursor=offset+12
        if data[offset:offset+4]!=b'glTF':continue
        while cursor+8<=len(data):
            n,kind=struct.unpack_from('<II',data,cursor);chunks.append({'type':kind,'length':n,'start':cursor+8,'end':cursor+8+n,'total':len(data)});cursor+=8+n
        if not any(c['length']%4 for c in chunks):continue
        path=Path('../../artifacts/desktop-parity/ion-format-sample')/(hashlib.sha256(data).hexdigest()+'.bin');path.parent.mkdir(parents=True,exist_ok=True);path.write_bytes(data)
        print(json.dumps({'sample':str(path.resolve()),'bytes':len(data),'magic':data[:4].decode(),'requests':count,'chunks':chunks}));found=True;break
    doc=json.loads(data);nodes=[doc['root']]
    while nodes:
        node=nodes.pop(0)
        if not intersects(node):continue
        content=node.get('content',{})
        uri=content.get('uri') or content.get('url')
        if uri:pending.append(child(current,uri))
        nodes.extend(node.get('children',[]))
assert found,'No content within bounded sample search'
