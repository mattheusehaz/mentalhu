'use strict';

// Runs only against the disposable PostgreSQL database in CI. No real email is sent.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const {spawn} = require('node:child_process');
const {once} = require('node:events');
const {Pool} = require('pg');
const {buildDatabaseConfig} = require('../lib/database-config.cjs');
const {chromium} = require(process.env.BROWSER_TOOLS || 'playwright');

const database = new URL(process.env.DATABASE_URL || 'http://invalid');
assert(['127.0.0.1','localhost'].includes(database.hostname) && /test/.test(database.pathname), 'Disposable local test database required');
const root = path.resolve(__dirname, '..');
const db = new Pool(buildDatabaseConfig());
const base = 'http://127.0.0.1:18086';
const secret = crypto.randomBytes(48).toString('hex');
const password = crypto.randomBytes(24).toString('hex');
const inquiryId = crypto.randomUUID();
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
let child, browser, output = '';

async function until(check, label) {
  for (let i=0; i<100; i++) { if (await check()) return; await wait(100); }
  throw new Error('Timed out: ' + label);
}
async function json(context, route) {
  const response = await context.request.get(base + route);
  assert.equal(response.status(), 200, route);
  return response.json();
}
async function noOverflow(page) {
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'No horizontal document overflow');
}

(async () => {
  child = spawn(process.execPath, ['server.js'], {cwd:root,env:{...process.env,PORT:'18086',NODE_ENV:'test',CMS_JWT_SECRET:secret,CMS_ADMIN_EMAIL:'admin@example.test',CMS_ADMIN_PASSWORD:password,SMTP_HOST:'',RESEND_API_KEY:'',BREVO_API_KEY:''},stdio:['ignore','pipe','pipe']});
  child.stdout.on('data', value => output += value);
  child.stderr.on('data', value => output += value);
  await until(async () => {
    assert.equal(child.exitCode, null, output);
    try { return (await fetch(base + '/health/ready')).ok; } catch { return false; }
  }, 'server readiness');

  browser = await chromium.launch({headless:true});
  const admin = await browser.newContext({viewport:{width:1440,height:1080}});
  const login = await admin.request.post(base + '/api/admin/login', {data:{email:'admin@example.test',password}});
  assert.equal(login.status(), 200);
  const initial = await json(admin, '/api/admin/statistics?range=today');
  const article = (await db.query("SELECT id,slug,title FROM articles WHERE status='published' AND category='Szorongás' AND (published_at IS NULL OR published_at<=now()) ORDER BY id LIMIT 1")).rows[0];
  assert(article, 'Published anxiety article fixture exists');

  const guest = await browser.newContext({viewport:{width:1440,height:1080},userAgent:'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 MentalQA/' + crypto.randomUUID()});
  assert.equal((await guest.request.get(base + '/api/admin/statistics')).status(), 401);
  const page = await guest.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(base + '/', {waitUntil:'networkidle'});
  await until(async () => Number((await json(admin, '/api/admin/statistics?range=today')).today.views) === Number(initial.today.views) + 1, 'visible homepage measurement');
  await page.goto(base + '/cikk/' + article.slug, {waitUntil:'networkidle'});
  await until(async () => Number((await json(admin, '/api/admin/statistics?range=today')).today.article_views) === Number(initial.today.article_views) + 1, 'article measurement');
  const providerCount = await page.locator('a.reader-provider-card').count();
  assert(providerCount >= 1 && providerCount <= 4, 'At most four relevant related provider cards from the fixture catalogue');
  const links = await page.locator('a.reader-provider-card').evaluateAll(nodes => nodes.map(node => node.getAttribute('href')));
  assert.equal(new Set(links).size, providerCount);
  assert(links.every(link => /^\/szolgaltato\/[^/?#]+$/.test(link)), 'Internal provider profile links');
  if (!(await page.locator('[data-related-providers]').getAttribute('data-provider-city-id'))) {
    assert.equal(await page.locator('.reader-provider-match').filter({hasText:'Online konzultáció'}).count(), providerCount, 'Unknown location shows explicitly labelled online consultations');
  }
  const desktopMargin = await page.locator('.reader-margin--providers').boundingBox();
  const desktopContent = await page.locator('.reader-content').boundingBox();
  assert(desktopMargin.x + desktopMargin.width <= desktopContent.x + 1, 'Provider sidebar is left of article text');
  await noOverflow(page);
  fs.mkdirSync(path.join(root, 'test-artifacts'), {recursive:true});
  await page.locator('.reader-layout').scrollIntoViewIfNeeded();
  await page.screenshot({path:path.join(root,'test-artifacts/article-providers-desktop.png')});

  const slug = decodeURIComponent(links[0].split('/').pop());
  const listing = (await db.query('SELECT id,slug,name FROM directory_listings WHERE slug=$1', [slug])).rows[0];
  assert(listing);
  await page.setViewportSize({width:390,height:844});
  const mobileMargin = await page.locator('.reader-margin--providers').boundingBox();
  const mobileContent = await page.locator('.reader-content').boundingBox();
  assert(mobileMargin.y >= mobileContent.y + mobileContent.height - 1, 'Provider cards follow article text on mobile');
  await noOverflow(page);
  await page.locator('.reader-providers').scrollIntoViewIfNeeded();
  await page.screenshot({path:path.join(root,'test-artifacts/article-providers-mobile.png')});
  await page.goto(base + links[0], {waitUntil:'networkidle'});
  await until(async () => Number((await json(admin, '/api/admin/statistics?range=today')).today.listing_views) === Number(initial.today.listing_views) + 1, 'listing measurement');
  const measured = await json(admin, '/api/admin/statistics?range=today');
  assert.equal(Number(measured.today.views), Number(initial.today.views) + 3);
  assert.equal(Number(measured.today.visitors), Number(initial.today.visitors) + 1, 'Same visitor counted once across three public pages');
  assert.equal(Number(measured.week.visitors), Number(initial.week.visitors) + 1, 'Weekly visitor deduplicated');

  await db.query("INSERT INTO directory_contact_inquiries(id,request_key,listing_id,delivery_status,consent_version,expires_at) VALUES($1,$2,$3,'needs_mail','ci-statistics',now()+interval '1 day')", [inquiryId,crypto.randomUUID(),listing.id]);
  const withContact = await json(admin, '/api/admin/statistics?range=today');
  assert.equal(Number(withContact.today.contacts), Number(initial.today.contacts) + 1, 'A saved pending inquiry counts before email delivery');

  const adminPage = await admin.newPage();
  adminPage.on('pageerror', error => errors.push(error.message));
  await adminPage.goto(base + '/admin/statisztikak.html', {waitUntil:'networkidle'});
  await adminPage.locator('#statisticsBody').waitFor({state:'visible'});
  await until(async () => (await adminPage.locator('#todayVisitors').textContent()).trim() !== '–', 'dashboard metrics');
  assert.equal(await adminPage.locator('#statisticsTrend > li').count(), 14);
  assert((await adminPage.locator('#statisticsStarted').textContent()).includes('202'), 'Measurement start displayed');
  await adminPage.locator('#statisticsRange').selectOption('today');
  await adminPage.locator('#articlesSearch').fill(article.title);
  await adminPage.locator('#articlesSearchForm').evaluate(form => form.requestSubmit());
  await until(async () => await adminPage.locator('#articlesTable tbody tr').count() === 1, 'article search');
  assert((await adminPage.locator('#articlesTable').textContent()).includes(article.title));
  await adminPage.locator('#listingsSearch').fill(listing.name);
  await adminPage.locator('#listingsSearchForm').evaluate(form => form.requestSubmit());
  await until(async () => !(await adminPage.locator('#listingsMessage').textContent()).trim() && (await adminPage.locator('#listingsTable').textContent()).includes(listing.name), 'listing search');
  const listingData = await json(admin, '/api/admin/statistics/listings?range=today&q=' + encodeURIComponent(listing.name));
  const listingStats = listingData.items.find(item => String(item.id) === String(listing.id));
  assert(listingStats && Number(listingStats.views) >= 1 && Number(listingStats.contacts) >= 1);
  await noOverflow(adminPage);
  await adminPage.evaluate(() => window.scrollTo(0,0));
  await adminPage.screenshot({path:path.join(root,'test-artifacts/statistics-desktop.png')});

  await adminPage.locator('#articlesSearch').fill('ZZZ-no-matching-article-' + crypto.randomUUID());
  await adminPage.locator('#articlesSearchForm').evaluate(form => form.requestSubmit());
  await until(async () => (await adminPage.locator('#articlesCount').textContent()).startsWith('0 '), 'empty search result');
  await adminPage.locator('#listingsSearch').fill('');
  await adminPage.locator('#listingsSearchForm').evaluate(form => form.requestSubmit());
  await until(async () => await adminPage.locator('#listingsNext').isEnabled(), 'listing pagination enabled');
  const beforePage = await adminPage.locator('#listingsTable tbody tr').first().textContent();
  await adminPage.locator('#listingsNext').click();
  await until(async () => (await adminPage.locator('#listingsTable tbody tr').first().textContent()) !== beforePage, 'next listing page');
  await adminPage.setViewportSize({width:390,height:844});
  await adminPage.evaluate(() => window.scrollTo(0,0));
  await noOverflow(adminPage);
  await adminPage.screenshot({path:path.join(root,'test-artifacts/statistics-mobile.png')});

  await adminPage.goto(base + '/cikk/' + article.slug, {waitUntil:'networkidle'});
  const afterAdmin = await json(admin, '/api/admin/statistics?range=today');
  assert.equal(Number(afterAdmin.today.views), Number(withContact.today.views), 'Authenticated admin article reading excluded');
  await page.goto(base + '/admin/statisztikak.html', {waitUntil:'networkidle'});
  await page.locator('#statisticsLogin').waitFor({state:'visible'});
  assert.equal(await page.locator('#statisticsBody').isVisible(), false);
  assert.deepEqual(errors, [], 'No browser JavaScript exceptions');
  console.log('STATISTICS_BROWSER_OK', JSON.stringify({guestViews:3,uniqueVisitors:1,savedInquiryCount:1,relatedProviders:4,desktopLeftSidebar:true,mobileArticleFirst:true,adminDashboard:true,search:true,pagination:true,privateApi:true,adminViewsExcluded:true,realEmailsSent:0}));
})().catch(error => {
  console.error(error.stack);
  console.error(output);
  process.exitCode = 1;
}).finally(async () => {
  if (browser) await browser.close();
  if (child && child.exitCode === null) { const done=once(child,'exit'); child.kill('SIGTERM'); await Promise.race([done,wait(2000)]); if (child.exitCode === null) child.kill('SIGKILL'); }
  await db.query('DELETE FROM directory_contact_inquiries WHERE id=$1', [inquiryId]).catch(() => {});
  await db.end();
});
