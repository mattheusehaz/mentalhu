'use strict';

// A fresh loopback-only schema and injected mail transport: this test cannot
// send a real email or change application/production data.
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const fs=require('node:fs');
const path=require('node:path');
const express=require('express');
const {Pool}=require('pg');
const {createNewsletterService,fridaySlot,editionWindow,CONSENT_TEXT}=require('../lib/newsletter.cjs');

const connectionString=process.env.TEST_DATABASE_URL;
assert(connectionString,'TEST_DATABASE_URL must identify a disposable local test database');
const database=new URL(connectionString);
assert(['postgres:','postgresql:'].includes(database.protocol)&&['localhost','127.0.0.1','[::1]'].includes(database.hostname)&&/test/i.test(database.pathname),'Disposable loopback PostgreSQL test database required');
const schema='newsletter_test_'+crypto.randomBytes(8).toString('hex');
const control=new Pool({connectionString,ssl:false,connectionTimeoutMillis:5000});
const pool=new Pool({connectionString,ssl:false,options:'-c search_path='+schema,connectionTimeoutMillis:5000});
const key=crypto.randomBytes(32),sent=[],csrf='isolated-newsletter-csrf',adminSecret=crypto.randomBytes(24).toString('hex');
let configured=false,transportFailure=null,service,peer,server,base,created=false;
function seal(value){const iv=crypto.randomBytes(12),cipher=crypto.createCipheriv('aes-256-gcm',key,iv);const encrypted=Buffer.concat([cipher.update(JSON.stringify(value)),cipher.final()]);return [iv,cipher.getAuthTag(),encrypted].map(value=>value.toString('base64url')).join('.');}
function unseal(value){const [iv,tag,encrypted]=value.split('.').map(value=>Buffer.from(value,'base64url'));const cipher=crypto.createDecipheriv('aes-256-gcm',key,iv);cipher.setAuthTag(tag);return JSON.parse(Buffer.concat([cipher.update(encrypted),cipher.final()]).toString());}
const mailer={ready:async()=>configured,seal,unseal,send:async message=>{if(transportFailure)throw Object.assign(new Error('Isolated failure'),{code:transportFailure});sent.push(message);return{id:'isolated-'+message.id};}};
const accounts={csrfFor:()=>csrf,protect:req=>{if(req.get('X-Provider-CSRF')!==csrf||req.get('Origin')!==base)throw Object.assign(new Error('FORM_EXPIRED'),{code:'FORM_EXPIRED',httpStatus:403});}};
async function request(route,{method='GET',data,admin=false,origin=base,withCsrf=true,form=false}={}){
  const response=await fetch(base+route,{method,headers:{Origin:origin,...(admin?{'X-Test-Admin':adminSecret}:{}),...(withCsrf?{'X-Provider-CSRF':csrf}:{}),...(data?{'Content-Type':form?'application/x-www-form-urlencoded':'application/json'}:{})},...(data?{body:form?new URLSearchParams(data):JSON.stringify(data)}:{})});
  const text=await response.text();return{status:response.status,headers:response.headers,body:response.headers.get('content-type')?.includes('application/json')?JSON.parse(text):text};
}
const rowFor=async email=>(await pool.query('SELECT * FROM newsletter_subscribers WHERE lower(email)=$1 AND merged_into_id IS NULL',[email.toLowerCase()])).rows[0];
const latest=async id=>(await pool.query("SELECT * FROM newsletter_mail_jobs WHERE subscriber_id=$1 AND kind='confirmation' ORDER BY created_at DESC,id DESC LIMIT 1",[id])).rows[0];
const rawToken=job=>/#token=([A-Za-z0-9_-]+)/.exec(unseal(job.payload_ciphertext).text)[1];
async function addReader(email,topics=['alvas']){return(await pool.query(`INSERT INTO newsletter_subscribers(email,name,status,topics,confirmed_at,consent_text,unsubscribe_token)
 VALUES($1,'Teszt Olvasó','active',$2,now(),$3,$4) RETURNING *`,[email,topics,CONSENT_TEXT,crypto.randomBytes(32).toString('hex')])).rows[0];}
async function main(){
  await control.query('CREATE SCHEMA '+schema);created=true;
  await pool.query(fs.readFileSync(path.join(__dirname,'../migrations/001_init.sql'),'utf8'));
  await pool.query("ALTER TABLE articles ADD COLUMN IF NOT EXISTS hero_image_path TEXT NOT NULL DEFAULT ''");
  const legacyTokens=[0,1,2].map(()=>crypto.randomBytes(32).toString('hex'));
  await pool.query(`INSERT INTO newsletter_subscribers(email,status,unsubscribe_token) VALUES
    ('Case@Example.Test','active',$1),('case@example.test','unsubscribed',$2),(' Padded@Example.Test ','active',$3)`,legacyTokens);
  await pool.query(fs.readFileSync(path.join(__dirname,'../migrations/020_newsletter.sql'),'utf8'));
  const merged=(await pool.query("SELECT * FROM newsletter_subscribers WHERE lower(btrim(email))='case@example.test' ORDER BY id")).rows;
  assert.equal(merged.length,2,'Migration preserves legacy rows and links');assert.equal(merged[0].status,'unsubscribed','Existing opt-out wins legacy deduplication');
  assert.equal(merged[1].merged_into_id,merged[0].id);assert(!merged[0].confirmed_at);assert.deepEqual(merged[0].topics,[]);
  const app=express();app.use(express.json());app.use(express.urlencoded({extended:false}));
  server=await new Promise(resolve=>{const listener=app.listen(0,'127.0.0.1',()=>resolve(listener));});base='http://127.0.0.1:'+server.address().port;
  const auth=(req,res,next)=>{if(req.get('X-Test-Admin')!==adminSecret)return res.status(401).json({error:'Unauthorized'});req.user={email:'admin@example.test'};next();};
  const options={pool,dbState:{ready:true},auth,accounts,mailer,baseUrl:base};
  service=createNewsletterService(options);peer=createNewsletterService(options);service.register(app);

  assert.equal((await request('/api/admin/newsletter')).status,401);
  assert.equal((await request('/api/newsletter/subscribe',{method:'POST',data:{name:'Test',email:'bad',topics:['alvas'],consent:true}})).status,400);
  assert.equal((await request('/api/newsletter/subscribe',{method:'POST',origin:'https://other.example',data:{name:'Test',email:'bad@example.test',topics:['alvas'],consent:true}})).status,403);
  const data={name:'Teszt Olvasó',email:'  Reader@Example.Test ',topics:['alvas','adhd'],consent:true};
  assert.equal((await request('/api/newsletter/subscribe',{method:'POST',data:{...data,consent:false}})).status,400);
  assert.equal((await request('/api/newsletter/subscribe',{method:'POST',data:{...data,website:'spam'}})).status,202);
  assert(!await rowFor('reader@example.test'));
  const subscribed=await request('/api/newsletter/subscribe',{method:'POST',data});assert.equal(subscribed.status,202);
  let reader=await rowFor('reader@example.test');assert.equal(reader.status,'pending');assert(!reader.confirmed_at);
  const firstMail=await latest(reader.id),token=rawToken(firstMail);
  assert.equal(firstMail.delivery_status,'needs_mail');assert(!firstMail.payload_ciphertext.includes('reader@example.test'));
  assert((await pool.query('SELECT token_hash FROM newsletter_tokens WHERE id=$1',[firstMail.token_id])).rows[0].token_hash!==token);
  await Promise.all([service.subscribe({...data,email:'reader@example.test'}),peer.subscribe({...data,email:'reader@example.test'})]);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM newsletter_mail_jobs WHERE subscriber_id=$1',[reader.id])).rows[0].n,1,'Cooldown serializes concurrent address requests');
  await request('/hirlevel/megerosites#token='+token);assert.equal((await rowFor('reader@example.test')).status,'pending','GET never confirms a mailbox');
  const confirmed=await request('/api/newsletter/confirm',{method:'POST',data:{token}});assert.equal(confirmed.status,200);
  const prefs=confirmed.body.preferences_token;reader=await rowFor('reader@example.test');assert.equal(reader.status,'active');assert.deepEqual(reader.topics,['adhd','alvas']);assert.equal(reader.name,'Teszt Olvasó');
  assert.equal((await request('/api/newsletter/confirm',{method:'POST',data:{token}})).status,410,'Confirmation is single use');
  await pool.query("UPDATE newsletter_request_limits SET last_requested_at=now()-interval '10 minutes'");
  await request('/api/newsletter/subscribe',{method:'POST',data:{...data,email:'reader@example.test',name:'Overwrite attempt',topics:['kapcsolatok']}});
  assert.equal((await rowFor('reader@example.test')).name,'Teszt Olvasó','Anonymous repeat signup does not change current preferences');
  const outstanding=rawToken(await latest(reader.id));
  assert.equal((await request('/api/newsletter/preferences',{method:'POST',data:{token:prefs,name:'Új Név',topics:['alvas']}})).status,200);
  assert.deepEqual((await rowFor('reader@example.test')).topics,['alvas']);
  assert.equal((await request('/api/newsletter/confirm',{method:'POST',data:{token:outstanding}})).status,410,'A stale signup cannot reverse newer preferences');
  const scanner=await request('/leiratkozas/'+reader.unsubscribe_token);assert.equal(scanner.status,200);assert.match(scanner.headers.get('cache-control'),/no-store/);
  assert.equal((await rowFor('reader@example.test')).status,'active','Email scanner GET cannot unsubscribe');
  assert.equal((await request('/leiratkozas/'+prefs,{method:'POST',form:true,data:{'List-Unsubscribe':'One-Click'}})).status,410,'One-click endpoint accepts purpose-limited opt-out tokens only');
  assert.equal((await request('/leiratkozas/'+reader.unsubscribe_token,{method:'POST',form:true,origin:'https://mail.example',withCsrf:false,data:{'List-Unsubscribe':'One-Click'}})).status,200);
  reader=await rowFor('reader@example.test');assert.equal(reader.status,'unsubscribed');assert.equal(reader.name,'');assert.deepEqual(reader.topics,[]);
  assert.equal((await request('/api/newsletter/preferences/read',{method:'POST',data:{token:prefs}})).status,410,'Unsubscribe revokes preference capabilities');
  assert.equal((await request('/leiratkozas/'+reader.unsubscribe_token,{method:'POST',form:true,data:{'List-Unsubscribe':'One-Click'}})).status,200,'Permanent opt-out is idempotent');

  configured=true;
  await service.subscribe({name:'Legacy Olvasó',email:'padded@example.test',topics:['alvas']});
  const padded=(await pool.query("SELECT * FROM newsletter_subscribers WHERE lower(btrim(email))='padded@example.test'")).rows[0];
  const paddedMail=await latest(padded.id),paddedToken=rawToken(paddedMail);
  await service.runWorker({limit:20});
  assert(sent.some(message=>message.to==='padded@example.test'&&message.scope==='mental-newsletter-confirm'),'Whitespace/case legacy mailbox receives normalized confirmation');
  await service.confirm(paddedToken);await service.unsubscribe(padded.unsubscribe_token);
  await Promise.all([service.unsubscribe(legacyTokens[0]),peer.unsubscribe(legacyTokens[1])]);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM newsletter_subscribers WHERE id=ANY($1::bigint[]) AND status=\'unsubscribed\'',[[merged[0].id,merged[1].id]])).rows[0].n,2,'Simultaneous old canonical/merged opt-out links succeed');

  configured=false;
  await service.subscribe({name:'Konkurens Olvasó',email:'concurrent@example.test',topics:['alvas']});
  const concurrent=await rowFor('concurrent@example.test');
  await pool.query("UPDATE newsletter_request_limits SET last_requested_at=now()-interval '10 minutes'");
  await peer.subscribe({name:'Konkurens Olvasó',email:'concurrent@example.test',topics:['kapcsolatok']});
  const competing=(await pool.query("SELECT * FROM newsletter_mail_jobs WHERE subscriber_id=$1 AND kind='confirmation' ORDER BY created_at,id",[concurrent.id])).rows.map(rawToken);
  assert.equal(competing.length,2);
  const raced=await Promise.allSettled([service.confirm(competing[0]),peer.confirm(competing[1])]);
  assert.equal(raced.filter(result=>result.status==='fulfilled').length,1,'Only one competing confirmation wins');
  assert.equal(raced.find(result=>result.status==='rejected').reason.code,'TOKEN_INVALID','Losing confirmation is safely invalidated, not deadlocked');
  const concurrentPreferences=raced.find(result=>result.status==='fulfilled').value.preferences_token;
  const changeRace=await Promise.allSettled([service.updatePreferences(concurrentPreferences,{name:'Új választás',topics:['adhd']}),peer.unsubscribe(concurrent.unsubscribe_token)]);
  assert(changeRace.every(result=>result.status==='fulfilled'||['TOKEN_INVALID','SUBSCRIPTION_INACTIVE'].includes(result.reason.code)),'Concurrent preference change and opt-out have consistent lock ordering');
  assert.equal((await rowFor('concurrent@example.test')).status,'unsubscribed');

  const a=await addReader('digest-a@example.test'),b=await addReader('digest-b@example.test'),c=await addReader('digest-c@example.test'),empty=await addReader('empty@example.test',['kapcsolatok']);
  await pool.query("INSERT INTO newsletter_subscribers(email,status,unsubscribe_token) VALUES('legacy@example.test','active',$1)",[crypto.randomBytes(32).toString('hex')]);
  const slot=fridaySlot(new Date()),window=editionWindow(slot),published=new Date(window.end.valueOf()-3600000);
  const article=(await pool.query(`INSERT INTO articles(slug,title,category,excerpt,content_html,status,published_at)
    VALUES('weekly-sleep','Heti alváskutatás','Alvás','Tesztkivonat','<p>Teszt.</p>','published',$1) RETURNING id`,[published])).rows[0];
  await pool.query(`INSERT INTO articles(slug,title,category,content_html,status,published_at) VALUES
    ('draft-sleep','Titkos piszkozat','Alvás','<p>Piszkozat</p>','draft',$1),
    ('future-sleep','Jövőbeli cikk','Alvás','<p>Jövő</p>','published',now()+interval '1 day'),
    ('old-sleep','Korábbi cikk','Alvás','<p>Régi</p>','published',$2)`,[published,new Date(window.start.valueOf()-1)]);
  await pool.query('UPDATE newsletter_settings SET first_due_at=$1',[slot]);
  const scheduledAt=new Date(slot.valueOf()+1000);
  configured=true;
  await Promise.all([service.runScheduler(scheduledAt),peer.runScheduler(scheduledAt)]);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM newsletter_campaigns')).rows[0].n,1,'Multiple instances create one edition');
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM newsletter_mail_jobs WHERE kind='digest'")).rows[0].n,4,'Exactly one digest record per eligible subscriber');
  const queued=(await pool.query("SELECT * FROM newsletter_mail_jobs WHERE kind='digest' ORDER BY subscriber_id")).rows;
  assert(queued.filter(job=>job.article_count).every(job=>job.article_ids.length===1&&job.article_ids[0]===article.id),'Draft/future/out-of-window articles never enter a digest');
  assert.equal(queued.find(job=>job.subscriber_id===empty.id).delivery_status,'skipped','No empty newsletter is sent');
  const campaign=queued[0].campaign_id;
  assert.equal(await service.runScheduler(scheduledAt),false,'Restarting/repeating a scheduler does not duplicate the edition');
  assert.equal(await service.runScheduler(new Date(slot.valueOf()+2*86400000)),false,'Historical catch-up is bounded');
  // The fixture's calendar slot may be earlier this week. Make just these local
  // outbox rows current before testing delivery, without altering their window.
  await pool.query("UPDATE newsletter_mail_jobs SET expires_at=now()+interval '1 day' WHERE kind='digest'");
  await service.unsubscribe(b.unsubscribe_token);
  await pool.query('UPDATE newsletter_subscribers SET preferences_version=preferences_version+1,topics=$2 WHERE id=$1',[c.id,['kapcsolatok']]);
  await Promise.all([service.runWorker({limit:20}),peer.runWorker({limit:20})]);
  const digests=sent.filter(message=>message.scope==='mental-newsletter');
  assert.equal(digests.length,1,'Concurrent workers send at most one personalized digest; opt-out/change after queue is respected');
  assert.equal(digests[0].to,a.email);assert(digests[0].text.includes('Heti alváskutatás'));assert(!digests[0].text.includes('Titkos piszkozat'));
  const accepted=(await pool.query("SELECT * FROM newsletter_mail_jobs WHERE subscriber_id=$1 AND kind='digest'",[a.id])).rows[0];
  assert.equal(accepted.delivery_status,'accepted');assert.equal(accepted.payload_ciphertext,null,'Accepted message body is erased immediately');assert((await rowFor(a.email)).last_sent_at);
  assert.equal((await pool.query('SELECT delivery_status FROM newsletter_mail_jobs WHERE subscriber_id=$1 AND kind=\'digest\'',[c.id])).rows[0].delivery_status,'skipped');
  const summary=(await request('/api/admin/newsletter',{admin:true})).body;assert.equal(summary.hour,8);assert.equal(summary.test_recipient,'den@proptechdigital.com');assert(summary.counts.needs_preferences>=1);
  assert.equal((await request('/api/admin/newsletter/settings',{method:'POST',admin:true,withCsrf:false,data:{enabled:false}})).status,403,'Admin writes require CSRF protection');
  assert.equal((await request('/api/admin/newsletter/settings',{method:'POST',admin:true,data:{enabled:false}})).status,200);
  assert.equal((await request('/api/admin/newsletter/settings',{method:'POST',admin:true,data:{enabled:true}})).status,200);
  const history=await request('/api/admin/newsletter/campaigns/'+campaign,{admin:true});assert.equal(history.status,200);assert.equal(history.body.items.length,4);assert(!JSON.stringify(history.body).includes('payload_ciphertext'));
  const search=await request('/api/admin/newsletter/subscribers?q=digest-a&status=active',{admin:true});assert.equal(search.body.total,1);assert.equal(search.body.items[0].email,a.email);

  const unpublished=await addReader('withdrawn@example.test');
  const jobId=crypto.randomUUID(),tokenId=crypto.randomUUID(),prefRaw=crypto.randomBytes(32).toString('base64url');
  const envelope={id:jobId,to:unpublished.email,_preferencesUrl:base+'/hirlevel/beallitasok#token='+prefRaw,_unsubscribeUrl:base+'/leiratkozas/'+unpublished.unsubscribe_token};
  await pool.query("INSERT INTO newsletter_tokens(id,subscriber_id,kind,token_hash,expires_at) VALUES($1,$2,'preferences',$3,now()+interval '180 days')",[tokenId,unpublished.id,crypto.createHash('sha256').update(prefRaw).digest('hex')]);
  await pool.query(`INSERT INTO newsletter_mail_jobs(id,kind,subscriber_id,campaign_id,token_id,payload_ciphertext,preferences_version,article_ids,article_count,expires_at)
    VALUES($1,'digest',$2,$3,$4,$5,0,$6,1,now()+interval '1 day')`,[jobId,unpublished.id,campaign,tokenId,seal(envelope),[article.id]]);
  await pool.query("UPDATE articles SET status='draft' WHERE id=$1",[article.id]);
  const before=sent.length;await service.runWorker({limit:20});assert.equal(sent.length,before,'A withdrawn article is checked again immediately before send');
  assert.equal((await pool.query('SELECT error_code FROM newsletter_mail_jobs WHERE id=$1',[jobId])).rows[0].error_code,'NO_MATCHING_ARTICLES');

  transportFailure='MAIL_RESULT_UNCERTAIN';
  const test=await request('/api/admin/newsletter/test',{method:'POST',admin:true,data:{topics:['alvas']}});assert.equal(test.status,202);
  await service.runWorker({limit:20});await peer.runWorker({limit:20});
  const uncertain=(await pool.query("SELECT * FROM newsletter_mail_jobs WHERE kind='test' ORDER BY created_at DESC LIMIT 1")).rows[0];
  assert.equal(uncertain.delivery_status,'uncertain');assert.equal(uncertain.attempts,1,'Unknown provider acceptance is never retried automatically');
  transportFailure=null;
  await pool.query("INSERT INTO newsletter_subscribers(email,status,unsubscribe_token,created_at) VALUES('old-pending@example.test','pending',$1,now()-interval '8 days')",[crypto.randomBytes(32).toString('hex')]);
  await pool.query('UPDATE newsletter_mail_jobs SET expires_at=now()-interval \'1 hour\' WHERE id=$1',[uncertain.id]);
  const cleanService=createNewsletterService(options);await cleanService.cleanup();assert(!await rowFor('old-pending@example.test'));
  assert.equal((await pool.query('SELECT payload_ciphertext FROM newsletter_mail_jobs WHERE id=$1',[uncertain.id])).rows[0].payload_ciphertext,null,'Expired uncertain payload is removed');
  console.log('NEWSLETTER_DB_OK',JSON.stringify({doubleOptIn:true,originAndCsrf:true,tokenHashing:true,concurrentSchedule:true,concurrentDelivery:true,oneClickUnsubscribe:true,unsubscribeClearsInterests:true,publishedOnly:true,sendTimeRecheck:true,noEmptyMail:true,noUncertainRetry:true,retention:true,realEmailsSent:0}));
}
main().catch(error=>{console.error(error.stack);process.exitCode=1;}).finally(async()=>{
  service?.stop();peer?.stop();if(server)await new Promise(resolve=>server.close(resolve));await pool.end();if(created)await control.query('DROP SCHEMA '+schema+' CASCADE');await control.end();
});
