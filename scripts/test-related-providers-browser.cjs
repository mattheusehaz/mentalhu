'use strict';

// Real public article routes and PostgreSQL with an isolated local catalogue.
// Only the approximate IP result is injected; no outside network or mail is used.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const cookieParser = require('cookie-parser');
const helmet = require('helmet');
const {Pool} = require('pg');
const {chromium} = require(process.env.BROWSER_TOOLS || 'playwright');
const {createArticleService} = require('../lib/public-articles.cjs');
const {createReaderLocationService, COOKIE_NAME} = require('../lib/reader-location.cjs');
const {resolveCity} = require('../lib/hungary-locations.cjs');

const root = path.resolve(__dirname, '..');
const storageKey = 'mental-provider-location-v1';
const articlePath = '/cikk/a-szorongas-megertese';
const apiPath = '/api/public/articles/a-szorongas-megertese/providers';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, label) {
  for (let i=0; i<100; i++) { if (await check()) return; await delay(100); }
  throw new Error('Timed out: ' + label);
}

async function fixture() {
  const connectionString = process.env.TEST_DATABASE_URL;
  assert(connectionString, 'TEST_DATABASE_URL must identify disposable local PostgreSQL');
  const database = new URL(connectionString);
  assert(['postgres:','postgresql:'].includes(database.protocol) && ['127.0.0.1','localhost','[::1]'].includes(database.hostname) && /test/i.test(database.pathname), 'Disposable loopback PostgreSQL required');
  const schema = 'geo_browser_' + crypto.randomBytes(8).toString('hex');
  const control = new Pool({connectionString,ssl:false});
  const db = new Pool({connectionString,ssl:false,options:'-c search_path=' + schema});
  let server, created = false;
  async function close() {
    if (server) await new Promise(resolve => server.close(resolve));
    await db.end();
    if (created) await control.query('DROP SCHEMA ' + schema + ' CASCADE');
    await control.end();
  }
  try {
    await control.query('CREATE SCHEMA ' + schema); created = true;
    for (const name of ['001_init.sql','002_directory.sql','009_articles_editorial.sql']) await db.query(fs.readFileSync(path.join(root,'migrations',name),'utf8'));
    await db.query(`INSERT INTO articles(slug,title,category,excerpt,content_html,status,published_at,reading_minutes)
      VALUES('a-szorongas-megertese','A szorongás megértése','Szorongás','Mit jeleznek a mindennapi érzéseink, és mikor kérjünk segítséget?',$1,'published',now()-interval '1 day',4)`, [
      '<p>Az érzéseink megismerése közelebb vihet önmagunkhoz. Ebben az izolált tesztcikkben a szorongásról és a támogatás kereséséről olvashatsz.</p><h2>Amikor jólesik beszélni róla</h2>' + '<p>A mindennapi nehézségekhez különféle segítség kapcsolódhat. A tájékozódás első lépését a saját kérdéseink megfogalmazása jelentheti.</p>'.repeat(6)
    ]);
    const category = (await db.query("INSERT INTO directory_categories(slug,name,group_name,verification_level) VALUES('pszichologusok','Pszichológusok','Szakemberek','professional') ON CONFLICT (slug) DO UPDATE SET active=true,verification_level='professional' RETURNING id")).rows[0].id;
    const entries = [
      ['budapest-egy','Budapesti személyes pszichológus','Budapest',false],
      ['budapest-ketto','Budapesti konzultáció','Budapest XI. kerület',false],
      ['budaors-kozel','Budaörsi szakember','Budaörs',false],
      ['debrecen-szemelyes','Debreceni személyes pszichológus','Debrecen',false],
      ['debrecen-online','Debreceni online pszichológus','Debrecen',true],
      ['szeged-online','Szegedi online pszichológus','Szeged',true]
    ];
    for (const values of entries) {
      const id = (await db.query("INSERT INTO directory_listings(slug,name,city,online_available,status,published_at,specialties) VALUES($1,$2,$3,$4,'published',now()-interval '1 day','Szorongás, felnőtt konzultáció') RETURNING id",values)).rows[0].id;
      await db.query('INSERT INTO directory_listing_categories VALUES($1,$2)',[id,category]);
    }
    const app = express();
    app.use(helmet({contentSecurityPolicy:{directives:{defaultSrc:["'self'"],scriptSrc:["'self'"],styleSrc:["'self'","'unsafe-inline'"],fontSrc:["'self'"],imgSrc:["'self'",'data:']}}}));
    app.use(express.json()); app.use(cookieParser());
    app.use((_req,res,next) => { res.set('Permissions-Policy','geolocation=(self)'); next(); });
    const readerLocation = createReaderLocationService({env:{NODE_ENV:'test',MENTAL_GEO_TRUST_DO_HEADER:'1'},lookup:() => resolveCity('Budapest')});
    createArticleService({pool:db,dbState:{ready:true},cleanHtml:value=>value,readerLocation}).register(app);
    app.get('/api/account/session',(_req,res)=>res.json({authenticated:false}));
    app.post('/api/public/statistics',(_req,res)=>res.json({ok:true}));
    app.use('/assets',express.static(path.join(root,'assets')));
    for (const name of ['mental.css','mental.js','editorial.css','related-providers.css','related-providers.js']) app.get('/'+name,(_req,res)=>res.sendFile(path.join(root,name)));
    server = await new Promise(resolve => { const listener=app.listen(0,'127.0.0.1',()=>resolve(listener)); });
    return {base:'http://127.0.0.1:'+server.address().port,close};
  } catch (error) { await close(); throw error; }
}

(async () => {
  const app = await fixture();
  let browser;
  const errors = [], outside = [];
  try {
    browser = await chromium.launch({headless:true});
    async function context(options={}) {
      const value = await browser.newContext({viewport:{width:1440,height:1250},reducedMotion:'reduce',...options});
      value.setDefaultTimeout(15000);
      await value.route('**/*',route => {
        if (new URL(route.request().url()).origin === app.base) return route.continue();
        outside.push(route.request().url()); return route.abort();
      });
      value.on('page',page=>page.on('pageerror',error=>errors.push(error.message)));
      return value;
    }
    async function screenshot(page,name) {
      await page.evaluate(() => document.fonts.ready);
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),'No horizontal overflow: '+name);
      fs.mkdirSync(path.join(root,'test-artifacts'),{recursive:true});
      await page.evaluate(() => window.scrollTo(0, document.querySelector('.reader-margin--providers').getBoundingClientRect().top + scrollY - 110));
      await page.screenshot({path:path.join(root,'test-artifacts',name+'.png')});
    }
    async function choose(page,name,{keyboard=false}={}) {
      const picker=page.locator('[data-provider-city-picker]');
      if (!(await picker.evaluate(node=>node.open))) await picker.locator('summary').click();
      await page.locator('#provider-city-query').fill(name);
      const button=page.getByRole('button',{name:name+' kiválasztása',exact:true});
      await button.waitFor({state:'visible'});
      if (keyboard) {
        await page.locator('#provider-city-query').press('ArrowDown');
        assert.equal(await page.evaluate(()=>document.activeElement.textContent),name);
        await page.keyboard.press('Enter');
      } else await button.click();
    }
    async function loaded(page,city) {
      await until(async()=>await page.locator('[data-provider-location-name]').textContent()===city && !(await page.locator('[data-provider-results]').getAttribute('aria-busy')) && await page.locator('.reader-provider-card').count()>0,'loaded city '+city);
    }
    async function stored(page) { return page.evaluate(key=>JSON.parse(localStorage.getItem(key)),storageKey); }
    const ctx = await context({extraHTTPHeaders:{'do-connecting-ip':'8.8.8.8'},geolocation:{latitude:47.4984012,longitude:19.0404012,accuracy:20}});
    await ctx.addInitScript(() => {
      window.__geoCalls=0;
      const original=navigator.geolocation.getCurrentPosition.bind(navigator.geolocation);
      navigator.geolocation.getCurrentPosition=(...args)=>{window.__geoCalls++;return original(...args);};
    });
    const page = await ctx.newPage();
    const resolves=[];
    page.on('request',request=>{if(new URL(request.url()).pathname==='/api/public/provider-location/resolve')resolves.push(request.postDataJSON());});
    await page.goto(app.base+articlePath,{waitUntil:'networkidle'});
    assert.equal(await page.evaluate(()=>window.__geoCalls),0,'Never request geolocation on page load');
    assert.equal(await page.locator('[data-provider-location-name]').textContent(),'Budapest');
    assert.equal(await page.locator('[data-provider-location-source]').textContent(),'Becsült hely');
    assert.equal(await page.locator('.reader-provider-card').count(),4);
    assert.equal(await page.locator('[href="/szolgaltato/debrecen-szemelyes"]').count(),0,'Budapest does not show distant in-person expert');
    assert.equal(await page.locator('.reader-provider-match').count(),1,'Only genuinely remote fallback is marked online');
    const boxes=await Promise.all([page.locator('.reader-margin--providers').boundingBox(),page.locator('.reader-content').boundingBox()]);
    assert(boxes[0].x+boxes[0].width<=boxes[1].x+1,'Desktop provider sidebar remains left of article');
    assert.equal(await stored(page),null,'Automatic IP never saved to localStorage');
    assert(!(await ctx.cookies()).some(cookie=>cookie.name===COOKIE_NAME),'Automatic IP never saved to preference cookie');
    await screenshot(page,'geo-providers-desktop');

    await choose(page,'Debrecen',{keyboard:true}); await loaded(page,'Debrecen');
    assert.equal(await page.locator('[href="/szolgaltato/debrecen-szemelyes"]').count(),1);
    assert.equal(await page.locator('[href="/szolgaltato/budapest-egy"]').count(),0);
    assert.deepEqual(await stored(page),{id:'debrecen',name:'Debrecen',source:'manual'});
    assert(await page.locator('[data-provider-reset-location]').isVisible());
    const response=await page.reload({waitUntil:'networkidle'});
    assert((await response.text()).includes('data-provider-city-id="debrecen"'),'SSR already respects chosen city before JavaScript');
    assert.equal(await page.locator('[data-provider-location-name]').textContent(),'Debrecen','Manual selection overrides automatic Budapest');
    assert.equal(await page.evaluate(()=>window.__geoCalls),0,'Reload never invokes browser geolocation');

    await ctx.grantPermissions(['geolocation'],{origin:app.base});
    await page.getByRole('button',{name:'Helyzetem használata',exact:true}).click(); await loaded(page,'Budapest');
    assert.equal(await page.evaluate(()=>window.__geoCalls),1,'Browser location is requested only after explicit click');
    assert.deepEqual(resolves,[{latitude:47.5,longitude:19.04,accuracy:1500}],'Only a rounded location is sent to the same-origin resolver');
    assert.deepEqual(await stored(page),{id:'budapest',name:'Budapest',source:'browser'});
    const preferences=(await ctx.cookies()).filter(cookie=>cookie.name===COOKIE_NAME);
    assert.equal(preferences.length,1);
    assert(!/47\.|19\.|8\.8\.8\.8/.test(preferences[0].value),'Cookie contains no coordinates or IP address');

    await page.getByRole('button',{name:'Automatikus hely',exact:true}).click(); await loaded(page,'Budapest');
    assert.equal(await stored(page),null);
    assert(!(await ctx.cookies()).some(cookie=>cookie.name===COOKIE_NAME));
    assert.equal(await page.locator('[data-provider-location-source]').textContent(),'Becsült hely');
    assert.equal(await page.evaluate(()=>window.__geoCalls),1,'Reset does not trigger geolocation permission');

    // A failed recommendation request clears old cards, keeps the article readable,
    // and retries the selected city successfully.
    const apiUrl=app.base+apiPath;
    await page.route(apiUrl,route=>route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'Unavailable in isolated test'})}));
    await choose(page,'Debrecen');
    await page.locator('[data-provider-location-retry]').waitFor({state:'visible'});
    assert.equal(await page.locator('.reader-provider-card').count(),0,'No old city cards remain after selection failure');
    assert((await page.locator('.reader-body').textContent()).includes('Az érzéseink megismerése'));
    await page.unroute(apiUrl);
    await page.getByRole('button',{name:'Újrapróbálom',exact:true}).click(); await loaded(page,'Debrecen');

    // Slow older city responses must never replace a later choice.
    await page.route(apiUrl,async route=>{
      if(route.request().postDataJSON()?.city==='debrecen') { await delay(1500); }
      await route.continue().catch(()=>{});
    });
    await choose(page,'Debrecen');
    await choose(page,'Budapest'); await loaded(page,'Budapest');
    await delay(1700);
    assert.equal(await page.locator('[data-provider-location-name]').textContent(),'Budapest');
    assert.equal(await page.locator('[href="/szolgaltato/debrecen-szemelyes"]').count(),0);
    assert.equal(decodeURIComponent((await ctx.cookies()).find(cookie=>cookie.name===COOKIE_NAME).value),'1|budapest|manual','A stale response cannot replace the server-rendered city preference');
    await page.unroute(apiUrl);

    await page.setViewportSize({width:390,height:844});
    const mobile=await Promise.all([page.locator('.reader-margin--providers').boundingBox(),page.locator('.reader-content').boundingBox()]);
    assert(mobile[0].y>=mobile[1].y+mobile[1].height-1,'Mobile recommendations remain after article text');
    await screenshot(page,'geo-providers-mobile');
    await page.locator('[data-provider-city-picker] summary').click();
    await page.locator('#provider-city-query').fill('Budapest');
    await page.getByRole('button',{name:'Budapest kiválasztása',exact:true}).waitFor({state:'visible'});
    await screenshot(page,'geo-providers-mobile-picker');
    await page.setViewportSize({width:320,height:740}); await screenshot(page,'geo-providers-320');
    await page.locator('#provider-city-query').press('Escape');
    assert(!(await page.locator('[data-provider-city-picker]').evaluate(node=>node.open)),'Escape closes city editor');

    const unknownContext=await context();
    const unknown=await unknownContext.newPage();
    await unknown.goto(app.base+articlePath,{waitUntil:'networkidle'});
    assert.equal(await unknown.locator('[data-provider-location-name]').textContent(),'Válassz települést');
    assert.equal(await unknown.locator('.reader-provider-card').count(),2);
    assert.equal(await unknown.locator('.reader-provider-match').count(),2,'Unknown reader gets online-only matches');
    assert.equal(await unknown.locator('[href="/szolgaltato/debrecen-szemelyes"]').count(),0);
    assert.equal(await stored(unknown),null);
    await screenshot(unknown,'geo-providers-unknown');

    const deniedContext=await context();
    await deniedContext.addInitScript(()=>{
      window.__deniedCalls=0;
      navigator.geolocation.getCurrentPosition=(_success,error)=>{window.__deniedCalls++;error({code:1});};
    });
    const denied=await deniedContext.newPage();
    await denied.goto(app.base+articlePath,{waitUntil:'networkidle'});
    assert.equal(await denied.evaluate(()=>window.__deniedCalls),0);
    await denied.getByRole('button',{name:'Helyzetem használata',exact:true}).click();
    await until(async()=>(await denied.locator('[data-provider-location-status]').textContent()).includes('nem engedélyezett'),'permission denial message');
    assert.equal(await denied.evaluate(()=>window.__deniedCalls),1);
    assert.equal(await denied.locator('.reader-provider-card').count(),2,'Permission denial retains safe online recommendations');
    await choose(denied,'Budapest'); await loaded(denied,'Budapest');

    const noStorage=await context();
    await noStorage.addInitScript(()=>{
      Storage.prototype.getItem=()=>{throw new DOMException('Unavailable','SecurityError');};
      Storage.prototype.setItem=()=>{throw new DOMException('Unavailable','SecurityError');};
      Storage.prototype.removeItem=()=>{throw new DOMException('Unavailable','SecurityError');};
    });
    const blocked=await noStorage.newPage();
    await blocked.goto(app.base+articlePath,{waitUntil:'networkidle'});
    await choose(blocked,'Debrecen'); await loaded(blocked,'Debrecen');
    assert((await blocked.locator('.reader-body').textContent()).includes('Az érzéseink megismerése'),'Unavailable storage does not break article or selection');

    const noJs=await context({javaScriptEnabled:false});
    const staticPage=await noJs.newPage();
    await staticPage.goto(app.base+articlePath,{waitUntil:'networkidle'});
    assert.equal(await staticPage.locator('.reader-provider-card').count(),2,'Server-rendered online results work without JavaScript');
    assert(!(await staticPage.locator('[data-provider-location-controls]').isVisible()),'Unavailable interactive controls stay hidden without JavaScript');
    assert((await staticPage.locator('.reader-body').textContent()).includes('Az érzéseink megismerése'));
    assert.deepEqual(errors,[],'No uncaught browser JavaScript errors');
    assert.deepEqual(outside,[],'No outside network requests');
    console.log('Geographic provider browser checks passed: real routes/PG; automatic/manual/browser/reset; keyboard; privacy; slow/error states; denied location; unavailable storage; no-JS; desktop/mobile/320px.');
  } finally { if(browser)await browser.close(); await app.close(); }
})().catch(error=>{console.error(error);process.exitCode=1;});
