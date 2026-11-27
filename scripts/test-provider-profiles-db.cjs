'use strict';

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
assert(connectionString,'TEST_DATABASE_URL must point to disposable local PostgreSQL');
const database=new URL(connectionString);
assert(['localhost','127.0.0.1','[::1]'].includes(database.hostname)&&/test/.test(database.pathname),'Disposable local test database required');
const schema='provider_profiles_test_'+crypto.randomBytes(8).toString('hex');
const admin=new Pool({connectionString,ssl:false});
const db=new Pool({connectionString,ssl:false,options:'-c search_path='+schema});
const dbState={ready:true};
let accounts,server,base;
const mailer={ready:async()=>false,seal:JSON.stringify,unseal:JSON.parse,send:async()=>{throw new Error('No email transport permitted in profile tests');}};

function client(cookies={},adminAccess=false){
 const jar={...cookies};let csrf;
 return {
  jar,
  async call(route,{method='GET',data,includeCsrf=true,origin=base}={}){
   const response=await fetch(base+route,{method,headers:{'Content-Type':'application/json',Origin:origin,Cookie:Object.entries(jar).map(([k,v])=>k+'='+v).join('; '),...(includeCsrf&&csrf?{'X-Provider-CSRF':csrf}:{}),...(adminAccess?{'X-Isolated-Admin':'fixture-only'}:{})},...(data?{body:JSON.stringify(data)}:{})});
   for(const item of response.headers.getSetCookie()){const [name,value]=item.split(';')[0].split('=');if(value)jar[name]=value;else delete jar[name];}
   const body=(response.headers.get('content-type')||'').includes('application/json')?await response.json():null;
   if(body?.csrf_token)csrf=body.csrf_token;
   return {status:response.status,body,headers:response.headers};
  },
  bootstrap(){return this.call('/api/provider/session');},
  put(data,options={}){return this.call('/api/provider/profile',{method:'PUT',data,...options});}
 };
}

async function seedAccount(email,{approved=false}={}){
 const row=(await db.query("INSERT INTO provider_accounts(email,display_name,password_hash,email_verified_at,approved_at,consent_at,consent_version,provider_profile_started_at) VALUES($1,'Teszt Szolgáltató','private-hash-must-not-leak',now(),CASE WHEN $2 THEN now() ELSE NULL END,now(),'test',now()) RETURNING id,email",[email,approved])).rows[0];
 const token=crypto.randomBytes(32).toString('hex');
 await db.query("INSERT INTO provider_account_sessions(session_hash,account_id,expires_at) VALUES($1,$2,now()+interval '1 day')",[hash(token),row.id]);
 const session=client({mental_provider:token});await session.bootstrap();return {...row,token,client:session};
}

async function publicCount(slug){return (await db.query("SELECT count(l.id)::int AS n FROM directory_categories c JOIN directory_listing_categories lc ON lc.category_id=c.id JOIN directory_listings l ON l.id=lc.listing_id AND l.status='published' WHERE c.active=true AND c.slug=$1",[slug])).rows[0].n;}
async function readListing(id){return (await db.query('SELECT * FROM directory_listings WHERE id=$1',[id])).rows[0];}
const complete={name:'Teszt pszichológiai rendelő',short_description:'Személyes és online pszichológiai konzultáció.',description:'Ez egy izolált tesztadatlap. Részletes tájékoztató szöveget használunk a szolgáltatások bemutatására.',city:'Budapest',category_slugs:['pszichologusok'],phone:'+36 1 555 0100'};

async function main(){
 await admin.query('CREATE SCHEMA '+schema);
 const connection=await db.connect();
 try{
  await connection.query('BEGIN');
  for(const file of ['001_init.sql','002_directory.sql','016_provider_accounts.sql','017_submission_trash.sql','018_provider_listing_owners.sql','021_reader_accounts.sql'])await connection.query(fs.readFileSync(path.join(__dirname,'../migrations',file),'utf8'));
  await connection.query('COMMIT');
 }catch(error){await connection.query('ROLLBACK');throw error;}finally{connection.release();}
 await db.query("UPDATE directory_categories SET active=false WHERE slug='coachok'");
 const app=express();app.use(express.json());app.use(cookieParser());
 accounts=createProviderAccountService({pool:db,dbState,secret:'isolated-provider-profile-secret',baseUrl:'http://127.0.0.1',mailer,env:{NODE_ENV:'test'}});
 accounts.register(app);
 const auth=(req,res,next)=>{if(req.get('X-Isolated-Admin')!=='fixture-only')return res.status(401).json({error:'Admin authentication required'});req.user={email:'admin@example.test'};next();};
 createProviderProfileService({pool:db,dbState,auth,accounts}).register(app);
 server=await new Promise(resolve=>{const listener=app.listen(0,'127.0.0.1',()=>resolve(listener));});base='http://127.0.0.1:'+server.address().port;

 const anonymous=client();await anonymous.bootstrap();assert.equal((await anonymous.call('/api/provider/profile')).status,401);
 const adminSession=client({},true);await adminSession.bootstrap();
 const a=await seedAccount('owner-a@example.test'),b=await seedAccount('owner-b@example.test',{approved:true});
 const preexisting=(await db.query("INSERT INTO directory_listings(slug,name,email,status,verified,admin_notes) VALUES('existing-directory-entry','Meglévő katalógusadat',$1,'published',true,'Private moderation note') RETURNING id",[a.email])).rows[0];
 await db.query("INSERT INTO directory_listing_categories(listing_id,category_id) SELECT $1,id FROM directory_categories WHERE slug='pszichologusok'",[preexisting.id]);
 const initial=await a.client.call('/api/provider/profile');assert.equal(initial.status,200);assert.equal(initial.body.listing,null,'Matching a catalog email does not grant ownership');
 assert.equal(initial.body.user.approved,false);assert(initial.body.categories.some(row=>row.slug==='pszichologusok'));assert(!initial.body.categories.some(row=>row.slug==='coachok'));
 assert.match(initial.headers.get('cache-control'),/no-store/);
 assert.equal((await a.client.put({name:'Draft'},{includeCsrf:false})).status,403);
 assert.equal((await a.client.put({name:'Draft'},{origin:'https://hostile.example'})).status,403);

 const first=await a.client.put({name:complete.name});assert.equal(first.status,200);const ownId=first.body.listing.id;
 assert.notEqual(ownId,preexisting.id);assert.equal(first.body.listing.status,'draft');assert.equal(first.body.listing.email,a.email);
 assert.equal((await db.query('SELECT count(*)::int AS n FROM provider_listing_owners WHERE account_id=$1',[a.id])).rows[0].n,1);
 assert.equal((await b.client.call('/api/provider/profile')).body.listing,null,'Another provider cannot read the owned profile');
 for(const [field,value] of Object.entries({id:preexisting.id,listing_id:preexisting.id,slug:'existing-directory-entry',status:'published',verified:true,featured:true,admin_notes:'overwrite',account_id:b.id})){
  const denied=await a.client.put({...complete,[field]:value});assert.equal(denied.status,400,field);assert.equal(denied.body.code,'FIELD_NOT_ALLOWED');
 }
 assert.equal((await a.client.put({...complete,email:b.email})).body.code,'EMAIL_NOT_VERIFIED');
 assert.equal((await a.client.put({...complete,category_slugs:['coachok']})).body.code,'CATEGORY_UNAVAILABLE');
 assert.equal((await a.client.put({...complete,category_slugs:['not-a-real-category']})).body.code,'CATEGORY_UNAVAILABLE');
 assert.equal((await readListing(preexisting.id)).admin_notes,'Private moderation note');
 assert.equal((await readListing(preexisting.id)).verified,true);

 const submitted=await a.client.put({...complete,action:'submit'});assert.equal(submitted.status,200);assert.equal(submitted.body.listing.status,'pending');assert.equal(submitted.body.submission_status,'new');
 const submission=(await db.query('SELECT * FROM directory_submissions WHERE provider_account_id=$1',[a.id])).rows[0];
 assert.equal(submission.email,a.email);assert.equal(submission.category_slugs,'pszichologusok');assert.equal(submission.consent,true);
 await a.client.put({...complete,description:complete.description+' Frissített leírás.',action:'submit'});
 assert.equal((await db.query('SELECT count(*)::int AS n FROM directory_submissions WHERE provider_account_id=$1',[a.id])).rows[0].n,1,'Resubmission updates the existing application');
 const unapproved=await a.client.put({...complete,action:'publish'});assert.equal(unapproved.status,403);assert.equal(unapproved.body.code,'APPROVAL_REQUIRED');
 assert.equal(await publicCount('pszichologusok'),1,'Pending profile stays out of public counts');

 await db.query('UPDATE provider_accounts SET approved_at=now() WHERE id=$1',[a.id]);
 await db.query("UPDATE directory_submissions SET status='accepted',accepted_at=now() WHERE id=$1",[submission.id]);
 assert.equal((await readListing(ownId)).status,'pending','Approval alone does not publish the profile');
 const published=await a.client.put({...complete,action:'publish'});assert.equal(published.status,200);assert.equal(published.body.listing.status,'published');assert.equal(await publicCount('pszichologusok'),2);
 const publishedAt=(await readListing(ownId)).published_at.toISOString();
 const saved=await a.client.put({short_description:'Frissített, személyes és online konzultációs lehetőség.'});assert.equal(saved.status,200);assert.equal(saved.body.listing.status,'published');assert.equal((await readListing(ownId)).published_at.toISOString(),publishedAt);assert.equal(await publicCount('pszichologusok'),2);
 const invalidSave=await a.client.put({description:'Rövid'});assert.equal(invalidSave.status,400);assert.equal((await readListing(ownId)).status,'published');
 const unpublish=await a.client.put({action:'unpublish'});assert.equal(unpublish.status,200);assert.equal(unpublish.body.listing.status,'draft');assert.equal((await readListing(ownId)).published_at,null);assert.equal(await publicCount('pszichologusok'),1);
 assert.equal((await a.client.put({action:'publish'})).status,200);

 const other=await b.client.put({...complete,name:'Másik szakember',category_slugs:['pszichiaterek'],action:'publish'});assert.equal(other.status,200);assert.notEqual(other.body.listing.id,ownId);
 assert.equal((await b.client.call('/api/provider/profile?listing_id='+ownId)).body.listing.id,other.body.listing.id,'Query IDs cannot select another profile');
 assert.equal((await a.client.call('/api/admin/provider-accounts')).status,401,'Provider session cannot administer accounts');
 const accountList=await adminSession.call('/api/admin/provider-accounts?q=owner-a');assert.equal(accountList.status,200);assert.equal(accountList.body.total,1);assert.equal(accountList.body.items[0].listing.id,ownId);
 assert(!JSON.stringify(accountList.body).includes('password_hash'));assert(!JSON.stringify(accountList.body).includes('private-hash'));assert(!JSON.stringify(accountList.body).includes(a.token));
 const noCsrf=await adminSession.call('/api/admin/provider-accounts/'+a.id+'/action',{method:'POST',data:{action:'disable'},includeCsrf:false});assert.equal(noCsrf.status,403);
 const suspended=await adminSession.call('/api/admin/provider-accounts/'+a.id+'/action',{method:'POST',data:{action:'disable'}});assert.equal(suspended.status,200);
 assert.equal((await db.query('SELECT count(*)::int AS n FROM provider_account_sessions WHERE account_id=$1',[a.id])).rows[0].n,0);
 assert.equal((await readListing(ownId)).status,'draft');assert.equal(await publicCount('pszichologusok'),1);
 assert.equal((await a.client.call('/api/provider/profile')).status,401);assert.equal((await b.client.call('/api/provider/profile')).status,200,'Suspension is isolated to its owner');
 const enabled=await adminSession.call('/api/admin/provider-accounts/'+a.id+'/action',{method:'POST',data:{action:'enable'}});assert.equal(enabled.status,200);assert.equal((await readListing(ownId)).status,'draft');assert.equal(await publicCount('pszichologusok'),1);
 a.client.jar.mental_provider=a.token;assert.equal((await a.client.call('/api/provider/profile')).status,401,'Enabling cannot revive revoked sessions');
 assert.equal((await readListing(preexisting.id)).status,'published','An independently maintained catalog entry is not the account profile');
 assert((await db.query("SELECT event_type FROM provider_account_events WHERE account_id=$1 AND event_type IN ('profile_publish','profile_unpublish','account_disable','account_enable')",[a.id])).rowCount>=4);
 dbState.ready=false;assert.equal((await b.client.call('/api/provider/profile')).status,503);dbState.ready=true;
 console.log('PROVIDER_PROFILES_DB_OK',JSON.stringify({realMigrations:true,csrf:true,explicitOwnership:true,noEmailClaim:true,readonlyAdminFields:true,verifiedEmailOnly:true,activeCategoriesOnly:true,pendingSubmit:true,submitDeduplicated:true,approvalBeforePublication:true,publicCounts:true,savePreservesPublication:true,unpublish:true,noHashLeaks:true,suspensionRevokesSessions:true,enableDoesNotRepublish:true,realEmailsSent:0}));
}

main().catch(error=>{console.error(error.stack);process.exitCode=1;}).finally(async()=>{accounts?.stop();if(server)await new Promise(resolve=>server.close(resolve));await db.end();await admin.query('DROP SCHEMA IF EXISTS '+schema+' CASCADE').catch(()=>{});await admin.end();});
