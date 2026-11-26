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
const schema = 'provider_browser_test_' + crypto.randomBytes(8).toString('hex');
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
const providerEmail = 'provider-' + suffix + '@example.test';
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
  const session = await getJson(context, admin ? '/api/admin/directory/submissions/session' : '/api/provider/session');
  const response = await context.request.fetch(base + route, {method, data,
    headers:{Origin:base, 'X-Provider-CSRF':session.csrf_token}});
  const result = await response.json();
  assert.equal(response.status(), status, route + ': ' + (result.error || ''));
  return result;
}
async function perform(page, method, route, action, status = 200) {
  const pending = page.waitForResponse(response => response.url() === base + route && response.request().method() === method);
  const [response] = await Promise.all([pending, action()]);
  const result = await response.json();
  assert.equal(response.status(), status, route + ': ' + (result.error || ''));
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
  assert.equal(url.search, '', 'Tokens are never query parameters');
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
  await perform(page, 'POST', '/api/provider/activate', () => page.locator('#providerActivationForm button[type="submit"]').click());
  await page.waitForURL(base + '/fiokom');
  await page.locator('#providerAccountBody').waitFor({state:'visible'});
}
async function saveProfile(page, action) {
  const selector = action === 'unpublish' ? '#providerUnpublish' : '#providerProfileForm button[value="' + action + '"]';
  const result = await perform(page, 'PUT', '/api/provider/profile', () => page.locator(selector).click());
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
  await page.goto(base + '/belepes', {waitUntil:'networkidle'});
  await page.locator('#providerLoginForm').waitFor({state:'visible'});
  await page.locator('#providerLoginEmail').fill(email);
  await page.locator('#providerLoginPassword').fill(password);
  await perform(page, 'POST', '/api/provider/login', () => page.locator('#providerLoginForm button[type="submit"]').click());
  await page.waitForURL(base + '/fiokom');
  await page.locator('#providerAccountBody').waitFor({state:'visible'});
}

async function main() {
  await control.query('CREATE SCHEMA ' + schema); schemaCreated = true;
  assert.equal((await db.query('SELECT current_schema() AS name')).rows[0].name, schema);
  base = 'http://127.0.0.1:' + await freePort();
  const env = {...process.env, DATABASE_URL:database.toString(), PGSSLMODE:'disable', PGSSLROOTCERT:'', DATABASE_CA_CERT:'',
    PGOPTIONS:'-c search_path=' + schema, PORT:new URL(base).port, NODE_ENV:'test', MENTAL_PUBLIC_URL:base,
    CMS_JWT_SECRET:secret, CONTACT_DATA_KEY:dataKey, CMS_ADMIN_EMAIL:'admin@example.test', CMS_ADMIN_PASSWORD:adminPassword,
    CMS_ADMIN_PASSWORD_HASH:'', SMTP_HOST:'', SMTP_USER:'', SMTP_PASSWORD:'', SMTP_FROM:'', SMTP_URL:'',
    RESEND_API_KEY:'', BREVO_API_KEY:'', CONTACT_FROM_EMAIL:'', MAIL_FROM:''};
  child = spawn(process.execPath, ['server.js'], {cwd:root, env, stdio:['ignore', 'pipe', 'pipe']});
  const collect = value => { output = (output + value).slice(-160000); };
  child.stdout.on('data', collect); child.stderr.on('data', collect);
  child.on('error', error => collect(error.message));
  await until(async () => {
    assert.equal(child.exitCode, null, 'The local test server exited');
    try { return (await fetch(base + '/health/ready', {signal:AbortSignal.timeout(2000)})).ok; } catch { return false; }
  }, 'server readiness and isolated migrations', 60000);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM directory_contact_settings')).rows[0].n, 0,
    'No production mail settings were inherited');
  fs.mkdirSync(artifacts, {recursive:true});
  browser = await chromium.launch({headless:true});
  const guest = await newContext(), guestPage = await guest.newPage();
  const categories = await getJson(guest, '/api/public/categories');
  const category = categories.find(item => item.slug === 'pszichologusok') || categories[0];
  assert(category && Number.isInteger(category.listing_count), 'An active catalog category is available');
  const originalCount = category.listing_count;

  // The public homepage form obtains CSRF protection and saves a real fake application.
  await guestPage.goto(base + '/', {waitUntil:'networkidle'});
  assert.equal(await guestPage.locator('.header-login[href="/belepes"]').count(), 1);
  assert.equal(await guestPage.locator('.site-header a[href^="/admin"]').count(), 0);
  await guestPage.locator('details.registration-box > summary').click();
  for (const [name, value] of Object.entries({name:applicantName, contact_name:contactName, email:providerEmail,
    phone:'+36 20 555 0101', website_url:'https://example.test', city:'Budapest', description,
    qualifications:'Böngészős tesztadat, nem valós képesítés.'})) {
    await guestPage.locator('#submitForm [name="' + name + '"]').fill(value);
  }
  await guestPage.locator('#submitCategory').selectOption(category.slug);
  await guestPage.locator('#submitForm [name="consent"]').check();
  const submitted = await perform(guestPage, 'POST', '/api/directory/submit',
    () => guestPage.locator('#submitForm button[type="submit"]').click(), 201);
  assert.equal(submitted.ok, true, 'Homepage submission returns the generic acknowledgement');
  const persisted = await db.query('SELECT id,email FROM directory_submissions WHERE email=$1', [providerEmail]);
  assert.equal(persisted.rowCount, 1, 'Homepage form persists exactly one application in the isolated test database');
  const submissionId = persisted.rows[0].id;
  await until(async () => (await guestPage.locator('#submitMsg').textContent()).includes('megérkezett'), 'public submission confirmation');
  assert.equal((await db.query('SELECT email FROM directory_submissions WHERE id=$1', [submissionId])).rows[0].email, providerEmail);

  // Admin login, recoverable trash, and acceptance use the actual admin controls.
  const admin = await newContext(), adminPage = await admin.newPage();
  await adminPage.goto(base + '/admin/', {waitUntil:'networkidle'});
  await adminPage.locator('#loginEmail').fill('admin@example.test');
  await adminPage.locator('#loginPassword').fill(adminPassword);
  await perform(adminPage, 'POST', '/api/admin/login', () => adminPage.locator('#loginForm button').click());
  await adminPage.locator('#appView').waitFor({state:'visible'});
  assert.equal((await getJson(admin, '/api/provider/session')).authenticated, false, 'CMS session is not a provider session');
  await adminPage.locator('[data-view="submissions"]').click();
  await adminPage.locator('#submissionSearch').fill(applicantName);
  await adminPage.locator('#submissionSearchForm button[type="submit"]').click();
  const row = adminPage.locator('[data-submission-id="' + submissionId + '"]');
  await row.waitFor({state:'visible'});
  await perform(adminPage, 'POST', '/api/admin/directory/submissions/' + submissionId + '/trash',
    () => row.locator('[data-sub-action="trash"]').click());
  await row.waitFor({state:'detached'});
  await adminPage.locator('#submissionUndo').waitFor({state:'visible'});
  assert((await db.query('SELECT deleted_at FROM directory_submissions WHERE id=$1', [submissionId])).rows[0].deleted_at);
  await adminPage.locator('#submissionTrashToggle').click();
  await row.waitFor({state:'visible'});
  assert.equal(await adminPage.locator('#submissionTrashToggle').getAttribute('aria-pressed'), 'true');
  await screenshot(adminPage, 'provider-submissions-trash-desktop', '#submissionsView');
  await adminPage.setViewportSize({width:390, height:844});
  await screenshot(adminPage, 'provider-submissions-trash-mobile', '#submissionsView');
  await adminPage.setViewportSize({width:1440, height:1080});
  await perform(adminPage, 'POST', '/api/admin/directory/submissions/' + submissionId + '/restore',
    () => row.locator('[data-sub-action="restore"]').click());
  await row.waitFor({state:'detached'});
  const restored = (await db.query('SELECT status,deleted_at FROM directory_submissions WHERE id=$1', [submissionId])).rows[0];
  assert.equal(restored.deleted_at, null); assert.equal(restored.status, 'new');
  assert.equal((await db.query('SELECT count(*)::int AS n FROM provider_account_mail WHERE submission_id=$1', [submissionId])).rows[0].n, 0,
    'Moving to and from the trash does not send an invitation');
  await adminPage.locator('#submissionTrashToggle').click();
  await row.waitFor({state:'visible'});
  const accepted = await perform(adminPage, 'PUT', '/api/admin/directory/submissions/' + submissionId,
    () => row.locator('[data-sub-action="accept"]').click());
  assert.equal(accepted.mail_status, 'needs_mail');
  await until(async () => (await row.textContent()).includes('Levélküldés beállítására vár'), 'pending invitation status in admin');
  const inviteMail = await latestMail(providerEmail, 'invite');
  const repeated = await writeApi(admin, '/api/admin/directory/submissions/' + submissionId, {status:'accepted'}, {method:'PUT', admin:true});
  assert.equal(repeated.invitation.mail_id, inviteMail.id, 'Repeated acceptance reuses one invitation');
  assert.equal((await db.query("SELECT count(*)::int AS n FROM provider_account_mail WHERE submission_id=$1 AND kind='invite'", [submissionId])).rows[0].n, 1);
  await screenshot(adminPage, 'provider-submissions-accepted-desktop', '#submissionsView');

  // Invitation activation, owned-profile editing, and actual catalog publication.
  const invitation = tokenFromMail(inviteMail, '/regisztracio', providerEmail);
  const owner = await newContext(), ownerPage = await owner.newPage();
  await ownerPage.goto(base + '/belepes', {waitUntil:'networkidle'});
  await screenshot(ownerPage, 'provider-login-desktop');
  await ownerPage.setViewportSize({width:390, height:844});
  await screenshot(ownerPage, 'provider-login-mobile');
  await ownerPage.setViewportSize({width:1440, height:1080});
  await activate(ownerPage, invitation, providerEmail, providerPassword);
  const session = await getJson(owner, '/api/provider/session');
  assert(session.authenticated && session.user.approved && session.user.email_verified);
  assert.equal(session.mail_ready, false);
  assert((await db.query('SELECT consent_at FROM provider_accounts WHERE id=$1', [session.user.id])).rows[0].consent_at);
  assert((await db.query('SELECT consumed_at FROM provider_account_tokens WHERE id=$1', [inviteMail.token_id])).rows[0].consumed_at);
  await writeApi(guest, '/api/provider/activate', {token:invitation, password:providerPassword, consent:true}, {status:410});
  assert.equal(await ownerPage.locator('#providerProfile_name').inputValue(), applicantName, 'Accepted application prefills the editor');
  assert.equal(await ownerPage.locator('#providerProfile_email').inputValue(), providerEmail);
  assert(await ownerPage.locator('#providerProfile_email').evaluate(input => input.readOnly));
  await ownerPage.locator('#providerProfile_description').fill('');
  const draft = await saveProfile(ownerPage, 'save');
  assert.equal(draft.listing.status, 'draft', 'Incomplete draft remains editable');
  assert.equal(await ownerPage.locator('#providerPublicLink').isVisible(), false);
  assert.equal((await guest.request.get(base + '/api/public/listings/' + draft.listing.slug)).status(), 404);
  await fillProfile(ownerPage, applicantName, category.slug);
  const published = await saveProfile(ownerPage, 'publish');
  assert.equal(published.listing.status, 'published');
  assert.equal(await ownerPage.locator('#providerPublicLink').getAttribute('href'), published.listing.url);
  assert.equal((await getJson(guest, '/api/public/categories')).find(item => item.slug === category.slug).listing_count, originalCount + 1,
    'Category counts include the newly published owned profile');
  const publicListing = await getJson(guest, '/api/public/listings/' + published.listing.slug);
  assert.equal(publicListing.name, applicantName); assert(publicListing.categories.some(item => item.slug === category.slug));
  const publicPage = await guest.newPage();
  assert.equal((await publicPage.goto(base + published.listing.url, {waitUntil:'networkidle'})).status(), 200);
  assert((await publicPage.locator('h1').textContent()).includes(applicantName));
  await ownerPage.locator('#providerProfile_price_info').fill('Frissített tesztadat; nincs valós díjszabás.');
  assert.equal((await saveProfile(ownerPage, 'save')).listing.status, 'published', 'Ordinary editing preserves publication');
  await screenshot(ownerPage, 'provider-account-desktop');
  await ownerPage.setViewportSize({width:390, height:844});
  await screenshot(ownerPage, 'provider-account-mobile');
  await screenshot(ownerPage, 'provider-categories-mobile', '#providerCategoryChoices');
  await ownerPage.setViewportSize({width:1440, height:1080});
  assert.equal((await saveProfile(ownerPage, 'unpublish')).listing.status, 'draft');
  assert.equal((await guest.request.get(base + '/api/public/listings/' + published.listing.slug)).status(), 404);
  assert.equal((await getJson(guest, '/api/public/categories')).find(item => item.slug === category.slug).listing_count, originalCount);
  await saveProfile(ownerPage, 'publish');
  assert.equal((await owner.request.get(base + '/api/admin/directory/submissions')).status(), 401, 'Provider session cannot read the CMS');
  assert.equal((await owner.request.get(base + '/api/admin/articles')).status(), 401);
  const ownerCookies = await owner.cookies(base);
  assert(ownerCookies.some(cookie => cookie.name === 'mental_provider' && cookie.httpOnly));
  assert(!ownerCookies.some(cookie => cookie.name === 'mental_cms'));

  // Public registration remains honest when email delivery is awaiting configuration.
  const signup = await newContext(), signupPage = await signup.newPage();
  const signupEmail = 'registration-' + suffix + '@example.test';
  await signupPage.goto(base + '/regisztracio', {waitUntil:'networkidle'});
  assert.equal(await signupPage.locator('#providerRegisterForm input[type="password"]').count(), 0);
  await signupPage.locator('#providerRegisterName').fill('Önálló teszt jelentkező');
  await signupPage.locator('#providerRegisterEmail').fill(signupEmail);
  await signupPage.locator('#providerRegisterConsent').check();
  const registered = await perform(signupPage, 'POST', '/api/provider/register',
    () => signupPage.locator('#providerRegisterForm button[type="submit"]').click(), 202);
  assert.equal(registered.mail_ready, false);
  await signupPage.locator('#providerRegistrationResult').waitFor({state:'visible'});
  assert.match(await signupPage.locator('#providerRegistrationResultMessage').textContent(), /folyamatban/);
  const signupMail = await latestMail(signupEmail, 'setup');
  await activate(signupPage, tokenFromMail(signupMail, '/regisztracio', signupEmail), signupEmail, providerPassword);
  assert.equal((await getJson(signup, '/api/provider/session')).user.approved, false);
  assert.equal(await signupPage.locator('#providerPublish').isVisible(), false);
  await fillProfile(signupPage, 'Önálló teszt jelentkező', category.slug);
  const pending = await saveProfile(signupPage, 'submit');
  assert.equal(pending.listing.status, 'pending');
  assert.notEqual(String(pending.listing.id), String(published.listing.id), 'Each provider receives their own profile');
  await writeApi(signup, '/api/provider/profile', {action:'publish'}, {method:'PUT', status:403});
  assert.equal((await guest.request.get(base + '/api/public/listings/' + pending.listing.slug)).status(), 404);

  // The reset form consumes its token once and invalidates the existing provider session.
  await guestPage.goto(base + '/elfelejtett-jelszo', {waitUntil:'networkidle'});
  await guestPage.locator('#providerForgotEmail').fill(providerEmail);
  const forgot = await perform(guestPage, 'POST', '/api/provider/forgot-password',
    () => guestPage.locator('#providerForgotForm button[type="submit"]').click(), 202);
  assert.equal(forgot.mail_ready, false);
  await guestPage.locator('#providerForgotResult').waitFor({state:'visible'});
  assert.match(await guestPage.locator('#providerForgotResultMessage').textContent(), /folyamatban/);
  const resetMail = await latestMail(providerEmail, 'reset');
  const resetToken = tokenFromMail(resetMail, '/jelszo-visszaallitas', providerEmail);
  await guestPage.goto(base + '/jelszo-visszaallitas#token=' + resetToken, {waitUntil:'networkidle'});
  await guestPage.locator('#providerResetForm').waitFor({state:'visible'});
  assert.equal(new URL(guestPage.url()).hash, '');
  await guestPage.locator('#providerResetPassword').fill(resetPassword);
  await guestPage.locator('#providerResetConfirm').fill(resetPassword);
  await perform(guestPage, 'POST', '/api/provider/reset-password', () => guestPage.locator('#providerResetForm button[type="submit"]').click());
  await guestPage.locator('#providerResetResult').waitFor({state:'visible'});
  assert.equal((await getJson(guest, '/api/provider/session')).authenticated, false, 'Reset does not implicitly sign in');
  assert.equal((await owner.request.get(base + '/api/provider/profile')).status(), 401, 'Reset revokes a previously active session');
  await writeApi(guest, '/api/provider/reset-password', {token:resetToken, password:changedPassword}, {status:410});
  await ownerPage.goto(base + '/belepes', {waitUntil:'networkidle'});
  await ownerPage.locator('#providerLoginEmail').fill(providerEmail);
  await ownerPage.locator('#providerLoginPassword').fill(providerPassword);
  await perform(ownerPage, 'POST', '/api/provider/login', () => ownerPage.locator('#providerLoginForm button[type="submit"]').click(), 401);
  await until(async () => (await ownerPage.locator('#providerPageMessage').textContent()).trim().length > 0 &&
    await ownerPage.locator('#providerLoginForm').getAttribute('aria-busy') === 'false', 'old password rejected in UI');
  await providerLogin(ownerPage, providerEmail, resetPassword);

  // Password management and logout keep provider authentication separate from CMS auth.
  await ownerPage.locator('.provider-security > summary').click();
  await ownerPage.locator('#providerCurrentPassword').fill(resetPassword);
  await ownerPage.locator('#providerNewPassword').fill(changedPassword);
  await ownerPage.locator('#providerNewPasswordConfirm').fill(changedPassword);
  await perform(ownerPage, 'POST', '/api/provider/change-password', () => ownerPage.locator('#providerChangePasswordForm button[type="submit"]').click());
  await ownerPage.waitForURL(base + '/belepes?jelszo=modositva');
  assert.equal((await getJson(owner, '/api/provider/session')).authenticated, false);
  await providerLogin(ownerPage, providerEmail, changedPassword);
  await perform(ownerPage, 'POST', '/api/provider/logout', () => ownerPage.locator('[data-provider-logout]').click());
  await ownerPage.waitForURL(base + '/belepes');
  assert.equal((await owner.request.get(base + '/api/provider/profile')).status(), 401);
  await ownerPage.goto(base + '/admin/', {waitUntil:'networkidle'});
  await ownerPage.locator('#loginView').waitFor({state:'visible'});
  assert.equal(await ownerPage.locator('#appView').isVisible(), false);

  for (const request of requests) assert(!tokens.some(token => request.url.includes(token) || request.referer.includes(token)),
    'Email tokens never appear in request URLs or referrers');
  for (const page of pages.filter(page => !page.isClosed())) {
    const stored = await page.evaluate(() => JSON.stringify({local:{...localStorage}, session:{...sessionStorage}}));
    assert(!tokens.some(token => stored.includes(token)) && !stored.includes(providerPassword) && !stored.includes(resetPassword) && !stored.includes(changedPassword),
      'Tokens and passwords are never persisted in browser storage');
  }
  const delivery = (await db.query("SELECT count(*) FILTER(WHERE attempts>0 OR delivery_status IN ('sending','accepted'))::int AS attempts FROM provider_account_mail")).rows[0];
  assert.equal(delivery.attempts, 0, 'No real email delivery was attempted');
  assert.deepEqual(errors, [], 'No uncaught browser JavaScript exceptions');
  console.log('PROVIDER_BROWSER_FUNCTIONAL_OK');
  assert.deepEqual(layoutFailures, [], 'No horizontal document overflow across desktop and mobile screenshots');
  console.log('PROVIDER_BROWSER_OK', JSON.stringify({publicApplication:true, adminLogin:true, trashAndRestore:true,
    idempotentInvitation:true, encryptedPendingMail:true, activation:true, ownedProfile:true, publication:true,
    categoryCounts:true, hideAndRepublish:true, registration:true, unapprovedCannotPublish:true,
    resetSingleUse:true, sessionsRevoked:true, passwordChange:true, logout:true, cmsIsolation:true,
    responsiveScreenshots:true, tokenUrlAndStorageSafety:true, realEmailsSent:0}));
}

main().catch(async error => {
  console.error(error.stack);
  // All data in these screenshots and server logs belongs to this disposable schema.
  for (let index=0; index<pages.length; index++) {
    const page=pages[index];
    if (!page.isClosed()) await page.screenshot({path:path.join(artifacts, 'provider-failure-' + index + '.png')}).catch(()=>{});
  }
  console.error(output);
  process.exitCode=1;
}).finally(async () => {
  if (browser) await browser.close().catch(()=>{});
  if (child && child.exitCode === null) {
    const done=once(child, 'exit').catch(()=>{}); child.kill('SIGTERM');
    await Promise.race([done, wait(2000)]);
    if (child.exitCode === null) { child.kill('SIGKILL'); await Promise.race([done, wait(2000)]); }
  }
  await db.end();
  if (schemaCreated) await control.query('DROP SCHEMA ' + schema + ' CASCADE');
  await control.end();
});
