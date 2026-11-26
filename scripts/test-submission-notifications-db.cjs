'use strict';

// Every database mutation is confined to a random schema on disposable loopback
// PostgreSQL. All mail uses an injected transport: this script sends zero emails.
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const fs=require('node:fs');
const path=require('node:path');
const express=require('express');
const {Pool}=require('pg');
const {RECIPIENT,createSubmissionNotificationService}=require('../lib/submission-notifications.cjs');

const connectionString=process.env.TEST_DATABASE_URL;
assert(connectionString,'TEST_DATABASE_URL must identify disposable loopback PostgreSQL');
const location=new URL(connectionString);
assert(['postgres:','postgresql:'].includes(location.protocol) &&
  ['localhost','127.0.0.1','[::1]'].includes(location.hostname) && /test/i.test(location.pathname),
  'Disposable loopback test database required');
const schema='submission_notice_test_'+crypto.randomBytes(8).toString('hex');
const control=new Pool({connectionString,ssl:false});
const db=new Pool({connectionString,ssl:false,options:'-c search_path='+schema});
const dbState={ready:true},sent=[],audits=[],services=[];
let mailReady=true,transport=async()=>({id:'isolated-message-'+crypto.randomUUID()}),server,base;
const csrf='isolated-notification-test-csrf';
const auth=(req,res,next)=>{
  if(req.get('X-Isolated-Admin')!=='fixture-only')return res.status(401).json({error:'Admin authentication required'});
  req.user={email:'admin@example.test',role:'admin'};next();
};
const accounts={protect:req=>{
  if(req.get('X-Provider-CSRF')!==csrf || req.get('Origin')!==base)
    throw Object.assign(Error('FORM_EXPIRED'),{code:'FORM_EXPIRED',httpStatus:403});
}};
const mailer={ready:async()=>mailReady,send:async message=>{
  sent.push({...message});return transport(message);
}};
function service(){
  const instance=createSubmissionNotificationService({pool:db,dbState,auth,accounts,mailer,audit:(...args)=>audits.push(args)});
  services.push(instance);return instance;
}
async function seed({name='Izolált teszt jelentkezés',email='applicant@example.test',consent=true,status='new',trashed=false}={}){
  return (await db.query(`INSERT INTO directory_submissions(name,contact_name,email,phone,website_url,category_slugs,city,online_available,description,qualifications,consent,status,deleted_at)
    VALUES($1,'Teszt Kapcsolattartó',$2,'+36 20 555 0100','https://example.test','pszichologusok','Budapest',true,
    'Izolált tesztben használt szakmai bemutatkozás.','Teszt képesítés',$3,$4,CASE WHEN $5 THEN now() ELSE NULL END) RETURNING *`,
    [name,email,consent,status,trashed])).rows[0];
}
async function notices(id){return (await db.query('SELECT * FROM directory_submission_notifications WHERE submission_id=$1 ORDER BY revision',[id])).rows;}
async function latest(id){return (await notices(id)).at(-1);}
async function cancelFixtures(){await db.query("UPDATE directory_submission_notifications SET delivery_status='cancelled' WHERE delivery_status IN ('queued','needs_mail','sending')");}
async function call(route,{method='GET',data,authorized=true,protectedRequest=true}={}){
  const response=await fetch(base+route,{method,headers:{'Content-Type':'application/json',Origin:base,
    ...(authorized?{'X-Isolated-Admin':'fixture-only'}:{}),...(protectedRequest?{'X-Provider-CSRF':csrf}:{})},
    ...(data===undefined?{}:{body:JSON.stringify(data)})});
  return {status:response.status,headers:response.headers,body:await response.json()};
}

async function main(){
  await control.query('CREATE SCHEMA '+schema);
  await db.query(`CREATE TABLE directory_submissions(
    id BIGSERIAL PRIMARY KEY,name TEXT NOT NULL,contact_name TEXT NOT NULL DEFAULT '',email TEXT NOT NULL,
    phone TEXT NOT NULL DEFAULT '',website_url TEXT NOT NULL DEFAULT '',category_slugs TEXT NOT NULL DEFAULT '',
    city TEXT NOT NULL DEFAULT '',online_available BOOLEAN NOT NULL DEFAULT false,description TEXT NOT NULL DEFAULT '',
    qualifications TEXT NOT NULL DEFAULT '',consent BOOLEAN NOT NULL DEFAULT true,status TEXT NOT NULL DEFAULT 'new',
    provider_account_id BIGINT,deleted_at TIMESTAMPTZ,deleted_by TEXT,accepted_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),updated_at TIMESTAMPTZ NOT NULL DEFAULT now());
    CREATE TABLE directory_categories(id BIGSERIAL PRIMARY KEY,slug TEXT NOT NULL UNIQUE,name TEXT NOT NULL,active BOOLEAN NOT NULL DEFAULT true);
    INSERT INTO directory_categories(slug,name) VALUES('pszichologusok','Pszichológusok');`);
  await seed({name:'Korábbi jelentkezés – nem küldhető visszamenőleg'});
  const migration=fs.readFileSync(path.join(__dirname,'../migrations/019_submission_notifications.sql'),'utf8');
  await db.query(migration);await db.query(migration);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM directory_submission_notifications')).rows[0].n,0,'Migration replay cannot backfill historical applicants');

  const first=await seed();
  assert.equal((await notices(first.id)).length,1);
  assert.equal((await latest(first.id)).recipient,RECIPIENT);
  assert.equal((await latest(first.id)).event_type,'new');
  await db.query("UPDATE directory_submissions SET status='new',description='Updated test description' WHERE id=$1",[first.id]);
  assert.equal((await notices(first.id)).length,1,'Repeated pending submission does not duplicate mail');
  await db.query("UPDATE directory_submissions SET status='reviewed' WHERE id=$1",[first.id]);
  await db.query("UPDATE directory_submissions SET status='new' WHERE id=$1",[first.id]);
  const reopened=await notices(first.id);
  assert.equal(reopened.length,2);assert.equal(reopened[1].event_type,'resubmitted');
  assert.equal(reopened[0].delivery_status,'cancelled');assert.equal(reopened[0].error_code,'SUPERSEDED');
  await db.query('UPDATE directory_submissions SET deleted_at=now() WHERE id=$1',[first.id]);
  await db.query('UPDATE directory_submissions SET deleted_at=NULL WHERE id=$1',[first.id]);
  assert.equal((await notices(first.id)).length,2,'Restoring trash does not create another notification');
  for(const overrides of [{consent:false},{status:'accepted'},{trashed:true}]){
    const row=await seed(overrides);assert.equal((await notices(row.id)).length,0);
  }
  const beforeRollback=(await db.query('SELECT count(*)::int AS n FROM directory_submission_notifications')).rows[0].n;
  const client=await db.connect();
  try{await client.query('BEGIN');await client.query("INSERT INTO directory_submissions(name,email) VALUES('Rolled-back fixture','rollback@example.test')");await client.query('ROLLBACK');}finally{client.release();}
  assert.equal((await db.query('SELECT count(*)::int AS n FROM directory_submission_notifications')).rows[0].n,beforeRollback,'Submission and outbox insertion are atomic');
  await cancelFixtures();

  const worker=service();
  const waiting=await seed({name:'Levélküldőre váró fixture'});mailReady=false;
  await worker.runWorker();assert.equal(sent.length,0);assert.equal((await latest(waiting.id)).delivery_status,'needs_mail');
  mailReady=true;await worker.runWorker();
  assert.equal((await latest(waiting.id)).delivery_status,'accepted');assert((await latest(waiting.id)).provider_message_id);
  assert.equal(sent.length,1);assert.equal(sent[0].to,RECIPIENT);assert.equal(sent[0].replyTo,waiting.email);
  assert(sent[0].text.includes('Pszichológusok'));assert(sent[0].text.includes('submission='+waiting.id));
  await worker.runWorker();assert.equal(sent.length,1,'Accepted notice cannot be sent twice');

  const concurrent=await seed({name:'Párhuzamos worker fixture'}),beforeConcurrent=sent.length;
  transport=async()=>{await new Promise(resolve=>setTimeout(resolve,25));return {id:'concurrent-'+crypto.randomUUID()};};
  await Promise.all([service().runWorker(),service().runWorker()]);
  assert.equal(sent.length,beforeConcurrent+1,'Concurrent workers claim each notification once');
  assert.equal((await latest(concurrent.id)).delivery_status,'accepted');

  for(const [label,error] of [['server',Object.assign(Error('rejected'),{code:'MAIL_HTTP_503'})],['network',Object.assign(Error('unknown'),{code:'MAIL_RESULT_UNCERTAIN'})]]){
    const row=await seed({name:label+' uncertainty fixture'}),before=sent.length;
    transport=async()=>{throw error;};await service().runWorker();
    assert.equal((await latest(row.id)).delivery_status,'uncertain',label);
    await service().runWorker();assert.equal(sent.length,before+1,'Uncertain delivery must not be retried automatically');
  }
  const missingId=await seed({name:'Hiányos küldési visszaigazolás'}),beforeMissing=sent.length;
  transport=async()=>({});await service().runWorker();
  assert.equal((await latest(missingId.id)).delivery_status,'uncertain');
  await service().runWorker();assert.equal(sent.length,beforeMissing+1);

  const interrupted=await seed({name:'Megszakadt worker fixture'}),beforeInterrupted=sent.length;
  await db.query("UPDATE directory_submission_notifications SET delivery_status='sending',sending_since=now()-interval '6 minutes',attempts=1 WHERE submission_id=$1",[interrupted.id]);
  await service().runWorker();assert.equal((await latest(interrupted.id)).delivery_status,'uncertain');
  assert.equal((await latest(interrupted.id)).error_code,'WORKER_INTERRUPTED');
  assert.equal(sent.length,beforeInterrupted,'A crashed sender has an unknown outcome and cannot be retried automatically');

  const throttled=await seed({name:'429 retry fixture'}),beforeThrottled=sent.length;
  transport=async()=>{throw Object.assign(Error('rate limit'),{code:'MAIL_HTTP_429'});};
  for(let attempt=1;attempt<=3;attempt++){
    await db.query("UPDATE directory_submission_notifications SET next_attempt_at=now()-interval '1 second' WHERE submission_id=$1",[throttled.id]);
    await service().runWorker();const row=await latest(throttled.id);
    assert.equal(row.attempts,attempt);assert.equal(row.delivery_status,attempt<3?'queued':'failed');
  }
  await service().runWorker();assert.equal(sent.length,beforeThrottled+3,'429 retries have a finite budget');
  assert.equal(new Set(sent.slice(beforeThrottled).map(message=>message.id)).size,1,'Safe retries retain the same transport idempotency key');

  transport=async()=>({id:'accepted-'+crypto.randomUUID()});
  const invalid=await seed({name:'Hibás jelentkezői e-mail fixture'}),beforeInvalid=sent.length;
  await db.query("UPDATE directory_submissions SET email='applicant@example.test\r\nBcc: attacker@example.test' WHERE id=$1",[invalid.id]);
  await service().runWorker();assert.equal((await latest(invalid.id)).delivery_status,'accepted');
  assert.equal(sent.length,beforeInvalid+1);assert.equal(sent.at(-1).to,RECIPIENT);assert.equal(sent.at(-1).replyTo,undefined);
  for(const kind of ['consent-revoked','trashed']){
    const row=await seed({name:kind+' cancellation fixture'}),before=sent.length;
    if(kind==='consent-revoked')await db.query('UPDATE directory_submissions SET consent=false WHERE id=$1',[row.id]);
    if(kind==='trashed')await db.query('UPDATE directory_submissions SET deleted_at=now() WHERE id=$1',[row.id]);
    await service().runWorker();assert.equal((await latest(row.id)).delivery_status,'cancelled',kind);assert.equal(sent.length,before,kind);
  }

  const app=express();app.use(express.json());service().register(app);
  server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});base='http://127.0.0.1:'+server.address().port;
  const prefix='/api/admin/directory/submission-notifications';
  assert.equal((await call(prefix,{authorized:false})).status,401);
  const settings=await call(prefix);assert.equal(settings.status,200);assert.equal(settings.body.recipient,RECIPIENT);assert.equal(settings.body.mail_ready,true);
  assert.match(settings.headers.get('cache-control'),/no-store/);
  const beforeTest=sent.length;
  assert.equal((await call(prefix+'/test',{method:'POST',data:{},authorized:false})).status,401);
  assert.equal((await call(prefix+'/test',{method:'POST',data:{},protectedRequest:false})).status,403);
  assert.equal(sent.length,beforeTest,'Unauthorized test requests cannot send mail');
  const test=await call(prefix+'/test',{method:'POST',data:{to:'attacker@example.test',name:'Untrusted body must not be forwarded'}});
  assert.equal(test.status,200);assert.equal(sent.length,beforeTest+1);assert.equal(sent.at(-1).to,RECIPIENT);
  assert(!sent.at(-1).text.includes('Untrusted body must not be forwarded'));
  assert(!sent.at(-1).text.includes(waiting.name),'Test email must not disclose a real application');
  console.log('SUBMISSION_NOTIFICATIONS_DB_OK',JSON.stringify({noBackfill:true,transactionalQueue:true,resubmission:true,noDuplicateNewOrRestore:true,
    pendingMailPreserved:true,concurrentWorkers:true,fixedRecipient:true,adminDeepLink:true,uncertainNotRetried:true,bounded429Retry:true,
    cancellation:true,protectedSyntheticTest:true,realEmailsSent:0}));
}
main().catch(error=>{console.error(error);process.exitCode=1;}).finally(async()=>{
  services.forEach(instance=>instance.stop());if(server)await new Promise(resolve=>server.close(resolve));
  await db.end();await control.query('DROP SCHEMA IF EXISTS '+schema+' CASCADE').catch(()=>{});await control.end();
});
