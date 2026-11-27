'use strict';

// Real PostgreSQL and the actual account/session/CSRF middleware. Every row is
// created in a fresh loopback test schema; no real email transport is available.
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const fs=require('node:fs');
const path=require('node:path');
const express=require('express');
const cookieParser=require('cookie-parser');
const {Pool}=require('pg');
const {createProviderAccountService,hash}=require('../lib/provider-accounts.cjs');
const {createProviderRatingService}=require('../lib/provider-ratings.cjs');

const connectionString=process.env.TEST_DATABASE_URL;
assert(connectionString,'TEST_DATABASE_URL must identify a disposable local test database');
const database=new URL(connectionString);
assert(['postgres:','postgresql:'].includes(database.protocol)&&['localhost','127.0.0.1','[::1]'].includes(database.hostname)&&/test/i.test(database.pathname),'Disposable loopback PostgreSQL required');
const schema='provider_ratings_test_'+crypto.randomBytes(8).toString('hex');
const control=new Pool({connectionString,ssl:false}),db=new Pool({connectionString,ssl:false,options:'-c search_path='+schema});
const dbState={ready:true},events=[];
let accounts,server,base,created=false;
const mailer={ready:async()=>false,seal:JSON.stringify,unseal:JSON.parse,send:async()=>{throw new Error('Email is forbidden in rating tests');}};

function client(cookies={}){
  const jar={...cookies};let csrf;
  return {jar,async call(route,{method='GET',data,withCsrf=true,origin=base,crossSite=false}={}){
    const response=await fetch(base+route,{method,headers:{'Content-Type':'application/json',Origin:origin,Cookie:Object.entries(jar).map(([name,value])=>name+'='+value).join('; '),...(csrf&&withCsrf?{'X-Account-CSRF':csrf}:{}),...(crossSite?{'Sec-Fetch-Site':'cross-site'}:{})},...(data!==undefined?{body:JSON.stringify(data)}:{})});
    for(const value of response.headers.getSetCookie()){const [name,token]=value.split(';')[0].split('=');if(token)jar[name]=token;else delete jar[name];}
    const type=response.headers.get('content-type')||'',body=type.includes('application/json')?await response.json():await response.text();
    if(body?.csrf_token)csrf=body.csrf_token;
    return {status:response.status,body,headers:response.headers};
  },bootstrap(){return this.call('/api/account/session');},
  get(slug){return this.call('/api/ratings/'+encodeURIComponent(slug));},
  put(slug,score,options={}){return this.call('/api/ratings/'+encodeURIComponent(slug),{method:'PUT',data:{score},...options});},
  remove(slug,options={}){return this.call('/api/ratings/'+encodeURIComponent(slug),{method:'DELETE',data:{},...options});}};
}
async function seedAccount(label,{verified=true,disabled=false,provider=false}={}){
  const row=(await db.query(`INSERT INTO provider_accounts(email,display_name,password_hash,email_verified_at,disabled_at,provider_profile_started_at)
    VALUES($1,$2,'private-password-hash',CASE WHEN $3 THEN now() ELSE NULL END,CASE WHEN $4 THEN now() ELSE NULL END,CASE WHEN $5 THEN now() ELSE NULL END) RETURNING *`,
    [label+'@example.test','Titkos olvasó '+label,verified,disabled,provider])).rows[0];
  const token=crypto.randomBytes(32).toString('hex');
  await db.query("INSERT INTO provider_account_sessions(session_hash,account_id,expires_at) VALUES($1,$2,now()+interval '1 day')",[hash(token),row.id]);
  const browser=client({mental_provider:token});await browser.bootstrap();return {...row,token,client:browser};
}
async function listing(slug,status='published'){
  return(await db.query('INSERT INTO directory_listings(slug,name,email,status) VALUES($1,$2,$3,$4) RETURNING id,slug,name',[slug,'Szolgáltató '+slug,'public-contact@example.test',status])).rows[0];
}
async function rating(accountId,listingId){return(await db.query('SELECT * FROM provider_ratings WHERE account_id=$1 AND listing_id=$2',[accountId,listingId])).rows[0];}
function privateResponse(response){
  assert.match(response.headers.get('cache-control')||'',/private/);assert.match(response.headers.get('cache-control')||'',/no-store/);
  assert.match(response.headers.get('vary')||'',/Cookie/i);assert.equal(response.headers.get('pragma'),'no-cache');assert.match(response.headers.get('x-robots-tag')||'',/noindex/);
}
function noRaterIdentities(body,users){
  const text=JSON.stringify(body);
  for(const user of users){assert(!text.includes(user.email),'Email addresses stay private');assert(!text.includes(user.display_name),'Other reader display names stay private');assert(!text.includes(user.token),'Session capabilities stay private');}
  for(const field of ['account_id','author_id','email','display_name','password_hash','session_hash'])assert(!text.includes('"'+field+'"'),'Private field is not exposed: '+field);
}
function noRatingData(body){for(const field of ['average','count','distribution','my_rating'])assert(!Object.hasOwn(body,field),'Unauthorized response must not expose '+field);}

async function main(){
  await control.query('CREATE SCHEMA '+schema);created=true;
  for(const filename of ['001_init.sql','002_directory.sql','016_provider_accounts.sql','017_submission_trash.sql','018_provider_listing_owners.sql','021_reader_accounts.sql','022_provider_ratings.sql'])await db.query(fs.readFileSync(path.join(__dirname,'../migrations',filename),'utf8'));
  const app=express();app.use(express.json());app.use(cookieParser());
  accounts=createProviderAccountService({pool:db,dbState,secret:'isolated-rating-account-secret',baseUrl:'http://127.0.0.1',mailer,env:{NODE_ENV:'test'}});
  accounts.register(app);
  createProviderRatingService({pool:db,dbState,accounts,audit:(...args)=>{events.push(args);}}).register(app);
  server=await new Promise(resolve=>{const listener=app.listen(0,'127.0.0.1',()=>resolve(listener));});base='http://127.0.0.1:'+server.address().port;

  const target=await listing('rating-provider'),another=await listing('second-provider'),draft=await listing('draft-provider','draft'),owned=await listing('owned-provider'),withdrawn=await listing('withdrawn-provider');
  const a=await seedAccount('reader-a'),b=await seedAccount('reader-b'),owner=await seedAccount('provider-owner',{provider:true}),validation=await seedAccount('validation-reader'),viewer=await seedAccount('viewer');
  const unverified=await seedAccount('unverified',{verified:false}),disabled=await seedAccount('disabled',{disabled:true});
  const users=[a,b,owner,validation,viewer,unverified,disabled];
  await db.query('INSERT INTO provider_listing_owners(account_id,listing_id) VALUES($1,$2)',[owner.id,owned.id]);
  const anonymous=client(),cmsOnly=client({mental_cms:'valid-looking-admin-cookie-is-not-an-account'});await anonymous.bootstrap();await cmsOnly.bootstrap();
  for(const browser of [anonymous,cmsOnly,unverified.client,disabled.client]){
    const get=await browser.get(target.slug);assert.equal(get.status,401);privateResponse(get);noRatingData(get.body);
    assert.equal((await browser.put(target.slug,5)).status,401);assert.equal((await browser.remove(target.slug)).status,401);
  }
  assert.equal((await db.query('SELECT count(*)::int AS n FROM provider_ratings')).rows[0].n,0,'Unauthorized requests create no ratings');

  const empty=await a.client.get(target.slug);assert.equal(empty.status,200);privateResponse(empty);noRaterIdentities(empty.body,users);
  assert.equal(empty.body.average,null);assert.equal(empty.body.count,0);assert.equal(empty.body.my_rating,null);assert.equal(empty.body.can_rate,true);
  assert.deepEqual(empty.body.distribution,[1,2,3,4,5].map(score=>({score,count:0})));
  assert.equal((await validation.client.put(target.slug,5,{withCsrf:false})).status,403);
  assert.equal((await validation.client.put(target.slug,5,{origin:'https://foreign.example'})).status,403);
  assert.equal((await validation.client.put(target.slug,5,{crossSite:true})).status,403);
  assert.equal((await validation.client.remove(target.slug,{withCsrf:false})).status,403);
  for(const data of [{score:0},{score:6},{score:2.5},{score:'5'},{score:true},{},{score:5,account_id:b.id},{score:5,listing_id:another.id}]){
    const result=await validation.client.call('/api/ratings/'+target.slug,{method:'PUT',data});assert.equal(result.status,400);assert.equal(result.body.code,'INVALID_RATING');
  }
  assert.equal((await db.query('SELECT count(*)::int AS n FROM provider_ratings')).rows[0].n,0,'Invalid score, identity and CSRF requests have no effects');
  for(const slug of [draft.slug,'does-not-exist']){
    assert.equal((await validation.client.get(slug)).status,404);assert.equal((await validation.client.put(slug,5)).status,404);assert.equal((await validation.client.remove(slug)).status,404);
  }

  const first=await a.client.put(target.slug,5);assert.equal(first.status,200);privateResponse(first);assert.equal(first.body.count,1);assert.equal(first.body.average,5);assert.equal(first.body.my_rating.score,5);noRaterIdentities(first.body,users);
  const edited=await a.client.put(target.slug,2);assert.equal(edited.status,200);assert.equal(edited.body.count,1);assert.equal(edited.body.average,2);assert.equal(edited.body.my_rating.score,2);
  assert.equal((await b.client.put(target.slug,4)).status,200);
  const aggregate=(await viewer.client.get(target.slug)).body;assert.equal(aggregate.count,2);assert.equal(aggregate.average,3);assert.equal(aggregate.my_rating,null);noRaterIdentities(aggregate,users);
  const concurrent=await Promise.all([1,3,5,2,4,3].map(score=>a.client.put(target.slug,score)));
  assert(concurrent.every(result=>result.status===200),'Concurrent requests complete without deadlocks or duplicate-key errors');
  const current=await rating(a.id,target.id);assert([1,3,5,2,4].includes(current.score));
  assert.equal((await db.query('SELECT count(*)::int AS n FROM provider_ratings WHERE account_id=$1 AND listing_id=$2',[a.id,target.id])).rows[0].n,1,'One vote survives concurrent updates');
  const concurrentSummary=(await a.client.get(target.slug)).body;assert.equal(concurrentSummary.count,2);assert.equal(concurrentSummary.average,Math.round((current.score+4)/2*10)/10);assert.equal(concurrentSummary.distribution.reduce((total,row)=>total+row.count,0),2);
  const authorQuery=await a.client.call('/api/ratings/'+target.slug+'?account_id='+b.id);assert.equal(authorQuery.body.my_rating.score,current.score,'Query IDs cannot switch the current author');
  await assert.rejects(db.query('INSERT INTO provider_ratings(account_id,listing_id,score) VALUES($1,$2,4)',[a.id,target.id]),{code:'23505'},'Database uniqueness is a final duplicate-vote guard');
  await assert.rejects(db.query('INSERT INTO provider_ratings(account_id,listing_id,score) VALUES($1,$2,0)',[viewer.id,target.id]),{code:'23514'},'Database rejects scores outside one through five');
  const removed=await a.client.remove(target.slug);assert.equal(removed.status,200);assert.equal(removed.body.count,1);assert.equal(removed.body.average,4);assert.equal(removed.body.my_rating,null);
  assert.equal((await a.client.remove(target.slug)).status,200,'Removing an absent own vote is idempotent');
  const forgedDelete=await a.client.remove(target.slug,{data:{account_id:b.id}});assert.equal(forgedDelete.status,200);assert(await rating(b.id,target.id),'Delete always targets the authenticated reader, ignoring a supplied author');

  const self=await owner.client.get(owned.slug);assert.equal(self.status,200);assert.equal(self.body.can_rate,false);
  const deniedOwn=await owner.client.put(owned.slug,5);assert.equal(deniedOwn.status,403);assert.equal(deniedOwn.body.code,'OWN_PROVIDER_RATING');assert(!await rating(owner.id,owned.id));
  await a.client.put(another.slug,5);
  await db.query('UPDATE provider_accounts SET provider_profile_started_at=now() WHERE id=$1',[a.id]);
  assert.equal((await a.client.bootstrap()).body.user.is_provider,true);
  const upgradedEdit=await a.client.put(another.slug,4);assert.equal(upgradedEdit.status,200);assert.equal(upgradedEdit.body.count,1,'Reader-to-provider extension does not create another voting identity');
  await db.query('INSERT INTO provider_listing_owners(account_id,listing_id) VALUES($1,$2)',[a.id,another.id]);
  const newlyOwned=await a.client.get(another.slug);assert.equal(newlyOwned.body.can_rate,false);assert.equal(newlyOwned.body.count,0);assert.equal(newlyOwned.body.average,null,'A prior reader vote stops counting after becoming the owner');
  assert.equal((await a.client.put(another.slug,5)).status,403);
  assert.equal((await viewer.client.get(another.slug)).body.count,0,'Owner historical votes are excluded for every reader');
  assert.equal((await a.client.remove(another.slug)).status,200,'Owner may remove a historical own vote');assert(!await rating(a.id,another.id));

  await db.query('UPDATE provider_accounts SET disabled_at=now() WHERE id=$1',[b.id]);
  const withoutDisabled=await viewer.client.get(target.slug);assert.equal(withoutDisabled.body.count,0);assert.equal(withoutDisabled.body.average,null);
  const suspended=await b.client.get(target.slug);assert.equal(suspended.status,401);noRatingData(suspended.body);
  await db.query('INSERT INTO provider_ratings(account_id,listing_id,score) VALUES($1,$2,5)',[unverified.id,target.id]);
  assert.equal((await viewer.client.get(target.slug)).body.count,0,'Unverified accounts cannot contribute to aggregates even if a row was inserted administratively');
  await a.client.put(withdrawn.slug,3);await db.query("UPDATE directory_listings SET status='draft' WHERE id=$1",[withdrawn.id]);
  for(const response of [await a.client.get(withdrawn.slug),await a.client.put(withdrawn.slug,5),await a.client.remove(withdrawn.slug)]){assert.equal(response.status,404);noRatingData(response.body);}

  assert.equal((await a.client.put(target.slug,3)).status,200);assert(await rating(a.id,target.id));
  await db.query('DELETE FROM provider_accounts WHERE id=$1',[a.id]);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM provider_ratings WHERE account_id=$1',[a.id])).rows[0].n,0,'Deleting an account removes its ratings');
  assert.equal((await a.client.get(target.slug)).status,401,'Deleted accounts cannot use a former session');
  await db.query('DELETE FROM directory_listings WHERE id=$1',[target.id]);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM provider_ratings WHERE listing_id=$1',[target.id])).rows[0].n,0,'Deleting a listing removes all associated ratings');
  assert.equal((await viewer.client.get(target.slug)).status,404);
  dbState.ready=false;const unavailable=await viewer.client.get(owned.slug);assert.equal(unavailable.status,503);noRatingData(unavailable.body);dbState.ready=true;
  assert(events.some(event=>event[0]==='rating_saved')&&events.some(event=>event[0]==='rating_removed'),'Successful writes leave admin audit events');
  assert.equal((await db.query('SELECT count(*)::int AS n FROM provider_account_mail')).rows[0].n,0,'Rating actions enqueue no emails');
  console.log('PROVIDER_RATINGS_DB_OK',JSON.stringify({actualAccountMiddleware:true,anonymousDenied:true,adminCookieDenied:true,unverifiedAndDisabledDenied:true,privateNoStore:true,noRaterIdentities:true,strictScores:true,noAuthorSpoofing:true,csrf:true,publishedOnly:true,createEditDelete:true,concurrentUniqueVote:true,selfRatingBlocked:true,disabledRaterExcluded:true,laterOwnerExcluded:true,accountAndListingCascade:true,realEmailsSent:0}));
}

main().catch(error=>{console.error(error.stack);process.exitCode=1;}).finally(async()=>{
  accounts?.stop();if(server)await new Promise(resolve=>server.close(resolve));await db.end();if(created)await control.query('DROP SCHEMA '+schema+' CASCADE');await control.end();
});
