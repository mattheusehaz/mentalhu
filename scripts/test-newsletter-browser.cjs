'use strict';

// The complete application runs only against a fresh, disposable local schema.
// No mail credentials are inherited and no email transport is configured. The
// confirmation capability is recovered from the encrypted test outbox, exactly
// as a recipient would receive it, without sending anything outside this test.
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const fs=require('node:fs');
const net=require('node:net');
const path=require('node:path');
const {spawn}=require('node:child_process');
const {once}=require('node:events');
const {Pool}=require('pg');
const {createContactService}=require('../lib/contact-inquiries.cjs');
const {chromium}=require(process.env.BROWSER_TOOLS||'playwright');

assert(process.env.TEST_DATABASE_URL,'TEST_DATABASE_URL must identify a disposable local test database');
const database=new URL(process.env.TEST_DATABASE_URL);
assert(['postgres:','postgresql:'].includes(database.protocol)&&
  ['127.0.0.1','localhost','[::1]'].includes(database.hostname)&&/test/i.test(database.pathname),
  'A disposable loopback PostgreSQL test database is required');
for(const key of ['options','ssl','sslmode','sslcert','sslkey','sslrootcert'])database.searchParams.delete(key);
const schema='newsletter_browser_test_'+crypto.randomBytes(8).toString('hex');
const connectionString=database.toString();
const control=new Pool({connectionString,ssl:false,connectionTimeoutMillis:5000});
const db=new Pool({connectionString,ssl:false,options:'-c search_path='+schema,connectionTimeoutMillis:5000});
database.searchParams.set('options','-c search_path='+schema);
const root=path.resolve(__dirname,'..');
const artifacts=path.join(root,'test-artifacts');
const secret=crypto.randomBytes(48).toString('hex');
const dataKey=crypto.randomBytes(48).toString('hex');
const adminPassword=crypto.randomBytes(24).toString('hex');
const suffix=crypto.randomBytes(6).toString('hex');
const subscriberEmail='newsletter-'+suffix+'@example.test';
const subscriberName='Hírlevél Olvasó '+suffix;
const unsealer=createContactService({pool:db,auth:()=>{},dbState:{ready:true},env:{CMS_JWT_SECRET:secret,CONTACT_DATA_KEY:dataKey}});
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const errors=[],requests=[],secretTokens=[],pages=[],layoutFailures=[];
let child,browser,base,output='',schemaCreated=false;

async function until(check,label,timeout=15000){
  const end=Date.now()+timeout;
  do{if(await check())return;await wait(100);}while(Date.now()<end);
  throw new Error('Timed out: '+label);
}
async function freePort(){
  const listener=net.createServer();
  await new Promise((resolve,reject)=>{listener.once('error',reject);listener.listen(0,'127.0.0.1',resolve);});
  const port=listener.address().port;
  await new Promise(resolve=>listener.close(resolve));
  return port;
}
async function newContext(options={}){
  const context=await browser.newContext({viewport:{width:1440,height:1080},reducedMotion:'reduce',...options});
  context.setDefaultTimeout(15000);
  context.on('page',page=>{pages.push(page);page.on('pageerror',error=>errors.push(error.message));});
  context.on('request',request=>requests.push({url:request.url(),referer:request.headers().referer||''}));
  await context.route('**/*',route=>new URL(route.request().url()).origin===base?route.continue():route.abort());
  return context;
}
async function getJson(context,route,status=200){
  const response=await context.request.get(base+route);
  assert.equal(response.status(),status,route);
  return response.json();
}
async function postJson(context,route,data,status=200){
  const response=await context.request.post(base+route,{data,headers:{Origin:base}});
  const result=await response.json();
  assert.equal(response.status(),status,route+': '+(result.error||''));
  return result;
}
async function perform(page,method,route,action,status=200){
  const responsePromise=page.waitForResponse(response=>response.url()===base+route&&response.request().method()===method);
  const [response]=await Promise.all([responsePromise,action()]);
  const result=await response.json();
  assert.equal(response.status(),status,route+': '+(result.error||''));
  return result;
}
async function screenshot(page,name,target=null){
  await page.evaluate(async()=>{await document.fonts.ready;});
  if(target)await page.locator(target).scrollIntoViewIfNeeded();
  else await page.evaluate(()=>window.scrollTo(0,0));
  const dimensions=await page.evaluate(()=>({documentWidth:document.documentElement.scrollWidth,viewportWidth:innerWidth}));
  if(dimensions.documentWidth>dimensions.viewportWidth+1)layoutFailures.push({path:new URL(page.url()).pathname,...dimensions});
  await page.screenshot({path:path.join(artifacts,name+'.png')});
}
async function subscriber(email=subscriberEmail){
  return(await db.query('SELECT * FROM newsletter_subscribers WHERE lower(email)=lower($1)',[email])).rows[0];
}
async function confirmationMail(id){
  let mail;
  await until(async()=>{
    mail=(await db.query("SELECT * FROM newsletter_mail_jobs WHERE subscriber_id=$1 AND kind='confirmation' ORDER BY created_at DESC,id DESC LIMIT 1",[id])).rows[0];
    return !!mail;
  },'Encrypted confirmation queued');
  assert(['queued','needs_mail'].includes(mail.delivery_status),'Without credentials the confirmation remains queued for mail setup');
  assert.equal(mail.attempts,0,'No transport attempt without mail setup');
  assert(mail.payload_ciphertext&&!mail.payload_ciphertext.includes(subscriberEmail)&&!mail.payload_ciphertext.includes('#token='),'Confirmation envelope is encrypted');
  return unsealer.unseal(mail.payload_ciphertext);
}
function confirmationLink(message){
  assert.equal(message.to,subscriberEmail);
  const match=/https?:\/\/[^\s<>]+\/hirlevel\/megerosites#token=([A-Za-z0-9_-]+)/.exec(message.text);
  assert(match,'Confirmation email contains the expected fragment-only link');
  const url=new URL(match[0]);
  assert.equal(url.origin,base,'Test confirmation stays on the isolated local server');
  assert.equal(url.search,'','Confirmation token is not a query parameter');
  secretTokens.push(match[1]);
  return url;
}

async function main(){
  await control.query('CREATE SCHEMA '+schema);schemaCreated=true;
  assert.equal((await db.query('SELECT current_schema() AS name')).rows[0].name,schema);
  base='http://127.0.0.1:'+await freePort();
  const env={...process.env,DATABASE_URL:database.toString(),PGSSLMODE:'disable',PGSSLROOTCERT:'',DATABASE_CA_CERT:'',
    PGOPTIONS:'-c search_path='+schema,PORT:new URL(base).port,NODE_ENV:'test',MENTAL_PUBLIC_URL:base,
    CMS_JWT_SECRET:secret,CONTACT_DATA_KEY:dataKey,CMS_ADMIN_EMAIL:'admin@example.test',CMS_ADMIN_PASSWORD:adminPassword,
    CMS_ADMIN_PASSWORD_HASH:'',SMTP_HOST:'',SMTP_USER:'',SMTP_PASSWORD:'',SMTP_FROM:'',SMTP_URL:'',
    RESEND_API_KEY:'',BREVO_API_KEY:'',CONTACT_FROM_EMAIL:'',MAIL_FROM:''};
  child=spawn(process.execPath,['server.js'],{cwd:root,env,stdio:['ignore','pipe','pipe']});
  const collect=value=>{output=(output+value).slice(-160000);};
  child.stdout.on('data',collect);child.stderr.on('data',collect);child.on('error',error=>collect(error.message));
  await until(async()=>{
    assert.equal(child.exitCode,null,'The local test server exited');
    try{return(await fetch(base+'/health/ready',{signal:AbortSignal.timeout(2000)})).ok;}catch{return false;}
  },'Server readiness and isolated migrations',60000);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM directory_contact_settings')).rows[0].n,0,'No production mail settings were inherited');
  fs.mkdirSync(artifacts,{recursive:true});
  browser=await chromium.launch({headless:true});
  const guest=await newContext(),page=await guest.newPage();
  const topics=await getJson(guest,'/api/newsletter/topics');
  assert(topics.items.some(topic=>topic.key==='alvas'),'Sleep is a selectable newsletter topic');
  assert(topics.items.some(topic=>topic.key==='adhd'),'ADHD is a selectable newsletter topic');
  assert(topics.items.some(topic=>topic.key==='kapcsolatok'),'Relationships are a selectable newsletter topic');

  // The homepage really collects name, email, selected topics and explicit consent.
  await page.goto(base+'/',{waitUntil:'networkidle'});
  const form=page.locator('form[data-newsletter-mode="subscribe"]');
  await form.waitFor({state:'visible'});
  assert.equal(await form.locator('[name="consent"]').isChecked(),false,'Newsletter consent is not preselected');
  await form.locator('[name="name"]').fill(subscriberName);
  await form.locator('[name="email"]').fill(subscriberEmail);
  await form.locator('[name="topics"][value="alvas"]').check();
  await form.locator('[name="topics"][value="adhd"]').check();
  await form.locator('[name="consent"]').check();
  await page.setViewportSize({width:390,height:844});
  await screenshot(page,'newsletter-public-mobile','form[data-newsletter-mode="subscribe"]');
  await page.setViewportSize({width:1440,height:1080});
  const submitted=await perform(page,'POST','/api/newsletter/subscribe',()=>form.locator('button[type="submit"]').click(),202);
  assert.equal(submitted.ok,true);
  const pending=await subscriber();
  assert(pending&&pending.status==='pending'&&!pending.confirmed_at,'A submitted address is pending until mailbox confirmation');
  const link=confirmationLink(await confirmationMail(pending.id));

  // GET is safe for mail scanners: a conscious button click confirms the mailbox.
  await page.goto(link.toString(),{waitUntil:'networkidle'});
  await page.locator('[data-newsletter-confirm]').waitFor({state:'visible'});
  assert.equal((await subscriber()).status,'pending','Opening a confirmation link does not confirm it automatically');
  assert.equal(new URL(page.url()).hash,'','The confirmation fragment is removed from the address bar');
  const confirmed=await perform(page,'POST','/api/newsletter/confirm',()=>page.locator('[data-newsletter-confirm]').click());
  assert.equal(confirmed.ok,true);
  assert(typeof confirmed.preferences_token==='string'&&confirmed.preferences_token.length>30,'A confirmed reader can manage their subscription');
  secretTokens.push(confirmed.preferences_token);
  const active=await subscriber();
  assert.equal(active.status,'active');assert(active.confirmed_at);assert.equal(active.name,subscriberName);
  assert.deepEqual([...active.topics].sort(),['adhd','alvas']);
  await postJson(guest,'/api/newsletter/subscribe',{name:'Anonymous overwrite attempt',email:subscriberEmail,topics:['kapcsolatok'],consent:true,website:''},202);
  const unchanged=await subscriber();
  assert.equal(unchanged.name,subscriberName,'Anonymous signup cannot overwrite a confirmed name');
  assert.deepEqual([...unchanged.topics].sort(),['adhd','alvas'],'Anonymous signup cannot change confirmed interests');

  // The personal management link updates only this reader and keeps email fixed.
  await page.goto(base+'/hirlevel/beallitasok#token='+confirmed.preferences_token,{waitUntil:'networkidle'});
  const preferences=page.locator('form[data-newsletter-mode="preferences"]');
  await preferences.waitFor({state:'visible'});
  await until(async()=>await preferences.locator('[name="name"]').inputValue()===subscriberName,'Personal preferences loaded');
  assert.equal(new URL(page.url()).hash,'','The preferences fragment is removed from the address bar');
  assert.equal(await preferences.locator('[name="topics"][value="alvas"]').isChecked(),true);
  assert.equal(await preferences.locator('[name="topics"][value="adhd"]').isChecked(),true);
  await preferences.locator('[name="name"]').fill('Frissített Olvasó '+suffix);
  await preferences.locator('[name="topics"][value="adhd"]').uncheck();
  await preferences.locator('[name="topics"][value="kapcsolatok"]').check();
  await perform(page,'POST','/api/newsletter/preferences',()=>preferences.locator('button[type="submit"]').click());
  const updated=await subscriber();
  assert.equal(updated.name,'Frissített Olvasó '+suffix);assert.equal(updated.email,subscriberEmail);
  assert.deepEqual([...updated.topics].sort(),['alvas','kapcsolatok']);
  await screenshot(page,'newsletter-preferences-desktop');

  // Legacy email links still work, but GET does not unsubscribe a scanner visit.
  await page.goto(base+'/leiratkozas/'+encodeURIComponent(updated.unsubscribe_token),{waitUntil:'networkidle'});
  await page.locator('[data-newsletter-unsubscribe]').waitFor({state:'visible'});
  assert.equal((await subscriber()).status,'active','Viewing the unsubscribe landing page is not an unsubscribe action');
  await perform(page,'POST','/api/newsletter/unsubscribe',()=>page.locator('[data-newsletter-unsubscribe]').click());
  assert.equal((await subscriber()).status,'unsubscribed','The explicit unsubscribe button removes the reader from future sends');

  // Admin fixtures are ordinary rows in this random test schema, never production.
  const otherEmail='newsletter-other-'+suffix+'@example.test';
  const other=(await db.query(`INSERT INTO newsletter_subscribers(email,name,status,topics,confirmed_at,unsubscribe_token)
    VALUES($1,$2,'active',$3,now(),$4) RETURNING id`,[otherEmail,'Heti Olvasó '+suffix,['alvas'],crypto.randomBytes(32).toString('hex')])).rows[0];
  await db.query(`INSERT INTO newsletter_subscribers(email,name,status,topics,unsubscribe_token)
    VALUES($1,'Korábbi feliratkozó','active','{}',$2)`,['legacy-'+suffix+'@example.test',crypto.randomBytes(32).toString('hex')]);
  const articleTitle='Heti alváskutatás böngészős ellenőrzéshez '+suffix;
  const draftTitle='Nem publikált hírlevélteszt '+suffix;
  const insertedArticles=await db.query(`INSERT INTO articles(slug,title,category,excerpt,content_html,status,published_at,hero_image_path)
    VALUES($1,$2,'Alvás','Egy ellenőrzött tesztkivonat a hírlevél előnézetéhez.','<p>Elszigetelt tesztcikk.</p>','published',now()-interval '1 second','/assets/mental-og.png'),
          ($3,$4,'Alvás','Piszkozat.','<p>Piszkozat.</p>','draft',now()-interval '1 day','') RETURNING id,slug`,
    ['newsletter-test-'+suffix,articleTitle,'newsletter-draft-'+suffix,draftTitle]);
  const articleId=insertedArticles.rows.find(article=>article.slug==='newsletter-test-'+suffix).id;
  const campaignId=crypto.randomUUID(),jobId=crypto.randomUUID();
  await db.query(`INSERT INTO newsletter_campaigns(id,scheduled_at,window_start,window_end,status,recipient_count,queued_count)
    VALUES($1,now(),now()-interval '7 days',now(),'queued',1,1)`,[campaignId]);
  await db.query(`INSERT INTO newsletter_mail_jobs(id,kind,subscriber_id,campaign_id,payload_ciphertext,preferences_version,
    article_ids,article_count,delivery_status,expires_at)
    VALUES($1,'digest',$2,$3,$4,0,$5,1,'needs_mail',now()+interval '1 day')`,
    [jobId,other.id,campaignId,unsealer.seal({id:jobId,to:otherEmail,subject:'Elszigetelt hírlevélteszt',
      text:'Böngészős ellenőrzéshez készített küldési napló. Ez a teszt nem küld e-mailt.',scope:'mental-newsletter'}),[articleId]]);

  const admin=await newContext(),adminPage=await admin.newPage();
  assert.equal((await guest.request.get(base+'/api/admin/newsletter')).status(),401,'Newsletter management is private');
  await adminPage.goto(base+'/admin/?view=subscribers',{waitUntil:'networkidle'});
  await adminPage.locator('#loginView').waitFor({state:'visible'});
  await adminPage.locator('#loginEmail').fill('admin@example.test');
  await adminPage.locator('#loginPassword').fill(adminPassword);
  await perform(adminPage,'POST','/api/admin/login',()=>adminPage.locator('#loginForm button').click());
  await adminPage.locator('#subscribersView').waitFor({state:'visible'});
  await adminPage.locator('#newsletterSubscribers').waitFor({state:'visible'});
  await until(async()=>(await adminPage.locator('#newsletterSubscribers').textContent()).includes(otherEmail),'Subscriber management loaded');
  assert.equal(await adminPage.locator('#viewTitle').textContent(),'Hírlevél','Admin email links preserve the newsletter view through login');
  const dashboard=await getJson(admin,'/api/admin/newsletter');
  assert.equal(dashboard.mail_ready,false);assert.equal(dashboard.test_recipient,'den@proptechdigital.com');
  assert.equal(await adminPage.locator('#newsletterTestButton').isDisabled(),true,'No test send is offered when mail is not configured');
  assert(dashboard.counts.needs_preferences>=1,'Legacy readers are visible as needing preference setup');
  assert(dashboard.next_send_at,'The next Friday edition is visible');
  const campaignButton=adminPage.locator('[data-newsletter-campaign-id="'+campaignId+'"]');
  await campaignButton.waitFor({state:'visible'});
  await campaignButton.click();
  await adminPage.locator('#newsletterCampaignDialog').waitFor({state:'visible'});
  await until(async()=>(await adminPage.locator('#newsletterCampaignDetails').textContent()).includes(otherEmail),'Per-recipient campaign history loaded');
  assert((await adminPage.locator('#newsletterCampaignDetails').textContent()).includes('1'),'Campaign details show the selected article count');
  await adminPage.keyboard.press('Escape');
  await adminPage.locator('#newsletterCampaignDialog').waitFor({state:'hidden'});
  await adminPage.setViewportSize({width:390,height:844});
  await screenshot(adminPage,'newsletter-admin-mobile','#subscribersView');
  await adminPage.setViewportSize({width:1440,height:1080});

  await adminPage.locator('#newsletterSearch').fill(otherEmail);
  await adminPage.locator('#newsletterSearchForm button[type="submit"]').click();
  const unsubscribeButton=adminPage.locator('[data-newsletter-unsubscribe-id="'+other.id+'"]');
  await unsubscribeButton.waitFor({state:'visible'});
  await until(async()=>!(await adminPage.locator('#newsletterSubscribers').textContent()).includes(subscriberEmail),'Search limits the visible subscribers');
  adminPage.once('dialog',dialog=>dialog.accept());
  await perform(adminPage,'POST','/api/admin/newsletter/subscribers/'+other.id+'/unsubscribe',()=>unsubscribeButton.click());
  assert.equal((await subscriber(otherEmail)).status,'unsubscribed');
  await adminPage.locator('#newsletterStatus').selectOption('unsubscribed');
  await until(async()=>(await adminPage.locator('#newsletterSubscribers').textContent()).includes(otherEmail),'Unsubscribed filter rendered');
  await adminPage.locator('#newsletterSearch').fill('');
  await adminPage.locator('#newsletterSearchForm button[type="submit"]').click();
  await until(async()=>(await adminPage.locator('#newsletterSubscribers').textContent()).includes(subscriberEmail),'Both unsubscribed readers shown');
  assert(!(await adminPage.locator('#newsletterSubscribers').textContent()).includes('Korábbi feliratkozó'),'The unsubscribed filter excludes a legacy active reader');

  // Pausing and resuming are real authenticated mutations; no digest is sent here.
  const originallyEnabled=dashboard.enabled;
  await perform(adminPage,'POST','/api/admin/newsletter/settings',()=>adminPage.locator('#newsletterPauseToggle').click());
  await until(async()=>(await getJson(admin,'/api/admin/newsletter')).enabled===!originallyEnabled,'Schedule pause persisted');
  await until(async()=>!(await adminPage.locator('#newsletterPauseToggle').isDisabled()),'Schedule button ready after save');
  await perform(adminPage,'POST','/api/admin/newsletter/settings',()=>adminPage.locator('#newsletterPauseToggle').click());
  assert.equal((await getJson(admin,'/api/admin/newsletter')).enabled,originallyEnabled,'Resuming restores the configured schedule');

  // Preview renders branded HTML from real published articles without enqueueing mail.
  const jobsBefore=(await db.query('SELECT count(*)::int AS n FROM newsletter_mail_jobs')).rows[0].n;
  await adminPage.locator('#newsletterPreviewForm summary').click();
  await adminPage.locator('#newsletterPreviewForm [name="preview_topics"][value="alvas"]').check();
  const previewHref=await adminPage.locator('#newsletterPreviewLink').getAttribute('href');
  const previewUrl=new URL(previewHref,base);
  assert.equal(previewUrl.origin,base);assert.equal(previewUrl.pathname,'/api/admin/newsletter/preview');
  assert.equal(previewUrl.searchParams.get('topics'),'alvas','The admin preview honors the selected topic');
  const preview=await admin.newPage();
  assert.equal((await preview.goto(previewUrl.toString(),{waitUntil:'networkidle'})).status(),200);
  assert((await preview.locator('body').textContent()).includes(articleTitle),'The relevant published article appears in the preview');
  assert(!(await preview.locator('body').textContent()).includes(draftTitle),'Unpublished content is excluded from the preview');
  assert(await preview.locator('img').count()>0,'The preview contains the newsletter logo or article image');
  assert(await preview.locator('img').first().evaluate(image=>image.complete&&image.naturalWidth>0),'The newsletter logo asset actually loads');
  assert(await preview.locator('a[href*="/cikk/newsletter-test-"]').count()>0,'Digest links point to the public article permalink');
  await preview.setViewportSize({width:700,height:1000});
  await screenshot(preview,'newsletter-email-preview');
  await preview.setViewportSize({width:390,height:844});
  await screenshot(preview,'newsletter-email-mobile');
  assert.equal((await db.query('SELECT count(*)::int AS n FROM newsletter_mail_jobs')).rows[0].n,jobsBefore,'Preview creates no outgoing mail jobs');

  for(const request of requests)assert(!secretTokens.some(token=>request.url.includes(token)||request.referer.includes(token)),
    'Confirmation and preferences tokens never appear in request URLs or referrers');
  for(const openPage of pages.filter(item=>!item.isClosed())){
    const stored=await openPage.evaluate(()=>JSON.stringify({local:{...localStorage},session:{...sessionStorage}}));
    assert(!secretTokens.some(token=>stored.includes(token))&&!stored.includes(adminPassword),'Capabilities are not persisted in browser storage');
  }
  const delivery=(await db.query("SELECT count(*) FILTER(WHERE attempts>0 OR delivery_status IN ('sending','accepted'))::int AS attempts FROM newsletter_mail_jobs")).rows[0];
  assert.equal(delivery.attempts,0,'No real newsletter email delivery was attempted');
  assert.deepEqual(errors,[],'No uncaught browser JavaScript exceptions');
  assert.deepEqual(layoutFailures,[],'No horizontal document overflow across newsletter screenshots');
  console.log('NEWSLETTER_BROWSER_OK',JSON.stringify({homepageSignup:true,explicitConsent:true,encryptedConfirmation:true,
    explicitConfirmation:true,anonymousOverwritePrevented:true,preferences:true,scannerSafeUnsubscribe:true,
    adminAuth:true,campaignHistory:true,subscriberSearch:true,statusFilter:true,adminUnsubscribe:true,schedulePauseResume:true,
    publishedOnlyPreview:true,previewDoesNotSend:true,responsiveScreenshots:true,tokenUrlAndStorageSafety:true,realEmailsSent:0}));
}

main().catch(async error=>{
  console.error(error.stack);
  fs.mkdirSync(artifacts,{recursive:true});
  for(let index=0;index<pages.length;index++){
    if(!pages[index].isClosed())await pages[index].screenshot({path:path.join(artifacts,'newsletter-failure-'+index+'.png')}).catch(()=>{});
  }
  console.error(output);process.exitCode=1;
}).finally(async()=>{
  if(browser)await browser.close().catch(()=>{});
  if(child&&child.exitCode===null){
    const done=once(child,'exit').catch(()=>{});child.kill('SIGTERM');
    await Promise.race([done,wait(2000)]);
    if(child.exitCode===null){child.kill('SIGKILL');await Promise.race([done,wait(2000)]);}
  }
  await db.end();
  if(schemaCreated)await control.query('DROP SCHEMA '+schema+' CASCADE');
  await control.end();
});
