'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const {once} = require('node:events');
const {createMcpOAuth, challengeFor} = require('../lib/mcp-oauth.cjs');

const connectionString = process.env.DATABASE_URL;
const database = new URL(connectionString || 'http://invalid');
assert(['postgres:', 'postgresql:'].includes(database.protocol)
  && ['127.0.0.1', 'localhost', '[::1]'].includes(database.hostname)
  && /^\/[a-zA-Z0-9_]*test[a-zA-Z0-9_]*$/.test(database.pathname),
'OAuth browser tests require a disposable loopback test database');

test('Native OAuth form preserves Origin, rejects forgeries and returns the approved callback', {timeout:90000}, async() => {
  const express = require('express');
  const cookieParser = require('cookie-parser');
  const {Pool} = require('pg');
  const {buildDatabaseConfig} = require('../lib/database-config.cjs');
  const {chromium} = require(process.env.BROWSER_TOOLS || 'playwright');
  const pool = new Pool(buildDatabaseConfig());
  const runId = crypto.randomBytes(8).toString('hex');
  const email = 'oauth-browser-' + runId + '@example.test';
  const password = crypto.randomBytes(24).toString('base64url');
  const redirectUri = 'https://chatgpt.com/connector_platform_oauth_redirect';
  const clientIds = [];
  const posts = [];
  const callbacks = [];
  let server, attackerServer, browser;
  let credentialChecks = 0;
  let legacyPolicy = false;

  try {
    const schema = (await pool.query("SELECT to_regclass('mcp_oauth_clients') AS clients,to_regclass('cms_audit_log') AS audit")).rows[0];
    assert(schema.clients && schema.audit, 'Run the application migrations before the browser regression');

    const app = express();
    app.use(express.json({limit:'32kb'}));
    app.use(express.urlencoded({extended:false, limit:'32kb'}));
    app.use(cookieParser());
    app.use((req, res, next) => {
      if (legacyPolicy && req.method === 'GET' && req.path === '/mcp/oauth/authorize') {
        const setHeader = res.setHeader.bind(res);
        res.setHeader = (name, value) => setHeader(name, name.toLowerCase() === 'referrer-policy' ? 'no-referrer' : value);
      }
      if (req.method === 'POST' && req.path === '/mcp/oauth/authorize') {
        // Deliberately keep only non-secret transport metadata.
        posts.push({origin:req.get('origin'), contentType:req.get('content-type')});
      }
      next();
    });
    server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const baseUrl = 'http://127.0.0.1:' + server.address().port;
    const authorizationEndpoint = baseUrl + '/mcp/oauth/authorize';
    const resource = baseUrl + '/mcp';
    const oauth = createMcpOAuth({pool, dbState:{ready:true}, baseUrl,
      verifyAdminCredentials:async(inputEmail, inputPassword) => {
        credentialChecks++;
        return inputEmail === email && inputPassword === password ? {email, role:'admin'} : null;
      }
    });
    oauth.register(app);
    app.get('/probe/read', oauth.requireAccess(['mental:read']), (req, res) => res.json({email:req.mcpAuth.email}));
    app.use((error, _req, res, _next) => res.status(500).json({error:error.code || 'TEST_FAILURE'}));

    // A separate local origin supplies an actual cross-origin browser form.
    const attacker = express();
    let forgedFields = {};
    const escape = value => String(value).replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
    attacker.get('/forgery', (_req, res) => res.type('html').send('<!doctype html><html><body><form method="post" action="'
      + authorizationEndpoint + '">' + Object.entries(forgedFields).map(([name, value]) => '<input type="hidden" name="'
      + escape(name) + '" value="' + escape(value) + '">').join('') + '<button>Forged consent</button></form></body></html>'));
    attackerServer = attacker.listen(0, '127.0.0.1');
    await once(attackerServer, 'listening');
    const attackerOrigin = 'http://127.0.0.1:' + attackerServer.address().port;

    const request = (pathname, options = {}) => fetch(baseUrl + pathname, {...options, redirect:'manual', signal:AbortSignal.timeout(10000)});
    const registration = await request('/mcp/oauth/register', {method:'POST', headers:{'content-type':'application/json'},
      body:JSON.stringify({client_name:'Isolated browser regression ' + runId, redirect_uris:[redirectUri], token_endpoint_auth_method:'none'})});
    assert.equal(registration.status, 201);
    const client = await registration.json();
    clientIds.push(client.client_id);
    const authorization = () => {
      const verifier = crypto.randomBytes(32).toString('base64url');
      const state = crypto.randomBytes(16).toString('hex');
      const query = new URLSearchParams({response_type:'code', client_id:client.client_id, redirect_uri:redirectUri, resource, state,
        code_challenge:challengeFor(verifier), code_challenge_method:'S256'});
      return {url:authorizationEndpoint + '?' + query, verifier, state};
    };

    // A missed route must fail locally instead of reaching the real callback service.
    browser = await chromium.launch({headless:true, args:['--host-resolver-rules=MAP chatgpt.com ~NOTFOUND']});
    const context = await browser.newContext();
    const page = await context.newPage();
    page.setDefaultTimeout(15000);
    // Fetch interception pauses each redirect independently, unlike the high-level
    // route handler for an existing redirect chain. Local requests stay native.
    const cdp = await context.newCDPSession(page);
    const interceptionErrors = [], browserErrors = [];
    page.on('requestfailed', request => browserErrors.push({origin:new URL(request.url()).origin, error:request.failure()?.errorText}));
    const intercept = async event => {
      const target = new URL(event.request.url);
      if (target.origin === 'https://chatgpt.com' && target.pathname === '/connector_platform_oauth_redirect') {
        const referer = Object.entries(event.request.headers).find(([name]) => name.toLowerCase() === 'referer')?.[1];
        callbacks.push({url:target, referer});
        // The real external ChatGPT service is never contacted by this test.
        return cdp.send('Fetch.fulfillRequest', {requestId:event.requestId,responseCode:200,
          responseHeaders:[{name:'Content-Type',value:'text/html; charset=utf-8'}],
          body:Buffer.from('<!doctype html><title>Local callback fixture</title><p data-testid="oauth-ci-callback">Callback captured in isolated CI.</p>').toString('base64')});
      }
      if (target.origin === baseUrl || target.origin === attackerOrigin) {
        // Never inject Origin; the native browser must supply it itself.
        return cdp.send('Fetch.continueRequest', {requestId:event.requestId});
      }
      return cdp.send('Fetch.failRequest', {requestId:event.requestId,errorReason:'BlockedByClient'});
    };
    cdp.on('Fetch.requestPaused', event => {
      intercept(event).catch(async error => {
        interceptionErrors.push(error.message);
        await cdp.send('Fetch.failRequest', {requestId:event.requestId,errorReason:'BlockedByClient'}).catch(()=>{});
      });
    });
    await cdp.send('Fetch.enable', {patterns:[{urlPattern:'*',requestStage:'Request'}]});
    const waitForCallback = async () => {
      try { await page.getByTestId('oauth-ci-callback').waitFor({state:'visible'}); }
      catch { assert.fail('Local callback failed: ' + JSON.stringify({interceptionErrors,browserErrors,callbacks:callbacks.length})); }
      assert.equal(new URL(page.url()).origin,'https://chatgpt.com');
    };
    const fillCredentials = async value => {
      await page.getByLabel('E-mail-cím', {exact:true}).fill(email);
      await page.getByLabel('Adminisztrátori jelszó', {exact:true}).fill(value);
    };
    const submit = async name => {
      const [response] = await Promise.all([
        page.waitForResponse(response => response.url() === authorizationEndpoint && response.request().method() === 'POST'),
        page.getByRole('button', {name, exact:true}).click()
      ]);
      return response;
    };

    // Negative control: the old response policy reproduces the reported browser failure.
    legacyPolicy = true;
    const legacy = authorization();
    await page.goto(legacy.url, {waitUntil:'domcontentloaded'});
    legacyPolicy = false;
    await fillCredentials(password);
    const rejectedLegacy = await submit('Kapcsolat engedélyezése');
    assert.equal(rejectedLegacy.status(), 403);
    assert.equal(posts.at(-1).origin, 'null', 'no-referrer must reproduce the native POST Origin:null regression');
    assert.deepEqual(await rejectedLegacy.json(), {error:'invalid_request', error_description:'Érvénytelen engedélyezési kérés.'});
    assert.equal(credentialChecks, 0, 'The reported failure happens before credentials are checked');

    const start = authorization();
    const consentPage = await page.goto(start.url, {waitUntil:'domcontentloaded'});
    assert.equal(consentPage.status(), 200);
    await fillCredentials('deliberately-incorrect-ci-password');
    const wrongPassword = await submit('Kapcsolat engedélyezése');
    assert.equal(posts.at(-1).origin, baseUrl, 'Native consent POST must retain the trusted origin');
    assert.match(posts.at(-1).contentType, /^application\/x-www-form-urlencoded/);
    assert.equal(wrongPassword.status(), 401, 'An incorrect password should reach credential validation, not fail Origin validation');
    assert.equal(credentialChecks, 1);
    assert((await page.getByRole('alert').textContent()).includes('Hibás e-mail-cím vagy jelszó.'));
    assert.equal(await page.getByLabel('Adminisztrátori jelszó', {exact:true}).inputValue(), '');

    // Retrying the returned form proves the policy is also correct on the 401 page.
    await fillCredentials(password);
    const accepted = await submit('Kapcsolat engedélyezése');
    assert.equal(posts.at(-1).origin, baseUrl);
    assert.equal(accepted.status(), 303);
    await waitForCallback();
    assert.equal(callbacks.length, 1, 'The approval callback must be fulfilled by the local browser fixture');
    const callback = new URL(page.url());
    assert.equal(callback.searchParams.get('state'), start.state);
    assert.equal(callback.searchParams.get('iss'), baseUrl);
    assert(callback.searchParams.get('code'));
    assert.equal(callbacks.at(-1).referer, undefined, 'The consent URL must not leak to the external callback');
    assert.equal(credentialChecks, 2);

    const exchange = await request('/mcp/oauth/token', {method:'POST', headers:{'content-type':'application/x-www-form-urlencoded'},
      body:new URLSearchParams({grant_type:'authorization_code', client_id:client.client_id, redirect_uri:redirectUri, resource,
        code:callback.searchParams.get('code'), code_verifier:start.verifier}).toString()});
    assert.equal(exchange.status, 200);
    const tokens = await exchange.json();
    const authorized = await request('/probe/read', {headers:{authorization:'Bearer ' + tokens.access_token}});
    assert.equal(authorized.status, 200);
    assert.equal((await authorized.json()).email, email);

    const deniedStart = authorization();
    await page.goto(deniedStart.url, {waitUntil:'domcontentloaded'});
    const denied = await submit('Mégse');
    assert.equal(denied.status(), 303);
    assert.equal(posts.at(-1).origin, baseUrl);
    await waitForCallback();
    assert.equal(callbacks.length, 2, 'The denial callback must be fulfilled by the local browser fixture');
    const deniedCallback = new URL(page.url());
    assert.equal(deniedCallback.searchParams.get('state'), deniedStart.state);
    assert.equal(deniedCallback.searchParams.get('iss'), baseUrl);
    assert.equal(deniedCallback.searchParams.get('error'), 'access_denied');
    assert.equal(deniedCallback.searchParams.has('code'), false);
    assert.equal(credentialChecks, 2, 'Denying a connection does not validate or require credentials');

    const forgedStart = authorization();
    await page.goto(forgedStart.url, {waitUntil:'domcontentloaded'});
    const requestId = await page.locator('input[name="request_id"]').inputValue();
    forgedFields = {request_id:requestId, csrf_token:await page.locator('input[name="csrf_token"]').inputValue(), decision:'allow', email, password};
    await page.goto(attackerOrigin + '/forgery', {waitUntil:'domcontentloaded'});
    const forged = await submit('Forged consent');
    assert.equal(forged.status(), 403);
    assert.equal(posts.at(-1).origin, attackerOrigin);
    assert.equal(credentialChecks, 2, 'A cross-origin form remains rejected even with matching cookie, CSRF token and test credentials');
    assert.equal((await pool.query('SELECT used_at FROM mcp_oauth_requests WHERE request_id=$1', [requestId])).rows[0].used_at, null);
    assert.equal(callbacks.length, 2, 'Only the explicit allow and deny actions reach intercepted callbacks');
    assert.deepEqual(interceptionErrors, []);
    console.log('MCP_OAUTH_BROWSER_OK', JSON.stringify({legacyOriginNullRejected:true, nativeOriginPreserved:true, wrongPassword:401,
      approval:303, tokenValidated:true, denial:303, crossOriginForgery:403, externalCallbackRequests:0}));
  } finally {
    if (browser) await browser.close();
    await Promise.all([server, attackerServer].filter(Boolean).map(listener => new Promise(resolve => listener.close(resolve))));
    try {
      await pool.query("DELETE FROM cms_audit_log WHERE entity_type='mcp_oauth' AND details->>'client_id'=ANY($1::text[])", [clientIds]);
      await pool.query('DELETE FROM mcp_oauth_clients WHERE client_id=ANY($1::text[])', [clientIds]);
    } finally { await pool.end(); }
  }
});
