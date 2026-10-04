"""Probe only this user's GeoD companion. Never return its vault credential."""
import argparse
import ctypes
from ctypes import wintypes
import hashlib
import json
import os
from pathlib import Path
import urllib.request
import urllib.error

ROOT = Path(os.environ['APPDATA']) / 'dev.geod-agent.desktop'

class Credential(ctypes.Structure):
    _fields_ = [('Flags', wintypes.DWORD), ('Type', wintypes.DWORD),
        ('TargetName', wintypes.LPWSTR), ('Comment', wintypes.LPWSTR),
        ('LastWritten', wintypes.FILETIME), ('CredentialBlobSize', wintypes.DWORD),
        ('CredentialBlob', ctypes.POINTER(ctypes.c_byte)), ('Persist', wintypes.DWORD),
        ('AttributeCount', wintypes.DWORD), ('Attributes', ctypes.c_void_p),
        ('TargetAlias', wintypes.LPWSTR), ('UserName', wintypes.LPWSTR)]

def own_token():
    target = 'runtime-' + hashlib.sha256(str(ROOT).encode()).hexdigest() + '.dev.geod-agent.background'
    pointer = ctypes.POINTER(Credential)()
    api = ctypes.WinDLL('Advapi32.dll', use_last_error=True)
    api.CredReadW.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD, ctypes.POINTER(ctypes.POINTER(Credential))]
    api.CredReadW.restype = wintypes.BOOL
    api.CredFree.argtypes = [ctypes.c_void_p]
    if not api.CredReadW(target, 1, 0, ctypes.byref(pointer)):
        raise RuntimeError('Own GeoD companion credential unavailable')
    try:
        return ctypes.string_at(pointer.contents.CredentialBlob, pointer.contents.CredentialBlobSize).decode('utf-16-le')
    finally:
        api.CredFree(pointer)

def request(endpoint, command='runtime_status', args=None, auth='valid', origin=False, extra=False):
    headers = {'Content-Type': 'application/json'}
    if auth == 'valid': headers['Authorization'] = 'Bearer ' + own_token()
    if auth == 'wrong': headers['Authorization'] = 'Bearer deliberate-invalid-acceptance'
    if origin: headers['Origin'] = 'https://deliberate-origin.example'
    body = {'command': command, 'args': {} if args is None else args}
    if extra: body['unexpected'] = True
    req = urllib.request.Request(f"http://127.0.0.1:{endpoint['port']}/rpc", data=json.dumps(body).encode(), headers=headers, method='POST')
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    try:
        response = opener.open(req, timeout=10)
    except urllib.error.HTTPError as error:
        response = error
    with response:
        return {'status': response.status, 'cacheControl': response.headers.get('Cache-Control'), **json.load(response)}

if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('mode', choices=['security', 'rpc'])
    parser.add_argument('--command', default='runtime_status')
    parser.add_argument('--args', default='{}')
    options = parser.parse_args()
    endpoint = json.loads((ROOT / 'background-endpoint.json').read_text())
    if options.mode == 'rpc':
        result = request(endpoint, options.command, json.loads(options.args))
    else:
        result = { 'valid': request(endpoint), 'noAuth': request(endpoint, auth='none'),
            'wrongAuth': request(endpoint, auth='wrong'), 'origin': request(endpoint, origin=True),
            'unregistered': request(endpoint, command='codex_turn'),
            'arrayArgs': request(endpoint, args=[]), 'extraField': request(endpoint, extra=True)}
    print(json.dumps(result, ensure_ascii=False))
