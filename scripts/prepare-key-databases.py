"""Fresh owned loopback databases for encrypted client-key acceptance."""
from pathlib import Path
import argparse,datetime as dt,hashlib,json,secrets,subprocess,sys,time,urllib.request,uuid
from cryptography import x509
from cryptography.hazmat.primitives import hashes,serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.x509.oid import NameOID,ExtendedKeyUsageOID

parser=argparse.ArgumentParser();parser.add_argument('provider',choices=['postgis','mysql','mariadb','oracle']);parser.add_argument('--output',type=Path);args=parser.parse_args()
provider=args.provider;repo=Path(__file__).resolve().parents[1]
root=(args.output or repo/'artifacts/product-gaps-20261004/database-keys').resolve()
assert root.is_relative_to((repo/'artifacts/product-gaps-20261004').resolve()) and root.name not in ['private','workspace'] and not root.is_symlink(),'Keep the owned database fixture inside product-gap artifacts'
private=root/'private'/provider;workspace=root/'workspace'
private.mkdir(parents=True,exist_ok=True);workspace.mkdir(parents=True,exist_ok=True)
assert not (root/(provider+'-ready.json')).exists(),'Preserve accepted fixture identities'
def docker(*args,data=None):
    result=subprocess.run(['docker',*args],input=data,capture_output=True,timeout=70)
    assert result.returncode==0,'Owned Docker operation failed; diagnostics retained privately'
    return result.stdout
def script(name,*args,allow_oracle_prepare=False):
    result=subprocess.run([sys.executable,'-X','utf8',str(repo/'scripts'/name),*args],capture_output=True)
    if result.returncode and not(allow_oracle_prepare and b'Oracle wallet setup is prepared' in result.stderr):
        raise RuntimeError('Owned fixture setup failed in '+name+'; private state retained')
    print(json.dumps({'provider':provider,'stage':name,'completed':True}),flush=True)

if provider=='postgis':
    assert not (private/'state.json').exists(),'An owned fixture already exists'
    now=dt.datetime.now(dt.timezone.utc)
    def pair(name,issuer=None,client=False):
        key=rsa.generate_private_key(public_exponent=65537,key_size=2048)
        subject=x509.Name([x509.NameAttribute(NameOID.COMMON_NAME,name)])
        builder=(x509.CertificateBuilder().subject_name(subject).issuer_name(issuer[1].subject if issuer else subject)
            .public_key(key.public_key()).serial_number(x509.random_serial_number())
            .not_valid_before(now-dt.timedelta(hours=1)).not_valid_after(now+dt.timedelta(days=2))
            .add_extension(x509.BasicConstraints(ca=issuer is None,path_length=0 if issuer is None else None),True))
        if issuer:
            builder=builder.add_extension(x509.ExtendedKeyUsage([ExtendedKeyUsageOID.CLIENT_AUTH if client else ExtendedKeyUsageOID.SERVER_AUTH]),False)
            if not client:builder=builder.add_extension(x509.SubjectAlternativeName([x509.DNSName('localhost')]),False)
        return key,builder.sign(issuer[0] if issuer else key,hashes.SHA256())
    ca=pair('GeoD encrypted-key QA '+uuid.uuid4().hex)
    pairs={'ca':ca,'server':pair('localhost',ca),'client':pair('geod_key_reader',ca,True)}
    for name,(key,cert) in pairs.items():
        (private/(name+'.pem')).write_bytes(cert.public_bytes(serialization.Encoding.PEM))
        (private/(name+'.key')).write_bytes(key.private_bytes(serialization.Encoding.PEM,serialization.PrivateFormat.PKCS8,serialization.NoEncryption()))
    image='postgis/postgis@sha256:60f6ad1d21ea86a67d47780b9a0d1e1d200500f62b19293fa834d0dea80b8677'
    image_id=json.loads(docker('image','inspect',image))[0]['Id']
    state={'container':'geod-agent-keys-postgis-'+uuid.uuid4().hex[:8],'fixtureId':uuid.uuid4().hex,'imageId':image_id,
        'password':'Gd9!'+secrets.token_hex(24),'readerPassword':'','marker':'POSTGIS_KEY_'+uuid.uuid4().hex.upper()}
    (private/'state.json').write_text(json.dumps(state),encoding='utf-8')
    (private/'password.txt').write_text(state['password'])
    (private/'pg_hba.conf').write_text('local all all trust\nhostssl all all 0.0.0.0/0 cert\nhostssl all all ::/0 cert\nhostnossl all all 0.0.0.0/0 reject\nhostnossl all all ::/0 reject\n')
    (private/'init.sql').write_text("CREATE EXTENSION postgis;CREATE ROLE geod_key_reader LOGIN;CREATE TABLE public.regions(id INT PRIMARY KEY,city TEXT,marker TEXT,geom geometry(Polygon,4326));INSERT INTO public.regions VALUES(1,'北京','"+state['marker']+"',ST_MakeEnvelope(116.1,39.6,116.2,39.7,4326));GRANT SELECT ON public.regions TO geod_key_reader;",encoding='utf-8')
    startup='install -o postgres -m 600 /qa/server.key /tmp/geod-server.key; install -o postgres -m 644 /qa/server.pem /tmp/geod-server.pem; exec /usr/local/bin/docker-entrypoint.sh postgres -c ssl=on -c ssl_cert_file=/tmp/geod-server.pem -c ssl_key_file=/tmp/geod-server.key -c ssl_ca_file=/qa/ca.pem -c hba_file=/qa/pg_hba.conf'
    docker('run','--detach','--name',state['container'],'--label','dev.geod-agent.fixture=database-tls','--label','dev.geod-agent.fixture-id='+state['fixtureId'],
        '--publish','127.0.0.1::5432','--memory','1g','--mount',f'type=bind,source={private},target=/qa,readonly',
        '--mount',f'type=bind,source={private/"init.sql"},target=/docker-entrypoint-initdb.d/10-geod.sql,readonly',
        '--env','POSTGRES_USER=geod_keys_admin','--env','POSTGRES_DB=geod_keys','--env','POSTGRES_PASSWORD_FILE=/qa/password.txt','--entrypoint','sh',image,'-c',startup)
    until=time.monotonic()+90
    while time.monotonic()<until:
        probe=subprocess.run(['docker','exec',state['container'],'psql','-U','geod_keys_admin','-d','geod_keys','-Atc','SELECT count(*) FROM public.regions'],capture_output=True,timeout=5)
        if probe.returncode==0 and probe.stdout.strip()==b'1':break
        time.sleep(1)
    else:raise RuntimeError('Owned PostGIS did not become ready')
    port=int(json.loads(docker('inspect',state['container']))[0]['NetworkSettings']['Ports']['5432/tcp'][0]['HostPort'])
    draft=dict(name='PostGIS encrypted key acceptance',host='localhost',port=port,database='geod_keys',user='geod_key_reader',password='',sslMode='verify-full',sslRootCert=(private/'ca.pem').read_text())
    fixture=dict(provider=provider,container=state['container'],fixtureId=state['fixtureId'],imageId=image_id,marker=state['marker'],table='public.regions',schema='public')
else:
    script('prepare-database-tls-fixture.py',provider,'--output',str(root),allow_oracle_prepare=provider=='oracle')
    state=json.loads((private/'state.json').read_text())
    if provider=='oracle':
        tools=json.loads((repo/'artifacts/product-gaps-20261004/database-tls/oracle-wallet-tools.json').read_text())
        (private/'tools').mkdir(exist_ok=True)
        for tool in tools:
            file=private/'tools'/(tool['artifact']+'.jar')
            with urllib.request.urlopen(tool['source'],timeout=40) as response:data=response.read()
            assert hashlib.sha256(data).hexdigest()==tool['sha256'],'Pinned Oracle QA helper changed'
            file.write_bytes(data)
        script('prepare-oracle-tls-wallet.py','--output',str(root))
        script('configure-oracle-tls-fixture.py','--output',str(root),'--client-auth')
    draft=json.loads((workspace/(provider+'-tls.json')).read_text(encoding='utf-8'))
    fixture=json.loads((root/(provider+'-fixture.json')).read_text(encoding='utf-8'))
    if provider in ['mysql','mariadb']:draft['user']='geod_client'
    draft['name']=provider+' encrypted key acceptance'

key=serialization.load_pem_private_key((private/'client.key').read_bytes(),None)
state['keyPassword']='密钥🗝-'+secrets.token_hex(20)
format=serialization.PrivateFormat.TraditionalOpenSSL if provider=='mariadb' else serialization.PrivateFormat.PKCS8
encrypted=key.private_bytes(serialization.Encoding.PEM,format,serialization.BestAvailableEncryption(state['keyPassword'].encode()))
(private/'client-encrypted.key').write_bytes(encrypted)
draft.update(sslClientCert=(private/'client.pem').read_text(),sslClientKey=encrypted.decode(),sslClientKeyPassword=state['keyPassword'])
(private/'state.json').write_text(json.dumps(state,ensure_ascii=False),encoding='utf-8')
(workspace/(provider+'-encrypted.json')).write_text(json.dumps(draft,ensure_ascii=False),encoding='utf-8')
fixture.update({k:v for k,v in draft.items() if k not in ['password','sslRootCert','sslClientCert','sslClientKey','sslClientKeyPassword']})
fixture.update(credentialFile=provider+'-encrypted.json',clientAuthentication=True,keyFormat='TraditionalOpenSSL' if provider=='mariadb' else 'PKCS8')
(root/(provider+'-ready.json')).write_text(json.dumps(fixture,ensure_ascii=False,indent=2),encoding='utf-8')
print(json.dumps(dict(ready=True,provider=provider,port=draft['port'],clientAuthentication=True)),flush=True)
