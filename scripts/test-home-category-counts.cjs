'use strict';
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const path = require('node:path');
const crypto = require('node:crypto');
const { Pool } = require('pg');
const { buildDatabaseConfig } = require('../lib/database-config.cjs');
const { renderCategoryCounts } = require('../lib/public-catalog.cjs');
const { chromium } = require(process.env.BROWSER_TOOLS);
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
let child, db, browser, insertedId, output = '';
const base = 'http://127.0.0.1:18082';
const read = async (origin, route) => {
  const r = await fetch(origin + route, { cache: 'no-store', signal: AbortSignal.timeout(12000) });
  return { status: r.status, headers: r.headers, text: await r.text() };
};
function badges(source) {
  return [...source.matchAll(/<small\b([^>]*\bdata-count="([^"]+)"[^>]*)>([\s\S]*?)<\/small>/g)].map(x => ({ slug: x[2], text: x[3], hidden: /\bhidden\b/.test(x[1]), source: /data-count-source="database"/.test(x[1]) }));
}
function checkHtml(source, categories) {
  const expected = new Map(categories.map(c => [c.slug, c.listing_count]));
  const found = badges(source);
  assert.equal(found.length, 29, '8 quick cards plus all 21 category links');
  for (const node of found) {
    assert(expected.has(node.slug), node.slug);
    assert.equal(node.text, '(' + expected.get(node.slug) + ')', node.slug);
    assert.equal(node.hidden, false, node.slug);
    assert.equal(node.source, true, node.slug);
  }
}
async function checkBrowser(page, categories) {
  const nodes = await page.locator('[data-count]').evaluateAll(items => items.map(n => ({slug:n.dataset.count, text:n.textContent, hidden:n.hidden, display:getComputedStyle(n).display})));
  assert.equal(nodes.length,29);
  const expected = new Map(categories.map(c => [c.slug, '(' + c.listing_count + ')']));
  for (const node of nodes) {
    assert.equal(node.text,expected.get(node.slug),node.slug);
    assert(!node.hidden && node.display !== 'none', node.slug + ' must be visible');
  }
}
async function main() {
  const url = new URL(process.env.DATABASE_URL);
  assert(['localhost','127.0.0.1'].includes(url.hostname) && /test/.test(url.pathname), 'Writes permitted only on disposable local database');
  db = new Pool(buildDatabaseConfig());
  child = spawn(process.execPath,['server.js'],{cwd:path.resolve(__dirname,'..'),env:{...process.env,PORT:'18082',NODE_ENV:'test',CMS_JWT_SECRET:crypto.randomBytes(48).toString('hex')},stdio:['ignore','pipe','pipe']});
  child.stdout.on('data', d => {output += d;}); child.stderr.on('data', d => {output += d;});
  let ready = false;
  for (let i=0;i<80;i++) {
    assert.equal(child.exitCode,null,output);
    try { if ((await read(base,'/health/ready')).status===200) {ready=true;break;} } catch {}
    await wait(250);
  }
  assert(ready,output);
  const catsResponse = await read(base,'/api/public/categories');
  assert.equal(catsResponse.status,200);
  assert.equal(catsResponse.headers.get('cache-control'),'no-store');
  const cats = JSON.parse(catsResponse.text);
  checkHtml((await read(base,'/')).text,cats);
  checkHtml((await read(base,'/index.html')).text,cats);
  assert(renderCategoryCounts('<small data-count="zero" hidden>(99)</small>',[{slug:'zero',listing_count:0}]).includes('>(0)</small>'));
  assert.equal(renderCategoryCounts('<small data-count="unknown" hidden></small>',[]),'<small data-count="unknown" hidden></small>');
  console.log('PASS all 29 badges are actual published counts in initial HTML, including zero');
  browser = await chromium.launch({headless:true});
  const context = await browser.newContext({javaScriptEnabled:false});
  const noJs = await context.newPage(); await noJs.goto(base,{waitUntil:'domcontentloaded'});
  await checkBrowser(noJs,cats); await context.close();
  console.log('PASS visible category counts with JavaScript disabled');
  const page = await browser.newPage(); const errors=[];page.on('pageerror', e=>errors.push(e.message));
  await page.goto(base,{waitUntil:'networkidle'});await checkBrowser(page,cats);
  const category = cats.find(c=>c.slug==='pszichologusok');
  insertedId = (await db.query("INSERT INTO directory_listings(slug,name,kind,status) VALUES($1,$2,'provider','draft') RETURNING id",['ci-count-'+crypto.randomUUID(),'CI count-only fixture'])).rows[0].id;
  await db.query('INSERT INTO directory_listing_categories(listing_id,category_id) VALUES($1,$2)',[insertedId,category.id]);
  checkHtml((await read(base,'/')).text,cats);
  await db.query("UPDATE directory_listings SET status='published' WHERE id=$1",[insertedId]);
  const updated=JSON.parse((await read(base,'/api/public/categories')).text);
  assert.equal(updated.find(c=>c.id===category.id).listing_count,category.listing_count+1);
  checkHtml((await read(base,'/')).text,updated);
  const refresh=page.waitForResponse(r=>r.url().endsWith('/api/public/categories'));
  await page.evaluate(()=>window.dispatchEvent(new Event('pageshow')));await refresh;
  await page.waitForFunction(({slug,count})=>Array.from(document.querySelectorAll('[data-count]')).filter(n=>n.dataset.count===slug).every(n=>n.textContent==='('+count+')'),{slug:category.slug,count:category.listing_count+1});
  await checkBrowser(page,updated);
  await db.query("UPDATE directory_listings SET status='draft' WHERE id=$1",[insertedId]);
  const refreshBack=page.waitForResponse(r=>r.url().endsWith('/api/public/categories'));
  await page.evaluate(()=>window.dispatchEvent(new Event('online')));await refreshBack;
  await page.waitForFunction(({slug,count})=>document.querySelector('[data-count="'+slug+'"]').textContent==='('+count+')',{slug:category.slug,count:category.listing_count});
  await checkBrowser(page,cats);
  console.log('PASS draft/publish/unpublish updates HTML and both badges in the open browser without deployment');
  await page.route('**/api/public/categories',route=>route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(cats.map(c=>({...c,listing_count:0})))}));
  await page.evaluate(()=>window.dispatchEvent(new Event('pageshow')));
  await page.waitForFunction(()=>Array.from(document.querySelectorAll('[data-count]')).every(n=>n.textContent==='(0)'));
  console.log('PASS all-zero API response clears previously nonzero counts');
  await page.unroute('**/api/public/categories');
  await page.route('**/api/public/categories',route=>route.fulfill({status:503,contentType:'application/json',body:'{"error":"unavailable"}'}));
  await page.reload({waitUntil:'networkidle'});await checkBrowser(page,cats);
  assert.deepEqual(errors,[]);
  console.log('PASS API outage preserves server counts; no browser script exceptions');
  console.log('ALL HOMEPAGE CATEGORY COUNT TESTS PASSED');
}
async function live() {
  const origin='https://mental.hu';
  const attempts=process.env.EXPECT_ROLLOUT==='1'?10:1;
  let home,cats,matched=false;
  for(let i=0;i<attempts;i++){
    home=await read(origin,'/');
    const api=await read(origin,'/api/public/categories');
    assert.equal(api.status,200);cats=JSON.parse(api.text);
    matched=home.headers.get('x-mental-release')==='catalog-counts-1';
    console.log('PUBLIC_COUNTS',JSON.stringify({attempt:i,release:home.headers.get('x-mental-release'),apiCache:api.headers.get('cache-control'),renderedBadges:badges(home.text).filter(n=>n.text&&!n.hidden).length,counts:cats.map(c=>({slug:c.slug,count:c.listing_count}))}));
    if(matched)break;
    if(i+1<attempts)await wait(10000);
  }
  browser=await chromium.launch({headless:true});
  const context=await browser.newContext({ignoreHTTPSErrors:false});
  const page=await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
  page.on('console',msg=>{if(msg.type()==='error')console.log('PUBLIC_BROWSER_ERROR',msg.text().slice(0,250));});
  await page.goto(origin,{waitUntil:'networkidle',timeout:30000});
  console.log('PUBLIC_BROWSER_BADGES',JSON.stringify(await page.locator('[data-count]').evaluateAll(nodes=>nodes.map(n=>({slug:n.dataset.count,text:n.textContent,hidden:n.hidden})))));
  console.log('PUBLIC_JS_ERRORS',JSON.stringify(errors));
  if(!matched){console.log('ROLLOUT_NOT_CONFIRMED');if(process.env.EXPECT_ROLLOUT==='1')throw new Error('New count release not yet live');return;}
  checkHtml(home.text,cats);await checkBrowser(page,cats);assert.deepEqual(errors,[]);
  for(const c of cats){const data=JSON.parse((await read(origin,'/api/public/listings?paginated=true&limit=1&category='+encodeURIComponent(c.slug))).text);assert.equal(data.total,c.listing_count,c.slug);}
  const ctxNoJs=await browser.newContext({javaScriptEnabled:false});const plain=await ctxNoJs.newPage();await plain.goto(origin,{waitUntil:'domcontentloaded'});await checkBrowser(plain,cats);
  console.log('LIVE_COUNTS_VERIFIED',JSON.stringify({domain:origin,release:'catalog-counts-1',categories:cats.length,badges:29,javascriptDisabled:true,categoryTotalsMatch:true,counts:cats.slice(0,8).map(c=>({name:c.name,count:c.listing_count}))}));
}
(process.argv.includes('--live')?live():main()).catch(e=>{console.error(e);if(output)console.error(output);process.exitCode=1;}).finally(async()=>{if(browser)await browser.close();if(db&&insertedId)await db.query('DELETE FROM directory_listings WHERE id=$1',[insertedId]);if(child&&child.exitCode===null){const exited=once(child,'exit');child.kill('SIGTERM');await Promise.race([exited,wait(3000)]);if(child.exitCode===null)child.kill('SIGKILL');}if(db)await db.end();});
