"""Small stdio MCP adapter for separately installed GIS skills."""
import hashlib, sys
sys.dont_write_bytecode=True
tools=json.loads(os.environ['GEOD_GIS_SCHEMAS'])
allowed=set(json.loads(os.environ['GEOD_GIS_TOOLS']))
justifications={}

def request(method,params):
    if method=='initialize': return {'protocolVersion':params.get('protocolVersion','2025-06-18'),'capabilities':{'tools':{}},'serverInfo':{'name':'geod-gis-skills','version':'1.0.0'}}
    if method=='ping': return {}
    if method=='tools/list': return {'tools':[t for t in tools if t['name'] in allowed or t['name']=='store_justification']}
    if method=='tools/call':
        name=params['name']; args=params.get('arguments') or {}
        try:
            if name=='store_justification':
                value=args['justification'];domain=args['domain']
                if domain not in ('crs_datum','resampling'): raise ValueError('Unknown method domain')
                path=Path.cwd()/'.preflight'/'justifications'/domain
                if not path.resolve().is_relative_to(Path.cwd().resolve()): raise ValueError('Invalid justification directory')
                path.mkdir(parents=True,exist_ok=True)
                digest=hashlib.sha256(json.dumps(args,sort_keys=True).encode()).hexdigest()
                (path/(digest+'.json')).write_text(json.dumps(args,ensure_ascii=False),encoding='utf-8')
                justifications[(args['tool_name'],domain)]=value;result={'stored':True,'domain':domain}
            else:
                if name not in allowed: raise ValueError('GIS skill is not installed or enabled')
                if name.endswith('_reproject'):
                    for domain in (['crs_datum','resampling'] if name.startswith('raster') else ['crs_datum']):
                        if (name,domain) not in justifications: raise ValueError(f"Epistemic preflight required for '{name}' **Domain:** {domain}")
                result=gis_operation(name,args)
            return {'content':[{'type':'text','text':json.dumps(result,ensure_ascii=False,allow_nan=False)}],'isError':False}
        except Exception as error: return {'content':[{'type':'text','text':str(error)}],'isError':True}
    raise ValueError('Unsupported MCP method')

for line in sys.stdin:
    value=None
    try:
        if len(line)>2_000_000: raise ValueError('Request too large')
        value=json.loads(line)
        if 'id' not in value: continue
        response={'jsonrpc':'2.0','id':value['id'],'result':request(value['method'],value.get('params') or {})}
    except Exception as error: response={'jsonrpc':'2.0','id':value.get('id') if isinstance(value,dict) else None,'error':{'code':-32602,'message':str(error)}}
    print(json.dumps(response,ensure_ascii=False),flush=True)
