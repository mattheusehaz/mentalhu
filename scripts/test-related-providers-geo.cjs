'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { selectRelatedProviders } = require('../lib/related-providers.cjs');
const { resolveCity, distanceKm } = require('../lib/hungary-locations.cjs');

const databaseUrl = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
const article = { category: 'ADHD', title: 'Felnőtt ADHD' };

test('geographic article recommendations use real publication, topic and locality constraints', { skip: !databaseUrl }, async t => {
  const url = new URL(databaseUrl);
  assert(['127.0.0.1', 'localhost'].includes(url.hostname) && /test/.test(url.pathname), 'Disposable local test database required');
  const { Client } = require('pg');
  const client = new Client({ connectionString: databaseUrl, ssl: false });
  await client.connect();
  try {
    await client.query('BEGIN');
    await client.query(`CREATE TEMP TABLE directory_categories(id bigint PRIMARY KEY,slug text,name text,active boolean,verification_level text,sort_order integer);
      CREATE TEMP TABLE directory_listings(id bigint PRIMARY KEY,slug text,name text,kind text,status text,city text,online_available boolean,short_description text,specialties text,published_at timestamptz);
      CREATE TEMP TABLE directory_listing_categories(listing_id bigint,category_id bigint,PRIMARY KEY(listing_id,category_id));
      INSERT INTO directory_categories VALUES
        (1,'pszichiaterek','Pszichiáterek',true,'healthcare',10),
        (2,'pszichologusok','Pszichológusok',true,'professional',20),
        (3,'pszichoterapeutak','Inaktív pszichoterapeuták',false,'healthcare',30),
        (4,'pszichoterapeutak','Alternatív besorolás',true,'alternative',40),
        (5,'szemeszek','Szemészek',true,'healthcare',50);`);

    async function reset() {
      await client.query('TRUNCATE directory_listing_categories,directory_listings');
    }
    async function listing(id, {
      city = 'Budapest', online = false, category = 1, specialty = 'Felnőtt ADHD',
      status = 'published', kind = 'provider', publication = 'past'
    } = {}) {
      const publishedAt = publication === null ? null : publication === 'future' ? '2099-01-01T00:00:00Z' : '2020-01-01T00:00:00Z';
      await client.query(`INSERT INTO directory_listings
        VALUES($1,$2,$3,$4,$5,$6,$7,'',$8,$9)`,
      [id, 'provider-' + id, 'Szolgáltató ' + id, kind, status, city, online, specialty, publishedAt]);
      await client.query('INSERT INTO directory_listing_categories VALUES($1,$2)', [id, category]);
    }
    const ids = rows => rows.map(row => Number(row.id));
    const budapest = resolveCity('Budapest');
    const debrecen = resolveCity('Debrecen');
    assert(budapest && debrecen, 'Both reader cities must resolve canonically');

    await t.test('Budapest and Debrecen readers get their own in-person providers, with explicit online fallback', async () => {
      await reset();
      await listing(1, { city: 'Budapest', category: 2, specialty: 'Felnőtt pszichológiai tanácsadás' });
      await listing(2, { city: 'Debrecen' });
      await listing(3, { city: 'Debrecen', online: true });

      const capital = await selectRelatedProviders(client, article, 4, budapest);
      assert.deepEqual(ids(capital), [1, 3], 'The local generalist outranks a remote online specialist; far in-person is absent');
      assert.deepEqual(capital.map(row => row.match_type), ['local', 'online']);
      assert.equal(capital[1].city, 'Debrecen', 'The source listing city remains available for transparent labeling');
      assert(capital.every(row => row.distance_km === null));

      const eastern = await selectRelatedProviders(client, article, 4, debrecen);
      assert.deepEqual(new Set(ids(eastern)), new Set([2, 3]));
      assert(eastern.every(row => row.match_type === 'local'));
    });

    await t.test('Budapest district labels are the same city, with at most four unique provider cards', async () => {
      await reset();
      await listing(1, { city: 'Budapest XI. kerület' });
      await listing(2, { city: 'Budapest 13. kerület' });
      await listing(3, { city: 'Budapest' });
      await client.query('INSERT INTO directory_listing_categories VALUES(1,2)');
      const district = resolveCity('Budapest XI. kerület');
      assert(district && district.id === budapest.id);
      const rows = await selectRelatedProviders(client, article, 4, district);
      assert.deepEqual(new Set(ids(rows)), new Set([1, 2, 3]));
      assert(rows.every(row => row.match_type === 'local' && row.distance_km === null));
      for (let id = 4; id <= 7; id++) await listing(id);
      const capped = await selectRelatedProviders(client, article, 99, district);
      assert.equal(capped.length, 4);
      assert.equal(new Set(ids(capped)).size, 4);
    });

    await t.test('same-city, within 50 km, and online tiers outrank editorial specificity in that order', async () => {
      await reset();
      await listing(1, { city: 'Budapest', category: 2, specialty: 'Felnőtt pszichológiai tanácsadás' });
      await listing(2, { city: 'Budaörs', specialty: 'Felnőtt ADHD' });
      await listing(3, { city: 'Debrecen', online: true });
      await listing(4, { city: 'Székesfehérvár' });
      const nearbyDistance = distanceKm(budapest, resolveCity('Budaörs'));
      const distantDistance = distanceKm(budapest, resolveCity('Székesfehérvár'));
      assert(nearbyDistance > 0 && nearbyDistance <= 50);
      assert(distantDistance > 50, 'The test has an in-person provider just beyond the nearby region');
      const rows = await selectRelatedProviders(client, article, 4, budapest);
      assert.deepEqual(ids(rows), [1, 2, 3]);
      assert.deepEqual(rows.map(row => row.match_type), ['local', 'nearby', 'online']);
      assert.equal(rows[1].distance_km, Math.round(nearbyDistance));
      assert.equal(rows[2].distance_km, null);
    });

    await t.test('unknown, invalid and foreign reader locations recommend only genuinely available online services', async () => {
      await reset();
      await listing(1, { city: 'Budapest' });
      await listing(2, { city: 'Debrecen' });
      await listing(3, { city: null, online: true });
      await listing(4, { city: 'Ismeretlen település', online: true });
      await listing(5, { city: 'Budapest', online: true });
      for (const location of [null, { name: 'Nem létező város' }, { ...budapest, country: 'RO' }, { latitude: budapest.latitude, longitude: budapest.longitude }]) {
        const rows = await selectRelatedProviders(client, article, 4, location);
        assert.deepEqual(new Set(ids(rows)), new Set([3, 4, 5]));
        assert(rows.every(row => row.match_type === 'online' && row.distance_km === null));
      }
      await client.query('UPDATE directory_listings SET online_available=false');
      assert.deepEqual(await selectRelatedProviders(client, article), [], 'Lack of online supply does not enable arbitrary in-person fallback');
    });

    await t.test('canonical city controls ranking even when caller-supplied coordinates point elsewhere', async () => {
      await reset();
      await listing(1, { city: 'Budapest' });
      await listing(2, { city: 'Debrecen' });
      const rows = await selectRelatedProviders(client, article, 4, { ...budapest, latitude: debrecen.latitude, longitude: debrecen.longitude });
      assert.deepEqual(ids(rows), [1]);
      assert.equal(rows[0].match_type, 'local');
    });

    await t.test('reader switches and listing updates cannot reuse another city or stale public state', async () => {
      await reset();
      await listing(1, { city: 'Budapest' });
      await listing(2, { city: 'Debrecen' });
      await listing(3, { city: 'Budapest', online: true });
      const [capital, eastern] = await Promise.all([
        selectRelatedProviders(client, article, 4, budapest),
        selectRelatedProviders(client, article, 4, debrecen)
      ]);
      assert.deepEqual(new Set(ids(capital)), new Set([1, 3]));
      assert(capital.every(row => row.match_type === 'local'));
      assert.deepEqual(ids(eastern), [2, 3]);
      assert.deepEqual(eastern.map(row => row.match_type), ['local', 'online']);
      assert.deepEqual(new Set(ids(await selectRelatedProviders(client, article, 4, budapest))), new Set([1, 3]));
      await client.query("UPDATE directory_listings SET city='Debrecen' WHERE id=1");
      assert.deepEqual(ids(await selectRelatedProviders(client, article, 4, budapest)), [3]);
      await client.query("UPDATE directory_listings SET status='draft' WHERE id=3");
      assert.deepEqual(await selectRelatedProviders(client, article, 4, budapest), []);
      assert.deepEqual(new Set(ids(await selectRelatedProviders(client, article, 4, debrecen))), new Set([1, 2]));
    });

    await t.test('geographic proximity does not bypass publication, age audience, category or clinical safeguards', async () => {
      await reset();
      await listing(1, { category: 5 });
      await listing(2, { category: 4 });
      await listing(3, { category: 3 });
      await listing(4, { specialty: 'Gyermekpszichiátria, gyermek ADHD' });
      await listing(5, { status: 'draft' });
      await listing(6, { status: 'pending' });
      await listing(7, { kind: 'event' });
      await listing(8, { publication: 'future' });
      await listing(9, { city: 'Debrecen', online: true });
      await listing(10, { specialty: 'Gyermek és felnőtt ADHD' });
      await listing(11, { specialty: 'Felnőtt pszichológiai tanácsadás', category: 2, kind: 'organization', publication: null });
      const rows = await selectRelatedProviders(client, article, 4, budapest);
      assert.deepEqual(ids(rows), [10, 11, 9]);
      assert.deepEqual(rows.map(row => row.match_type), ['local', 'local', 'online']);
      assert.deepEqual(ids(await selectRelatedProviders(client, article, 1, budapest)), [10]);
    });

    await t.test('a large distant provider population never truncates away a sparse local match', async () => {
      await reset();
      await client.query(`INSERT INTO directory_listings
        SELECT n,'remote-'||n,'Távoli szakértő '||n,'provider','published','Debrecen',false,'','Felnőtt ADHD',now()-interval '1 day'
        FROM generate_series(1,600) AS n;
        INSERT INTO directory_listing_categories SELECT id,1 FROM directory_listings;`);
      await listing(1000, { city: 'Budapest', category: 2, specialty: 'Felnőtt pszichológiai tanácsadás' });
      const rows = await selectRelatedProviders(client, article, 4, budapest);
      assert.deepEqual(ids(rows), [1000], 'One local result is preferable to filling four cards with far-away in-person providers');
      assert.equal(rows[0].match_type, 'local');
    });
  } finally {
    await client.query('ROLLBACK').catch(() => {});
    await client.end();
  }
});
