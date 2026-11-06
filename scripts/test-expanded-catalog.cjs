'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {spawn}=require('node:child_process');const {once}=require('node:events');const {Pool}=require('pg');
const express=require('express'),cookieParser=require('cookie-parser'),jwt=require('jsonwebtoken');
const {buildDatabaseConfig}=require('../lib/database-config.cjs');const {createContactService}=require('../lib/contact-inquiries.cjs');
const u=new URL(process.env.DATABASE_URL||'http://invalid');assert(['127.0.0.1','localhost'].includes(u.hostname)&&/test/.test(u.pathname),'Disposable local test database required');
const db=new Pool(buildDatabaseConfig()),root=path.resolve(__dirname,'..'),base='http://127.0.0.1:18081';
const manifest=JSON.parse(fs.readFileSync(path.join(root,'catalog-release.json'),'utf8'));
const secret=crypto.randomBytes(48).toString('hex'),adminPassword=crypto.randomBytes(24).toString('hex');let child,server,output='';
const wait=ms=>new Promise(r=>setTimeout(r,ms));
async function req(url,options={}){return fetch(url.startsWith('http')?url:base+url,{...options,signal:AbortSignal.timeout(20000)});}
async function read(route){const r=await req(route);assert.equal(r.status,200,route+' '+output);return r;}
async function start(){child=spawn(process.execPath,['server.js'],{cwd:root,env:{...process.env,PORT:'18081',NODE_ENV:'test',CMS_JWT_SECRET:secret,CMS_ADMIN_EMAIL:'admin@example.test',CMS_ADMIN_PASSWORD:adminPassword},stdio:['ignore','pipe','pipe']});child.stdout.on('data',x=>output+=x);child.stderr.on('data',x=>output+=x);for(let i=0;i<100;i++){assert.equal(child.exitCode,null,output);try{const r=await req('/health/ready');if(r.ok)return r.json();}catch{}await wait(200);}throw Error('Server never ready: '+output);}
async function stop(){if(child&&child.exitCode===null){const done=once(child,'exit');child.kill('SIGTERM');await Promise.race([done,wait(2000)]);if(child.exitCode===null)child.kill('SIGKILL');}}
async function catalogTests(){
 const health=await start();assert(health.listings>=1000);assert.equal(health.categories,31);
 const cats=await (await read('/api/public/categories')).json();assert.equal(cats.length,31);assert(cats.every(x=>x.listing_count>=20),JSON.stringify(cats.filter(x=>x.listing_count<20)));
 const home=await (await read('/')).text();assert(home.includes('data-total="'+health.listings+'"'));
 const badges=[...home.matchAll(/<small\b([^>]*\bdata-count="([^"]+)"[^>]*)>([\s\S]*?)<\/small>/g)];assert.equal(badges.length,39);
 const map=new Map(cats.map(c=>[c.slug,c.listing_count]));for(const b of badges){assert(!/\bhidden\b/.test(b[1]));assert.equal(b[3],'('+map.get(b[2])+')');}
 for(const cat of cats){assert(home.includes('href="/kategoria/'+cat.slug+'"'));const d=await(await read('/api/public/listings?paginated=true&limit=1&category='+cat.slug)).json();assert.equal(d.total,cat.listing_count);assert(d.items[0].categories.some(c=>c.slug===cat.slug));const html=await(await read('/kategoria/'+cat.slug)).text();assert(html.includes('data-catalog-total="'+d.total+'"'));const profile=await(await read(d.items[0].url)).text();assert(profile.includes('data-contact-slug="'+d.items[0].slug+'"'));assert(profile.includes('contactInquiryForm'));}
 const first=await(await read('/api/public/listings?paginated=true&limit=100')).json(),ids=new Set();let links=[];
 for(let p=1;p<=first.pages;p++){const d=await(await read('/api/public/listings?paginated=true&limit=100&page='+p)).json();d.items.forEach(x=>{assert(!ids.has(x.id),'Duplicate listing');ids.add(x.id);assert(x.categories.length>0);});}assert.equal(ids.size,health.listings);
 const htmlPages=Math.ceil(health.listings/24);
 for(let p=1;p<=htmlPages;p++){const html=await(await read('/kereses?page='+p)).text();const pageLinks=[...html.matchAll(/class="listing-card[^\"]*" href="\/szolgaltato\/([^\"]+)"/g)].map(m=>m[1]);assert.equal(pageLinks.length,p===htmlPages?(health.listings-24*(htmlPages-1)):24);links.push(...pageLinks);}
 assert.equal(new Set(links).size,health.listings);
 const privatePaths=['/server.js','/lib/contact-inquiries.cjs','/migrations/008_contact_inquiries.sql','/research/expansion-20261106/candidates.json','/scripts/test-expanded-catalog.cjs','/node_modules/pg/package.json'];
 for(const p of privatePaths)assert.equal((await req(p)).status,404,p);
 assert.equal((await req('/api/admin/contact/inquiries')).status,401);
 const profile=first.items[0],publicApi=await(await read('/api/public/listings/'+profile.slug)).json();assert(!('admin_notes'in publicApi));assert(!('email_source_url'in publicApi));
 const sample=(await db.query('SELECT id,name FROM directory_listings ORDER BY id LIMIT 1')).rows[0];
 await db.query('UPDATE directory_listings SET name=$1 WHERE id=$2',[sample.name+' CI-EDIT',sample.id]);await stop();const restarted=await start();assert.equal(restarted.listings,health.listings);assert.equal((await db.query('SELECT name FROM directory_listings WHERE id=$1',[sample.id])).rows[0].name,sample.name+' CI-EDIT');await db.query('UPDATE directory_listings SET name=$1 WHERE id=$2',[sample.name,sample.id]);
 console.log('CATALOG_OK',JSON.stringify({total:health.listings,categories:cats.length,minimum:Math.min(...cats.map(c=>c.listing_count)),htmlPages,distinctProfiles:links.length,homepageBadges:badges.length,allCategoriesReachable:true,restartPreservesEdits:true}));
 return {health,cats};
}
async function contactTests(){
 const app=express();app.set('trust proxy',1);app.use(express.json());app.use(cookieParser());
 const auth=(req,res,next)=>{try{const token=jwt.verify(req.cookies.mental_cms,secret);if(token.role!=='admin')throw Error();req.user=token;next();}catch{res.status(401).json({error:'Unauthorized'});}};
 const deliveries=[],audits=[];let failMail=false;
 const env={CMS_JWT_SECRET:secret,NODE_ENV:'test'};
 const service=createContactService({pool:db,auth,dbState:{ready:true},env,audit:(...x)=>audits.push(x),transport:async envelope=>{assert(!envelope.text.includes('diagnózis:'));if(failMail)throw Object.assign(Error('smtp test'),{code:'ETIMEDOUT'});deliveries.push(envelope);return{id:'test-only-'+envelope.id};}});
 service.register(app);app.use((err,req,res,next)=>{console.error('CONTACT_TEST_ERROR',err.code||err.message);res.status(500).json({error:'TEST_ERROR'});});
 server=app.listen(18082,'127.0.0.1');await once(server,'listening');const endpoint='http://127.0.0.1:18082';
 let jar={};const adminCookie=jwt.sign({email:'admin@example.test',role:'admin'},secret,{expiresIn:'1h'});
 async function call(p,{method='GET',data,admin=false,csrf,ip='198.51.100.20'}={}){const cookies={...jar,...(admin?{mental_cms:adminCookie}:{})};const r=await req(endpoint+p,{method,headers:{'Content-Type':'application/json','Cookie':Object.entries(cookies).map(([k,v])=>k+'='+v).join('; '),'X-Forwarded-For':ip,...(csrf?{'X-Contact-CSRF':csrf}:{})},...(data?{body:JSON.stringify(data)}:{})});for(const raw of r.headers.getSetCookie()){const[k,v]=raw.split(';')[0].split('=');jar[k]=v;}return{status:r.status,data:await r.json()};}
 const selected=(await db.query("SELECT id,slug,email,email_source_url FROM directory_listings WHERE status='published' ORDER BY id LIMIT 2")).rows;
 const [x,y]=selected;await db.query('UPDATE directory_listings SET email=$1 WHERE id=$2',['provider@example.test',x.id]);await db.query("UPDATE directory_listings SET email='' WHERE id=$1",[y.id]);
 const form0=await call('/api/contact/form/'+x.slug);assert.equal(form0.data.enabled,false);
 const countBefore=(await db.query('SELECT count(*)::int AS n FROM directory_contact_inquiries')).rows[0].n;
 const closed=await call('/api/contact/inquiries/'+x.slug,{method:'POST',data:{},csrf:form0.data.csrf_token});assert.equal(closed.status,503);
 assert.equal((await db.query('SELECT count(*)::int AS n FROM directory_contact_inquiries')).rows[0].n,countBefore);
 assert.equal((await call('/api/admin/contact/inquiries')).status,401);
 let cfg=await call('/api/admin/contact/settings',{admin:true}),token=cfg.data.csrf_token;
 const settings={enabled:true,controller_name:'Izolált CI Teszt',controller_address:'Tesztkörnyezet, nem valós ügyfél',privacy_email:'privacy@example.test',retention_days:30,provider:'resend',from_email:'sender@example.test',api_key:'fake-ci-key-never-sent',smtp_port:587};
 assert.equal((await call('/api/admin/contact/settings',{method:'PUT',admin:true,data:settings})).status,403);
 assert.equal((await call('/api/admin/contact/settings',{method:'PUT',admin:true,csrf:token,data:settings})).status,200);
 cfg=await call('/api/admin/contact/settings',{admin:true});token=cfg.data.csrf_token;assert(cfg.data.has_api_key);assert(!JSON.stringify(cfg.data).includes(settings.api_key));
 const form=(await call('/api/contact/form/'+x.slug)).data;assert(form.enabled&&form.mail_ready&&form.recipient_ready);assert(form.consent_text.includes('Izolált CI Teszt'));
 const data={name:'CI Kapcsolat',email:'requester@example.test',phone:'+36 20 555 0101',preference:'email',adult:true,consent:true,request_key:form.request_key,recipient:'attacker@example.test'};
 assert.equal((await call('/api/contact/inquiries/'+x.slug,{method:'POST',data,csrf:'invalid'})).status,403);
 assert.equal((await call('/api/contact/inquiries/'+x.slug,{method:'POST',data:{...data,consent:false},csrf:form.csrf_token})).status,400);
 assert.equal((await call('/api/contact/inquiries/'+x.slug,{method:'POST',data:{...data,email:'bad\n@example.test'},csrf:form.csrf_token})).status,400);
 const created=await call('/api/contact/inquiries/'+x.slug,{method:'POST',data,csrf:form.csrf_token});assert.equal(created.status,201);const id=created.data.id;
 const dup=await call('/api/contact/inquiries/'+x.slug,{method:'POST',data,csrf:form.csrf_token});assert.equal(dup.status,200);assert.equal(dup.data.id,id);
 for(let i=0;i<30;i++){await service.runWorker();if(deliveries.length)break;await wait(25);}await wait(50);
 assert.equal(deliveries.length,1);assert.equal(deliveries[0].to,'provider@example.test');assert.equal(deliveries[0].replyTo,'requester@example.test');assert(!deliveries[0].text.includes('attacker'));
 const stored=(await db.query('SELECT * FROM directory_contact_inquiries WHERE id=$1',[id])).rows[0];assert.equal(stored.delivery_status,'accepted');assert(!stored.payload_ciphertext.includes('CI Kapcsolat'));assert(!stored.payload_ciphertext.includes(data.email));assert.equal(service.unseal(stored.payload_ciphertext).phone,data.phone);
 assert.equal((await call('/api/admin/contact/inquiries/'+id)).status,401);
 const adminDetail=await call('/api/admin/contact/inquiries/'+id,{admin:true});assert.equal(adminDetail.data.payload.email,data.email);assert(adminDetail.data.events.some(e=>e.event_type==='accepted'));assert(adminDetail.data.payload.consent_text);
 const f2=(await call('/api/contact/form/'+y.slug)).data;
 const cross=await call('/api/contact/inquiries/'+y.slug,{method:'POST',data,csrf:f2.csrf_token});assert.equal(cross.status,409,'Idempotency keys cannot cross listing boundaries');
 const pending=await call('/api/contact/inquiries/'+y.slug,{method:'POST',csrf:f2.csrf_token,data:{...data,request_key:f2.request_key}});assert.equal(pending.status,201);assert.equal(pending.data.status,'needs_recipient');
 assert.equal((await call('/api/admin/contact/inquiries/'+pending.data.id+'/action',{method:'POST',admin:true,csrf:token,data:{action:'retry'}})).status,409);
 await db.query('UPDATE directory_listings SET email=$1 WHERE id=$2',['second-provider@example.test',y.id]);
 const retry=await call('/api/admin/contact/inquiries/'+pending.data.id+'/action',{method:'POST',admin:true,csrf:token,data:{action:'retry'}});assert.equal(retry.status,200);await wait(50);await service.runWorker();await wait(50);assert.equal(deliveries.length,2);
 await call('/api/admin/contact/settings',{method:'PUT',admin:true,csrf:token,data:{...settings,provider:''}});
 const f3=(await call('/api/contact/form/'+x.slug)).data;const noMail=await call('/api/contact/inquiries/'+x.slug,{method:'POST',csrf:f3.csrf_token,data:{...data,email:'second@example.test',request_key:f3.request_key}});assert.equal(noMail.data.status,'needs_mail');assert.equal(deliveries.length,2);
 await call('/api/admin/contact/settings',{method:'PUT',admin:true,csrf:token,data:settings});failMail=true;
 await call('/api/admin/contact/inquiries/'+noMail.data.id+'/action',{method:'POST',admin:true,csrf:token,data:{action:'retry'}});await wait(50);await service.runWorker();await wait(50);
 const uncertain=(await db.query('SELECT delivery_status FROM directory_contact_inquiries WHERE id=$1',[noMail.data.id])).rows[0];assert.equal(uncertain.delivery_status,'uncertain');
 assert.equal((await call('/api/admin/contact/inquiries/'+noMail.data.id+'/action',{method:'POST',admin:true,csrf:token,data:{action:'retry'}})).status,409);
 const erased=await call('/api/admin/contact/inquiries/'+id+'/action',{method:'POST',admin:true,csrf:token,data:{action:'erase'}});assert.equal(erased.status,200);const gone=(await db.query('SELECT * FROM directory_contact_inquiries WHERE id=$1',[id])).rows[0];assert.equal(gone.payload_ciphertext,null);assert.equal(gone.requester_hash,null);assert.equal(gone.listing_id,null);
 await db.query('UPDATE directory_contact_inquiries SET expires_at=now()-interval \'1 minute\' WHERE id=$1',[pending.data.id]);const cleanup=createContactService({pool:db,auth,dbState:{ready:true},env,transport:async()=>{throw Error('Must not send')}});await cleanup.runWorker();assert.equal((await db.query('SELECT payload_ciphertext FROM directory_contact_inquiries WHERE id=$1',[pending.data.id])).rows[0].payload_ciphertext,null);
 assert(!JSON.stringify(audits).includes('requester@example.test'));
 for(const row of selected)await db.query('UPDATE directory_listings SET email=$1,email_source_url=$2 WHERE id=$3',[row.email,row.email_source_url,row.id]);
 // Do not leave a locally enabled test controller or test requests in the DB for subsequent tests.
 await db.query('DELETE FROM directory_contact_inquiries');await db.query('DELETE FROM directory_contact_settings');
 console.log('CONTACT_OK',JSON.stringify({csrf:true,adminOnly:true,encrypted:true,explicitConsent:true,noHealthFreeText:true,idempotency:true,recipientIsolation:true,pendingRecipient:true,pendingMailer:true,acceptedNotRead:true,uncertainRetryGuard:true,adminErasure:true,retentionCleanup:true,realEmailsSent:0,testTransportAcceptances:deliveries.length}));
}
(async()=>{const result=await catalogTests();await contactTests();fs.writeFileSync(path.join(root,'release-test-report.json'),JSON.stringify({ok:true,...result,contactTests:true,realEmailsSent:0},null,2));console.log('ALL EXPANDED CATALOG AND CONTACT TESTS PASSED');})().catch(e=>{console.error(e.stack);console.error(output);process.exitCode=1;}).finally(async()=>{if(server)await new Promise(r=>server.close(r));await stop();await db.end();});
