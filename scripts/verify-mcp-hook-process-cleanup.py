"""Identify the actual QA process instances; Windows may reuse their old PIDs."""
import json
from datetime import datetime
from pathlib import Path
import psutil
import sys

root=Path(sys.argv[1]) if len(sys.argv)>1 else Path('artifacts/product-gaps-20261004/plugin-mcp-hooks')
events_file=sys.argv[2] if len(sys.argv)>2 else 'native-events.jsonl'
starts=[value for value in map(json.loads,(root/events_file).read_text(encoding='utf-8').splitlines()) if value['type']=='started']
pids=sorted({pid for value in starts for pid in (value['pid'],value.get('descendantPid')) if pid is not None})
live=[]
reused=[]
for pid in pids:
    try:
        process=psutil.Process(pid)
        if process.name().lower()!='node.exe':continue
        recorded=[value['at']/1000 if isinstance(value['at'],(int,float)) else datetime.fromisoformat(value['at'].replace('Z','+00:00')).timestamp() for value in starts if pid in (value['pid'],value.get('descendantPid'))]
        if min(abs(process.create_time()-stamp) for stamp in recorded)>5:
            reused.append(pid)
        else:
            live.append(pid)
    except psutil.NoSuchProcess:
        continue
report={'passed':not live,'startedProcesses':len(starts),'checkedPids':len(pids),'liveQaNodePids':live,'reusedPids':reused}
(root/'process-cleanup-result.json').write_text(json.dumps(report,indent=2),encoding='utf-8')
print(json.dumps(report))
assert not live,'An actual QA process instance remains running'
