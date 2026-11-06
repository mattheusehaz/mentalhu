'use strict';
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { Pool } = require('pg');
const { buildDatabaseConfig } = require('../lib/database-config.cjs');
const crypto = require('node:crypto');
const url = new URL(process.env.DATABASE_URL || 'http://invalid');
assert(['127.0.0.1','localhost'].includes(url.hostname) && /test/.test(url.pathname), 'Disposable local test database required');
const db = new Pool(buildDatabaseConfig());
const base = 'http://127.0.0.1:18081';
const wait = ms => new Promise(resolve=>setTimeout(resolve,ms));
let child, output='';
const request = route => fetch(base+route,{signal:AbortSignal.timeout(18000)});
async function json(route){const r=await request(route);assert.equal(r.status,200,route+' '+output);return r.json();}
async function body(route){const r=await request(route);assert.equal(r.status,200,route+' '+output);return r.text();}
async function main(){
  child=spawn(process.execPath,['server.js'],{cwd:require('node:path').resolve(__dirname,'..'),env:{...process.env,PORT:'18081',NODE_ENV:'test',CMS_JWT_SECRET:crypto.randomBytes(48).toString('hex')},stdio:['ignore','pipe','pipe']});
  child.stdout.on('data',x=>{output+=x;});child.stderr.on('data',x=>{output+=x;});
  let health;
  for(let i=0;i<80;i++){
    assert.equal(child.exitCode,null,output);
    try{const r=await request('/health/ready');if(r.ok){health=await r.json();break;}}catch{}
    await wait(250);
  }
  assert(health?.database && health?.migrations,output);
  const expected=(await db.query("SELECT id,slug FROM directory_listings WHERE status='published' ORDER BY id")).rows;
  assert.equal(expected.length,399,'Known seed total must not be faked by the frontend');
  const all=await json('/api/public/directory-summary');
  assert.equal(all.total,expected.length);assert.equal(all.categories,21);
  const home=await body('/');
  assert(home.includes('data-total="399"'),'Real total must be in HTML before JS');
  assert(home.includes('Mind a 399 adatlap megtekintése'));
  assert(home.includes('href="/szolgaltatok"'));
  console.log('PASS homepage: 399 actual published records, 21 categories, direct complete-catalog link (no JavaScript required)');
  const first=await json('/api/public/listings?paginated=true&limit=100');
  assert.equal(first.total,399);assert.equal(first.pages,4);assert.equal(first.items.length,100);
  const ids=[];
  for(let page=1;page<=first.pages;page++){
    const result=await json('/api/public/listings?paginated=true&limit=100&page='+page);
    assert.equal(result.page,page);assert.equal(result.total,399);
    ids.push(...result.items.map(x=>String(x.id)));
  }
  assert.equal(ids.length,399);assert.equal(new Set(ids).size,399);
  assert.deepEqual([...ids].sort(),expected.map(x=>String(x.id)).sort());
  const arrayResponse=await request('/api/public/listings?limit=9');
  assert.equal(arrayResponse.headers.get('x-total-count'),'399');
  assert.equal((await arrayResponse.json()).length,9,'Existing homepage API contract preserved');
  console.log('PASS API pagination: all 399 unique records reached, no gaps or duplicate rows, old homepage API compatible');
  const slugs=[];
  for(let page=1;page<=17;page++){
    const text=await body('/kereses?page='+page);
    assert(text.includes('data-catalog-total="399"'));
    assert(text.includes('data-catalog-page="'+page+'"'));
    const links=[...text.matchAll(/class="listing-card[^\"]*" href="\/szolgaltato\/([^\"]+)"/g)].map(x=>decodeURIComponent(x[1]));
    assert.equal(links.length,page===17?15:24,'Each visible page must contain real records');
    slugs.push(...links);
    assert.equal(text.includes('rel="next"'),page<17);
  }
  assert.equal(new Set(slugs).size,399);assert.deepEqual(slugs.slice().sort(),expected.map(x=>x.slug).sort());
  assert((await body('/szolgaltatok')).includes('data-catalog-total="399"'));
  assert((await body('/kereses?page=999999')).includes('data-catalog-page="17"'));
  console.log('PASS public HTML: 17 pages, 24 records/page, last page 15; exactly 399 distinct profile links');
  const categories=await json('/api/public/categories');
  for(const cat of categories){
    const actual=await json('/api/public/listings?paginated=true&category='+encodeURIComponent(cat.slug));
    assert.equal(actual.total,cat.listing_count,cat.slug);
    const categoryHtml=await body('/kategoria/'+cat.slug);
    assert(categoryHtml.includes('data-catalog-total="'+cat.listing_count+'"'));
    assert(actual.items.every(x=>x.categories.some(c=>c.slug===cat.slug)));
  }
  const known=await json('/api/public/listings?paginated=true&q=LineaMed&category=pszichiaterek');
  assert(known.items.some(x=>x.categories.some(c=>c.slug==='pszichologusok')),'Category filtering must not hide a record\'s other categories');
  const filter=await json('/api/public/listings?paginated=true&category=pszichologusok&city=Budapest&online=true');
  const filteredCount=(await db.query("SELECT count(*)::int AS n FROM directory_listings l WHERE l.status='published' AND lower(l.city)='budapest' AND l.online_available AND EXISTS(SELECT 1 FROM directory_listing_categories lc JOIN directory_categories c ON c.id=lc.category_id WHERE lc.listing_id=l.id AND c.slug='pszichologusok')")).rows[0].n;
  assert.equal(filter.total,filteredCount);
  const empty=await json('/api/public/listings?paginated=true&q=MENTAL_NO_MATCH_XYZ_8873');
  assert.equal(empty.total,0);assert.equal(empty.items.length,0);
  assert((await body('/kereses?q=MENTAL_NO_MATCH_XYZ_8873')).includes('data-catalog-total="0"'));
  for(const slug of [slugs[0],slugs.at(-1)])assert((await body('/szolgaltato/'+encodeURIComponent(slug))).includes('<!doctype html>'));
  console.log('PASS all 21 category totals, category/city/online filters, zero results, first/last profiles');
  console.log('ALL PUBLIC CATALOG PAGINATION TESTS PASSED');
}
main().catch(e=>{console.error(e);console.error(output);process.exitCode=1;}).finally(async()=>{if(child&&child.exitCode===null){const ended=once(child,'exit');child.kill('SIGTERM');await Promise.race([ended,wait(3000)]);if(child.exitCode===null)child.kill('SIGKILL');}await db.end();});
