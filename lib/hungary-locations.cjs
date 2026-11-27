'use strict';

// Coarse, offline settlement coordinates. Sources and refresh instructions are
// in content/GEO-DATA-SOURCES.md; exact reader coordinates are never retained.
const dataset = require('../content/hungary-locations.json');
const fold = value => value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
const clean = value => value.normalize('NFC').trim().replace(/\s+/g, ' ').toLowerCase();
const byId = new Map();
const byName = new Map();
const byFoldedName = new Map();

for (const [id, name, county, latitude, longitude] of dataset.cities) {
  const city = Object.freeze({ id, name, country: 'HU', county, latitude, longitude });
  byId.set(id, city);
  byName.set(clean(name), city);
  const key = fold(name);
  const matches = byFoldedName.get(key) || [];
  matches.push(city);
  byFoldedName.set(key, matches);
}

const aliases = new Map((dataset.aliases || []).map(([name, id]) => [fold(name), id]));
const cities = [...byId.values()];
const anchors = cities.map(city => ({ city, latitude: city.latitude, longitude: city.longitude }));
for (const [id, latitude, longitude] of dataset.anchors || []) {
  const city = byId.get(id);
  if (city) anchors.push({ city, latitude, longitude });
}
const romanDistricts = new Set(['i','ii','iii','iv','v','vi','vii','viii','ix','x','xi','xii','xiii','xiv','xv','xvi','xvii','xviii','xix','xx','xxi','xxii','xxiii']);

function cityByKey(key) {
  return typeof key === 'string' ? byId.get(clean(key)) || null : null;
}

function resolveCity(value) {
  if (typeof value !== 'string' || value.length > 180) return null;
  let name = clean(value);
  if (!name) return null;
  if (byId.has(name)) return byId.get(name);
  name = name.replace(/^(?:h-)?\d{4}[\s,]+/i, '')
    .replace(/,?\s+(?:magyarország|magyarorszag|hungary|hu)\.?$/i, '')
    .replace(/^[,\s]+|[,\s.]+$/g, '');
  if (byName.has(name)) return byName.get(name);
  const normalized = fold(name);
  const aliasId = aliases.get(normalized);
  if (aliasId) return byId.get(aliasId) || null;

  // Accept a single valid Budapest district, with Roman or Arabic numbering.
  // Do not treat arbitrary text containing Budapest as a known settlement.
  const district = normalized.match(/^(?:budapest|bp\.?)\s*[,\-(]?\s*(?:district\s+)?([ivx]+|\d{1,2})\.?\s*(?:(?:kerulet|ker\.?|district))?\s*\)?$/);
  if (district && (romanDistricts.has(district[1])
    || (/^\d+$/.test(district[1]) && Number(district[1]) >= 1 && Number(district[1]) <= 23))) {
    return byId.get('budapest');
  }
  const matches = byFoldedName.get(normalized);
  // Komló/Kömlő and Komoró/Kömörő are different places. An accentless
  // ambiguous name must be selected from the autocomplete, never guessed.
  return matches && matches.length === 1 ? matches[0] : null;
}

function validCoordinates(latitude, longitude) {
  return typeof latitude === 'number' && Number.isFinite(latitude) && latitude >= -90 && latitude <= 90
    && typeof longitude === 'number' && Number.isFinite(longitude) && longitude >= -180 && longitude <= 180;
}

function distanceKm(a, b) {
  if (!a || !b || !validCoordinates(a.latitude, a.longitude) || !validCoordinates(b.latitude, b.longitude)) return Infinity;
  const toRadians = Math.PI / 180;
  const lat = (b.latitude - a.latitude) * toRadians;
  const lon = (b.longitude - a.longitude) * toRadians;
  const h = Math.sin(lat / 2) ** 2
    + Math.cos(a.latitude * toRadians) * Math.cos(b.latitude * toRadians) * Math.sin(lon / 2) ** 2;
  return 6371.0088 * 2 * Math.asin(Math.sqrt(Math.min(1, Math.max(0, h))));
}

function nearestCity(latitude, longitude, options = {}) {
  if (!validCoordinates(latitude, longitude)) return null;
  const maxKm = (options && (options.maxKm ?? options.maxDistanceKm)) ?? 35;
  if (typeof maxKm !== 'number' || !Number.isFinite(maxKm) || maxKm < 0 || maxKm > 100) return null;
  let nearest = null;
  let best = maxKm;
  for (const anchor of anchors) {
    const distance = distanceKm({ latitude, longitude }, anchor);
    if (distance <= best) {
      best = distance;
      nearest = anchor.city;
    }
  }
  return nearest;
}

function searchCities(query, limit = 12) {
  if (typeof query !== 'string' || query.length > 180) return [];
  const count = Number.isInteger(limit) && limit > 0 ? Math.min(limit, 30) : 12;
  const q = fold(clean(query));
  const exact = resolveCity(query);
  const matches = q ? cities.filter(city => fold(city.name).includes(q) || city.id === q) : cities.slice();
  if (exact && !matches.includes(exact)) matches.push(exact);
  return matches.sort((a, b) => {
    const score = city => city === exact ? 0
      : (!q && city.id === 'budapest') || fold(city.name) === q ? 1
      : fold(city.name).startsWith(q) ? 2 : 3;
    return score(a) - score(b) || a.name.localeCompare(b.name, 'hu');
  }).slice(0, count);
}

module.exports = { resolveCity, cityByKey, distanceKm, nearestCity, searchCities };
