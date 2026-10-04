"""Apply an exact, versioned extension without accepting changed upstream files."""
from pathlib import Path
import hashlib
import shutil

PATCHES = {
    'mysql-XXIHWQGR.js': ('4c1b865f88a099c03445140acca3bd7fdee668375e2411b29f976ee1d3331a43',
                         '      return config2;', '      return applyGeodTls(config2, "mysql");'),
    'mariadb-L7Z55ROY.js': ('03d85adb9ad211e132cb8e135fd5762a6623f0aa91048be5744608c359bce597',
                           '      return connectionConfig;', '      return applyGeodTls(connectionConfig, "mariadb");'),
    'sqlserver-AJUK6L55.js': ('162b532a9f78b750571063f945a9098b57d7e10de806b1a3c92cd90bf42d188c',
                             '      return config2;', '      return applyGeodTls(config2, "sqlserver");'),
    'oracle-OUKBU52X.js': ('7372bc27f01a18f40436249e515e19c55c72ec788a744664cb048d13560043c8',
                          '        pool,\n', '        pool: applyGeodTls(pool, "oracle"),\n'),
}
IMPORT = 'import { applyGeodTls } from "./geod-tls.mjs";\n'


def patch(target: Path, source: Path):
    directory = target / 'node_modules/@bytebase/dbhub/dist'
    for name, (digest, old, new) in PATCHES.items():
        path = directory / name
        content = path.read_bytes()
        if content.startswith(IMPORT.encode()):
            upstream = content[len(IMPORT):].decode().replace(new, old, 1).encode()
        else:
            upstream = content
        if hashlib.sha256(upstream).hexdigest() != digest:
            raise RuntimeError(f'Pinned DBHub connector changed: {name}')
        text = upstream.decode()
        if text.count(old) != 1:
            raise RuntimeError(f'DBHub connector patch is ambiguous: {name}')
        path.write_bytes((IMPORT + text.replace(old, new, 1)).encode())
    shutil.copyfile(source / 'geod-tls.mjs', directory / 'geod-tls.mjs')
    # mysql2 deliberately omits IP literals from SNI. Identity verification must
    # still check those IPs against the leaf certificate, independently of SNI.
    path = target / 'node_modules/mysql2/lib/base/connection.js'
    old = "if (typeof servername === 'string' && verifyIdentity) {\n            const cert = secureSocket.getPeerCertificate(true);\n            const serverIdentityCheckError = Tls.checkServerIdentity(\n              servername,"
    new = "if (verifyIdentity) {\n            const cert = secureSocket.getPeerCertificate(true);\n            const serverIdentityCheckError = Tls.checkServerIdentity(\n              this.config.host,"
    content = path.read_bytes().decode()
    upstream = content.replace(new, old, 1) if new in content else content
    if hashlib.sha256(upstream.encode()).hexdigest() != 'b22610ef653a8c2e4e6395aa5fdfa78bd150a631fc8029e49e2d165f83d0ccb7' or upstream.count(old) != 1:
        raise RuntimeError('Pinned mysql2 TLS identity implementation changed')
    path.write_bytes(upstream.replace(old, new, 1).encode())


if __name__ == '__main__':
    repo = Path(__file__).resolve().parents[1]
    patch(repo / 'apps/geod-agent-desktop/src-tauri/resources/dbhub', repo / 'vendor/dbhub')
