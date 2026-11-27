'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { providerSelection, selectRelatedProviders } = require('../lib/related-providers.cjs');
const { renderRelatedProviders } = require('../lib/article-views.cjs');

const slugs = groups => [...new Set(groups.flatMap(group => group.slugs))];
test('topic selection prioritizes relevant categories and never routes clinical topics to alternative listings', () => {
  assert.deepEqual(providerSelection({ category: 'Kapcsolatok' })[0].slugs, ['par-es-csaladterapeutak']);
  assert.deepEqual(providerSelection({ category: 'Mentálhigiéné' })[0].slugs, ['mentalhigienes-szakemberek']);
  assert.deepEqual(providerSelection({ category: 'Alvás' })[0].slugs, ['alvas-es-relaxacio']);
  assert.deepEqual(providerSelection({ category: 'Bipoláris zavar' })[0].slugs, ['pszichiaterek']);
  assert.deepEqual(providerSelection({ category: 'Időskori mentális egészség', title: 'Memóriazavar és demencia' })[0].slugs, ['demencia']);
  for (const category of ['Depresszió', 'Szorongás', 'ADHD', 'Trauma és krízis', 'Függőségek', 'Terápia és ellátás']) {
    const allowed = slugs(providerSelection({ category }));
    assert(allowed.every(slug => ['pszichologusok', 'pszichiaterek', 'pszichoterapeutak'].includes(slug)), category);
  }
});

test('child and adult ADHD article contexts use distinct relevant audiences', () => {
  const child = providerSelection({ category: 'ADHD', title: 'Gyermekkori ADHD kivizsgálása' });
  assert(slugs(child).includes('gyermekkori-diagnosztika'));
  assert(child[0].patterns.length === 2, 'First tier requires both ADHD and child specialism');
  assert(child.every(group => group.adult === false));
  const adult = providerSelection({ category: 'ADHD', title: 'Gyermekkori diagnózis: fiatal felnőttek tapasztalatai' });
  assert(!slugs(adult).includes('gyermekkori-diagnosztika'));
  assert(adult.every(group => group.adult === true));
  const childhood = providerSelection({ category: 'Gyermekek és serdülők', title: 'Kamaszok és családi beszélgetések' });
  assert(!slugs(childhood).includes('gyermekkori-diagnosztika'), 'Childhood alone is not a diagnostic recommendation');
  assert.deepEqual(providerSelection({ category: 'Gyermekek és serdülők', title: 'Autizmus és a diagnosztikai vizsgálat' })[0].slugs, ['gyermekkori-diagnosztika']);
});

test('provider rendering caps at four unique internal links and escapes directory content', () => {
  const providers = Array.from({ length: 6 }, (_, index) => ({
    slug: 'provider-' + index,
    name: 'Szolgáltató ' + index,
    category_name: 'Pszichológusok',
    city: 'Budapest', online_available: true
  }));
  providers[0] = { ...providers[0], slug: '"><script>alert(1)</script>', name: '<img src=x onerror=alert(1)>', category_name: '<b>kategória</b>', city: '<i>város</i>', url: 'https://evil.invalid' };
  providers.splice(1, 0, { ...providers[0] });
  const markup = renderRelatedProviders(providers);
  assert.equal((markup.match(/class="reader-provider-card"/g) || []).length, 4);
  assert(markup.includes('&lt;img src=x onerror=alert(1)&gt;'));
  assert(markup.includes('&lt;b&gt;kategória&lt;/b&gt;'));
  assert(markup.includes('&lt;i&gt;város&lt;/i&gt;'));
  assert(!markup.includes('<script>'));
  assert(!markup.includes('https://evil.invalid'));
  assert(markup.includes('/szolgaltato/%22%3E%3Cscript%3Ealert(1)%3C%2Fscript%3E'));
  assert(markup.includes('Online is'));
  assert(renderRelatedProviders([]).includes('href="/szolgaltatok"'));
  assert(!renderRelatedProviders([]).includes('reader-provider-card'));
});

test('provider lookup is bounded and produces profile URLs from slugs', async () => {
  let query;
  const rows = await selectRelatedProviders({ query: async value => {
    query = value;
    return { rows: [{ id: 1, slug: 'minta / nev', name: 'Minta' }] };
  } }, { category: 'Szorongás' }, 99);
  assert.equal(query.values[1], 4);
  assert.equal(query.query_timeout, 1500);
  assert.equal(rows[0].url, '/szolgaltato/minta%20%2F%20nev');
  assert.equal(rows[0].match_type, 'online', 'Unknown location uses the online fallback');
  assert.equal(rows[0].distance_km, null);
});

test('an optional provider-query failure leaves the public article readable', async () => {
  const express = require('express');
  const { createArticleService } = require('../lib/public-articles.cjs');
  const app = express();
  const article = { id: 1, slug: 'test-article', title: 'Olvasható cikk', category: 'Szorongás', content_html: '<p>Az eredeti cikk szövege.</p>', sources: [] };
  const pool = { query: async query => {
    if (typeof query === 'object') throw new Error('Optional source failed');
    return { rows: query.includes('a.content_html') ? [article] : [] };
  } };
  createArticleService({ pool, dbState: { ready: true }, cleanHtml: html => html }).register(app);
  const server = app.listen(0, '127.0.0.1');
  try {
    await new Promise(resolve => server.once('listening', resolve));
    const response = await fetch('http://127.0.0.1:' + server.address().port + '/cikk/test-article');
    assert.equal(response.status, 200);
    const html = await response.text();
    assert(html.includes('Az eredeti cikk szövege.'));
    assert(html.includes('Böngéssz a katalógusban'));
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

const databaseUrl = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
test('database selection respects state, category, audience, duplicate membership and random selection', { skip: !databaseUrl }, async () => {
  const url = new URL(databaseUrl);
  assert(['127.0.0.1', 'localhost'].includes(url.hostname) && /test/.test(url.pathname), 'Disposable local test database required');
  const { Client } = require('pg');
  const client = new Client({ connectionString: databaseUrl, ssl: false });
  await client.connect();
  try {
    await client.query('BEGIN');
    await client.query(`CREATE TEMP TABLE directory_categories(id bigint PRIMARY KEY,slug text,name text,active boolean,verification_level text,sort_order integer);
      CREATE TEMP TABLE directory_listings(id bigint PRIMARY KEY,slug text,name text,kind text,status text,city text,online_available boolean,short_description text,specialties text,published_at timestamptz);
      CREATE TEMP TABLE directory_listing_categories(listing_id bigint,category_id bigint,PRIMARY KEY(listing_id,category_id));`);
    const categories = [
      [1, 'pszichiaterek', 'Pszichiáterek', true, 'healthcare'],
      [2, 'pszichologusok', 'Pszichológusok', true, 'professional'],
      [3, 'pszichoterapeutak', 'Pszichoterapeuták', false, 'healthcare'],
      [4, 'mentalhigienes-szakemberek', 'Hibás alternatív besorolás', true, 'alternative'],
      [5, 'szemeszek', 'Szemészek', true, 'healthcare'],
      [6, 'gyermekkori-diagnosztika', 'Gyermekkori diagnosztikák', true, 'healthcare']
    ];
    for (const category of categories) await client.query('INSERT INTO directory_categories VALUES($1,$2,$3,$4,$5,10)', category);
    async function listing(id, { status = 'published', kind = 'provider', specialty = 'Felnőtt ADHD', category = 1, future = false } = {}) {
      await client.query(`INSERT INTO directory_listings VALUES($1,$2,$3,$4,$5,'Budapest',true,'',$6,now() + $7 * interval '1 day')`, [id, 'provider-' + id, 'Szolgáltató ' + id, kind, status, specialty, future ? 1 : -1]);
      await client.query('INSERT INTO directory_listing_categories VALUES($1,$2)', [id, category]);
    }
    for (let id = 1; id <= 8; id++) await listing(id);
    await client.query('INSERT INTO directory_listing_categories VALUES(1,2)');
    await listing(100, { status: 'draft' });
    await listing(101, { status: 'pending' });
    await listing(102, { kind: 'event' });
    await listing(103, { future: true });
    await listing(104, { category: 3 });
    await listing(105, { category: 4 });
    await listing(106, { category: 5 });
    await listing(107, { specialty: 'Általános pszichiátria' });
    await listing(201, { specialty: 'Gyermekpszichiátria, gyermek ADHD' });
    await listing(202, { category: 6, specialty: 'Gyermekkori diagnosztika' });
    await listing(203, { category: 2, specialty: 'Gyermekpszichológia' });
    const selections = new Set();
    for (let attempt = 0; attempt < 12; attempt++) {
      const rows = await selectRelatedProviders(client, { category: 'ADHD', title: 'Felnőtt ADHD' });
      assert.equal(rows.length, 4);
      assert(rows.every(row => Number(row.id) >= 1 && Number(row.id) <= 8), 'Only primary, published, relevant adult providers');
      assert.equal(new Set(rows.map(row => row.id)).size, 4);
      selections.add(rows.map(row => row.id).sort().join(','));
    }
    assert(selections.size > 1, 'Selections vary between article requests');
    const children = await selectRelatedProviders(client, { category: 'ADHD', title: 'Gyermekek ADHD-vizsgálata' });
    assert.deepEqual(children.map(row => Number(row.id)), [201, 202, 203]);
    const wellness = await selectRelatedProviders(client, { category: 'Mentálhigiéné' });
    assert(!wellness.some(row => Number(row.id) === 105), 'Alternative-classified categories are excluded even if assigned a known slug');
  } finally {
    await client.query('ROLLBACK').catch(() => {});
    await client.end();
  }
});
