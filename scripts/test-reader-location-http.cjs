'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const cookieParser = require('cookie-parser');
const { createArticleService } = require('../lib/public-articles.cjs');
const { createReaderLocationService, COOKIE_NAME } = require('../lib/reader-location.cjs');
const { resolveCity } = require('../lib/hungary-locations.cjs');
const { createStatisticsService } = require('../lib/site-statistics.cjs');

async function fixture(t, { ready = true, providerFailure = false, autoCity = 'debrecen' } = {}) {
  const queries = [];
  const article = { id: 1, slug: 'teszt-cikk', title: 'Szorongás és segítség', category: 'Szorongás',
    excerpt: 'Cikk összefoglalója', author_name: 'Szerkesztőség', content_html: '<p>Olvasható cikk.</p>',
    published_at: new Date('2026-11-20T08:00:00Z'), reading_minutes: 3, sources: [] };
  const pool = { async query(query, values) {
    if (typeof query === 'object') {
      queries.push(query);
      if (providerFailure) throw new Error('provider lookup unavailable');
      if (query.text.startsWith('SELECT DISTINCT city')) return { rows: [{ city: 'Budapest' }, { city: 'Debrecen' }] };
      return { rows: [{ id: 1, slug: 'online-szakerto', name: 'Online szakértő', city: 'Pécs',
        online_available: true, category_name: 'Pszichológusok', match_type: 'online', distance_km: null }] };
    }
    if (query.includes('a.id<>$1')) return { rows: [] };
    if (query.includes('a.slug=$1')) return { rows: values[0] === article.slug ? [article] : [] };
    throw new Error('Unexpected fixture query');
  } };
  const readerLocation = createReaderLocationService({ env: { NODE_ENV: 'test', MENTAL_GEO_TRUST_DO_HEADER: '1' }, lookup: () => autoCity ? resolveCity(autoCity) : null });
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use(createStatisticsService({ pool, auth: () => {}, dbState: { ready }, secret: 'geographic-http-test-statistics-only' }).publicMiddleware);
  createArticleService({ pool, dbState: { ready }, cleanHtml: html => html, readerLocation }).register(app);
  app.use((err, _req, res, _next) => res.status(500).json({ code: err.code || 'FAILED' }));
  const server = await new Promise(resolve => { const instance = app.listen(0, '127.0.0.1', () => resolve(instance)); });
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const base = 'http://127.0.0.1:' + server.address().port;
  const post = (route, body = {}, headers = {}) => fetch(base + route, {
    method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json', 'do-connecting-ip': '5.2.2.1', ...headers }, body: JSON.stringify(body)
  });
  return { base, post, queries };
}
const endpoint = '/api/public/articles/teszt-cikk/providers';
function assertPrivate(response) {
  assert.match(response.headers.get('cache-control'), /private/);
  assert.match(response.headers.get('cache-control'), /no-store/);
  assert.match(response.headers.get('vary'), /Cookie/i);
}
function cookie(response) { return response.headers.get('set-cookie').split(';')[0]; }

test('city autocomplete is canonical and never exposes centroids', async t => {
  const { base } = await fixture(t);
  const response = await fetch(base + '/api/public/provider-locations?q=Budapest');
  assert.equal(response.status, 200);
  assertPrivate(response);
  const result = await response.json();
  assert.equal(result.items[0].id, 'budapest');
  assert.equal(result.items[0].name, 'Budapest');
  assert(result.items.every(city => Object.keys(city).every(key => ['id', 'name', 'county'].includes(key))));
});

test('manual city overrides IP, survives SSR navigation and resets to automatic', async t => {
  const { base, post, queries } = await fixture(t);
  const automatic = await post(endpoint);
  assertPrivate(automatic);
  assert.equal(automatic.headers.get('set-cookie'), null);
  assert.deepEqual((await automatic.json()).location, { id: 'debrecen', name: 'Debrecen', source: 'ip' });
  const manual = await post(endpoint, { city: 'budapest' });
  assert.equal(manual.status, 200);
  assertPrivate(manual);
  const saved = cookie(manual);
  assert.match(manual.headers.get('set-cookie'), /HttpOnly/);
  assert.match(manual.headers.get('set-cookie'), /SameSite=Lax/);
  assert.deepEqual((await manual.json()).location, { id: 'budapest', name: 'Budapest', source: 'manual' });
  const repeat = await post(endpoint, {}, { Cookie: saved });
  assert.equal((await repeat.json()).location.id, 'budapest');
  const html = await fetch(base + '/cikk/teszt-cikk', { headers: { Cookie: saved, 'do-connecting-ip': '5.2.2.1', 'User-Agent': 'Mozilla/5.0 Chrome/130.0.0.0 Safari/537.36' } });
  assertPrivate(html);
  const markup = await html.text();
  assert.match(markup, /data-provider-city-id="budapest"/);
  assert.match(markup, /Olvasható cikk/);
  assert.match(markup, /src="\/statistics.js/, 'Full HTML instrumentation must preserve private location response headers');
  assert(!markup.includes('5.2.2.1'));
  assert(!markup.includes('47.498'));
  const selection = queries.filter(query => Array.isArray(query.values)).at(-1);
  const geo = JSON.parse(selection.values[2]);
  assert(geo.some(row => row.city === 'Budapest' && row.match_type === 'local'));
  assert(!geo.some(row => row.city === 'Debrecen'));
  const reset = await post(endpoint, { automatic: true }, { Cookie: saved });
  assert.equal((await reset.json()).location.id, 'debrecen');
  assert.match(reset.headers.get('set-cookie'), /Expires=Thu, 01 Jan 1970/);
});

test('browser resolution exposes and persists a city, never the supplied position', async t => {
  const { post } = await fixture(t);
  const response = await post('/api/public/provider-location/resolve', { latitude: 47.497912345, longitude: 19.04023456, accuracy: 1500 });
  assert.equal(response.status, 200);
  assertPrivate(response);
  const data = await response.json();
  assert.deepEqual(data, { location: { id: 'budapest', name: 'Budapest', source: 'browser' } });
  const saved = cookie(response);
  assert.equal(decodeURIComponent(saved), COOKIE_NAME + '=1|budapest|browser');
  const providers = await post(endpoint, {}, { Cookie: saved });
  assert.deepEqual((await providers.json()).location, data.location);
  const overseas = await post('/api/public/provider-location/resolve', { latitude: 40.71, longitude: -74, accuracy: 1500 });
  assert.deepEqual(await overseas.json(), { location: null });
  assert.equal(overseas.headers.get('set-cookie'), null);
});

test('missing and unknown location stay online-only without writing a preference', async t => {
  const { base, post } = await fixture(t, { autoCity: null });
  const response = await post(endpoint, {}, { Cookie: COOKIE_NAME + '=1%7Cbogus%7Cmanual' });
  const result = await response.json();
  assert.equal(result.location, null);
  assert.equal(result.mode, 'online');
  assert(result.items.every(item => item.match_type === 'online'));
  assert.equal(response.headers.get('set-cookie'), null);
  const html = await fetch(base + '/cikk/teszt-cikk');
  const markup = await html.text();
  assert.match(markup, /Online konzultáció/);
  assert.match(markup, /Válassz települést/);
});

test('forged origins, invalid bodies and unpublished article requests cannot set preferences', async t => {
  const { base, post } = await fixture(t);
  for (const [route, body, headers, code] of [
    [endpoint, { city: 'budapest' }, { Origin: 'https://evil.invalid' }, 403],
    [endpoint, { city: 'budapest' }, { Origin: 'null' }, 403],
    [endpoint, { city: 'budapest' }, { 'Sec-Fetch-Site': 'cross-site' }, 403],
    [endpoint, { city: 'budapest' }, { 'Content-Type': 'text/plain' }, 415],
    [endpoint, { city: 'invalid' }, {}, 400],
    [endpoint, { city: 'budapest', latitude: 47.5 }, {}, 400],
    [endpoint, { automatic: true, city: 'budapest' }, {}, 400],
    ['/api/public/provider-location/resolve', { latitude: '47.5', longitude: 19, accuracy: 10 }, {}, 400],
    ['/api/public/articles/unpublished/providers', { city: 'budapest' }, {}, 404]
  ]) {
    const response = await post(route, body, headers);
    assert.equal(response.status, code, JSON.stringify({ route, body }));
    assertPrivate(response);
    assert.equal(response.headers.get('set-cookie'), null);
  }
  const missingOrigin = await fetch(base + endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(missingOrigin.status, 403);
});

test('provider failures preserve article and private API fallback; unavailable database returns 503', async t => {
  const { base, post } = await fixture(t, { providerFailure: true });
  const article = await fetch(base + '/cikk/teszt-cikk');
  assert.equal(article.status, 200);
  assert.match(await article.text(), /Olvasható cikk/);
  const response = await post(endpoint, { city: 'budapest' });
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).items, []);
  const unavailable = await fixture(t, { ready: false });
  const result = await unavailable.post(endpoint);
  assert.equal(result.status, 503);
  assertPrivate(result);
  assert.equal((await result.json()).code, 'ARTICLES_UNAVAILABLE');
});

test('parallel requests retain their own city and public results never carry coordinates', async t => {
  const { post } = await fixture(t);
  const responses = await Promise.all(['budapest', 'debrecen', 'budapest', 'debrecen'].map(city => post(endpoint, { city })));
  for (let index = 0; index < responses.length; index++) {
    const response = responses[index];
    const expected = index % 2 ? 'debrecen' : 'budapest';
    const raw = await response.text();
    const result = JSON.parse(raw);
    assert.equal(result.location.id, expected);
    assert.equal(decodeURIComponent(cookie(response)), COOKIE_NAME + '=1|' + expected + '|manual');
    assert(!/latitude|longitude|5\.2\.2\.1/.test(raw));
    assertPrivate(response);
  }
});
