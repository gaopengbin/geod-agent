"""Declared localhost HTTP503 fault for native download acceptance; not a mocked tool."""
from http.server import BaseHTTPRequestHandler,ThreadingHTTPServer
class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(503)
        self.send_header('Content-Type','text/plain')
        self.end_headers()
        self.wfile.write(b'Declared GeoD local HTTP503 fault fixture')
    def log_message(self,*args): pass
print('Declared fault fixture listening on localhost:15441',flush=True)
ThreadingHTTPServer(('127.0.0.1',15441),Handler).serve_forever()
