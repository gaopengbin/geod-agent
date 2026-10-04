// GeoD's versioned extension to the pinned DBHub 1.4.0 DSN parsers.
// Only the native host supplies this private session file. Nothing is logged.
import { readFileSync, statSync } from 'node:fs';
import { rootCertificates } from 'node:tls';

let settings;
function nativeSettings() {
  if (settings !== undefined) return settings;
  const file = process.env.GEOD_DBHUB_TLS_FILE;
  if (!file) return settings = null;
  if (statSync(file).size > 1024 * 1024) throw new Error('TLS session settings exceed limit');
  const value = JSON.parse(readFileSync(file, 'utf8'));
  if (!value || !['disable', 'require', 'verify-ca', 'verify-full'].includes(value.mode)
      || Object.keys(value).some(key => !['mode', 'ca', 'cert', 'key'].includes(key))
      || ['ca', 'cert', 'key'].some(key => value[key] !== undefined && typeof value[key] !== 'string')
      || Boolean(value.cert) !== Boolean(value.key)) throw new Error('Invalid TLS session settings');
  if (value.mode === 'disable' && (value.ca || value.cert)) throw new Error('TLS material requires encryption');
  return settings = value;
}

export function applyGeodTls(config, kind) {
  const value = nativeSettings();
  if (!value) return config; // Preserve the original standalone DBHub behavior.
  if (kind === 'mysql' || kind === 'mariadb') {
    config.ssl = value.mode === 'disable' ? undefined : {
      rejectUnauthorized: value.mode !== 'require',
      ...(kind === 'mysql' ? { verifyIdentity: value.mode === 'verify-full' }
        : value.mode === 'verify-ca' ? { checkServerIdentity: () => undefined } : {}),
      ...(value.ca ? { ca: value.ca } : {}),
      ...(value.cert ? { cert: value.cert, key: value.key } : {}),
    };
  } else if (kind === 'sqlserver') {
    if (value.mode === 'verify-ca' || value.cert) throw new Error('Unsupported SQL Server TLS configuration');
    config.options.encrypt = value.mode !== 'disable';
    config.options.trustServerCertificate = value.mode === 'require';
    if (value.ca) config.options.cryptoCredentialsDetails = { ca: value.ca };
  } else if (kind === 'oracle') {
    config.sslServerDNMatch = value.mode === 'verify-full';
    config.sslAllowWeakDNMatch = false;
    // Thin mode always validates the chain. CA-only connections use the native
    // NODE_EXTRA_CA_CERTS file; mTLS uses one PEM wallet held in process memory.
    if (value.cert) config.walletContent = [value.key, value.cert, value.ca || rootCertificates.join('\n')].join('\n');
  } else if (kind !== 'sqlite') throw new Error('Unsupported TLS database provider');
  return config;
}
