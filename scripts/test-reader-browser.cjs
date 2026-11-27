'use strict';

// This exercises the real application only in a disposable local PostgreSQL schema.
// Mail credentials are cleared. Invitation/reset tokens are read from the encrypted
// test outbox; no email transport is configured or called.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const {spawn} = require('node:child_process');
const {once} = require('node:events');
const {Pool} = require('pg');
const {createContactService} = require('../lib/contact-inquiries.cjs');
const {chromium} = require(process.env.BROWSER_TOOLS || 'playwright');

assert(process.env.TEST_DATABASE_URL, 'TEST_DATABASE_URL must identify a disposable local test database');
const database = new URL(process.env.TEST_DATABASE_URL);
assert(['postgres:', 'postgresql:'].includes(database.protocol) &&
  ['127.0.0.1', 'localhost', '[::1]'].includes(database.hostname) && /test/i.test(database.pathname),
  'A disposable loopback PostgreSQL test database is required');
for (const key of ['options', 'ssl', 'sslmode', 'sslcert', 'sslkey', 'sslrootcert']) database.searchParams.delete(key);
const schema = 'reader_browser_test_' + crypto.randomBytes(8).toString('hex');
const connectionString = database.toString();
const control = new Pool({connectionString, ssl:false, connectionTimeoutMillis:5000});
const db = new Pool({connectionString, ssl:false, options:'-c search_path=' + schema, connectionTimeoutMillis:5000});
database.searchParams.set('options', '-c search_path=' + schema);
const root = path.resolve(__dirname, '..');
const artifacts = path.join(root, 'test-artifacts');
const secret = crypto.randomBytes(48).toString('hex');
const dataKey = crypto.randomBytes(48).toString('hex');
const adminPassword = crypto.randomBytes(24).toString('hex');
const providerPassword = 'Isolated-provider-' + crypto.randomBytes(12).toString('hex');
const resetPassword = 'Isolated-reset-' + crypto.randomBytes(12).toString('hex');
const changedPassword = 'Isolated-changed-' + crypto.randomBytes(12).toString('hex');
const suffix = crypto.randomBytes(6).toString('hex');
const providerEmail = 'reader-' + suffix + '@example.test';
const applicantName = 'Böngészős teszt szolgáltató ' + suffix;
const contactName = 'Teszt Jelentkező';
const description = 'Kizárólag elszigetelt böngészős ellenőrzéshez készült tesztadatlap. Nem valós szolgáltató, nem fogad megkereséseket.';
const shortDescription = 'Elszigetelt tesztadatlap a szolgáltatói jelentkezés és a katalógus ellenőrzéséhez.';
const unsealer = createContactService({pool:db, auth:()=>{}, dbState:{ready:true}, env:{CMS_JWT_SECRET:secret, CONTACT_DATA_KEY:dataKey}});
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const errors = [], requests = [], tokens = [], pages = [], layoutFailures = [];
let child, browser, base, output = '', schemaCreated = false;

async function until(check, label, timeout = 15000) {
  const end = Date.now() + timeout;
  do { if (await check()) return; await wait(100); } while (Date.now() < end);
  throw new Error('Timed out: ' + label);
}
async function freePort() {
  const listener = net.createServer();
  await new Promise((resolve, reject) => { listener.once('error', reject); listener.listen(0, '127.0.0.1', resolve); });
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  return port;
}
async function getJson(context, route, status = 200) {
  const response = await context.request.get(base + route);
  assert.equal(response.status(), status, route);
  return response.json();
}
async function writeApi(context, route, data, {method='POST', status=200, admin=false} = {}) {
  const session = await getJson(context, admin ? '/api/admin/directory/submissions/session' : '/api/account/session');
  const response = await context.request.fetch(base + route, {method, data,
    headers:{Origin:base, 'X-Provider-CSRF':session.csrf_token}});
  const result = await response.json();
  assert.equal(response.status(), status, route + ': ' + (result.error || ''));
  return result;
}
async function perform(page, method, route, action, status = 200, {readBody = true} = {}) {
  const pending = page.waitForResponse(response => response.url() === base + route && response.request().method() === method);
  const [response] = await Promise.all([pending, action()]);
  // Successful auth writes navigate immediately; Chromium may release the old
  // document's response body before Playwright reads it. Those callers verify
  // the destination and session separately, while all other replies stay strict.
  const result = readBody ? await response.json() : null;
  assert.equal(response.status(), status, route + ': ' + (result?.error || ''));
  return result;
}
async function newContext(options = {}) {
  const context = await browser.newContext({viewport:{width:1440, height:1080}, reducedMotion:'reduce', ...options});
  context.setDefaultTimeout(15000);
  context.on('page', page => { pages.push(page); page.on('pageerror', error => errors.push(error.message)); });
  context.on('request', request => requests.push({url:request.url(), referer:request.headers().referer || ''}));
  // All required fonts/assets are local. Prevent accidental outbound browser calls.
  await context.route('**/*', route => new URL(route.request().url()).origin === base ? route.continue() : route.abort());
  return context;
}
async function noOverflow(page) {
  const dimensions = await page.evaluate(() => ({documentWidth:document.documentElement.scrollWidth, viewportWidth:innerWidth}));
  if (dimensions.documentWidth > dimensions.viewportWidth + 1) {
    layoutFailures.push({path:new URL(page.url()).pathname, ...dimensions});
  }
}
async function screenshot(page, name, target = null) {
  await page.evaluate(async () => { await document.fonts.ready; });
  if (target) await page.locator(target).scrollIntoViewIfNeeded();
  else await page.evaluate(() => window.scrollTo(0, 0));
  await noOverflow(page);
  await page.screenshot({path:path.join(artifacts, name + '.png')});
}
async function latestMail(email, kind) {
  let mail;
  await until(async () => {
    mail = (await db.query(`SELECT m.* FROM provider_account_mail m JOIN provider_accounts a ON a.id=m.account_id
      WHERE a.email=$1 AND m.kind=$2 ORDER BY m.created_at DESC,m.id DESC LIMIT 1`, [email, kind])).rows[0];
    return !!mail;
  }, kind + ' mail queued');
  assert.equal(mail.delivery_status, 'needs_mail', 'Missing mail setup is recorded truthfully');
  assert.equal(mail.attempts, 0, 'No transport attempt without mail setup');
  assert(mail.payload_ciphertext && !mail.payload_ciphertext.includes(email) && !mail.payload_ciphertext.includes('#token='), 'Outbox payload is encrypted');
  return mail;
}
function tokenFromMail(mail, expectedPath, expectedEmail) {
  const payload = unsealer.unseal(mail.payload_ciphertext);
  assert.equal(payload.to, expectedEmail);
  const match = /https?:\/\/[^\s<>]+#token=([A-Za-z0-9_-]{43})/.exec(payload.text);
  assert(match, 'Mail contains a fragment-only account link');
  const url = new URL(match[0]);
  assert.equal(url.origin, base, 'Test invitation stays on the local server');
  assert.equal(url.pathname, expectedPath);
  assert.equal(url.searchParams.has('token'),false,'Tokens are never query parameters');
  tokens.push(match[1]);
  return match[1];
}
async function activate(page, token, email, password) {
  await page.goto(base + '/regisztracio#token=' + token, {waitUntil:'networkidle'});
  await page.locator('#providerActivationForm').waitFor({state:'visible'});
  assert.equal(new URL(page.url()).hash, '', 'Invitation fragment is removed immediately');
  assert.equal(await page.locator('#providerActivationEmail').inputValue(), email);
  assert(await page.locator('#providerActivationEmail').evaluate(input => input.readOnly));
  assert.equal(await page.locator('#providerActivationConsent').isChecked(), false, 'Consent is an explicit applicant action');
  await page.locator('#providerActivationPassword').fill(password);
  await page.locator('#providerActivationConfirm').fill(password);
  await page.locator('#providerActivationConsent').check();
  await perform(page, 'POST', '/api/account/activate', () => page.locator('#providerActivationForm button[type="submit"]').click(), 200, {readBody:false});
  await page.waitForURL(url=>url.origin===base&&url.pathname==='/fiokom');
  await page.locator('#providerAccountBody').waitFor({state:'visible'});
}
async function saveProfile(page, action) {
  const selector = action === 'unpublish' ? '#providerUnpublish' : '#providerProfileForm button[value="' + action + '"]';
  const result = await perform(page, 'PUT', '/api/account/provider-profile', () => page.locator(selector).click());
  await until(async () => await page.locator('#providerProfileForm').getAttribute('aria-busy') === 'false', 'profile save rendered');
  assert.equal(await page.locator('#providerProfileMessage.is-error').count(), 0);
  return result;
}
async function fillProfile(page, name, category) {
  const values = {name, short_description:shortDescription, description, city:'Budapest', county:'Budapest',
    address:'Teszt utca 1.', website_url:'https://example.test', booking_url:'https://example.test/idopont',
    phone:'+36 20 555 0101', qualifications:'Kizárólag teszteléshez rögzített adat.', specialties:'Böngészős folyamatellenőrzés',
    languages:'Magyar', price_info:'Tesztadat; nincs valós díjszabás.'};
  for (const [key, value] of Object.entries(values)) await page.locator('#providerProfile_' + key).fill(value);
  await page.locator('#providerProfile_online_available').check();
  for (const selected of await page.locator('#providerCategoryChoices input:checked').all()) await selected.uncheck();
  await page.locator('#providerCategoryChoices input[value="' + category + '"]').check();
}
async function providerLogin(page, email, password) {
  await page.goto(base + '/belepes?next=%2Ffiokom%3Fszolgaltato%3D1', {waitUntil:'networkidle'});
  await page.locator('#providerLoginForm').waitFor({state:'visible'});
  await page.locator('#providerLoginEmail').fill(email);
  await page.locator('#providerLoginPassword').fill(password);
  await perform(page, 'POST', '/api/account/login', () => page.locator('#providerLoginForm button[type="submit"]').click(), 200, {readBody:false});
  await page.waitForURL(url=>url.origin===base&&url.pathname==='/fiokom');
  await page.locator('#providerAccountBody').waitFor({state:'visible'});
}

async function main() {
  await control.query('CREATE SCHEMA ' + schema);schemaCreated=true;
  base='http://127.0.0.1:'+await freePort();
  const env={...process.env,DATABASE_URL:database.toString(),PGSSLMODE:'disable',PGSSLROOTCERT:'',DATABASE_CA_CERT:'',
    PGOPTIONS:'-c search_path='+schema,PORT:new URL(base).port,NODE_ENV:'test',MENTAL_PUBLIC_URL:base,
    CMS_JWT_SECRET:secret,CONTACT_DATA_KEY:dataKey,CMS_ADMIN_EMAIL:'admin@example.test',CMS_ADMIN_PASSWORD:adminPassword,
    CMS_ADMIN_PASSWORD_HASH:'',SMTP_HOST:'',SMTP_USER:'',SMTP_PASSWORD:'',SMTP_FROM:'',SMTP_URL:'',RESEND_API_KEY:'',BREVO_API_KEY:'',CONTACT_FROM_EMAIL:'',MAIL_FROM:''};
  child=spawn(process.execPath,['server.js'],{cwd:root,env,stdio:['ignore','pipe','pipe']});
  const collect=value=>{output=(output+value).slice(-160000);};child.stdout.on('data',collect);child.stderr.on('data',collect);child.on('error',error=>collect(error.message));
  await until(async()=>{assert.equal(child.exitCode,null,'The local test server exited');try{return(await fetch(base+'/health/ready',{signal:AbortSignal.timeout(2000)})).ok;}catch{return false;}},'real server migrations',60000);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM directory_contact_settings')).rows[0].n,0);
  const fixture=(await db.query(`INSERT INTO directory_listings(slug,name,kind,description,short_description,city,status,published_at)
    VALUES($1,$2,'provider',$3,$4,'Budapest','published',now()) RETURNING id,slug`,['reader-rating-'+suffix,'Olvasói értékelés teszt szolgáltató '+suffix,description,shortDescription])).rows[0];
  const providerPath='/szolgaltato/'+fixture.slug,returnPath=providerPath+'#ertekelesek';
  fs.mkdirSync(artifacts,{recursive:true});browser=await chromium.launch({headless:true});
  const reader=await newContext(),page=await reader.newPage();

  // The same general account registration is visible at both responsive breakpoints.
  await page.goto(base+'/',{waitUntil:'networkidle'});
  assert.equal(await page.locator('#submitForm').count(),0,'No separate anonymous catalog application remains');
  assert(await page.locator('.header-account-links [data-account-login]').isVisible());
  assert(await page.locator('.header-account-links [data-account-register]').isVisible());
  const sessionsBefore=requests.filter(request=>new URL(request.url).pathname==='/api/account/session').length;
  await page.evaluate(()=>Promise.all([window.MentalAccount.session(true),window.MentalAccount.session(true),window.MentalAccount.session(true)]));
  assert.equal(requests.filter(request=>new URL(request.url).pathname==='/api/account/session').length-sessionsBefore,1,'Concurrent forced session checks share one CSRF seed request');
  assert.deepEqual(await page.evaluate(()=>['/fiokom/ugyfelek','/fiokom/ugyfelek?kontakt=1','/fiokom/ugyfelek#kapcsolatok','//outside.example/fiokom/ugyfelek'].map(value=>window.MentalAccount.safeNext(value))),['/fiokom/ugyfelek','/fiokom','/fiokom','/fiokom']);
  const crmLogin=await reader.newPage();
  await crmLogin.goto(base+'/belepes?next=%2Ffiokom%2Fugyfelek',{waitUntil:'networkidle'});
  assert.equal(new URL(await crmLogin.locator('a.provider-form-link').getAttribute('href'),base).searchParams.get('next'),'/fiokom/ugyfelek');
  await crmLogin.locator('a.provider-form-link').click();await crmLogin.locator('#providerForgotForm').waitFor({state:'visible'});
  assert.equal(new URL(await crmLogin.locator('#providerForgotForm a').getAttribute('href'),base).searchParams.get('next'),'/fiokom/ugyfelek');
  await crmLogin.close();
  await page.setViewportSize({width:390,height:844});
  assert(await page.locator('.header-account-links [data-account-login]').isVisible(),'Mobile login is visible without opening the menu');
  assert(await page.locator('.header-account-links [data-account-register]').isVisible(),'Mobile registration is visible without opening the menu');
  await screenshot(page,'reader-home-mobile');
  await page.setViewportSize({width:1440,height:1080});
  await writeApi(reader,'/api/directory/submit',{name:'Blocked anonymous fixture',email:providerEmail,description,consent:true},{status:401});

  // Scores, counts, authors and controls are absent from public HTML and APIs.
  const publicHtml=await (await reader.request.get(base+providerPath)).text();
  assert(publicHtml.includes('data-service-ratings'));
  assert(!/aggregateRating|ratingValue|reviewCount|class="service-ratings-average"|name="service_rating"/.test(publicHtml));
  await getJson(reader,'/api/ratings/'+fixture.slug,401);
  await page.goto(base+providerPath,{waitUntil:'networkidle'});
  assert(await page.locator('[data-ratings-guest]').isVisible());
  assert.equal(await page.locator('[data-ratings-content]').textContent(),'');
  const registrationLink=page.locator('[data-ratings-guest] a[href^="/regisztracio"]');
  assert.equal(new URL(await registrationLink.getAttribute('href'),base).searchParams.get('next'),returnPath);
  await registrationLink.click();await page.locator('#providerRegisterForm').waitFor({state:'visible'});
  assert.equal(await page.locator('#providerHeading').textContent(),'Regisztráció');
  await page.locator('#providerRegisterName').fill('Teszt Olvasó '+suffix);await page.locator('#providerRegisterEmail').fill(providerEmail);await page.locator('#providerRegisterConsent').check();
  await perform(page,'POST','/api/account/register',()=>page.locator('#providerRegisterForm button[type="submit"]').click(),202);
  const setup=await latestMail(providerEmail,'setup');
  const setupEnvelope=unsealer.unseal(setup.payload_ciphertext),setupLink=/https?:\/\/[^\s<>]+#token=([A-Za-z0-9_-]{43})/.exec(setupEnvelope.text);
  assert(setupLink);tokens.push(setupLink[1]);const setupUrl=new URL(setupLink[0]);
  assert.equal(setupUrl.searchParams.get('next'),returnPath,'Email preserves the safe provider destination');
  await page.goto(setupUrl.href,{waitUntil:'networkidle'});await page.locator('#providerActivationForm').waitFor({state:'visible'});
  assert.equal((await getJson(reader,'/api/account/session')).authenticated,false,'Opening the email link alone does not activate the account');
  assert.equal(new URL(page.url()).hash,'');
  await page.locator('#providerActivationPassword').fill(providerPassword);await page.locator('#providerActivationConfirm').fill(providerPassword);await page.locator('#providerActivationConsent').check();
  await perform(page,'POST','/api/account/activate',()=>page.locator('#providerActivationForm button[type="submit"]').click(),200,{readBody:false});
  await page.waitForURL(base+returnPath);await page.locator('[data-rating-form]').waitFor({state:'visible'});
  const initial=await getJson(reader,'/api/account/session');assert(initial.authenticated&&initial.user.email_verified);assert.equal(initial.user.is_provider,false);
  assert.equal(await page.locator('.header-account-links [data-account-login]').textContent(),'Fiókom');
  assert.equal(await page.locator('.header-account-links [data-account-register]').isVisible(),false);

  // A rating is a single mutable user/provider vote; private result updates in the UI.
  await page.locator('input[name="service_rating"][value="4"]').check();
  await perform(page,'PUT','/api/ratings/'+fixture.slug,()=>page.locator('[data-rating-save]').click());
  let rating=await getJson(reader,'/api/ratings/'+fixture.slug);assert.equal(rating.count,1);assert.equal(Number(rating.average),4);assert.equal(rating.my_rating.score,4);
  await page.locator('input[name="service_rating"][value="2"]').check();
  await perform(page,'PUT','/api/ratings/'+fixture.slug,()=>page.locator('[data-rating-save]').click());
  rating=await getJson(reader,'/api/ratings/'+fixture.slug);assert.equal(rating.count,1);assert.equal(Number(rating.average),2);assert.equal(rating.my_rating.score,2);
  await screenshot(page,'reader-rating-desktop','#ertekelesek');await page.setViewportSize({width:390,height:844});await screenshot(page,'reader-rating-mobile','#ertekelesek');await page.setViewportSize({width:1440,height:1080});
  await perform(page,'DELETE','/api/ratings/'+fixture.slug,()=>page.locator('[data-rating-delete]').click());
  rating=await getJson(reader,'/api/ratings/'+fixture.slug);assert.equal(rating.count,0);assert.equal(rating.my_rating,null);

  // A parsed mutation response must not repaint scores after a logout event.
  for(const method of ['PUT','DELETE']){
    if(method==='PUT')await page.locator('input[name="service_rating"][value="3"]').check();
    await page.evaluate(({method,path})=>{
      const originalFetch=window.fetch;
      window.fetch=async(input,options={})=>{
        const response=await originalFetch(input,options);
        if(String(input)===path&&options.method===method&&response.ok){
          const readJson=response.json.bind(response);
          response.json=async()=>{const result=await readJson();window.fetch=originalFetch;window.dispatchEvent(new CustomEvent('mental-account-change',{detail:{authenticated:false}}));window.ratingGateParsed=method;return result;};
        }
        return response;
      };
    },{method,path:'/api/ratings/'+fixture.slug});
    await perform(page,method,'/api/ratings/'+fixture.slug,()=>page.locator(method==='PUT'?'[data-rating-save]':'[data-rating-delete]').click());
    await page.waitForFunction(method=>window.ratingGateParsed===method,method);
    await page.evaluate(()=>new Promise(resolve=>setTimeout(resolve,0)));
    assert.equal(await page.locator('[data-ratings-content]').textContent(),'','A stale '+method+' response cannot restore private scores');
    assert(await page.locator('[data-ratings-guest]').isVisible());
    await page.reload({waitUntil:'networkidle'});await page.locator('[data-rating-form]').waitFor({state:'visible'});
  }
  rating=await getJson(reader,'/api/ratings/'+fixture.slug);assert.equal(rating.count,0);
  await page.route('**/api/account/session',route=>route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'Test session unavailable'})}));
  await page.evaluate(()=>document.dispatchEvent(new Event('visibilitychange')));
  await page.locator('[data-ratings-retry]').waitFor({state:'visible'});
  assert.equal(await page.locator('[data-ratings-content]').textContent(),'','Failed session revalidation erases private scores');
  assert(await page.locator('[data-ratings-guest]').isVisible());
  await page.unroute('**/api/account/session');await page.locator('[data-ratings-retry]').click();await page.locator('[data-rating-form]').waitFor({state:'visible'});
  const stranger=await newContext();await getJson(stranger,'/api/ratings/'+fixture.slug,401);

  // Merely opening a reader account never creates an unsolicited provider profile.
  await page.goto(base+'/fiokom',{waitUntil:'networkidle'});await page.locator('#readerDashboard').waitFor({state:'visible'});
  assert.equal(await page.locator('#providerProfileWorkspace').isVisible(),false);assert.equal(await page.locator('#providerCrmCard').isVisible(),false);
  assert(await page.locator('#providerStart').isVisible());
  assert.equal((await db.query('SELECT count(*)::int AS n FROM provider_listing_owners WHERE account_id=$1',[initial.user.id])).rows[0].n,0);
  await writeApi(reader,'/api/directory/submit',{name:'Blocked reader fixture',email:providerEmail,description,consent:true},{status:403});
  await screenshot(page,'reader-account-desktop');await page.setViewportSize({width:390,height:844});await screenshot(page,'reader-account-mobile');await page.setViewportSize({width:1440,height:1080});

  // Ordinary-reader forgot-password uses the same verified email and revokes sessions.
  const resetContext=await newContext(),resetPage=await resetContext.newPage();
  await resetPage.goto(base+'/elfelejtett-jelszo?next='+encodeURIComponent(returnPath),{waitUntil:'networkidle'});
  await resetPage.locator('#providerForgotEmail').fill(providerEmail);
  await perform(resetPage,'POST','/api/account/forgot-password',()=>resetPage.locator('#providerForgotForm button[type="submit"]').click(),202);
  const reset=await latestMail(providerEmail,'reset'),resetEnvelope=unsealer.unseal(reset.payload_ciphertext);
  const resetMatch=/https?:\/\/[^\s<>]+#token=([A-Za-z0-9_-]{43})/.exec(resetEnvelope.text);assert(resetMatch);tokens.push(resetMatch[1]);
  await resetPage.goto(resetMatch[0],{waitUntil:'networkidle'});await resetPage.locator('#providerResetForm').waitFor({state:'visible'});
  await resetPage.locator('#providerResetPassword').fill(resetPassword);await resetPage.locator('#providerResetConfirm').fill(resetPassword);
  await perform(resetPage,'POST','/api/account/reset-password',()=>resetPage.locator('#providerResetForm button[type="submit"]').click());
  assert.equal((await getJson(reader,'/api/account/session')).authenticated,false,'Reset revoked the previous reader session');
  await resetPage.locator('#providerResetResult a').click();await resetPage.locator('#providerLoginForm').waitFor({state:'visible'});
  assert.equal(new URL(resetPage.url()).searchParams.get('next'),returnPath);
  await resetPage.locator('#providerLoginEmail').fill(providerEmail);await resetPage.locator('#providerLoginPassword').fill(resetPassword);
  await perform(resetPage,'POST','/api/account/login',()=>resetPage.locator('#providerLoginForm button[type="submit"]').click(),200,{readBody:false});
  await resetPage.waitForURL(base+returnPath);await resetPage.locator('[data-rating-form]').waitFor({state:'visible'});

  // One explicit upgrade adds professional tools to the very same reader account.
  await resetPage.goto(base+'/fiokom?szolgaltato=1',{waitUntil:'networkidle'});await resetPage.locator('#providerStart').waitFor({state:'visible'});
  await perform(resetPage,'POST','/api/account/provider-profile/start',()=>resetPage.locator('#providerStart').click());
  await resetPage.locator('#providerProfileWorkspace').waitFor({state:'visible'});
  const upgraded=await getJson(resetContext,'/api/account/session');assert.equal(String(upgraded.user.id),String(initial.user.id));assert.equal(upgraded.user.is_provider,true);
  assert(await resetPage.locator('#providerCrmLink').isVisible(),'CRM is available as soon as professional mode is enabled');
  const legacy=await writeApi(resetContext,'/api/directory/submit',{},{status:410});assert.equal(legacy.code,'PROFILE_APPLICATION_REQUIRED');
  const categories=await getJson(resetContext,'/api/public/categories');const category=categories.find(item=>item.slug==='pszichologusok')||categories[0];
  await fillProfile(resetPage,'Olvasóból szolgáltató '+suffix,category.slug);
  const submitted=await saveProfile(resetPage,'submit');assert.equal(submitted.listing.status,'pending');
  assert.equal((await db.query('SELECT provider_account_id FROM directory_submissions WHERE provider_account_id=$1',[initial.user.id])).rowCount,1);
  const owned=submitted.listing;
  // A published owned fixture isolates the self-rating rule; moderation itself is
  // exercised by test-provider-browser.cjs rather than bypassed in the real app.
  await db.query("UPDATE directory_listings SET status='published',published_at=now() WHERE id=$1",[owned.id]);
  await resetPage.goto(base+'/szolgaltato/'+owned.slug,{waitUntil:'networkidle'});await resetPage.locator('.service-rating-own').waitFor({state:'visible'});
  assert.equal(await resetPage.locator('[data-rating-form]').count(),0);
  const own=await getJson(resetContext,'/api/ratings/'+owned.slug);assert.equal(own.can_rate,false);
  await writeApi(resetContext,'/api/ratings/'+owned.slug,{score:5},{method:'PUT',status:403});
  await resetPage.goto(base+'/fiokom',{waitUntil:'networkidle'});await resetPage.locator('#readerDashboard').waitFor({state:'visible'});
  assert(await resetPage.locator('#providerEditorLink').isVisible());assert(await resetPage.locator('#providerCrmCard').isVisible());
  assert.equal(await resetPage.locator('#providerStart').isVisible(),false);

  // A non-relative redirect can never escape the account flow.
  await perform(resetPage,'POST','/api/account/logout',()=>resetPage.locator('[data-provider-logout]').click(),200,{readBody:false});
  await resetPage.waitForURL(url=>url.pathname==='/belepes');
  await resetPage.goto(base+'/belepes?next='+encodeURIComponent('https://outside.example/'),{waitUntil:'networkidle'});
  await resetPage.locator('#providerLoginEmail').fill(providerEmail);await resetPage.locator('#providerLoginPassword').fill(resetPassword);
  await perform(resetPage,'POST','/api/account/login',()=>resetPage.locator('#providerLoginForm button[type="submit"]').click(),200,{readBody:false});
  await resetPage.waitForURL(base+'/fiokom');
  for(const request of requests)assert(!tokens.some(token=>request.url.includes(token)||request.referer.includes(token)),'No secret capability in a URL or referrer');
  for(const openPage of pages.filter(item=>!item.isClosed())){
    const storage=await openPage.evaluate(()=>JSON.stringify({local:{...localStorage},session:{...sessionStorage}}));
    assert(!tokens.some(token=>storage.includes(token))&&!storage.includes(providerPassword)&&!storage.includes(resetPassword));
  }
  assert.equal((await db.query("SELECT count(*)::int AS n FROM provider_account_mail WHERE attempts>0 OR delivery_status IN ('sending','accepted')")).rows[0].n,0);
  assert.deepEqual(errors,[]);assert.deepEqual(layoutFailures,[]);
  console.log('READER_BROWSER_OK',JSON.stringify({unifiedRegistration:true,visibleMobileAuth:true,readerVerifiedLogin:true,returnToProvider:true,privateRatings:true,createUpdateDeleteRating:true,staleRatingResponsesDiscarded:true,failedSessionErasesRatings:true,ordinaryReaderReset:true,explicitProviderUpgrade:true,sameAccount:true,crmProviderNavigation:true,crmReturnPath:true,selfRatingBlocked:true,legacyAnonymousApplicationDisabled:true,safeRedirects:true,noTokenStorage:true,realEmails:0}));
}
main().catch(async error=>{console.error(error.stack);fs.mkdirSync(artifacts,{recursive:true});for(let i=0;i<pages.length;i++)if(!pages[i].isClosed())await pages[i].screenshot({path:path.join(artifacts,'reader-failure-'+i+'.png')}).catch(()=>{});console.error(output);process.exitCode=1;}).finally(async()=>{
  if(browser)await browser.close().catch(()=>{});
  if(child&&child.exitCode===null){const done=once(child,'exit').catch(()=>{});child.kill('SIGTERM');await Promise.race([done,wait(2000)]);if(child.exitCode===null){child.kill('SIGKILL');await Promise.race([done,wait(2000)]);}}
  await db.end();if(schemaCreated)await control.query('DROP SCHEMA '+schema+' CASCADE');await control.end();
});
