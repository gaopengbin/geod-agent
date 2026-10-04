"""Observe only the owned Office QA process and its temporary file bytes."""
from pathlib import Path
import hashlib,json,psutil,time
root=Path('artifacts/product-gaps-20261004/legacy-office')
seen=[];ids=set();deadline=time.monotonic()+45
while time.monotonic()<deadline:
    for process in psutil.process_iter(['pid','name','cmdline']):
        if not process.info['name'] or process.info['name'].lower()!='java.exe' or process.info['pid'] in ids:continue
        args=process.info['cmdline'] or []
        if 'GeodOfficeReader' not in args:continue
        ids.add(process.info['pid']);item={'pid':process.info['pid'],'args':args}
        try:
            file=Path(args[args.index('GeodOfficeReader')+1]);item['fileExists']=file.exists()
            if file.is_file():item['fileBytes']=file.stat().st_size;item['fileSha256']=hashlib.sha256(file.read_bytes()).hexdigest()
        except (OSError,IndexError):pass
        seen.append(item);print(json.dumps(item,ensure_ascii=False),flush=True)
    if seen:break
    time.sleep(.02)
(root/'actual-java-child.json').write_text(json.dumps(seen,ensure_ascii=False,indent=2),encoding='utf-8')
