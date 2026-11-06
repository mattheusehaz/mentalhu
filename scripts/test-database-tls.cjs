'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { Client } = require('pg');
const { buildDatabaseConfig } = require('../lib/database-config.cjs');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const tlsUrl = process.env.TLS_TEST_DATABASE_URL;
assert(tlsUrl, 'TLS_TEST_DATABASE_URL must point to a disposable TLS-enabled PostgreSQL instance');
const ca = fs.readFileSync(process.env.TLS_TEST_CA_FILE, 'utf8').trim();
const env = { DATABASE_URL: tlsUrl, DATABASE_CA_CERT: ca, PGSSLMODE: 'verify-full', NODE_ENV: 'production' };
let child, output = '';
async function failure(config, codes) {
  const client = new Client(config);
  try {
    await client.connect();
  } catch (err) {
    assert(codes.includes(err.code), 'Unexpected connection failure code: ' + err.code);
    return err.code;
  } finally {
    await client.end().catch(() => {});
  }
  assert.fail('An untrusted/mismatched certificate was accepted');
}
async function main() {
  const priorCode = await failure({ connectionString: tlsUrl, connectionTimeoutMillis: 4000, ssl: { rejectUnauthorized: false } }, ['SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE']);
  console.log('REPRODUCED original URL/SSL override:', priorCode);
  const missingCode = await failure(buildDatabaseConfig({ ...env, DATABASE_CA_CERT: '' }), ['SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE']);
  console.log('PASS missing CA rejected:', missingCode);
  for (const mode of ['require', 'verify-full', 'no-verify']) {
    const u = new URL(tlsUrl); u.searchParams.set('sslmode', mode);
    const config = buildDatabaseConfig({ ...env, DATABASE_URL: u.toString() });
    assert.equal(new URL(config.connectionString).searchParams.has('sslmode'), false);
    const client = new Client(config);
    assert.equal(client.connectionParameters.ssl.rejectUnauthorized, true);
    assert.equal(client.connectionParameters.ssl.ca, ca);
    try {
      await client.connect();
      const result = await client.query('SELECT ssl FROM pg_stat_ssl WHERE pid=pg_backend_pid()');
      assert.equal(result.rows[0].ssl, true);
    } finally { await client.end(); }
  }
  console.log('PASS verified TLS database queries; URL sslmode cannot override supplied CA');
  const mismatched = new URL(tlsUrl); mismatched.hostname = '127.0.0.1';
  await failure(buildDatabaseConfig({ ...env, DATABASE_URL: mismatched.toString() }), ['ERR_TLS_CERT_ALTNAME_INVALID']);
  console.log('PASS hostname mismatch rejected');
  assert.equal(buildDatabaseConfig({ ...env, DATABASE_CA_CERT: ca.replace(/\n/g, '\\n') }).ssl.ca, ca);
  assert.throws(() => buildDatabaseConfig({ ...env, DATABASE_CA_CERT: '${unresolved.CA_CERT}' }), { code: 'DATABASE_CA_CERT_INVALID' });
  assert.throws(() => buildDatabaseConfig({ DATABASE_URL: 'postgresql://example.invalid/db', PGSSLMODE: 'disable' }), { code: 'DATABASE_TLS_REQUIRED' });
  console.log('PASS escaped PEM, unresolved binding and remote plaintext checks');
  const port = '18081';
  child = spawn(process.execPath, ['server.js'], {
    cwd: path.resolve(__dirname, '..'),
    env: { ...process.env, ...env, PORT: port, CMS_JWT_SECRET: crypto.randomBytes(48).toString('hex') },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  child.stdout.on('data', data => { output += data; });
  child.stderr.on('data', data => { output += data; });
  let ready;
  const base = 'http://127.0.0.1:' + port;
  for (let i = 0; i < 60; i++) {
    if (child.exitCode !== null) throw new Error('App stopped: ' + output);
    try {
      const res = await fetch(base + '/health/ready', { signal: AbortSignal.timeout(10000) });
      const body = await res.json();
      if (res.status === 200) { ready = body; break; }
    } catch { /* retry startup only */ }
    await wait(200);
  }
  assert(ready && ready.database && ready.migrations, 'App did not become ready over TLS: ' + output);
  assert.equal(ready.categories, 21);
  assert(ready.listings >= 300);
  for (const route of ['/api/public/categories', '/api/public/listings?category=pszichologusok&limit=3', '/kategoria/pszichologusok', '/kereses?category=pszichologusok', '/szolgaltato/lineamed-debrecen']) {
    const res = await fetch(base + route, { signal: AbortSignal.timeout(10000) });
    assert.equal(res.status, 200, route);
    await res.text();
  }
  console.log('PASS real application using verified PostgreSQL TLS:', JSON.stringify(ready));
  console.log('ALL DATABASE TLS TESTS PASSED');
}
main().catch(err => { console.error(err); console.error(output); process.exitCode = 1; }).finally(async () => {
  if (child && child.exitCode === null) {
    const ended = once(child, 'exit'); child.kill('SIGTERM');
    await Promise.race([ended, wait(2000)]);
    if (child.exitCode === null) child.kill('SIGKILL');
  }
});
