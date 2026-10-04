from pathlib import Path
import json

repo = Path(__file__).resolve().parents[1]
description = ('On user request connect and save a SQLite, MySQL/MariaDB, SQL Server or Oracle input using bundled DBHub MCP. '
               'SQLite uses kind=sqlite and a workspace-relative relativePath (.db/.sqlite/.sqlite3/.gpkg). '
               'Other types use a user-provided workspace-relative credentialFile (JSON kind, name, host, port, database, user, password, sslMode and optional sslRootCert, sslClientCert, sslClientKey) '
               'or non-secret kind/host/database/user; authentication opens a native form. '
               'TLS modes: disable, require (encryption), verify-ca (certificate chain), verify-full (chain and hostname). SQL Server supports disable/require/verify-full and no client certificate. '
               'Oracle encrypted connections always validate the certificate chain. Custom CA and client certificate/private key are configured locally, not in model arguments. '
               'Never read credential files through shell tools or ask for secrets in chat. Returns connection ID and real table catalog. SQL attributes do not automatically become polygon boundaries.')
for relative in ['apps/geod-agent-desktop/src-tauri/native-tools.json', 'apps/geod-agent-desktop/src/sql-tools.json']:
    path = repo / relative
    values = json.loads(path.read_text(encoding='utf-8'))
    for item in values:
        function = item.get('function', item)
        if function['name'] == 'sql_connection_connect':
            function['description'] = description
            schema = function.get('parameters', function.get('inputSchema'))
            schema['properties']['sslMode']['enum'] = ['disable', 'require', 'verify-ca', 'verify-full']
    path.write_text(json.dumps(values, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
path = repo / 'apps/geod-agent-desktop/src/locales/en.json'
value = json.loads(path.read_text(encoding='utf-8'))
value.update({'加密并验证 CA 证书': 'Encrypt and verify the CA certificate',
              'Oracle 加密连接始终验证证书链；私有证书需要配置 CA。': 'Oracle encrypted connections always verify the certificate chain. Configure a CA for private certificates.',
              '证书文件不能超过 {0} KiB': 'Certificate files must not exceed {0} KiB'})
path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
