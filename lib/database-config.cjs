'use strict';
const fs = require('node:fs');

function configError(code, message) {
  return Object.assign(new Error(message), { code });
}

/** Build pg options without allowing URL SSL parameters to replace the trusted CA. */
function buildDatabaseConfig(env = process.env) {
  let url;
  if (env.DATABASE_URL) {
    try {
      url = new URL(env.DATABASE_URL);
      if (!['postgres:', 'postgresql:'].includes(url.protocol)) throw new Error();
    } catch {
      throw configError('DATABASE_URL_INVALID', 'DATABASE_URL must be a PostgreSQL connection URL.');
    }
  }
  const mode = String(env.PGSSLMODE || url?.searchParams.get('sslmode') || 'verify-full').toLowerCase();
  const rootFile = env.PGSSLROOTCERT || url?.searchParams.get('sslrootcert');
  let ca = String(env.DATABASE_CA_CERT || '').replace(/\\r\\n/g, '\n').replace(/\\n/g, '\n').replace(/\r\n/g, '\n').trim();
  if (!ca && rootFile) ca = fs.readFileSync(rootFile, 'utf8').trim();
  if (ca && (!ca.startsWith('-----BEGIN CERTIFICATE-----') || !ca.endsWith('-----END CERTIFICATE-----'))) {
    throw configError('DATABASE_CA_CERT_INVALID', 'DATABASE_CA_CERT must contain the database CA certificate in PEM format.');
  }

  // A deliberate plaintext exception is permitted only for loopback development/CI.
  const local = url && ['localhost', '127.0.0.1', '[::1]', '::1'].includes(url.hostname);
  const disable = mode === 'disable';
  if (disable && !local) {
    throw configError('DATABASE_TLS_REQUIRED', 'Remote PostgreSQL connections require TLS.');
  }
  const ssl = disable ? false : { rejectUnauthorized: true, ...(ca ? { ca } : {}) };
  // Preserve explicitly configured client certificates, if this deployment uses mTLS.
  if (!disable && url?.searchParams.has('sslcert')) ssl.cert = fs.readFileSync(url.searchParams.get('sslcert'), 'utf8');
  if (!disable && url?.searchParams.has('sslkey')) ssl.key = fs.readFileSync(url.searchParams.get('sslkey'), 'utf8');
  if (url) {
    // node-postgres otherwise replaces the entire ssl object while parsing these.
    for (const key of ['ssl', 'sslmode', 'sslrootcert', 'sslcert', 'sslkey', 'uselibpqcompat', 'sslnegotiation']) {
      url.searchParams.delete(key);
    }
  }
  return {
    connectionString: url ? url.toString() : undefined,
    connectionTimeoutMillis: 7000,
    idleTimeoutMillis: 30000,
    query_timeout: 15000,
    statement_timeout: 15000,
    ssl
  };
}
module.exports = { buildDatabaseConfig };
