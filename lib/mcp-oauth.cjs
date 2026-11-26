'use strict';

const crypto = require('node:crypto');
const rateLimit = require('express-rate-limit');

const SCOPES = Object.freeze(['mental:read', 'mental:write', 'mental:publish']);
const SCOPE_LABELS = Object.freeze({
  'mental:read': 'Cikkek és a hozzájuk tartozó médiaadatok megtekintése',
  'mental:write': 'Piszkozatok szerkesztése, képek és videók feltöltése',
  'mental:publish': 'Cikkek publikálása a külön megadott jóváhagyásod után'
});
const ACCESS_SECONDS = 3600;
const GRANT_SECONDS = 30 * 24 * 60 * 60;
const REQUEST_SECONDS = 600;
const CODE_SECONDS = 120;
const PATH = '/mcp/oauth';
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const random = (prefix = '') => prefix + crypto.randomBytes(32).toString('base64url');
const escape = value => String(value || '').replace(/[&<>"']/g, character => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[character]));
const oauthError = (error, description, status = 400) => Object.assign(new Error(description), {oauthError:error, status});
const input = (value, max = 2000) => typeof value === 'string' && value.length > 0 && value.length <= max && !/[\x00-\x1f\x7f]/.test(value) ? value : '';
const isAdmin = user => user && user.role === 'admin' && typeof user.email === 'string' && user.email.length > 0;
const equal = (left, right) => {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  const a = Buffer.from(left), b = Buffer.from(right);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};
const expires = seconds => new Date(Date.now() + seconds * 1000);

function allowedRedirect(value) {
  try {
    const url = new URL(value);
    return url.href === value && url.protocol === 'https:' && url.hostname === 'chatgpt.com' && !url.port && !url.username && !url.password && !url.search && !url.hash
      && (url.pathname === '/connector_platform_oauth_redirect' || /^\/connector\/oauth\/[A-Za-z0-9_-]{8,160}$/.test(url.pathname));
  } catch { return false; }
}
function parseScopes(value, allowed = SCOPES, fallback = allowed) {
  if (value === undefined || value === '') return [...fallback];
  if (typeof value !== 'string' || value.length > 300) throw oauthError('invalid_scope', 'A kért jogosultság nem támogatott.');
  const scopes = [...new Set(value.trim().split(/\s+/))];
  if (!scopes.length || scopes.some(scope => !allowed.includes(scope))) throw oauthError('invalid_scope', 'A kért jogosultság nem támogatott.');
  return scopes;
}
function validVerifier(value) { return typeof value === 'string' && /^[A-Za-z0-9._~-]{43,128}$/.test(value); }
function challengeFor(value) { return crypto.createHash('sha256').update(value).digest('base64url'); }
function cookieName(requestId) { return 'mental_mcp_csrf_' + requestId.slice(0, 16); }

function createMcpOAuth({pool, dbState, baseUrl = 'https://mental.hu', getAdminUser = () => null, verifyAdminCredentials = async() => null}) {
  const base = new URL(baseUrl);
  if (base.username || base.password || base.search || base.hash || !['', '/'].includes(base.pathname)
      || (base.protocol !== 'https:' && !(base.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname)))) throw new Error('MCP_OAUTH_INVALID_BASE_URL');
  const issuer = base.origin;
  const resourceUrl = issuer + '/mcp';
  const resourceMetadataUrl = issuer + '/.well-known/oauth-protected-resource/mcp';
  const metadata = Object.freeze({
    issuer,
    authorization_response_iss_parameter_supported: true,
    authorization_endpoint: issuer + PATH + '/authorize',
    token_endpoint: issuer + PATH + '/token',
    registration_endpoint: issuer + PATH + '/register',
    revocation_endpoint: issuer + PATH + '/revoke',
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    token_endpoint_auth_methods_supported: ['none'],
    revocation_endpoint_auth_methods_supported: ['none'],
    code_challenge_methods_supported: ['S256'],
    scopes_supported: [...SCOPES]
  });
  const resourceMetadata = Object.freeze({
    resource: resourceUrl,
    resource_name: 'MENTÁL.hu – Cikkfeltöltés',
    authorization_servers: [issuer],
    scopes_supported: [...SCOPES],
    bearer_methods_supported: ['header']
  });
  const cookieOptions = {httpOnly:true, secure:base.protocol === 'https:', sameSite:'lax', path:PATH + '/authorize', maxAge:REQUEST_SECONDS * 1000};
  const {maxAge:cookieMaxAge,...clearCookieOptions} = cookieOptions;
  let nextRequestCleanup = 0;
  async function cleanupExpiredRequests() {
    if (Date.now() < nextRequestCleanup) return;
    await pool.query("DELETE FROM mcp_oauth_requests WHERE expires_at<now()-interval '1 day'; DELETE FROM mcp_oauth_codes WHERE expires_at<now()-interval '1 day'");
    nextRequestCleanup = Date.now() + 60 * 60 * 1000;
  }
  const noStore = (_req, res, next) => {res.set({'Cache-Control':'no-store', Pragma:'no-cache'}); next();};
  function ready(_req, res, next) {
    if (dbState.ready) return next();
    res.set('Retry-After', '15').status(503).json({error:'temporarily_unavailable',error_description:'A szerkesztőségi csatlakozás átmenetileg nem elérhető.'});
  }
  const wrap = handler => async(req, res, next) => {
    try { await handler(req, res); } catch(error) {
      if (error.oauthError) return res.status(error.status).json({error:error.oauthError,error_description:error.message});
      next(error);
    }
  };
  function authChallenge(error, scopes) {
    return 'Bearer resource_metadata="' + resourceMetadataUrl + '"'
      + (error ? ', error="' + error + '"' : '')
      + (scopes?.length ? ', scope="' + scopes.join(' ') + '"' : '');
  }
  function redirectAuthorization(res, request, values) {
    const destination = new URL(request.redirect_uri);
    for (const [key, value] of Object.entries({...values, state:request.state, iss:issuer})) destination.searchParams.set(key, value);
    res.redirect(303, destination.href);
  }
  async function audit(client, action, entityId, email, details = {}) {
    await client.query(`INSERT INTO cms_audit_log(action,entity_type,entity_id,actor_email,details)
      VALUES($1,'mcp_oauth',$2,$3,$4)`, [action,entityId,email,JSON.stringify(details)]);
  }
  async function transaction(handler) {
    const client = await pool.connect();
    try { await client.query('BEGIN'); const result = await handler(client); await client.query('COMMIT'); return result; }
    catch(error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
    finally { client.release(); }
  }
  async function registeredClient(clientId) {
    if (!/^mental_[A-Za-z0-9_-]{43}$/.test(input(clientId, 60))) throw oauthError('invalid_client', 'Ismeretlen csatlakozó.', 401);
    const {rows} = await pool.query('SELECT * FROM mcp_oauth_clients WHERE client_id=$1', [clientId]);
    if (!rows[0]) throw oauthError('invalid_client', 'Ismeretlen csatlakozó.', 401);
    return rows[0];
  }
  async function authorizationRequest(query) {
    const client = await registeredClient(query.client_id);
    const redirect = input(query.redirect_uri);
    if (!allowedRedirect(redirect) || !client.redirect_uris.includes(redirect)) throw oauthError('invalid_request', 'A visszatérési cím nem engedélyezett.');
    const request = {client_id:client.client_id,redirect_uri:redirect,state:input(query.state, 1000)};
    try {
      if (query.response_type !== 'code') throw oauthError('unsupported_response_type', 'Csak az engedélyezési kód támogatott.');
      if (!request.state) throw oauthError('invalid_request', 'Hiányzik a kapcsolat állapotazonosítója.');
      if (query.resource !== resourceUrl) throw oauthError('invalid_target', 'A hozzáférés csak a MENTÁL.hu csatolóhoz kérhető.');
      if (query.code_challenge_method !== 'S256' || !/^[A-Za-z0-9_-]{43}$/.test(input(query.code_challenge, 43))) throw oauthError('invalid_request', 'S256 PKCE szükséges.');
      request.resource = resourceUrl;
      request.scopes = parseScopes(query.scope, client.scopes);
      request.code_challenge = query.code_challenge;
      request.client_name = client.client_name;
      return request;
    } catch(error) { if (error.oauthError) error.authorizationRequest = request; throw error; }
  }
  function authorizationPage(request, csrf, user, error = '') {
    return '<!doctype html><html lang="hu"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">'
      + '<meta name="robots" content="noindex,nofollow"><title>Csatoló engedélyezése – MENTÁL.hu</title>'
      + '<style>body{margin:0;background:#fafbf7;color:#183c33;font:16px/1.6 system-ui,sans-serif}main{max-width:540px;margin:7vh auto;padding:30px}h1{font:500 32px/1.15 Georgia,serif;margin:20px 0}p{margin:14px 0}.brand{font:700 26px Georgia,serif}ul{padding-left:24px}label{display:block;margin:18px 0}input{display:block;box-sizing:border-box;width:100%;padding:12px;margin-top:6px;font:inherit;border:1px solid #b9c4b0;border-radius:5px;background:white}.actions{display:flex;flex-wrap:wrap;gap:12px;margin-top:25px}button{font:600 16px system-ui,sans-serif;padding:13px 18px;border:1px solid #183c33;border-radius:5px;cursor:pointer;background:#183c33;color:white}button[name=decision][value=deny]{background:transparent;color:#183c33}.error{color:#9b2923;background:#fff0ec;padding:12px}.small{font-size:14px;color:#52624a}.permissions{background:#edf0e6;padding:14px 20px;border-radius:7px}a{color:inherit}</style></head><body><main>'
      + '<div class="brand">MENTÁL.hu</div><h1>Kapcsolódás a szerkesztőséghez</h1><p>A <strong>' + escape(request.client_name) + '</strong> alkalmazás az alábbi műveletekhez kér hozzáférést:</p>'
      + '<div class="permissions"><ul>' + request.scopes.map(scope => '<li>' + escape(SCOPE_LABELS[scope]) + '</li>').join('') + '</ul></div>'
      + '<p class="small">A kapcsolat engedélyezése önmagában egyetlen cikket sem publikál. A cikk megjelentetését a beszélgetésben külön kell jóváhagynod.</p>'
      + (error ? '<p class="error" role="alert">' + escape(error) + '</p>' : '')
      + '<form method="post" action="' + PATH + '/authorize"><input type="hidden" name="request_id" value="' + escape(request.request_id) + '"><input type="hidden" name="csrf_token" value="' + escape(csrf) + '">'
      + (isAdmin(user) ? '<p>Bejelentkezve: <strong>' + escape(user.email) + '</strong></p>'
        : '<label>E-mail-cím<input type="email" name="email" required autocomplete="username" maxlength="254"></label><label>Adminisztrátori jelszó<input type="password" name="password" required autocomplete="current-password" maxlength="512"></label>')
      + '<div class="actions"><button type="submit" name="decision" value="allow">Kapcsolat engedélyezése</button><button type="submit" name="decision" value="deny" formnovalidate>Mégse</button></div></form>'
      + '<p class="small"><a href="/">Vissza a magazinhoz</a></p></main></body></html>';
  }
  function sendAuthorizationPage(res, request, csrf, user, error, status = 200) {
    // Browsers also apply form-action to the POST's redirect back to ChatGPT.
    // redirect_uri has already passed the exact callback allowlist.
    res.set({'Content-Security-Policy':"default-src 'none'; style-src 'unsafe-inline'; form-action 'self' " + request.redirect_uri + "; base-uri 'none'; frame-ancestors 'none'",'X-Frame-Options':'DENY','Referrer-Policy':'no-referrer','X-Robots-Tag':'noindex, nofollow'});
    res.status(status).type('html').send(authorizationPage(request, csrf, user, error));
  }
  async function issueTokens(client, grant, scopes) {
    const access = random('mha_'), refresh = random('mhr_');
    const accessExpiry = new Date(Math.min(Date.now() + ACCESS_SECONDS * 1000, new Date(grant.expires_at).getTime()));
    await client.query(`INSERT INTO mcp_oauth_tokens(token_hash,grant_id,kind,scopes,expires_at)
      VALUES($1,$2,'access',$3,$4),($5,$2,'refresh',$3,$6)`, [hash(access),grant.grant_id,scopes,accessExpiry,hash(refresh),grant.expires_at]);
    return {access_token:access,token_type:'Bearer',expires_in:Math.max(0,Math.floor((accessExpiry.getTime() - Date.now()) / 1000)),refresh_token:refresh,scope:scopes.join(' ')};
  }
  async function exchangeCode(body) {
    await registeredClient(body.client_id);
    if (!/^mhc_[A-Za-z0-9_-]{43}$/.test(input(body.code, 50)) || !validVerifier(body.code_verifier)) throw oauthError('invalid_grant', 'Az engedélyezési kód nem érvényes.');
    const outcome = await transaction(async client => {
      const code = (await client.query('SELECT * FROM mcp_oauth_codes WHERE code_hash=$1 FOR UPDATE', [hash(body.code)])).rows[0];
      if (!code || code.client_id !== body.client_id || code.redirect_uri !== body.redirect_uri || code.resource !== body.resource || !equal(code.code_challenge, challengeFor(body.code_verifier)) || new Date(code.expires_at).getTime() <= Date.now()) return null;
      if (code.used_at) {
        if (code.grant_id) {
          await client.query('UPDATE mcp_oauth_grants SET revoked_at=COALESCE(revoked_at,now()) WHERE grant_id=$1', [code.grant_id]);
          await audit(client, 'mcp_oauth_code_replay', code.grant_id, code.email, {client_id:code.client_id});
        }
        return null;
      }
      const scopes = parseScopes(body.scope, code.scopes);
      const grant = {grant_id:random('mhg_'),client_id:code.client_id,email:code.email,resource:code.resource,scopes,expires_at:expires(GRANT_SECONDS)};
      await client.query(`INSERT INTO mcp_oauth_grants(grant_id,client_id,email,resource,scopes,expires_at) VALUES($1,$2,$3,$4,$5,$6)`, [grant.grant_id,grant.client_id,grant.email,grant.resource,scopes,grant.expires_at]);
      await client.query('UPDATE mcp_oauth_codes SET used_at=now(),grant_id=$2 WHERE code_hash=$1', [hash(body.code),grant.grant_id]);
      const tokens = await issueTokens(client, grant, scopes);
      await audit(client, 'mcp_oauth_connected', grant.grant_id, grant.email, {client_id:grant.client_id,scopes});
      return tokens;
    });
    if (!outcome) throw oauthError('invalid_grant', 'Az engedélyezési kód lejárt vagy már felhasználták.');
    return outcome;
  }
  async function refreshTokens(body) {
    await registeredClient(body.client_id);
    if (!/^mhr_[A-Za-z0-9_-]{43}$/.test(input(body.refresh_token, 50))) throw oauthError('invalid_grant', 'A kapcsolatot újra engedélyezni kell.');
    const outcome = await transaction(async client => {
      const token = (await client.query(`SELECT t.*,g.client_id,g.email,g.resource,g.expires_at AS grant_expires_at,g.revoked_at AS grant_revoked_at
        FROM mcp_oauth_tokens t JOIN mcp_oauth_grants g ON g.grant_id=t.grant_id
        WHERE t.token_hash=$1 AND t.kind='refresh' FOR UPDATE OF t,g`, [hash(body.refresh_token)])).rows[0];
      if (!token || token.client_id !== body.client_id || token.resource !== body.resource || token.grant_revoked_at || new Date(token.grant_expires_at).getTime() <= Date.now()) return null;
      if (token.used_at || token.revoked_at) {
        await client.query('UPDATE mcp_oauth_grants SET revoked_at=COALESCE(revoked_at,now()) WHERE grant_id=$1', [token.grant_id]);
        await audit(client, 'mcp_oauth_refresh_replay', token.grant_id, token.email, {client_id:token.client_id});
        return null;
      }
      if (new Date(token.expires_at).getTime() <= Date.now()) return null;
      const scopes = parseScopes(body.scope, token.scopes);
      await client.query('UPDATE mcp_oauth_tokens SET used_at=now() WHERE token_hash=$1', [hash(body.refresh_token)]);
      return issueTokens(client, {...token,expires_at:token.grant_expires_at}, scopes);
    });
    if (!outcome) throw oauthError('invalid_grant', 'A kapcsolat lejárt vagy visszavonták. Engedélyezd újra.');
    return outcome;
  }
  function requireAccess(requiredScopes = []) {
    if (!Array.isArray(requiredScopes) || requiredScopes.some(scope => !SCOPES.includes(scope))) throw new Error('MCP_OAUTH_UNKNOWN_SCOPE');
    return async(req, res, next) => {
      res.set({'Cache-Control':'no-store',Pragma:'no-cache'});
      if (!dbState.ready) return ready(req,res,next);
      const match = /^Bearer (mha_[A-Za-z0-9_-]{43})$/.exec(req.get('authorization') || '');
      if (!match) return res.set('WWW-Authenticate',authChallenge()).status(401).json({error:'unauthorized'});
      try {
        const token = (await pool.query(`SELECT t.token_hash,t.scopes,t.expires_at,g.grant_id,g.client_id,g.email,g.resource
          FROM mcp_oauth_tokens t JOIN mcp_oauth_grants g ON g.grant_id=t.grant_id
          WHERE t.token_hash=$1 AND t.kind='access' AND t.revoked_at IS NULL AND t.used_at IS NULL
            AND t.expires_at>now() AND g.revoked_at IS NULL AND g.expires_at>now() AND g.resource=$2`, [hash(match[1]),resourceUrl])).rows[0];
        if (!token) return res.set('WWW-Authenticate',authChallenge('invalid_token')).status(401).json({error:'invalid_token'});
        if (!requiredScopes.every(scope => token.scopes.includes(scope))) return res.set('WWW-Authenticate',authChallenge('insufficient_scope',requiredScopes)).status(403).json({error:'insufficient_scope'});
        req.mcpAuth = {email:token.email,role:'admin',clientId:token.client_id,scopes:token.scopes,resource:token.resource,grantId:token.grant_id,tokenId:token.token_hash};
        next();
      } catch(error) { next(error); }
    };
  }
  function register(app) {
    const registrationLimiter = rateLimit({windowMs:15*60*1000,limit:30,standardHeaders:true,legacyHeaders:false});
    const authorizationLimiter = rateLimit({windowMs:15*60*1000,limit:30,standardHeaders:true,legacyHeaders:false});
    const credentialLimiter = rateLimit({windowMs:15*60*1000,limit:15,standardHeaders:true,legacyHeaders:false});
    const tokenLimiter = rateLimit({windowMs:15*60*1000,limit:120,standardHeaders:true,legacyHeaders:false});
    app.get(['/.well-known/oauth-protected-resource','/.well-known/oauth-protected-resource/mcp'], (_req,res) => res.set('Cache-Control','public,max-age=300').json(resourceMetadata));
    app.get(['/.well-known/oauth-authorization-server',PATH + '/.well-known/oauth-authorization-server'], (_req,res) => res.set('Cache-Control','public,max-age=300').json(metadata));
    app.use(PATH, noStore);
    app.post(PATH + '/register', registrationLimiter, ready, wrap(async(req,res) => {
      const body = req.body || {};
      if (!req.is('application/json')) throw oauthError('invalid_client_metadata', 'JSON regisztráció szükséges.');
      if (body.token_endpoint_auth_method && body.token_endpoint_auth_method !== 'none') throw oauthError('invalid_client_metadata', 'A csatlakozó S256 PKCE-t használ, kliensjelszó nélkül.');
      if (!Array.isArray(body.redirect_uris) || !body.redirect_uris.length || body.redirect_uris.length > 5 || body.redirect_uris.some(uri => typeof uri !== 'string' || !allowedRedirect(uri))) throw oauthError('invalid_redirect_uri', 'Csak engedélyezett ChatGPT visszatérési cím regisztrálható.');
      if (body.grant_types !== undefined && (!Array.isArray(body.grant_types) || !body.grant_types.includes('authorization_code') || body.grant_types.some(type => !['authorization_code','refresh_token'].includes(type)))) throw oauthError('invalid_client_metadata', 'Nem támogatott hozzáférési mód.');
      if (body.response_types !== undefined && (!Array.isArray(body.response_types) || body.response_types.length !== 1 || body.response_types[0] !== 'code')) throw oauthError('invalid_client_metadata', 'Csak code válasz támogatott.');
      const clientId = random('mental_');
      const scopes = parseScopes(body.scope);
      const name = input(body.client_name, 100) || 'ChatGPT';
      const redirects = [...new Set(body.redirect_uris)];
      await pool.query('INSERT INTO mcp_oauth_clients(client_id,client_name,redirect_uris,scopes) VALUES($1,$2,$3,$4)', [clientId,name,JSON.stringify(redirects),scopes]);
      res.status(201).json({client_id:clientId,client_id_issued_at:Math.floor(Date.now()/1000),client_name:name,redirect_uris:redirects,grant_types:['authorization_code','refresh_token'],response_types:['code'],token_endpoint_auth_method:'none',scope:scopes.join(' ')});
    }));
    app.get(PATH + '/authorize', authorizationLimiter, ready, wrap(async(req,res) => {
      let request;
      try { request = await authorizationRequest(req.query); }
      catch(error) {
        if (error.authorizationRequest) return redirectAuthorization(res,error.authorizationRequest,{error:error.oauthError,error_description:error.message});
        throw error;
      }
      await cleanupExpiredRequests();
      const csrf = random(), requestId = random();
      request.request_id = requestId;
      await pool.query(`INSERT INTO mcp_oauth_requests(request_id,client_id,redirect_uri,resource,scopes,state,code_challenge,csrf_hash,expires_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [requestId,request.client_id,request.redirect_uri,request.resource,request.scopes,request.state,request.code_challenge,hash(csrf),expires(REQUEST_SECONDS)]);
      res.cookie(cookieName(requestId), csrf, cookieOptions);
      sendAuthorizationPage(res,request,csrf,await getAdminUser(req));
    }));
    app.post(PATH + '/authorize', credentialLimiter, ready, wrap(async(req,res) => {
      if (!req.is('application/x-www-form-urlencoded') || req.get('origin') !== issuer) throw oauthError('invalid_request', 'Érvénytelen engedélyezési kérés.', 403);
      const requestId = input(req.body?.request_id, 43), csrf = input(req.body?.csrf_token, 43);
      if (!/^[A-Za-z0-9_-]{43}$/.test(requestId) || !/^[A-Za-z0-9_-]{43}$/.test(csrf) || !equal(req.cookies?.[cookieName(requestId)],csrf)) throw oauthError('invalid_request', 'Lejárt vagy érvénytelen engedélyezési kérés.', 403);
      const request = (await pool.query(`SELECT r.*,c.client_name FROM mcp_oauth_requests r JOIN mcp_oauth_clients c ON c.client_id=r.client_id
        WHERE r.request_id=$1 AND r.used_at IS NULL AND r.expires_at>now()`, [requestId])).rows[0];
      if (!request || !equal(request.csrf_hash,hash(csrf))) throw oauthError('invalid_request', 'A kérés lejárt. Indítsd újra a kapcsolódást.', 403);
      if (!['allow','deny'].includes(req.body.decision)) throw oauthError('invalid_request', 'Válassz az engedélyezés és a megszakítás között.');
      let user = await getAdminUser(req);
      if (req.body.decision === 'allow' && !isAdmin(user)) {
        const email = input(req.body.email, 254).trim().toLowerCase(), password = input(req.body.password, 512);
        user = email && password ? await verifyAdminCredentials(email,password) : null;
        if (!isAdmin(user)) return sendAuthorizationPage(res,request,csrf,null,'Hibás e-mail-cím vagy jelszó.',401);
      }
      const code = random('mhc_');
      const consumed = await transaction(async client => {
        const locked = await client.query('UPDATE mcp_oauth_requests SET used_at=now() WHERE request_id=$1 AND used_at IS NULL AND expires_at>now() RETURNING request_id', [requestId]);
        if (!locked.rowCount) return false;
        if (req.body.decision === 'allow') await client.query(`INSERT INTO mcp_oauth_codes(code_hash,client_id,redirect_uri,resource,scopes,email,code_challenge,expires_at)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8)`, [hash(code),request.client_id,request.redirect_uri,request.resource,request.scopes,user.email,request.code_challenge,expires(CODE_SECONDS)]);
        return true;
      });
      res.clearCookie(cookieName(requestId),clearCookieOptions);
      if (!consumed) throw oauthError('invalid_request', 'A kérést már felhasználták. Indítsd újra a kapcsolódást.',403);
      redirectAuthorization(res,request,req.body.decision === 'allow' ? {code} : {error:'access_denied',error_description:'A felhasználó nem engedélyezte a kapcsolatot.'});
    }));
    app.post(PATH + '/token', tokenLimiter, ready, wrap(async(req,res) => {
      if (!req.is('application/x-www-form-urlencoded') && !req.is('application/json')) throw oauthError('invalid_request','Űrlap vagy JSON kérés szükséges.');
      const body = req.body || {};
      if (req.get('authorization') || body.client_secret !== undefined) throw oauthError('invalid_client','A nyilvános klienshez S256 PKCE szükséges.',401);
      if (body.resource !== resourceUrl) throw oauthError('invalid_target','A hozzáférés másik erőforráshoz nem használható.');
      if (body.grant_type === 'authorization_code') return res.json(await exchangeCode(body));
      if (body.grant_type === 'refresh_token') return res.json(await refreshTokens(body));
      throw oauthError('unsupported_grant_type','Csak authorization_code és refresh_token kérés támogatott.');
    }));
    app.post(PATH + '/revoke', tokenLimiter, ready, wrap(async(req,res) => {
      await registeredClient(req.body?.client_id);
      const tokenValue = input(req.body?.token, 50);
      if (/^mh[ar]_[A-Za-z0-9_-]{43}$/.test(tokenValue)) await transaction(async client => {
        const row = (await client.query(`SELECT g.grant_id,g.email FROM mcp_oauth_tokens t JOIN mcp_oauth_grants g ON g.grant_id=t.grant_id
          WHERE t.token_hash=$1 AND g.client_id=$2 AND g.revoked_at IS NULL FOR UPDATE OF g`, [hash(tokenValue),req.body.client_id])).rows[0];
        if (row) {
          await client.query('UPDATE mcp_oauth_grants SET revoked_at=now() WHERE grant_id=$1', [row.grant_id]);
          await audit(client,'mcp_oauth_revoked',row.grant_id,row.email,{client_id:req.body.client_id});
        }
      });
      res.status(200).json({});
    }));
  }
  return {register,requireAccess,metadata,resourceMetadata,resourceUrl,resourceMetadataUrl,issuer};
}

module.exports = {createMcpOAuth,allowedRedirect,parseScopes,validVerifier,challengeFor,SCOPES};
