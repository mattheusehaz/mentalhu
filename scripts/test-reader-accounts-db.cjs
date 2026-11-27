'use strict';

// Real PostgreSQL and HTTP routes, fresh local schema, no network mail transport.
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const fs=require('node:fs');
const path=require('node:path');
const express=require('express');
const cookieParser=require('cookie-parser');
const {Pool}=require('pg');
const {createProviderAccountService,hash}=require('../lib/provider-accounts.cjs');
const {createProviderProfileService}=require('../lib/provider-profiles.cjs');
const connectionString=process.env.TEST_DATABASE_URL;
assert(connectionString,'TEST_DATABASE_URL must identify a disposable local test database');
const database=new URL(connectionString);
assert(['localhost','127.0.0.1','[::1]'].includes(database.hostname)&&/test/i.test(database.pathname),'Disposable loopback PostgreSQL required');
const schema='reader_accounts_test_'+crypto.randomBytes(8).toString('hex');
const control=new Pool({connectionString,ssl:false}),db=new Pool({connectionString,ssl:false,options:'-c search_path='+schema});
const key=crypto.randomBytes(32);
let service,server,base,created=false;
function seal(value){const iv=crypto.randomBytes(12),cipher=crypto.createCipheriv('aes-256-gcm',key,iv);const encrypted=Buffer.concat([cipher.update(JSON.stringify(value)),cipher.final()]);return [iv,cipher.getAuthTag(),encrypted].map(value=>value.toString('base64url')).join('.');}
function unseal(value){const [iv,tag,encrypted]=value.split('.').map(value=>Buffer.from(value,'base64url'));const cipher=crypto.createDecipheriv('aes-256-gcm',key,iv);cipher.setAuthTag(tag);return JSON.parse(Buffer.concat([cipher.update(encrypted),cipher.final()]).toString());}
const mailer={ready:async()=>false,seal,unseal,send:async()=>{throw new Error('A real email must never be attempted in this test');}};
function browser(cookies={}){
  const jar={...cookies};let csrf;
  return {jar,async request(route,{method='GET',data,origin=base,withCsrf=true,legacyCsrf=false}={}){
    const response=await fetch(base+route,{method,headers:{Origin:origin,'Content-Type':'application/json',Cookie:Object.entries(jar).map(([name,value])=>name+'='+value).join('; '),...(withCsrf&&csrf?{[legacyCsrf?'X-Provider-CSRF':'X-Account-CSRF']:csrf}:{})},...(data?{body:JSON.stringify(data)}:{})});
    for(const entry of response.headers.getSetCookie()){const [name,value]=entry.split(';')[0].split('=');if(value)jar[name]=value;else delete jar[name];}
    const type=response.headers.get('content-type')||'',body=type.includes('application/json')?await response.json():await response.text();
    if(body?.csrf_token)csrf=body.csrf_token;
    return {status:response.status,body,headers:response.headers};
  },bootstrap(){return this.request('/api/account/session');}};
}
const account=async email=>(await db.query('SELECT * FROM provider_accounts WHERE email=$1',[email])).rows[0];
const mail=async(email,kind)=>(await db.query('SELECT m.* FROM provider_account_mail m JOIN provider_accounts a ON a.id=m.account_id WHERE a.email=$1 AND m.kind=$2 ORDER BY m.created_at DESC,m.id DESC LIMIT 1',[email,kind])).rows[0];
function tokenOf(job){return /#token=([A-Za-z0-9_-]{43})/.exec(unseal(job.payload_ciphertext).text)[1];}
async function activate(client,email,password='Reader-password-123'){
  const job=await mail(email,'setup'),token=tokenOf(job);
  const result=await client.request('/api/account/activate',{method:'POST',data:{token,password,consent:true}});
  assert.equal(result.status,200);return result;
}
async function main(){
  await control.query('CREATE SCHEMA '+schema);created=true;
  for(const filename of ['001_init.sql','002_directory.sql','016_provider_accounts.sql','017_submission_trash.sql','018_provider_listing_owners.sql'])await db.query(fs.readFileSync(path.join(__dirname,'../migrations',filename),'utf8'));
  const legacy=(await db.query("INSERT INTO provider_accounts(email,display_name,email_verified_at,approved_at) VALUES('legacy@example.test','Meglévő szolgáltató',now(),now()) RETURNING *")).rows[0];
  const migration=fs.readFileSync(path.join(__dirname,'../migrations/021_reader_accounts.sql'),'utf8');await db.query(migration);
  assert((await account(legacy.email)).provider_profile_started_at,'Migration preserves existing provider capability');
  const app=express();app.use(express.json());app.use(cookieParser());
  service=createProviderAccountService({pool:db,dbState:{ready:true},secret:'isolated-reader-account-secret',baseUrl:'http://127.0.0.1',mailer,env:{NODE_ENV:'test'}});
  service.register(app);
  createProviderProfileService({pool:db,dbState:{ready:true},auth:(_req,res)=>res.status(401).end(),accounts:service}).register(app);
  app.get('/account-only',service.requireAccount,(req,res)=>res.json({generic:req.accountUser,legacy:req.providerUser}));
  server=await new Promise(resolve=>{const listener=app.listen(0,'127.0.0.1',()=>resolve(listener));});base='http://127.0.0.1:'+server.address().port;

  const anon=browser(),reader=browser();await anon.bootstrap();await reader.bootstrap();
  assert.equal((await anon.request('/api/account/provider-profile/start',{method:'POST',data:{}})).status,401);
  assert.equal((await reader.request('/api/account/register',{method:'POST',withCsrf:false,data:{email:'reader@example.test',display_name:'Olvasó',consent:true}})).status,403);
  const registration=await reader.request('/api/account/register',{method:'POST',data:{email:'Reader@Example.Test',display_name:'Teszt Olvasó',consent:true,is_provider:true,approved:true,next:'/szolgaltato/teszt-szakember#ertekelesek'}});
  assert.equal(registration.status,202);const pending=await account('reader@example.test');assert(!pending.provider_profile_started_at);assert(!pending.email_verified_at);assert(!pending.approved_at);
  await db.query(migration);assert(!(await account('reader@example.test')).provider_profile_started_at,'Reapplying migration never promotes new readers');
  const setup=await mail(pending.email,'setup'),envelope=unseal(setup.payload_ciphertext);
  assert.match(envelope.subject,/regisztrációdat/);assert(!setup.payload_ciphertext.includes(pending.email));
  assert(envelope.text.includes('?next=%2Fszolgaltato%2Fteszt-szakember%23ertekelesek#token='),'Safe return path survives confirmation mail without moving token into query');
  assert.equal((await reader.bootstrap()).body.authenticated,false,'Pending email cannot authenticate');
  const token=tokenOf(setup),info=await reader.request('/api/account/token-info',{method:'POST',data:{token}});
  assert.equal(info.body.next,'/szolgaltato/teszt-szakember#ertekelesek');assert(!(await account(pending.email)).email_verified_at,'Token-info is read-only');
  const active=await activate(reader,pending.email);assert.equal(active.body.user.is_provider,false);assert.equal(active.body.user.has_provider_profile,false);assert.equal(active.body.user.approved,false);
  assert.equal(active.body.next,info.body.next);assert(reader.jar.mental_provider,'Existing session cookie remains compatible');
  const self=await reader.request('/api/account/me');assert.equal(self.body.user.id,pending.id);assert.equal(self.body.user.email_verified,true);
  const aliases=await reader.request('/account-only');assert.deepEqual(aliases.body.generic,aliases.body.legacy);
  const before=(await db.query('SELECT count(*)::int AS n FROM directory_listings')).rows[0].n;
  for(const route of ['/api/account/provider-profile','/api/provider/profile']){
    const profile=await reader.request(route);assert.equal(profile.status,200);assert.equal(profile.body.has_provider_profile,false);assert.equal(profile.body.listing,null);assert.deepEqual(profile.body.categories,[]);
    const denied=await reader.request(route,{method:'PUT',data:{name:'Nem engedélyezett',action:'submit'}});assert.equal(denied.status,403);assert.equal(denied.body.code,'PROVIDER_PROFILE_REQUIRED');
  }
  assert.equal((await db.query('SELECT count(*)::int AS n FROM directory_listings')).rows[0].n,before,'Reading or directly writing profile endpoints cannot auto-upgrade a reader');
  assert(!(await account(pending.email)).provider_profile_started_at);
  const oldRegister=browser();await oldRegister.bootstrap();
  await oldRegister.request('/api/provider/register',{method:'POST',legacyCsrf:true,data:{email:'alias-reader@example.test',display_name:'Alias olvasó',consent:true,next:'https://evil.example'}});
  assert(!(await account('alias-reader@example.test')).provider_profile_started_at,'Legacy registration endpoint also starts as reader');
  assert.equal((await oldRegister.request('/api/account/token-info',{method:'POST',data:{token:tokenOf(await mail('alias-reader@example.test','setup'))}})).body.next,'/fiokom','External email return targets are rejected');

  assert.equal((await reader.request('/api/account/provider-profile/start',{method:'POST',withCsrf:false,data:{}})).status,403);
  assert.equal((await reader.request('/api/account/provider-profile/start',{method:'POST',origin:'https://other.example',data:{}})).status,403);
  const starts=await Promise.all([reader.request('/api/account/provider-profile/start',{method:'POST',data:{}}),reader.request('/api/account/provider-profile/start',{method:'POST',data:{}})]);
  assert(starts.every(result=>result.status===200&&result.body.user.is_provider));assert(starts.every(result=>result.body.listing===null));
  assert.equal((await db.query("SELECT count(*)::int AS n FROM provider_account_events WHERE account_id=$1 AND event_type='provider_profile_started'",[pending.id])).rows[0].n,1,'Concurrent start is idempotent');
  assert.equal((await account(pending.email)).id,pending.id,'Provider extension uses the same reader account');
  assert(!(await account(pending.email)).approved_at,'Provider extension is not moderation approval');
  const userSession=await reader.bootstrap();assert(userSession.body.user.has_provider_profile);
  const unrelated=(await db.query("INSERT INTO directory_listings(slug,name,email,status) VALUES('email-matching-listing','Nem igényelhető',$1,'published') RETURNING id",[pending.email])).rows[0];
  assert.equal((await reader.request('/api/account/provider-profile')).body.listing,null,'Matching directory email grants no listing ownership');
  const complete={name:'Saját szolgáltatói adatlap',short_description:'Személyes és online pszichológiai konzultáció.',description:'Ez egy elkülönített tesztadatlap részletes leírással, kizárólag a regisztrációs munkafolyamat ellenőrzéséhez.',city:'Budapest',category_slugs:['pszichologusok'],action:'submit'};
  const submitted=await reader.request('/api/account/provider-profile',{method:'PUT',data:complete});assert.equal(submitted.status,200);assert.equal(submitted.body.listing.status,'pending');assert.equal(submitted.body.submission_status,'new');assert.notEqual(submitted.body.listing.id,unrelated.id);
  const owner=(await db.query('SELECT * FROM provider_listing_owners WHERE account_id=$1',[pending.id])).rows[0];assert.equal(owner.listing_id,submitted.body.listing.id);
  const submission=(await db.query('SELECT * FROM directory_submissions WHERE provider_account_id=$1',[pending.id])).rows[0];assert.equal(submission.email,pending.email);
  assert.equal((await reader.request('/api/account/provider-profile',{method:'PUT',data:{action:'publish'}})).status,403,'Publishing still needs editorial approval');

  const second=browser();await second.bootstrap();
  const logged=await second.request('/api/account/login',{method:'POST',data:{email:pending.email,password:'Reader-password-123'}});assert.equal(logged.status,200);assert.equal(logged.body.user.id,pending.id);assert(logged.body.user.is_provider);
  const resetReply=await reader.request('/api/account/forgot-password',{method:'POST',data:{email:pending.email,next:'/fiokom?szolgaltato=1'}});
  const unknownReply=await anon.request('/api/account/forgot-password',{method:'POST',data:{email:'missing@example.test',next:'/fiokom?szolgaltato=1'}});assert.deepEqual(resetReply.body,unknownReply.body,'Reset does not reveal whether a mailbox is registered');
  const resetJob=await mail(pending.email,'reset'),resetEnvelope=unseal(resetJob.payload_ciphertext);assert(resetEnvelope.text.includes('MENTÁL.hu-fiókodhoz'));assert(!resetEnvelope.text.includes('szolgáltatói fiókodhoz'));
  const reset=await reader.request('/api/account/reset-password',{method:'POST',data:{token:tokenOf(resetJob),password:'Reader-new-password-456'}});assert.equal(reset.status,200);assert.equal(reset.body.next,'/fiokom?szolgaltato=1');
  assert.equal((await second.bootstrap()).body.authenticated,false,'Password reset revokes all existing sessions');
  const signedIn=await second.request('/api/account/login',{method:'POST',data:{email:pending.email,password:'Reader-new-password-456'}});assert.equal(signedIn.status,200);assert(signedIn.body.user.is_provider,'Password reset preserves provider extension and explicit listing ownership');
  assert.equal((await second.request('/api/account/logout',{method:'POST',data:{}})).status,200);assert.equal((await second.bootstrap()).body.authenticated,false);
  const adminOnly=browser({mental_cms:'admin-is-not-a-reader'});assert.equal((await adminOnly.request('/account-only')).status,401);
  const savedLegacy=await account(legacy.email);assert(savedLegacy.provider_profile_started_at&&savedLegacy.approved_at,'Existing provider approval and extension remain unchanged');
  assert.equal((await db.query('SELECT count(*)::int AS n FROM provider_account_mail WHERE attempts>0')).rows[0].n,0,'No email delivery attempted');
  console.log('READER_ACCOUNTS_DB_OK',JSON.stringify({newAccountsAreReaders:true,legacyAliases:true,legacyProvidersPreserved:true,migrationRepeatSafe:true,verifiedAccountOnly:true,explicitUpgrade:true,noAutoCreateOnRead:true,noDirectSubmitByReader:true,csrf:true,sameAccount:true,noEmailClaim:true,pendingModeration:true,safeReturnLinks:true,passwordReset:true,resetRevokesAllSessions:true,realEmailsSent:0}));
}
main().catch(error=>{console.error(error.stack);process.exitCode=1;}).finally(async()=>{
  service?.stop();if(server)await new Promise(resolve=>server.close(resolve));await db.end();if(created)await control.query('DROP SCHEMA '+schema+' CASCADE');await control.end();
});
