'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveCity } = require('../lib/hungary-locations.cjs');
const { COOKIE_NAME, ipKey, ipv6Hex, lookupIpCity, requestIp, publicLocation,
  coordinatesLocation, sameOrigin, createReaderLocationService } = require('../lib/reader-location.cjs');

function request({ headers = {}, cookies = {}, address = '127.0.0.1', secure = false } = {}) {
  return { cookies, secure, protocol: secure ? 'https' : 'http', socket: { remoteAddress: address },
    get: name => headers[name.toLowerCase()] };
}
function response() {
  return { writes: [], clears: [], cookie(...args) { this.writes.push(args); }, clearCookie(...args) { this.clears.push(args); } };
}
const localEnv = { NODE_ENV: 'test' };
const doEnv = { NODE_ENV: 'production', MENTAL_GEO_TRUST_DO_HEADER: '1' };
const fixture = {
  ipv4: [[ipKey('5.1.1.0').key, ipKey('5.1.1.255').key, 'budapest'],
    [ipKey('5.2.2.0').key, ipKey('5.2.2.255').key, 'debrecen']],
  ipv6: [['2a010001000000000000000000000000', '2a010001ffffffffffffffffffffffff', 'budapest'],
    ['2a010002000000000000000000000000', '2a010002ffffffffffffffffffffffff', 'debrecen']]
};

test('offline IP range lookup handles inclusive boundaries, gaps and mapped IPv4', () => {
  for (const ip of ['5.1.1.0', '5.1.1.128', '5.1.1.255', '::ffff:5.1.1.25', '::ffff:0501:0119']) {
    assert.equal(lookupIpCity(ip, fixture)?.id, 'budapest', ip);
  }
  assert.equal(lookupIpCity('5.2.2.1', fixture)?.id, 'debrecen');
  for (const ip of ['5.1.0.255', '5.1.2.0', '5.2.3.0', '8.8.8.8']) assert.equal(lookupIpCity(ip, fixture), null);
  for (const ip of ['2a01:1::', '2A01:1::1234', '2a01:1:ffff:ffff:ffff:ffff:ffff:ffff']) assert.equal(lookupIpCity(ip, fixture)?.id, 'budapest');
  assert.equal(lookupIpCity('2a01:2::1', fixture)?.id, 'debrecen');
  assert.equal(lookupIpCity('2a01:3::', fixture), null);
  assert.equal(ipv6Hex('2a01:1::1234'), '2a010001000000000000000000001234');
});

test('private, malformed, multicast and documentation addresses fail closed', () => {
  for (const ip of [null, 123, '', '10.1.2.3', '100.64.0.1', '127.0.0.1', '169.254.1.2', '172.16.2.3',
    '192.168.1.1', '192.0.2.1', '198.18.1.2', '198.51.100.1', '203.0.113.1', '224.1.1.1', '255.255.255.255',
    '::1', '::ffff:10.1.2.3', 'fe80::1', 'fe80::1%eth0', 'fc00::1', 'ff01::1', '2001:db8::1',
    '5.1.1.1, 5.2.2.1', '5.1.1.1:123', '[2a01:1::1]', '999.1.1.1', '005.1.1.1', '5.1.1.1\r\nX: true']) {
    assert.equal(ipKey(ip), null, String(ip));
    assert.equal(lookupIpCity(ip, fixture), null, String(ip));
  }
});

test('App Platform uses its verified client header and never forwarded ingress headers', () => {
  const req = request({ headers: { 'do-connecting-ip': '5.1.1.5', 'x-forwarded-for': '5.2.2.6', 'x-real-ip': '5.2.2.7' }, address: '5.2.2.8' });
  req.ip = '5.2.2.9';
  assert.equal(requestIp(req, doEnv), '5.1.1.5');
  assert.equal(requestIp(req, localEnv), '5.2.2.8', 'A direct development server ignores spoofable proxy headers');
  assert.equal(requestIp(req, { NODE_ENV: 'production' }), '5.2.2.8', 'Production alone does not establish a trusted proxy');
  assert.equal(requestIp(req, { ...localEnv, MENTAL_GEO_TRUST_DO_HEADER: '1' }), '5.1.1.5');
  assert.equal(requestIp(req, { ...doEnv, MENTAL_GEO_TRUST_DO_HEADER: '0' }), '5.2.2.8');
  for (const headers of [{}, { 'do-connecting-ip': 'bad', 'x-forwarded-for': '5.1.1.1' },
    { 'do-connecting-ip': '5.1.1.1,5.2.2.1' }, { 'do-connecting-ip': '127.0.0.1' }]) {
    assert.equal(requestIp(request({ headers, address: '5.2.2.8' }), doEnv), null);
  }
});

test('a saved canonical settlement overrides IP and carries no coordinates in its cookie', () => {
  let lookups = 0;
  const service = createReaderLocationService({ env: doEnv, lookup: () => { lookups++; return resolveCity('Debrecen'); } });
  const req = request({ headers: { 'do-connecting-ip': '5.2.2.1' }, secure: true }), res = response();
  const selected = service.choose(req, res, { city: 'budapest' });
  assert.equal(selected.id, 'budapest');
  assert.equal(lookups, 0);
  assert.equal(res.writes.length, 1);
  const [name, value, options] = res.writes[0];
  assert.equal(name, COOKIE_NAME);
  assert.equal(value, '1|budapest|manual');
  assert.deepEqual(options, { httpOnly: true, secure: true, sameSite: 'lax', path: '/', maxAge: 90 * 86400000 });
  req.cookies[COOKIE_NAME] = value;
  assert.deepEqual(publicLocation(service.current(req)), { id: 'budapest', name: 'Budapest', source: 'manual' });
  assert.equal(lookups, 0);
  const automatic = service.choose(req, res, { automatic: true });
  assert.equal(automatic.id, 'debrecen');
  assert.equal(automatic.source, 'ip');
  assert.equal(res.clears.length, 1);
  assert.equal(res.writes.length, 1, 'Automatic estimates are never persisted');
});

test('invalid or oversized preference cookies cannot supply locations or override IP', () => {
  const service = createReaderLocationService({ env: doEnv, lookup: () => resolveCity('Debrecen') });
  for (const value of ['1|budapest|ip', '1|unknown|manual', '2|budapest|manual', '1|budapest|manual|47.5', {}, 'x'.repeat(181)]) {
    const req = request({ headers: { 'do-connecting-ip': '5.2.2.1' }, cookies: { [COOKIE_NAME]: value } });
    assert.equal(service.preference(req), null);
    assert.equal(service.current(req).id, 'debrecen');
  }
});

test('malformed selection input has no persistence side effects', () => {
  const service = createReaderLocationService({ env: localEnv });
  for (const body of [null, [], 'budapest', { city: 'missing' }, { city: [] }, { city: 'Budapest, Debrecen' },
    { city: 'budapest', source: 'ip' }, { source: 'manual' }, { automatic: false }, { automatic: 'true' },
    { automatic: true, city: 'budapest' }, { city: 'budapest', latitude: 47.5 }]) {
    const res = response();
    assert.throws(() => service.choose(request(), res, body), { code: 'LOCATION_INVALID' });
    assert.equal(res.writes.length + res.clears.length, 0);
  }
  const res = response();
  assert.equal(service.choose(request(), res, {}), null);
  assert.equal(res.writes.length + res.clears.length, 0);
});

test('browser position returns only canonical city data and rejects unusable estimates', () => {
  const input = { latitude: 47.4979123456, longitude: 19.0402345678, accuracy: 7.2 };
  const found = coordinatesLocation(input);
  assert.equal(found.id, 'budapest');
  assert.equal(found.source, 'browser');
  assert.notEqual(found.latitude, input.latitude);
  assert.deepEqual(publicLocation(found), { id: 'budapest', name: 'Budapest', source: 'browser' });
  assert(!JSON.stringify(publicLocation(found)).includes('47.49'));
  assert.equal(coordinatesLocation({ latitude: 40.71, longitude: -74, accuracy: 1500 }), null);
  assert.equal(coordinatesLocation({ ...input, accuracy: 90000 }), null);
  for (const body of [null, [], {}, { ...input, latitude: '47.5' }, { ...input, longitude: 181 },
    { ...input, latitude: NaN }, { ...input, accuracy: -1 }, { ...input, accuracy: Infinity }]) {
    assert.throws(() => coordinatesLocation(body), { code: 'LOCATION_INVALID' });
  }
});

test('unknown IP or a lookup error yields an unknown location without breaking articles', () => {
  const req = request({ headers: { 'do-connecting-ip': '5.1.1.1' } });
  assert.equal(createReaderLocationService({ env: doEnv, lookup: () => null }).current(req), null);
  assert.equal(createReaderLocationService({ env: doEnv, lookup: () => { throw new Error('unavailable'); } }).current(req), null);
});

test('origin protection rejects missing, opaque, foreign and cross-site requests', () => {
  for (const origin of [undefined, 'null', 'https://foreign.invalid', 'http://mental.test', 'https://mental.test.evil.invalid']) {
    assert.equal(sameOrigin(request({ secure: true, headers: { host: 'mental.test', origin } })), false);
  }
  assert(sameOrigin(request({ secure: true, headers: { host: 'mental.test', origin: 'https://mental.test' } })));
  assert(!sameOrigin(request({ secure: true, headers: { host: 'mental.test', origin: 'https://mental.test', 'sec-fetch-site': 'cross-site' } })));
});

test('checked-in Hungarian IP snapshot contains sorted disjoint ranges and only canonical cities', () => {
  const data = require('../content/hungary-ip-locations.json');
  assert.equal(data.schemaVersion, 1);
  assert(data.ipv4.length > 100);
  assert(data.ipv6.length > 10);
  for (const family of ['ipv4', 'ipv6']) {
    let previousEnd = null;
    for (const [start, end, id] of data[family]) {
      assert(start <= end);
      if (previousEnd !== null) assert(previousEnd < start, 'Ranges must be sorted and disjoint');
      previousEnd = end;
      if (family === 'ipv6') { assert.match(start, /^[0-9a-f]{32}$/); assert.match(end, /^[0-9a-f]{32}$/); }
      else { assert(Number.isSafeInteger(start)); assert(Number.isSafeInteger(end)); }
      assert.equal(resolveCity(id)?.id, id);
    }
  }
  for (const id of ['budapest', 'debrecen']) {
    const range = data.ipv4.find(row => row[2] === id);
    assert(range, id);
    const value = range[0];
    const ip = [Math.floor(value / 16777216), Math.floor(value / 65536) % 256, Math.floor(value / 256) % 256, value % 256].join('.');
    assert.equal(lookupIpCity(ip)?.id, id);
  }
});
