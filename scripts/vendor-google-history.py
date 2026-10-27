"""Copy the reviewed protocol snapshot; never create dependencies on the old checkout."""
from pathlib import Path
import argparse,hashlib,json,subprocess

ROOT=Path(__file__).resolve().parents[1]
parser=argparse.ArgumentParser(description=__doc__)
parser.add_argument('--source',type=Path,required=True,help='Explicit old GeoD checkout to snapshot')
UPSTREAM=parser.parse_args().source.resolve(strict=True)
SOURCE=UPSTREAM/'src-tauri/src/earth_history'
DEST=ROOT/'crates/geod-earth-history/src'
(DEST/'keyhole').mkdir(parents=True,exist_ok=True)
records=[]
for source,target in [('keyhole/io.rs','keyhole/io.rs'),('keyhole/protocol.rs','keyhole/protocol.rs'),('keyhole/wire.rs','keyhole/wire.rs'),('wire.rs','wire_base.rs')]:
    raw=(SOURCE/source).read_bytes()
    text=raw.decode('utf-8').replace('super::super::{transport::sha, Result}','crate::{storage::sha, Result}')
    text=text.replace('super::super::transport::directory()','crate::storage::directory()').replace('super::super::validate_id','crate::validate_id')
    text=text.replace('super::{catalog::pack_date, transport::sha, Result}','crate::{dates::pack_date, storage::sha, Result}')
    text=text.replace('super::super::{wire::varint, Result}','crate::{wire_base::varint, Result}')
    if source=='keyhole/protocol.rs':
        text=text.replace('use super::{\n    crate::{dates::pack_date, storage::sha, Result},\n    io, wire,\n};','use crate::{dates::pack_date, storage::sha, Result};\nuse super::{io, wire};')
    if source=='wire.rs':
        text='use crate::Result;\n\n'+text[text.index('pub fn varint('):text.index('pub fn parse(')]
    (DEST/target).write_text(text,encoding='utf-8')
    records.append({'source':'src-tauri/src/earth_history/'+source,'sourceSha256':hashlib.sha256(raw).hexdigest(),
                    'vendored':target,'vendoredSha256':hashlib.sha256((DEST/target).read_bytes()).hexdigest()})
records.append({'source':'src-tauri/src/earth_history/keyhole/mod.rs','sourceSha256':hashlib.sha256((SOURCE/'keyhole/mod.rs').read_bytes()).hexdigest(),'reuse':'quadtree addressing and inverse Web Mercator raster sampling'})
provenance={'contract':'geod-earth-history.v1','version':'0.1.0','sourceRepository':'https://github.com/gaopengbin/geo-downloader',
            'sourceHead':subprocess.check_output(['git','rev-parse','HEAD'],cwd=UPSTREAM,text=True).strip(),
            'sourceState':'working-tree snapshot; content hashes identify uncommitted source files',
            'capturedOn':'2026-10-27','files':records,'localDependencies':False}
license_bytes=(UPSTREAM/'LICENSE').read_bytes()
(DEST.parent/'LICENSE').write_bytes(license_bytes)
provenance['license']={'source':'LICENSE','vendored':'LICENSE','sha256':hashlib.sha256(license_bytes).hexdigest()}
(ROOT/'crates/geod-earth-history/UPSTREAM.json').write_text(json.dumps(provenance,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
print('Vendored four reviewed protocol files with source hashes; the original checkout is unchanged.')
