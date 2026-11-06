'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs');
const {Pool}=require('pg');
const {buildDatabaseConfig}=require('../lib/database-config.cjs');
const u=new URL(process.env.DATABASE_URL);
assert(['127.0.0.1','localhost'].includes(u.hostname)&&/test/.test(u.pathname),'Disposable LOCAL database only');
const pool=new Pool(buildDatabaseConfig());
(async()=>{
 const client=await pool.connect();
 try{
  const repair=fs.readFileSync(require('node:path').join(__dirname,'../migrations/005_restore_import_category_links.sql'),'utf8');
  const pairs=[...repair.matchAll(/\('([a-z0-9-]+)','([a-z0-9-]+)'\)/g)].map(m=>[m[1],m[2]]);
  assert.equal(pairs.length,348);
  const unclassified=(await client.query("SELECT count(*)::int n FROM directory_listings l WHERE status='published' AND NOT EXISTS(SELECT 1 FROM directory_listing_categories lc WHERE lc.listing_id=l.id)")).rows[0].n;
  assert.equal(unclassified,0,'Fresh installation must classify ALL 399 published records');
  console.log('PASS fresh database: 399 published records, none missing categories');
  await client.query('BEGIN');
  await client.query('DELETE FROM directory_listing_categories WHERE listing_id IN (SELECT id FROM directory_listings WHERE slug=ANY($1))',[pairs.map(p=>p[0])]);
  const before=(await client.query("SELECT count(*)::int n FROM directory_listings l WHERE status='published' AND NOT EXISTS(SELECT 1 FROM directory_listing_categories lc WHERE lc.listing_id=l.id)")).rows[0].n;
  assert.equal(before,348);
  console.log('REPRODUCED original production issue: all 348 bulk imports have no category');
  const curated=pairs[0][0];
  await client.query("INSERT INTO directory_listing_categories(listing_id,category_id) SELECT l.id,c.id FROM directory_listings l CROSS JOIN directory_categories c WHERE l.slug=$1 AND c.slug='coachok'",[curated]);
  await client.query("UPDATE directory_listings SET name='CI editorial name',verified=true WHERE slug=$1",[curated]);
  const snapshots=await client.query('SELECT * FROM directory_listings ORDER BY id');
  await client.query(repair);
  const after=(await client.query("SELECT count(*)::int n FROM directory_listings l WHERE status='published' AND NOT EXISTS(SELECT 1 FROM directory_listing_categories lc WHERE lc.listing_id=l.id)")).rows[0].n;
  assert.equal(after,0);
  assert.deepEqual((await client.query('SELECT * FROM directory_listings ORDER BY id')).rows,snapshots.rows,'No profile fields or publication state may change');
  const assigned=(await client.query('SELECT l.slug,c.slug category FROM directory_listings l JOIN directory_listing_categories lc ON lc.listing_id=l.id JOIN directory_categories c ON c.id=lc.category_id WHERE l.slug=ANY($1)',[pairs.map(p=>p[0])])).rows;
  for(const [slug,category]of pairs){const found=assigned.filter(r=>r.slug===slug);assert.equal(found.length,1,slug);assert.equal(found[0].category,slug===curated?'coachok':category,slug);}
  const linkCount=(await client.query('SELECT count(*)::int n FROM directory_listing_categories')).rows[0].n;
  await client.query(repair);
  assert.equal((await client.query('SELECT count(*)::int n FROM directory_listing_categories')).rows[0].n,linkCount);
  console.log('PASS upgrade backfill, exact original classifications, editorial changes and repeat execution preserved');
  await client.query('ROLLBACK');
  const counts=(await client.query("SELECT c.slug,COUNT(l.id)::int n FROM directory_categories c LEFT JOIN directory_listing_categories lc ON lc.category_id=c.id LEFT JOIN directory_listings l ON l.id=lc.listing_id AND l.status='published' GROUP BY c.id ORDER BY c.sort_order")).rows;
  console.log('REPAIRED_CATEGORY_TOTALS',JSON.stringify(counts));
 }catch(e){await client.query('ROLLBACK').catch(()=>{});throw e;}finally{client.release();}
})().catch(e=>{console.error(e);process.exitCode=1;}).finally(()=>pool.end());
