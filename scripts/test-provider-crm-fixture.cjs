'use strict';
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const fs=require('node:fs');
const path=require('node:path');
const express=require('express');
const cookieParser=require('cookie-parser');
const helmet=require('helmet');
const {Pool}=require('pg');
const {createProviderAccountService,hash}=require('../lib/provider-accounts.cjs');
const {createContactService}=require('../lib/contact-inquiries.cjs');
const {createProviderCrmService}=require('../lib/provider-crm.cjs');
const {renderProviderCrmPage}=require('../lib/provider-crm-views.cjs');

async function createFixture(){
 const connectionString=process.env.TEST_DATABASE_URL;assert(connectionString,'TEST_DATABASE_URL must identify disposable local PostgreSQL');
 const url=new URL(connectionString);assert(['postgres:','postgresql:'].includes(url.protocol)&&['127.0.0.1','localhost','[::1]'].includes(url.hostname)&&/test/i.test(url.pathname),'Disposable loopback PostgreSQL database required');
 const schema='provider_crm_test_'+crypto.randomBytes(8).toString('hex'),root=path.resolve(__dirname,'..');
 const control=new Pool({connectionString,ssl:false}),db=new Pool({connectionString,ssl:false,options:'-c search_path='+schema});
 let server,accounts,service,created=false,mailAttempts=0;
 async function close(){service?.stop();accounts?.stop();if(server)await new Promise(resolve=>server.close(resolve));await db.end();if(created)await control.query('DROP SCHEMA '+schema+' CASCADE');await control.end();}
 try{
  await control.query('CREATE SCHEMA '+schema);created=true;
  for(const name of ['001_init.sql','002_directory.sql','008_contact_inquiries.sql','016_provider_accounts.sql','017_submission_trash.sql','018_provider_listing_owners.sql','021_reader_accounts.sql','023_provider_crm.sql'])await db.query(fs.readFileSync(path.join(root,'migrations',name),'utf8'));
  const contact=createContactService({pool:db,auth:()=>{},dbState:{ready:true},env:{CONTACT_DATA_KEY:crypto.randomBytes(48).toString('hex')}});
  const mailer={ready:async()=>false,seal:contact.seal,unseal:contact.unseal,send:async()=>{mailAttempts++;throw Error('Real mail is prohibited in CRM tests');}};
  const app=express();app.use(helmet({contentSecurityPolicy:{directives:{defaultSrc:["'self'"],scriptSrc:["'self'"],styleSrc:["'self'","'unsafe-inline'"],fontSrc:["'self'"],imgSrc:["'self'",'data:']}}}));app.use(express.json());app.use(cookieParser());
  server=await new Promise(resolve=>{const listener=app.listen(0,'127.0.0.1',()=>resolve(listener));});const base='http://127.0.0.1:'+server.address().port;
  accounts=createProviderAccountService({pool:db,dbState:{ready:true},secret:crypto.randomBytes(32).toString('hex'),baseUrl:base,mailer,env:{NODE_ENV:'test'}});accounts.register(app);
  service=createProviderCrmService({pool:db,dbState:{ready:true},accounts,seal:contact.seal,unseal:contact.unseal});service.register(app);
  app.get('/fiokom/ugyfelek',(_req,res)=>{res.set({'Cache-Control':'private, no-store','X-Robots-Tag':'noindex, nofollow','Referrer-Policy':'no-referrer'});res.type('html').send(renderProviderCrmPage());});
  app.get('/api/public/articles',(_req,res)=>res.json({items:[],total:0}));
  app.use('/assets',express.static(path.join(root,'assets')));
  for(const name of ['mental.css','mental.js','provider-account.css','provider-crm.css','provider-crm.js'])app.get('/'+name,(_req,res)=>res.sendFile(path.join(root,name)));
  function client(cookies={}){const jar={...cookies};let csrf='';return {jar,async call(route,{method='GET',data,origin=base,withCsrf=true}={}){const response=await fetch(base+route,{method,headers:{Origin:origin,Accept:'application/json','Content-Type':'application/json',Cookie:Object.entries(jar).map(([name,value])=>name+'='+value).join('; '),...(withCsrf&&csrf?{'X-Account-CSRF':csrf}:{})},...(data===undefined?{}:{body:JSON.stringify(data)})});for(const item of response.headers.getSetCookie()){const [name,value]=item.split(';')[0].split('=');if(value)jar[name]=value;else delete jar[name];}const body=response.headers.get('content-type')?.includes('application/json')?await response.json():await response.text();if(body?.csrf_token)csrf=body.csrf_token;return {status:response.status,body,headers:response.headers};},bootstrap(){return this.call('/api/account/session');}};}
  async function seedAccount(email,{provider=true,verified=true,disabled=false}={}){const account=(await db.query(`INSERT INTO provider_accounts(email,display_name,email_verified_at,disabled_at,provider_profile_started_at)
   VALUES($1,'Izolált tesztfiók',CASE WHEN $2 THEN now() ELSE NULL END,CASE WHEN $3 THEN now() ELSE NULL END,CASE WHEN $4 THEN now() ELSE NULL END) RETURNING id,email`,[email,verified,disabled,provider])).rows[0];const token=crypto.randomBytes(32).toString('hex');await db.query("INSERT INTO provider_account_sessions(session_hash,account_id,expires_at) VALUES($1,$2,now()+interval '1 day')",[hash(token),account.id]);const session=client({mental_provider:token});await session.bootstrap();return {...account,token,client:session};}
  async function seedListing(account,{email=account.email,name='Teszt szakember',owner=true,status='pending'}={}){const listing=(await db.query('INSERT INTO directory_listings(slug,name,email,status) VALUES($1,$2,$3,$4) RETURNING *',['crm-'+crypto.randomBytes(8).toString('hex'),name,email,status])).rows[0];if(owner)await db.query('INSERT INTO provider_listing_owners(account_id,listing_id) VALUES($1,$2)',[account.id,listing.id]);return listing;}
  async function seedInquiry(listing,{name='Új Érdeklődő',email='lead@example.test',phone='+36 30 555 0101',expires=null,status='accepted'}={}){const id=crypto.randomUUID(),payload={name,email,phone,preference:'email',listing_name:listing.name,listing_slug:listing.slug,recipient:listing.email};await db.query(`INSERT INTO directory_contact_inquiries(id,request_key,listing_id,payload_ciphertext,delivery_status,consent_version,expires_at)
   VALUES($1,$2,$3,$4,$5,'isolated-crm-test',COALESCE($6::timestamptz,now()+interval '90 days'))`,[id,crypto.randomUUID(),listing.id,contact.seal(payload),status,expires]);return {...payload,id};}
  return {db,base,root,accounts,service,seal:contact.seal,unseal:contact.unseal,client,seedAccount,seedListing,seedInquiry,close,get mailAttempts(){return mailAttempts;}};
 }catch(error){await close();throw error;}
}
module.exports={createFixture};
