from pathlib import Path
import subprocess
import sys
import time
import urllib.request

directory = Path(sys.argv[1]).resolve(strict=True)
server = Path(__file__).with_name('serve-update-fixture.py')
process = subprocess.Popen([sys.executable, '-X', 'utf8', str(server), str(directory)],
                           stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                           creationflags=subprocess.CREATE_NO_WINDOW | subprocess.CREATE_NEW_PROCESS_GROUP)
for _ in range(30):
    try:
        with urllib.request.urlopen('http://127.0.0.1:16451/manifest', timeout=1) as response:
            if response.status == 200:
                print('Local signed update acceptance service ready (non-executable fixture)')
                break
    except OSError:
        time.sleep(.1)
else:
    process.terminate()
    raise SystemExit('Update acceptance fixture did not start')
