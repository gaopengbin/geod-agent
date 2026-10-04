from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import json
import sys
import threading

root = Path(sys.argv[1]).resolve()
class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass
    def do_POST(self):
        if self.path == "/shutdown":
            self.send_response(204); self.end_headers()
            threading.Thread(target=self.server.shutdown, daemon=True).start()
            return
        if self.path != "/mode":
            self.send_error(404); return
        mode = self.rfile.read(int(self.headers.get("Content-Length", "0"))).decode()
        if mode not in ("valid", "tampered", "wrong-version", "current"):
            self.send_error(400); return
        (root / "mode.txt").write_text(mode)
        self.send_response(204); self.end_headers()
    def do_GET(self):
        if self.path == "/manifest":
            mode = (root / "mode.txt").read_text()
            content = json.dumps({"version": "0.2.0" if mode == "current" else "0.2.2" if mode == "wrong-version" else "0.2.1",
                                  "notes": "Local signed acceptance fixture; this is not a published release.",
                                  "pub_date": "2026-10-04T00:00:00Z",
                                  "url": "http://127.0.0.1:16451/" + ("tampered.bin" if mode == "tampered" else "fixture.bin"),
                                  "signature": (root / "fixture.bin.sig").read_text().strip()}).encode()
            mime = "application/json"
        elif self.path in ("/fixture.bin", "/tampered.bin"):
            content = (root / self.path.lstrip("/")).read_bytes(); mime = "application/octet-stream"
        else:
            self.send_error(404); return
        self.send_response(200); self.send_header("Content-Type", mime); self.send_header("Content-Length", str(len(content))); self.end_headers(); self.wfile.write(content)
server = ThreadingHTTPServer(("127.0.0.1", 16451), Handler)
try:
    server.serve_forever()
finally:
    server.server_close()
