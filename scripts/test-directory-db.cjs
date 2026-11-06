'use strict';
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { Pool } = require('pg');
const crypto = require('node:crypto');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const base = 'http://127.0.0.1:18080';
let child = null;
let output = '';
const env = {
  ...process.env, PORT: '18080', NODE_ENV: 'test', PGSSLMODE: 'disable',
  CMS_JWT_SECRET: crypto.randomBytes(48).toString('hex'),
  CMS_ADMIN_EMAIL: 'ci@example.invalid', CMS_ADMIN_PASSWORD: crypto.randomBytes(20).toString('hex')
};
assert(env.DATABASE_URL, 'A disposable DATABASE_URL is required');
const db = new Pool({ connectionString: env.DATABASE_URL, ssl: false, connectionTimeoutMillis: 3000 });
function start(connectionString = env.DATABASE_URL) {
  output = '';
  child = spawn(process.execPath, ['server.js'], { cwd: require('node:path').resolve(__dirname, '..'), env: { ...env, DATABASE_URL: connectionString }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', data => { output += data; });
  child.stderr.on('data', data => { output += data; });
}
async function stop() {
  if (!child || child.exitCode !== null) return;
  const exit = once(child, 'exit');
  child.kill('SIGTERM');
  await Promise.race([exit, wait(4000)]);
  if (child.exitCode === null) { child.kill('SIGKILL'); await exit; }
  child = null;
}
async function request(route, options = {}) {
  return fetch(base + route, { ...options, signal: AbortSignal.timeout(18000) });
}
async function waitFor(route, status = 200) {
  let detail = '';
  for (let attempt = 0; attempt < 80; attempt++) {
    if (child.exitCode !== null) throw new Error('Server exited.\n' + output);
    try {
      const response = await request(route);
      detail = await response.text();
      if (response.status === status) return JSON.parse(detail);
    } catch (err) { detail = err.message; }
    await wait(500);
  }
  throw new Error('Readiness timeout: ' + detail + '\n' + output);
}
async function json(route) {
  const response = await request(route);
  assert.equal(response.status, 200, route + '\n' + output);
  return response.json();
}
async function main() {
  start();
  const ready = await waitFor('/health/ready');
  assert.equal(ready.database, true);
  assert.equal(ready.migrations, true);
  assert.equal(ready.categories, 21);
  assert(ready.listings >= 300, 'Bulk seed should contain at least 300 published records');
  console.log('PostgreSQL ready:', JSON.stringify(ready));

  const categories = await json('/api/public/categories');
  assert.equal(categories.length, 21);
  const category = categories.find(c => c.slug === 'pszichologusok');
  assert(category && category.listing_count > 0);
  const listings = await json('/api/public/listings?category=pszichologusok&limit=3');
  assert(listings.length > 0 && listings.length <= 3);
  assert(listings.every(x => x.categories.some(c => c.slug === 'pszichologusok')));
  const city = listings[0].city;
  if (city) {
    const cityListings = await json('/api/public/listings?category=pszichologusok&city=' + encodeURIComponent(city) + '&limit=3');
    assert(cityListings.length > 0);
    assert(cityListings.every(x => x.city.toLowerCase() === city.toLowerCase()));
  }
  const query = listings[0].name;
  const found = await json('/api/public/listings?q=' + encodeURIComponent(query) + '&limit=5');
  assert(found.some(x => x.id === listings[0].id));
  const online = await json('/api/public/listings?online=true&limit=5');
  assert(online.every(x => x.online_available === true));
  console.log('PASS category API, provider API, category/city/text/online filters');

  for (const route of ['/kategoria/pszichologusok', '/kereses?category=pszichologusok', '/kereses?q=' + encodeURIComponent(query), '/szolgaltato/' + encodeURIComponent(listings[0].slug)]) {
    const response = await request(route);
    const html = await response.text();
    assert.equal(response.status, 200, route + ': ' + html.slice(0, 200));
    assert(html.includes('<!doctype html>'), route);
    assert(!html.includes('ETIMEDOUT'));
  }
  console.log('PASS category page, search page and provider profile');

  const login = await request('/api/admin/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: env.CMS_ADMIN_EMAIL, password: env.CMS_ADMIN_PASSWORD }) });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const admin = await request('/api/admin/directory/listings', { headers: { Cookie: cookie } });
  assert.equal(admin.status, 200);
  assert((await admin.json()).length >= ready.listings);
  console.log('PASS admin login and catalog access');

  const migrationCount = await db.query('SELECT count(*)::int AS count FROM cms_schema_migrations');
  assert.equal(migrationCount.rows[0].count, 5);
  const original = await db.query("SELECT name FROM directory_listings WHERE slug='levitania-pszichologiai-kozpont'");
  await db.query("UPDATE directory_listings SET name=$1 WHERE slug='levitania-pszichologiai-kozpont'", ['CI editorial change']);
  await stop(); start();
  const again = await waitFor('/health/ready');
  assert.equal(again.listings, ready.listings);
  const preserved = await db.query("SELECT name FROM directory_listings WHERE slug='levitania-pszichologiai-kozpont'");
  assert.equal(preserved.rows[0].name, 'CI editorial change');
  await db.query("UPDATE directory_listings SET name=$1 WHERE slug='levitania-pszichologiai-kozpont'", [original.rows[0].name]);
  console.log('PASS restart: no duplicate seeds and editorial changes preserved');

  await stop();
  start('postgresql://ci:unused@127.0.0.1:65432/unreachable');
  await waitFor('/health');
  for (const route of ['/health/ready', '/api/public/categories', '/api/public/listings', '/kategoria/pszichologusok']) {
    const before = Date.now();
    const response = await request(route);
    const body = await response.text();
    assert.equal(response.status, 503, route);
    assert(Date.now() - before < 10000, 'Bounded unavailable response');
    assert(!body.includes('127.0.0.1') && !body.includes('65432'), 'Internal database details must not leak');
    if (route.startsWith('/kategoria')) assert(response.headers.get('content-type').includes('text/html'));
  }
  console.log('PASS unavailable database: 503, no fake zero-count success, no raw connection details');
  console.log('ALL DATABASE SMOKE TESTS PASSED');
}
main().catch(err => { console.error(err); console.error(output); process.exitCode = 1; }).finally(async () => { await stop(); await db.end(); });
