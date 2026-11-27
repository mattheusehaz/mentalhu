'use strict';

const net = require('node:net');
const { cityByKey, nearestCity } = require('./hungary-locations.cjs');

const COOKIE_NAME = 'mental_provider_location';
const PREFERENCE_DAYS = 90;
let ipSnapshot;

function snapshot() {
  if (ipSnapshot !== undefined) return ipSnapshot;
  try {
    const data = require('../content/hungary-ip-locations.json');
    ipSnapshot = data.schemaVersion === 1 && Array.isArray(data.ipv4) && Array.isArray(data.ipv6) ? data : null;
  } catch {
    // Location is optional: a missing snapshot must never make articles fail.
    ipSnapshot = null;
  }
  return ipSnapshot;
}

function ipv4Number(value) {
  return value.split('.').reduce((number, byte) => number * 256 + Number(byte), 0);
}

function ipv6Hex(value) {
  if (net.isIP(value) !== 6 || value.includes('%')) return null;
  let expanded = value.toLowerCase();
  if (expanded.includes('.')) {
    const lastColon = expanded.lastIndexOf(':');
    const tail = ipv4Number(expanded.slice(lastColon + 1));
    expanded = expanded.slice(0, lastColon + 1) + Math.floor(tail / 65536).toString(16) + ':' + (tail % 65536).toString(16);
  }
  const parts = expanded.split('::');
  const left = parts[0] ? parts[0].split(':') : [];
  const right = parts[1] ? parts[1].split(':') : [];
  const words = parts.length === 2 ? [...left, ...Array(8 - left.length - right.length).fill('0'), ...right] : left;
  return words.length === 8 ? words.map(word => word.padStart(4, '0')).join('') : null;
}

function publicIpv4(number) {
  const a = Math.floor(number / 16777216);
  const b = Math.floor(number / 65536) % 256;
  const c = Math.floor(number / 256) % 256;
  return !(a === 0 || a === 10 || a === 127 || a >= 224
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && (b === 168 || (b === 0 && (c === 0 || c === 2))))
    || (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100)))
    || (a === 203 && b === 0 && c === 113));
}

function ipKey(value) {
  if (typeof value !== 'string' || value.length > 64) return null;
  const ip = value.trim();
  const family = net.isIP(ip);
  if (family === 4) {
    const key = ipv4Number(ip);
    return publicIpv4(key) ? { family: 4, key } : null;
  }
  if (family !== 6) return null;
  const key = ipv6Hex(ip);
  if (!key) return null;
  if (key.startsWith('00000000000000000000ffff')) {
    const mapped = parseInt(key.slice(24), 16);
    return publicIpv4(mapped) ? { family: 4, key: mapped } : null;
  }
  // Only global unicast. Local, link-local, multicast and documentation
  // addresses must not accidentally resolve to a real Hungarian city.
  if (key < '20000000000000000000000000000000' || key >= '40000000000000000000000000000000'
    || key.startsWith('20010db8')) return null;
  return { family: 6, key };
}

function lookupIpCity(value, data = snapshot()) {
  const address = ipKey(value);
  if (!address || !data) return null;
  const ranges = address.family === 4 ? data.ipv4 : data.ipv6;
  if (!Array.isArray(ranges)) return null;
  let left = 0, right = ranges.length - 1;
  while (left <= right) {
    const middle = Math.floor((left + right) / 2);
    const [start, end, id] = ranges[middle];
    if (address.key < start) right = middle - 1;
    else if (address.key > end) left = middle + 1;
    else return cityByKey(id);
  }
  return null;
}

function requestIp(req, env = process.env) {
  const trustDigitalOcean = env.MENTAL_GEO_TRUST_DO_HEADER === '1';
  // App Platform supplies this header. Its X-Forwarded-For is an ingress
  // address, so deliberately never use X-Forwarded-For, X-Real-IP or req.ip.
  const value = trustDigitalOcean ? req.get('do-connecting-ip') : req.socket?.remoteAddress;
  return ipKey(value) ? value.trim() : null;
}

function publicLocation(location) {
  return location ? { id: location.id, name: location.name, source: location.source } : null;
}

function invalidInput(message = 'Válassz egy települést a találatok közül.') {
  return Object.assign(new Error(message), { code: 'LOCATION_INVALID', status: 400 });
}

function coordinatesLocation(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw invalidInput('A helymeghatározás adatai érvénytelenek.');
  const { latitude, longitude, accuracy } = body;
  if (typeof latitude !== 'number' || !Number.isFinite(latitude) || latitude < -90 || latitude > 90
    || typeof longitude !== 'number' || !Number.isFinite(longitude) || longitude < -180 || longitude > 180
    || typeof accuracy !== 'number' || !Number.isFinite(accuracy) || accuracy < 0 || accuracy > 100000) {
    throw invalidInput('A helymeghatározás adatai érvénytelenek.');
  }
  if (accuracy > 50000) return null;
  // The browser rounds before sending; round again for other clients. Only
  // the nearest settlement survives this function, never the reader's point.
  const city = nearestCity(Math.round(latitude * 100) / 100, Math.round(longitude * 100) / 100, { maxKm: 35 });
  return city ? { ...city, source: 'browser' } : null;
}

function sameOrigin(req) {
  if (req.get('Sec-Fetch-Site') === 'cross-site') return false;
  try {
    const origin = new URL(req.get('Origin'));
    return !origin.username && !origin.password && origin.origin === req.protocol + '://' + req.get('host');
  } catch { return false; }
}

function privateResponse(res) {
  res.set({ 'Cache-Control': 'private, no-store', 'Pragma': 'no-cache', 'Referrer-Policy': 'same-origin' });
  res.vary('Cookie');
}

function createReaderLocationService({ env = process.env, lookup = lookupIpCity } = {}) {
  function cookieOptions(req) {
    return { httpOnly: true, secure: env.NODE_ENV === 'production' || req.secure, sameSite: 'lax', path: '/' };
  }
  function preference(req) {
    const raw = req.cookies?.[COOKIE_NAME];
    if (typeof raw !== 'string' || raw.length > 180) return null;
    const [version, id, source, extra] = raw.split('|');
    if (version !== '1' || extra !== undefined || !['manual', 'browser'].includes(source)) return null;
    const city = cityByKey(id);
    return city ? { ...city, source } : null;
  }
  function automatic(req) {
    const ip = requestIp(req, env);
    if (!ip) return null;
    try {
      const city = lookup(ip);
      return city ? { ...city, source: 'ip' } : null;
    } catch { return null; }
  }
  function current(req) { return preference(req) || automatic(req); }
  function remember(req, res, location) {
    if (!location || !['manual', 'browser'].includes(location.source) || !cityByKey(location.id)) throw invalidInput();
    res.cookie(COOKIE_NAME, '1|' + location.id + '|' + location.source, {
      ...cookieOptions(req), maxAge: PREFERENCE_DAYS * 24 * 60 * 60 * 1000
    });
  }
  function clear(req, res) { res.clearCookie(COOKIE_NAME, cookieOptions(req)); }
  function choose(req, res, body = {}) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw invalidInput();
    if (Object.keys(body).some(key => !['city', 'source', 'automatic'].includes(key))) throw invalidInput();
    if (Object.prototype.hasOwnProperty.call(body, 'automatic')) {
      if (body.automatic !== true || body.city !== undefined || body.source !== undefined) throw invalidInput();
      clear(req, res);
      return automatic(req);
    }
    if (body.city === undefined) {
      if (body.source !== undefined) throw invalidInput();
      return current(req);
    }
    const source = body.source === undefined ? 'manual' : body.source;
    const city = typeof body.city === 'string' && body.city.length <= 120 ? cityByKey(body.city) : null;
    if (!city || !['manual', 'browser'].includes(source)) throw invalidInput();
    const location = { ...city, source };
    remember(req, res, location);
    return location;
  }
  return { current, automatic, preference, choose, remember, clear };
}

module.exports = { COOKIE_NAME, PREFERENCE_DAYS, ipKey, ipv6Hex, lookupIpCity, requestIp,
  publicLocation, coordinatesLocation, sameOrigin, privateResponse, createReaderLocationService };
