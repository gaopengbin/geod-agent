"""Fetch the official EDB portable archive for the isolated local test."""
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
import os
import subprocess
import zipfile

size=315936452
url="https://get.enterprisedb.com/postgresql/postgresql-17.4-1-windows-x64-binaries.zip"
folder=Path(os.environ["TEMP"])/"geod-pg-download"
folder.mkdir(exist_ok=True)
parts=[(i, min(i+16*1024*1024,size)-1) for i in range(0,size,16*1024*1024)]
def fetch(part):
    start,end=part
    path=folder/str(start)
    if not path.exists() or path.stat().st_size!=end-start+1:
        subprocess.run(["curl.exe","--fail","-L","--retry","2","--max-time","180","--proxy","http://127.0.0.1:10808","--range",f"{start}-{end}","-s","-o",str(path),url],check=True,creationflags=subprocess.CREATE_NO_WINDOW)
    if path.stat().st_size != end-start+1: raise RuntimeError("archive range size mismatch")
    return path
with ThreadPoolExecutor(max_workers=8) as pool:
    for future in as_completed([pool.submit(fetch,part) for part in parts]):
        print("Downloaded PostgreSQL archive part",future.result().name,flush=True)
target=Path(os.environ["TEMP"])/"geod-postgresql17.zip"
with target.open("wb") as output:
    for start,end in parts:
        with (folder/str(start)).open("rb") as chunk:
            while data:=chunk.read(1024*1024): output.write(data)
with zipfile.ZipFile(target) as archive:
    if archive.testzip(): raise RuntimeError("PostgreSQL archive CRC check failed")
print("Official PostgreSQL archive complete and CRC verified",flush=True)
