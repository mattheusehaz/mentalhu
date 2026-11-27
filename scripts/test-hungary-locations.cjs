'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveCity, cityByKey, distanceKm, nearestCity, searchCities } = require('../lib/hungary-locations.cjs');
const dataset = require('../content/hungary-locations.json');

test('Hungarian settlement names and Budapest districts resolve to canonical cities', () => {
  const budapest = resolveCity('Budapest');
  for (const value of ['budapest', ' BUDAPEST ', 'Budapest XI. kerület', 'Budapest, 13. kerület',
    'Budapest (XVIII. kerület)', 'Bp. II.', 'Budapest (District XVI.)', '1111 Budapest XI.',
    'Budapest, Hungary', 'Zugló']) {
    assert.equal(resolveCity(value), budapest, value);
  }
  assert.equal(resolveCity('Budaors').name, 'Budaörs');
  assert.equal(resolveCity('H-2000 Szentendre, Magyarország').name, 'Szentendre');
  assert.equal(cityByKey('szekesfehervar').name, 'Székesfehérvár');
  assert.equal(Object.isFrozen(budapest), true);
  for (const value of [null, {}, [], 123, '', 'Unknown City', 'Budapest / Debrecen',
    'Budapest környéke', 'Budapest XXIV. kerület', 'Budapest 99', '<script>Budapest</script>']) {
    assert.equal(resolveCity(value), null, String(value));
  }
});

test('accent-fold collisions never silently choose a distant settlement', () => {
  const komlo = resolveCity('Komló');
  const komloe = resolveCity('Kömlő');
  assert.notEqual(komlo.id, komloe.id);
  assert.ok(distanceKm(komlo, komloe) > 200);
  assert.equal(resolveCity('komlo'), null);
  assert.equal(resolveCity('komoro'), null);
  assert.equal(resolveCity(komlo.id), komlo);
  assert.deepEqual(new Set(searchCities('komlo', 2).map(city => city.name)), new Set(['Komló', 'Kömlő']));
  assert.equal(searchCities('Kömlő')[0].name, 'Kömlő');
});

test('nearby and distant city distances support the article recommendation radius', () => {
  const budapest = resolveCity('Budapest');
  assert.equal(distanceKm(budapest, budapest), 0);
  assert.ok(distanceKm(budapest, resolveCity('Budaörs')) < 10);
  assert.ok(distanceKm(budapest, resolveCity('Szentendre')) < 25);
  assert.ok(distanceKm(budapest, resolveCity('Székesfehérvár')) > 50);
  const debrecenKm = distanceKm(budapest, resolveCity('Debrecen'));
  assert.ok(debrecenKm > 190 && debrecenKm < 200);
  assert.equal(distanceKm(budapest, { latitude: 400, longitude: 19 }), Infinity);
});

test('browser coordinates coarsen to city centroids including outer Budapest districts', () => {
  const budapest = resolveCity('Budapest');
  const p = nearestCity(47.56263, 19.11681);
  assert.equal(p, budapest);
  assert.notEqual(p.latitude, 47.56263);
  assert.notEqual(p.longitude, 19.11681);
  assert.equal(nearestCity(47.48, 19.25).name, 'Budapest');
  assert.equal(nearestCity(47.4618, 18.9585).name, 'Budaörs');
  assert.equal(nearestCity(47.5333, 21.6333).name, 'Debrecen');
  assert.equal(nearestCity(51.5074, -0.1278), null);
  assert.equal(nearestCity(47.4984, 19.0404, { maxKm: 0 }), budapest);
  for (const args of [[null, 19], ['47.5', '19'], [91, 19], [47, 181], [NaN, 19], [47, Infinity], [47, 19, {maxKm: -1}], [47, 19, {maxKm: 500}]]) {
    assert.equal(nearestCity(...args), null);
  }
});

test('autocomplete stays bounded, handles accents, and returns canonical IDs', () => {
  assert.equal(searchCities('pecs')[0].name, 'Pécs');
  assert.equal(searchCities('Budapest XI. kerület')[0].id, 'budapest');
  assert.ok(searchCities('sz', 5).length <= 5);
  assert.ok(searchCities('', 1000).length <= 30);
  assert.equal(searchCities('')[0].name, 'Budapest');
  assert.deepEqual(searchCities('<img src=x>'), []);
  assert.deepEqual(searchCities({}), []);
  for (const city of searchCities('sz', 30)) assert.equal(resolveCity(city.id), city);
});

test('checked-in source snapshot covers Hungary with unique valid city IDs', () => {
  assert.equal(dataset.source.license, 'CC-BY-4.0');
  assert.ok(dataset.cities.length >= 3100);
  assert.equal(new Set(dataset.cities.map(row => row[0])).size, dataset.cities.length);
  assert.ok(dataset.anchors.length >= 23);
  for (const [id, name, county, latitude, longitude] of dataset.cities) {
    assert.match(id, /^[a-z0-9-]+$/);
    assert.ok(name && county);
    assert.ok(latitude >= 45.7 && latitude <= 48.7 && longitude >= 16 && longitude <= 23, name);
    assert.equal(resolveCity(id).name, name);
  }
});
