'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {spawn} = require('node:child_process');
const {once} = require('node:events');
const {Pool} = require('pg');
const {buildDatabaseConfig} = require('../lib/database-config.cjs');
const {chromium} = require(process.env.BROWSER_TOOLS || 'playwright');
const root = path.resolve(__dirname, '..');
const database = new URL(process.env.DATABASE_URL || 'http://invalid');
assert(['127.0.0.1','localhost'].includes(database.hostname) && /test/.test(database.pathname), 'Disposable local test database required');
const pool = new Pool(buildDatabaseConfig());
const base = 'http://127.0.0.1:18084';
const secret = crypto.randomBytes(48).toString('hex');
const password = crypto.randomBytes(24).toString('hex');
const wait = ms => new Promise(r=>setTimeout(r,ms));
let server, browser, output = '', session = '', draftId;
const ids = [];
const req = (url,options={}) => fetch(base+url,{...options,signal:AbortSignal.timeout(20000)});
async function json(url,options={}) { const response = await req(url,options); assert.equal(response.status,200,url+' '+output); return response.json(); }
async function page(url,options={}) { const response = await req(url,options); assert.equal(response.status,200,url+' '+output); return response.text(); }
const apiOptions = (method,data) => ({method,headers:{'Content-Type':'application/json',Cookie:session},body:JSON.stringify(data)});
const articleClassCount = (markup, className) => [...markup.matchAll(/<article\b[^>]*class="([^"]*)"/g)].filter(match=>match[1].split(/\s+/).includes(className)).length;

async function start() {
  server = spawn(process.execPath,['server.js'],{cwd:root,env:{...process.env,PORT:'18084',NODE_ENV:'test',CMS_JWT_SECRET:secret,CMS_ADMIN_EMAIL:'admin@example.test',CMS_ADMIN_PASSWORD:password},stdio:['ignore','pipe','pipe']});
  server.stdout.on('data',x=>output+=x); server.stderr.on('data',x=>output+=x);
  for (let i=0;i<100;i++) { assert.equal(server.exitCode,null,output); try { if((await req('/health/ready')).ok) return; } catch {} await wait(200); }
  throw new Error('Server did not become ready: '+output);
}
async function stop() {
  if(server && server.exitCode === null) { const done=once(server,'exit');server.kill('SIGTERM');await Promise.race([done,wait(2000)]);if(server.exitCode===null)server.kill('SIGKILL'); }
}

(async()=>{
  await start();
  const initial = await json('/api/public/articles?paginated=true&limit=50');
  const legacyFiles = fs.readdirSync(path.join(root,'cikkek')).filter(x=>x.endsWith('.html'));
  const baselineTotal = initial.total;
  const legacyItems = JSON.parse(JSON.stringify((await pool.query("SELECT * FROM articles WHERE publication_origin='legacy' ORDER BY id")).rows)).map(require('../lib/public-articles.cjs').publicArticle);
  assert.equal(legacyItems.length,legacyFiles.length,'Every already published legacy article is imported');
  assert(baselineTotal>=legacyFiles.length);
  assert.equal(legacyItems.filter(a=>a.published_at).length,8,'Only original known dates are shown');
  assert(legacyItems.filter(a=>a.published_at).every(a=>a.published_at.startsWith('2026-09-10')),'Import must not manufacture freshness');
  assert(legacyItems.every(a=>a.hero_url.startsWith('/assets/')));
  const home = await page('/');
  const expectedHomeTotal=Math.min(baselineTotal,14), expectedFeatured=Math.min(baselineTotal,5), expectedLower=Math.max(0,expectedHomeTotal-expectedFeatured);
  assert.equal(articleClassCount(home,'story'),expectedHomeTotal);
  assert.equal(articleClassCount(home,'story-compact'),Math.max(0,expectedFeatured-1));
  assert.equal(articleClassCount(home,'article-card'),expectedLower);
  const homeOrder=[home.indexOf('id="friss-cikkek"'),home.search(/<form\b[^>]*action="\/kereses"/),home.indexOf('id="cikkek"'),home.indexOf('id="kategoriak"'),home.indexOf('id="tudastar"')];
  assert(homeOrder.every((position,index)=>position>=0 && (index===0 || position>homeOrder[index-1])),'Home order: cover, expert search, articles, categories, knowledge');
  assert(home.includes('href="/cikkek"'));
  const archive = await page('/cikkek');
  assert.equal(articleClassCount(archive,'story-grid'),Math.min(baselineTotal,12));
  const first = await json('/api/public/articles?paginated=true&limit=3');
  const second = await json('/api/public/articles?paginated=true&limit=3&page=2');
  assert.equal(second.page,2);assert.equal(second.items.length,3);
  assert(!second.items.some(a=>first.items.some(b=>a.id===b.id)));
  assert.equal((await json('/api/public/articles?limit=NaN')).length,Math.min(baselineTotal,12));
  const search = await json('/api/public/articles?paginated=true&q='+encodeURIComponent('szorongás'));
  assert(search.total>=1);
  assert((await page('/cikkek?q='+encodeURIComponent('szorongás'))).includes('A szorongás nem mindig látványos'));
  const allOld = legacyItems;
  for(const a of allOld) {
    const article=await page(a.url);assert(article.includes(a.title));assert(article.includes('href="/cikkek"'));
    const legacy=await req('/cikkek/'+a.slug+'.html',{redirect:'manual'});assert.equal(legacy.status,301);assert.equal(legacy.headers.get('location'),a.url);
  }
  assert.equal((await req('/content/approved-articles/unapproved.json')).status,404);
  assert.equal((await req('/docs/editorial-publishing.md')).status,404);
  assert.equal((await req('/api/admin/articles')).status,401);
  const login=await req('/api/admin/login',apiOptions('POST',{email:'admin@example.test',password}));assert.equal(login.status,200);
  session=login.headers.getSetCookie().map(c=>c.split(';')[0]).join('; ');
  const data={title:'CI cikk – csak izolált teszt',slug:'ci-editorial-only',category:'Kutatások',excerpt:'Izolált ellenőrzés, nem valódi kutatási eredmény.',content_html:'<p>Izolált tesztváltozat.</p><script>window.XSS=true</script>',author_name:'CI',status:'draft'};
  const create=await req('/api/admin/articles',apiOptions('POST',data));assert.equal(create.status,201);
  const draft=await create.json();draftId=draft.id;ids.push(draftId);assert.equal(draft.status,'draft');assert(!draft.content_html.includes('<script'));
  assert.equal((await req('/cikk/'+data.slug)).status,404);
  assert.equal((await req('/api/admin/articles/'+draftId+'/preview')).status,401);
  const preview=await req('/api/admin/articles/'+draftId+'/preview',{headers:{Cookie:session}});assert.equal(preview.status,200);assert(preview.headers.get('x-robots-tag').includes('noindex'));assert(preview.headers.get('cache-control').includes('no-store'));assert((await preview.text()).includes('Ez a piszkozat nem nyilvános.'));
  assert(!(await page('/')).includes(data.title));assert.equal((await json('/api/public/articles?paginated=true')).total,baselineTotal);
  const publish=await req('/api/admin/articles/'+draftId,apiOptions('PUT',{...data,status:'published'}));assert.equal(publish.status,200);
  assert.equal((await json('/api/public/articles?limit=1'))[0].id,draftId);
  assert((await page('/')).includes(data.title));assert((await page('/cikkek')).includes(data.title));assert((await page('/cikk/'+data.slug)).includes('Izolált tesztváltozat.'));
  const unpublish=await req('/api/admin/articles/'+draftId,apiOptions('PUT',data));assert.equal(unpublish.status,200);
  assert.equal((await req('/cikk/'+data.slug)).status,404);
  assert.equal((await req('/cikkek/'+data.slug+'.html')).status,404);
  assert(!(await page('/')).includes(data.title));

  browser=await chromium.launch({headless:true});
  const context=await browser.newContext({viewport:{width:1440,height:1000}});
  const browserPage=await context.newPage();const errors=[];
  browserPage.on('pageerror',e=>errors.push(e.message));
  fs.mkdirSync(path.join(root,'test-artifacts'),{recursive:true});
  await browserPage.goto(base+'/',{waitUntil:'networkidle'});
  await browserPage.locator('#cikkek').screenshot({path:'test-artifacts/articles-home-desktop.png'});
  assert.equal(await browserPage.locator('.home-editorial .story').count(),expectedLower);
  await browserPage.locator('.dir-nav').getByRole('link',{name:'Magazin',exact:true}).click();
  await browserPage.waitForURL('**/cikkek');
  await browserPage.screenshot({path:'test-artifacts/articles-index-desktop.png',fullPage:true});
  await browserPage.getByRole('searchbox').fill('szorongás');
  await browserPage.locator('.article-filters').getByRole('button').click();
  await browserPage.waitForURL('**/cikkek?*');
  assert(await browserPage.locator('.articles-grid .story').count()>=1);
  await browserPage.locator('.story-link').first().click();await browserPage.waitForURL('**/cikk/*');
  await browserPage.screenshot({path:'test-artifacts/article-desktop.png',fullPage:true});
  const mobile=await browser.newContext({viewport:{width:390,height:844},isMobile:true,deviceScaleFactor:1});
  const mp=await mobile.newPage();mp.on('pageerror',e=>errors.push(e.message));
  for(const route of ['/','/cikkek',allOld[0].url]) {
    await mp.goto(base+route,{waitUntil:'networkidle'});
    assert(await mp.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+1),'Mobile overflow '+route);
  }
  await mp.goto(base+'/',{waitUntil:'networkidle'});
  await mp.locator('#cikkek').screenshot({path:'test-artifacts/articles-home-mobile.png'});
  await mp.locator('.mobile-menu summary').click();
  await mp.locator('.mobile-menu').getByRole('link',{name:'Magazin',exact:true}).click();await mp.waitForURL('**/cikkek');
  await mp.screenshot({path:'test-artifacts/articles-index-mobile.png',fullPage:true});
  const authLogin=await context.request.post(base+'/api/admin/login',{data:{email:'admin@example.test',password}});assert.equal(authLogin.status(),200);
  await browserPage.goto(base+'/admin/',{waitUntil:'networkidle'});
  await browserPage.locator('[data-view=articles]').click();
  await browserPage.locator('#newArticleBtn').click();
  assert.equal(await browserPage.locator('#status').inputValue(),'draft');
  await browserPage.locator('#title').fill('CI böngészős piszkozat');
  await browserPage.locator('#excerpt').fill('Tesztkörnyezet.');
  await browserPage.locator('#contentHtml').fill('<p>Privát tesztpiszkozat.</p>');
  await browserPage.locator('#articleForm button[type=submit], #articleForm button.primary').last().click();
  await browserPage.locator('#editorMsg').filter({hasText:/mentve/i}).waitFor();
  const browserDraftId=await browserPage.locator('#articleId').inputValue();ids.push(browserDraftId);
  assert(browserDraftId);assert.equal((await json('/api/public/articles?paginated=true')).total,baselineTotal);
  assert.deepEqual(errors,[],'Browser JavaScript exceptions');
  await mobile.close();await context.close();await browser.close();browser=null;

  const original=allOld[0];
  await pool.query('UPDATE articles SET title=$1,status=$2 WHERE id=$3',[original.title+' CI-EDIT','draft',original.id]);
  await stop();await start();
  const edited=(await pool.query('SELECT title,status FROM articles WHERE id=$1',[original.id])).rows[0];
  assert.equal(edited.title,original.title+' CI-EDIT');assert.equal(edited.status,'draft');
  assert.equal((await req('/cikkek/'+original.slug+'.html')).status,404);
  assert.equal((await req('/cikkek//'+original.slug+'.html')).status,404,'Normalized static paths must not leak unpublished articles');
  await pool.query('UPDATE articles SET title=$1,status=$2 WHERE id=$3',[original.title,'published',original.id]);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM articles WHERE publication_origin='legacy'")).rows[0].n,legacyFiles.length);
  const report={ok:true,legacyArticles:legacyFiles.length,baselineTotal,originalDatesPreserved:true,serverRenderedHome:true,archiveSearch:true,pagination:true,draftHidden:true,privatePreview:true,publishUpdatesHome:true,unpublishHidesLegacyUrl:true,restartPreservesCmsEdits:true,desktopAndMobile:true,browserAdminDraftCreation:true,browserErrors:errors,realResearchArticlesPublished:0};
  fs.writeFileSync(path.join(root,'articles-test-report.json'),JSON.stringify(report,null,2));
  console.log('ARTICLE_TESTS_OK',JSON.stringify(report));
})().catch(error=>{console.error(error.stack);console.error(output);process.exitCode=1;}).finally(async()=>{
  if(browser)await browser.close();await stop();
  if(ids.length)await pool.query('DELETE FROM articles WHERE id=ANY($1::bigint[])',[ids]);
  await pool.end();
});
