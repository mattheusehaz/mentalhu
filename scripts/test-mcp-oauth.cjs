'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const {once} = require('node:events');
const {createMcpOAuth, allowedRedirect, parseScopes, validVerifier, challengeFor, SCOPES} = require('../lib/mcp-oauth.cjs');

const redirectUri = 'https://chatgpt.com/connector_platform_oauth_redirect';

test('OAuth only registers exact HTTPS ChatGPT callbacks', () => {
  assert(allowedRedirect(redirectUri));
  assert(allowedRedirect('https://chatgpt.com/connector/oauth/12345678-abcd-efgh'));
  for (const uri of ['http://chatgpt.com/connector_platform_oauth_redirect','https://chatgpt.com.evil.example/connector_platform_oauth_redirect','https://evil.example/?next='+redirectUri,'https://user@chatgpt.com/connector_platform_oauth_redirect',redirectUri+'?redirect=https://evil.example',redirectUri+'#fragment',redirectUri+'/', 'https://chatgpt.com:444/connector_platform_oauth_redirect','http://127.0.0.1/callback']) assert.equal(allowedRedirect(uri),false,uri);
});

test('OAuth scope and PKCE helpers reject widening or weak proofs', () => {
  assert.deepEqual(parseScopes(undefined),SCOPES);
  assert.deepEqual(parseScopes('mental:read mental:read'),['mental:read']);
  assert.throws(() => parseScopes('mental:write',['mental:read']), /jogosultság/);
  assert.throws(() => parseScopes(['mental:read']), /jogosultság/);
  const verifier = crypto.randomBytes(32).toString('base64url');
  assert(validVerifier(verifier));assert.equal(challengeFor(verifier).length,43);
  assert(!validVerifier('short'));assert(!validVerifier('x'.repeat(129)));assert(!validVerifier('é'.repeat(43)));
  assert.throws(() => createMcpOAuth({pool:{},dbState:{ready:true},baseUrl:'https://mental.hu/attacker-path'}), /BASE_URL/);
  assert.throws(() => createMcpOAuth({pool:{},dbState:{ready:true},baseUrl:'http://mental.hu'}), /BASE_URL/);
});

const connectionString = process.env.DATABASE_URL;
let localDatabase = false;
if (connectionString) {
  const database = new URL(connectionString);
  localDatabase = ['postgres:','postgresql:'].includes(database.protocol) && ['127.0.0.1','localhost','[::1]'].includes(database.hostname) && /^\/[a-zA-Z0-9_]*test[a-zA-Z0-9_]*$/.test(database.pathname);
  assert(localDatabase, 'MCP OAuth integration tests require a disposable loopback test database');
}

test('OAuth HTTP and PostgreSQL flow binds consent, codes, resource, scopes and rotated tokens', {skip:!localDatabase,timeout:60000}, async() => {
  const express = require('express');
  const cookieParser = require('cookie-parser');
  const {Pool} = require('pg');
  const {buildDatabaseConfig} = require('../lib/database-config.cjs');
  const pool = new Pool(buildDatabaseConfig());
  const app = express();
  app.use(express.json({limit:'32kb'}));app.use(express.urlencoded({extended:false,limit:'32kb'}));app.use(cookieParser());
  const server = app.listen(0,'127.0.0.1');
  await once(server,'listening');
  const baseUrl = 'http://127.0.0.1:' + server.address().port;
  const resource = baseUrl + '/mcp';
  const email = 'oauth-test-'+crypto.randomBytes(6).toString('hex')+'@example.test';
  const password = crypto.randomBytes(24).toString('base64url');
  const adminSession = crypto.randomBytes(24).toString('base64url');
  const clientIds = [];
  const oauth = createMcpOAuth({pool,dbState:{ready:true},baseUrl,
    getAdminUser:req => req.cookies.admin_fixture === adminSession ? {email,role:'admin'} : null,
    verifyAdminCredentials:async(inputEmail,inputPassword) => inputEmail === email && inputPassword === password ? {email,role:'admin'} : null
  });
  oauth.register(app);
  app.get('/probe/read',oauth.requireAccess(['mental:read']),(req,res)=>res.json({email:req.mcpAuth.email,scopes:req.mcpAuth.scopes}));
  app.get('/probe/write',oauth.requireAccess(['mental:read','mental:write']),(req,res)=>res.json({ok:true}));
  app.use((error,_req,res,_next)=>{res.status(500).json({error:error.code || 'TEST_FAILURE'});});
  const request = (uri,options={}) => fetch(baseUrl+uri,{...options,redirect:'manual'});
  const form = (uri,data,headers={}) => request(uri,{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded',...headers},body:new URLSearchParams(data).toString()});
  const register = async(scope=SCOPES.join(' '),name='ChatGPT test') => {
    const response = await request('/mcp/oauth/register',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({client_name:name,redirect_uris:[redirectUri],scope,token_endpoint_auth_method:'none'})});
    assert.equal(response.status,201);const client=await response.json();clientIds.push(client.client_id);return client;
  };
  const startAuthorization = async(client,scope=client.scope,extra={},session=false) => {
    const verifier = crypto.randomBytes(32).toString('base64url');
    const params = {response_type:'code',client_id:client.client_id,redirect_uri:redirectUri,resource,state:crypto.randomBytes(16).toString('hex'),scope,code_challenge:challengeFor(verifier),code_challenge_method:'S256',...extra};
    const response = await request('/mcp/oauth/authorize?'+new URLSearchParams(params),{headers:session?{cookie:'admin_fixture='+adminSession}:{}});
    const html = await response.text();
    return {response,html,params,verifier,cookie:response.headers.get('set-cookie')?.split(';')[0],request_id:html.match(/name="request_id" value="([^"]+)"/)?.[1],csrf_token:html.match(/name="csrf_token" value="([^"]+)"/)?.[1]};
  };
  const approve = async(start,additional={},session=false) => {
    const response = await form('/mcp/oauth/authorize',{request_id:start.request_id,csrf_token:start.csrf_token,decision:'allow',email,password,...additional},{origin:baseUrl,cookie:start.cookie+(session?'; admin_fixture='+adminSession:'')});
    return {response,location:response.headers.get('location') ? new URL(response.headers.get('location')) : null};
  };
  const exchange = (client,start,code,additional={}) => form('/mcp/oauth/token',{grant_type:'authorization_code',client_id:client.client_id,resource,redirect_uri:redirectUri,code,code_verifier:start.verifier,...additional});
  const refresh = (client,token,additional={}) => form('/mcp/oauth/token',{grant_type:'refresh_token',client_id:client.client_id,resource,refresh_token:token,...additional});
  const probe = (access,kind='read') => request('/probe/'+kind,{headers:{authorization:'Bearer '+access}});
  try {
    await pool.query(fs.readFileSync(path.join(__dirname,'../migrations/012_mcp_oauth.sql'),'utf8'));
    const discovery = await request('/.well-known/oauth-authorization-server');
    const metadata = await discovery.json();assert.equal(metadata.issuer,baseUrl);assert.equal(metadata.authorization_response_iss_parameter_supported,true);assert.deepEqual(metadata.code_challenge_methods_supported,['S256']);assert.deepEqual(metadata.token_endpoint_auth_methods_supported,['none']);
    const protectedMetadata = await (await request('/.well-known/oauth-protected-resource/mcp')).json();assert.equal(protectedMetadata.resource,resource);assert.deepEqual(protectedMetadata.authorization_servers,[baseUrl]);
    const anonymous = await request('/probe/read');assert.equal(anonymous.status,401);assert(anonymous.headers.get('www-authenticate').includes('/.well-known/oauth-protected-resource/mcp'));
    const badRegistration = await request('/mcp/oauth/register',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({redirect_uris:['https://evil.example/callback']})});assert.equal(badRegistration.status,400);

    const readClient = await register('mental:read','<svg onload=alert(1)>');
    const badPkce = await startAuthorization(readClient,'mental:read',{code_challenge_method:'plain'});assert.equal(badPkce.response.status,303);const badPkceCallback=new URL(badPkce.response.headers.get('location'));assert.equal(badPkceCallback.searchParams.get('error'),'invalid_request');assert.equal(badPkceCallback.searchParams.get('iss'),baseUrl);
    const badRedirect = await startAuthorization(readClient,'mental:read',{redirect_uri:'https://evil.example/callback'});assert.equal(badRedirect.response.status,400);assert.equal(badRedirect.response.headers.get('location'),null);
    const started = await startAuthorization(readClient);assert.equal(started.response.status,200);assert(started.html.includes('&lt;svg'));assert(!started.html.includes('<svg'));assert(started.cookie);assert.equal(started.response.headers.get('cache-control'),'no-store');
    assert(started.response.headers.get('content-security-policy').includes("form-action 'self' " + redirectUri + ';'),'Consent must allow the exact ChatGPT callback after form submission');
    const missingOrigin = await form('/mcp/oauth/authorize',{request_id:started.request_id,csrf_token:started.csrf_token,decision:'allow',email,password},{cookie:started.cookie});assert.equal(missingOrigin.status,403);
    const wrongCsrf = await approve(started,{csrf_token:'a'.repeat(43)});assert.equal(wrongCsrf.response.status,403);
    const wrongPassword = await approve(started,{password:'incorrect'});assert.equal(wrongPassword.response.status,401);const wrongPasswordBody=await wrongPassword.response.text();assert(!wrongPasswordBody.includes('incorrect'));assert(!wrongPasswordBody.includes(password));
    const consent = await approve(started);assert.equal(consent.response.status,303);assert.equal(consent.location.origin,'https://chatgpt.com');assert.equal(consent.location.searchParams.get('state'),started.params.state);assert.equal(consent.location.searchParams.get('iss'),baseUrl);
    const consentReplay = await approve(started);assert.equal(consentReplay.response.status,403);
    const code = consent.location.searchParams.get('code');assert(code);
    const wrongProof = await exchange(readClient,started,code,{code_verifier:crypto.randomBytes(32).toString('base64url')});assert.equal(wrongProof.status,400);assert.equal((await wrongProof.json()).error,'invalid_grant');
    const wrongResource = await exchange(readClient,started,code,{resource:'https://evil.example/mcp'});assert.equal(wrongResource.status,400);assert.equal((await wrongResource.json()).error,'invalid_target');
    const redeemed = await exchange(readClient,started,code);assert.equal(redeemed.status,200);const tokens = await redeemed.json();assert.equal(tokens.scope,'mental:read');assert.equal(tokens.token_type,'Bearer');assert(tokens.expires_in>3500);assert.notEqual(tokens.access_token,tokens.refresh_token);
    assert.equal((await probe(tokens.access_token)).status,200);const deniedWrite=await probe(tokens.access_token,'write');assert.equal(deniedWrite.status,403);assert(deniedWrite.headers.get('www-authenticate').includes('insufficient_scope'));
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM mcp_oauth_codes WHERE code_hash=$1',[code])).rows[0].n,0,'Raw authorization codes are never stored');
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM mcp_oauth_tokens WHERE token_hash=$1',[tokens.access_token])).rows[0].n,0,'Raw access tokens are never stored');
    const readGrant = (await pool.query('SELECT grant_id FROM mcp_oauth_grants WHERE client_id=$1',[readClient.client_id])).rows[0].grant_id;
    const restartOAuth=createMcpOAuth({pool,dbState:{ready:true},baseUrl});app.get('/probe/restart',restartOAuth.requireAccess(['mental:read']),(_req,res)=>res.json({ok:true}));assert.equal((await request('/probe/restart',{headers:{authorization:'Bearer '+tokens.access_token}})).status,200,'Auth survives a new server instance');
    const scopeExpansion = await refresh(readClient,tokens.refresh_token,{scope:'mental:read mental:write'});assert.equal(scopeExpansion.status,400);assert.equal((await scopeExpansion.json()).error,'invalid_scope');
    const rotatedResponse = await refresh(readClient,tokens.refresh_token);assert.equal(rotatedResponse.status,200);const rotated=await rotatedResponse.json();assert.notEqual(rotated.refresh_token,tokens.refresh_token);assert.equal((await probe(rotated.access_token)).status,200);
    const refreshReplay = await refresh(readClient,tokens.refresh_token);assert.equal(refreshReplay.status,400);assert.equal((await probe(rotated.access_token)).status,401,'A replay revokes the entire token family');
    assert((await pool.query('SELECT revoked_at FROM mcp_oauth_grants WHERE grant_id=$1',[readGrant])).rows[0].revoked_at);

    const fullClient = await register();
    const sessionStart = await startAuthorization(fullClient,fullClient.scope,{},true);assert(sessionStart.html.includes('Bejelentkezve'));assert(!sessionStart.html.includes('name="password"'));
    const sessionConsent = await approve(sessionStart,{email:'',password:''},true);assert.equal(sessionConsent.response.status,303);
    const fullCode=sessionConsent.location.searchParams.get('code');const fullRedeemed=await exchange(fullClient,sessionStart,fullCode);assert.equal(fullRedeemed.status,200);const fullTokens=await fullRedeemed.json();assert.equal((await probe(fullTokens.access_token,'write')).status,200);
    const wrongClientRefresh = await refresh(readClient,fullTokens.refresh_token);assert.equal(wrongClientRefresh.status,400);assert.equal((await probe(fullTokens.access_token)).status,200,'Wrong clients cannot revoke another client’s grant');
    const replayCode = await exchange(fullClient,sessionStart,fullCode);assert.equal(replayCode.status,400);assert.equal((await probe(fullTokens.access_token)).status,401,'Replaying a valid used code revokes its issued grant');

    const revokeStart=await startAuthorization(fullClient);const revokeConsent=await approve(revokeStart);const revokeRedeemed=await exchange(fullClient,revokeStart,revokeConsent.location.searchParams.get('code'));const revokeTokens=await revokeRedeemed.json();assert.equal(revokeRedeemed.status,200);
    const accessHash=crypto.createHash('sha256').update(revokeTokens.access_token).digest('hex');await pool.query("UPDATE mcp_oauth_tokens SET expires_at=now()-interval '1 second' WHERE token_hash=$1",[accessHash]);assert.equal((await probe(revokeTokens.access_token)).status,401,'Expired access cannot read editorial data');
    const recovered=await refresh(fullClient,revokeTokens.refresh_token);assert.equal(recovered.status,200);const recoveredTokens=await recovered.json();
    const revoked=await form('/mcp/oauth/revoke',{client_id:fullClient.client_id,token:recoveredTokens.refresh_token});assert.equal(revoked.status,200);assert.equal((await probe(recoveredTokens.access_token)).status,401);assert.equal((await refresh(fullClient,recoveredTokens.refresh_token)).status,400);
    const repeatRevoke=await form('/mcp/oauth/revoke',{client_id:fullClient.client_id,token:recoveredTokens.refresh_token});assert.equal(repeatRevoke.status,200);

    const denyStart=await startAuthorization(fullClient);const denied=await approve(denyStart,{decision:'deny',email:'',password:''});assert.equal(denied.response.status,303);assert.equal(denied.location.searchParams.get('error'),'access_denied');assert.equal(denied.location.searchParams.get('iss'),baseUrl);assert.equal(denied.location.searchParams.has('code'),false);
    const logs=(await pool.query("SELECT details FROM cms_audit_log WHERE entity_type='mcp_oauth' AND details->>'client_id'=ANY($1::text[])",[clientIds])).rows;
    const logText=JSON.stringify(logs);for(const secret of [password,code,tokens.access_token,tokens.refresh_token,recoveredTokens.access_token])assert(!logText.includes(secret),'Audit must not contain credentials or raw tokens');
  } finally {
    await new Promise(resolve=>server.close(resolve));
    try { await pool.query("DELETE FROM cms_audit_log WHERE entity_type='mcp_oauth' AND details->>'client_id'=ANY($1::text[])",[clientIds]);await pool.query('DELETE FROM mcp_oauth_clients WHERE client_id=ANY($1::text[])',[clientIds]); }
    finally { await pool.end(); }
  }
});
