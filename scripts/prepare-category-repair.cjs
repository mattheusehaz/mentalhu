'use strict';
// Build an auditable, additive repair from the ORIGINAL imported slug/category pairs.
// This runs in CI; the generated SQL is committed and applied once by the normal migrator.
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname,'..');
const sql = zlib.gunzipSync(Buffer.from([0,1,2,3].map(i=>fs.readFileSync(path.join(root,'migrations','004_directory_expansion.sql.gz.b64.part'+i),'utf8').trim()).join(''),'base64')).toString('utf8');
const block = sql.match(/\bseed\s*\(([^)]*)\)\s+AS\s*\(\s*VALUES\s*([\s\S]*?)\s*\),\s*prepared\s+AS\s*\(/i);
assert(block,'Original seed CTE must be found before preparing any repair');
const fields = block[1].split(',').map(s=>s.trim());
assert.equal(fields.length,6);
const tuples = [...block[2].matchAll(/\(\s*'((?:''|[^'])*)'\s*,\s*'((?:''|[^'])*)'\s*,\s*'((?:''|[^'])*)'\s*,\s*'((?:''|[^'])*)'\s*,\s*'((?:''|[^'])*)'\s*,\s*'((?:''|[^'])*)'\s*\)/g)];
assert.equal(tuples.length,348,'All original imported records must be covered');
const slugIndex=fields.indexOf('slug')+1,catIndex=fields.indexOf('category')+1;
assert(slugIndex>0&&catIndex>0);
const pairs=tuples.map(row=>[row[slugIndex],row[catIndex]]);
assert.equal(new Set(pairs.map(p=>p[0])).size,348,'Original slugs must be unique');
for(const [slug,category] of pairs){assert(/^[a-z0-9-]+$/.test(slug));assert(['pszichologusok','pszichiaterek','dietetikusok','joga-es-mozgas','masszorok','fogaszatok'].includes(category));}
const repair = '-- Restore missing links from the 348-record import.\n-- The original data-modifying CTE joined the base table instead of RETURNING rows.\n-- Only known imported slugs without ANY category are repaired.\n-- Existing editorial classifications, profile fields and publication state are preserved.\nWITH imported(slug,category_slug) AS (VALUES\n'+pairs.map(([s,c])=>"('"+s+"','"+c+"')").join(',\n')+'\n)\nINSERT INTO directory_listing_categories(listing_id,category_id)\nSELECT l.id,c.id FROM imported i\nJOIN directory_listings l ON l.slug=i.slug\nJOIN directory_categories c ON c.slug=i.category_slug\nWHERE NOT EXISTS (SELECT 1 FROM directory_listing_categories existing WHERE existing.listing_id=l.id)\nON CONFLICT (listing_id,category_id) DO NOTHING;\n';
const filename='005_restore_import_category_links.sql';
fs.writeFileSync(path.join(root,'migrations',filename),repair);
const serverFile=path.join(root,'server.js');let server=fs.readFileSync(serverFile,'utf8');
if(!server.includes(filename)){
  const anchor='  const client = await pool.connect();\n  let locked = false;';
  assert.equal(server.split(anchor).length,2,'Only the migrator may be patched');
  server=server.replace(anchor,()=>"  steps.push({ name: '"+filename+"', sql: fs.readFileSync(path.join(ROOT, 'migrations', '"+filename+"'), 'utf8') });\n"+anchor);
  fs.writeFileSync(serverFile,server);
}
const testFile=path.join(root,'scripts/test-directory-db.cjs');let test=fs.readFileSync(testFile,'utf8');
if(test.includes('assert.equal(migrationCount.rows[0].count, 4);')){test=test.replace('assert.equal(migrationCount.rows[0].count, 4);','assert.equal(migrationCount.rows[0].count, 5);');fs.writeFileSync(testFile,test);}
console.log('Prepared additive category recovery for',pairs.length,'exact imported slugs.');
