'use strict';
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const fs=require('node:fs');
const path=require('node:path');
const express=require('express');
const {Pool}=require('pg');
const {saveView,visitorKey,weekOf,dayOf,signToken,createStatisticsService}=require('../lib/site-statistics.cjs');
const connectionString=process.env.TEST_DATABASE_URL;
assert(connectionString,'TEST_DATABASE_URL must point to disposable local PostgreSQL');
assert(['localhost','127.0.0.1','[::1]'].includes(new URL(connectionString).hostname),'This test only accepts loopback PostgreSQL');
const schema='statistics_test_'+crypto.randomBytes(8).toString('hex');
const admin=new Pool({connectionString,ssl:false});
const db=new Pool({connectionString,ssl:false,options:'-c search_path='+schema});
const migration=fs.readFileSync(path.join(__dirname,'../migrations/015_site_statistics.sql'),'utf8');
const secret='isolated-statistics-test-secret';
const ua='Mozilla/5.0 Chrome/130.0.0.0 Safari/537.36';
const browser={ip:'192.0.2.10',get:()=>ua};let server,service;
async function migrate(){const client=await db.connect();try{await client.query('BEGIN');await client.query(migration);await client.query('COMMIT');}catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}}
async function view(date,kind='article',slug='published-article',visitor=browser,nonce=crypto.randomBytes(16).toString('hex')){
 const now=new Date(date);return {saved:await saveView(db,{page:{kind,slug},nonce,expires:new Date(now.getTime()+21600000),visitor:visitorKey(secret,visitor,weekOf(dayOf(now))),now}),nonce};
}
async function main(){
 await admin.query('CREATE SCHEMA '+schema);
 await db.query(`CREATE TABLE articles(id BIGINT PRIMARY KEY,slug TEXT UNIQUE,title TEXT,status TEXT,published_at TIMESTAMPTZ);
 CREATE TABLE directory_listings(id BIGINT PRIMARY KEY,slug TEXT UNIQUE,name TEXT,status TEXT,city TEXT);
 CREATE TABLE directory_contact_inquiries(id UUID PRIMARY KEY,request_key UUID UNIQUE,listing_id BIGINT,created_at TIMESTAMPTZ NOT NULL DEFAULT now(),delivery_status TEXT);
 INSERT INTO articles VALUES(1,'published-article','Publikált cikk','published',NULL),(2,'draft-article','Titkos piszkozat','draft',NULL),(3,'zero-article','Nulla megtekintés','published',NULL);
 INSERT INTO directory_listings VALUES(1,'test-provider','Teszt szolgáltató','published','Budapest'),(2,'zero-provider','Még nem látogatott szolgáltató','published','Szeged');`);
 await db.query("INSERT INTO directory_contact_inquiries(id,request_key,listing_id,created_at,delivery_status) VALUES($1,$2,1,'2026-11-22T10:00:00Z','failed')",[crypto.randomUUID(),crypto.randomUUID()]);
 await migrate();const started=(await db.query('SELECT measurement_started_at FROM site_statistics_settings')).rows[0].measurement_started_at.toISOString();
 await migrate();assert.equal((await db.query('SELECT sum(contacts)::int AS total FROM site_statistics_days')).rows[0].total,1,'Backfill must run exactly once');
 assert.equal((await db.query('SELECT measurement_started_at FROM site_statistics_settings')).rows[0].measurement_started_at.toISOString(),started);
 const first=await view('2026-11-23T10:00:00Z');assert.equal(first.saved,true);
 assert.equal((await view('2026-11-23T10:00:01Z','article','published-article',browser,first.nonce)).saved,false,'A replay must not count again');
 await view('2026-11-23T11:00:00Z');
 await view('2026-11-24T10:00:00Z','listing','test-provider');
 await view('2026-11-24T11:00:00Z','site','',{...browser,ip:'192.0.2.11'});
 await view('2026-11-30T10:00:00Z');
 assert.equal((await view('2026-11-24T11:00:00Z','article','draft-article')).saved,false,'Unpublished pages must not count');
 assert.equal((await db.query("SELECT visitors::int AS visitors FROM site_statistics_weeks WHERE week_start='2026-11-23'")).rows[0].visitors,2,'Weekly visitors are distinct across days');
 assert.equal((await db.query("SELECT sum(visitors)::int AS visitors FROM site_statistics_days WHERE day IN ('2026-11-23','2026-11-24')")).rows[0].visitors,3,'Daily visitors separately count a returning visitor');
 assert.equal((await db.query("SELECT visitors::int AS visitors FROM site_statistics_weeks WHERE week_start='2026-11-30'")).rows[0].visitors,1,'Next week is separate');
 const concurrent=await Promise.all(Array.from({length:8},()=>view('2026-11-25T12:00:00Z')));assert(concurrent.every(x=>x.saved));
 const day=(await db.query("SELECT views::int,visitors::int FROM site_statistics_days WHERE day='2026-11-25'")).rows[0];assert.deepEqual(day,{views:8,visitors:1});
 const inquiryId=crypto.randomUUID(),requestKey=crypto.randomUUID();
 await db.query("INSERT INTO directory_contact_inquiries(id,request_key,listing_id,created_at,delivery_status) VALUES($1,$2,1,'2026-11-24T12:00:00Z','needs_mail')",[inquiryId,requestKey]);
 await db.query("INSERT INTO directory_contact_inquiries(id,request_key,listing_id,created_at,delivery_status) VALUES($1,$2,1,'2026-11-24T12:00:00Z','needs_mail') ON CONFLICT(request_key) DO NOTHING",[crypto.randomUUID(),requestKey]);
 await db.query("UPDATE directory_contact_inquiries SET listing_id=NULL,delivery_status='expired' WHERE id=$1",[inquiryId]);
 assert.equal((await db.query("SELECT contacts::int FROM site_statistics_pages WHERE kind='listing' AND entity_id=1 AND day='2026-11-24'")).rows[0].contacts,1,'Contact counts survive expiry and duplicate requests');
 const rollback=await db.connect();try{await rollback.query('BEGIN');await rollback.query("INSERT INTO directory_contact_inquiries(id,request_key,listing_id,created_at) VALUES($1,$2,1,'2026-11-24T12:00:00Z')",[crypto.randomUUID(),crypto.randomUUID()]);await rollback.query('ROLLBACK');}finally{rollback.release();}
 assert.equal((await db.query("SELECT contacts::int FROM site_statistics_days WHERE day='2026-11-24'")).rows[0].contacts,1,'Rolled back inquiries must not count');
 let current=new Date('2026-11-24T16:00:00Z');const state={ready:true};
 const app=express();app.use(express.json());service=createStatisticsService({pool:db,secret,dbState:state,now:()=>current,auth:(req,res,next)=>req.get('authorization')==='test-admin'?next():res.status(401).json({error:'auth'}),isAdmin:req=>req.get('authorization')==='test-admin'});service.register(app);app.use(service.publicMiddleware);app.get('/',(_req,res)=>res.type('html').send('<html><body>home</body></html>'));
 server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});const origin='http://127.0.0.1:'+server.address().port;
 async function get(route,authenticated=true){return fetch(origin+route,{headers:{'User-Agent':ua,...(authenticated?{Authorization:'test-admin'}:{})}});}
 assert.equal((await get('/api/admin/statistics',false)).status,401);
 const summaryResponse=await get('/api/admin/statistics?range=week');assert.match(summaryResponse.headers.get('cache-control'),/no-store/);const summary=await summaryResponse.json();
 assert.equal(summary.today.visitors,2);assert.equal(summary.week.visitors,2);assert.equal(summary.week.views,4);assert.equal(summary.week.contacts,1);assert.equal(summary.trend.length,14);assert.equal(summary.trend.at(-1).date,'2026-11-24');
 const articles=await(await get('/api/admin/statistics/articles?range=week&page_size=1')).json();assert.equal(articles.total,2);assert.equal(articles.pages,2);assert.equal(articles.items[0].views,2);
 const listings=await(await get('/api/admin/statistics/listings?range=week&q='+encodeURIComponent('Teszt'))).json();assert.equal(listings.items[0].views,1);assert.equal(listings.items[0].contacts,1);
 const zero=await(await get('/api/admin/statistics/articles?range=today&q=Nulla')).json();assert.equal(zero.items[0].views,0);
 const badSearch=await(await get('/api/admin/statistics/articles?q='+encodeURIComponent("%' OR 1=1 --"))).json();assert.equal(badSearch.total,0);
 const token=signToken(secret,{kind:'site',slug:''},current);
 const post=(body,headers={})=>fetch(origin+'/api/public/statistics/view',{method:'POST',headers:{'User-Agent':ua,'Content-Type':'application/json',Origin:origin,...headers},body:JSON.stringify(body)});
 await post({token},{Origin:'https://hostile.example'});await post({token:'broken'});await post({token},{Authorization:'test-admin'});await post({token},{DNT:'1'});
 assert.equal((await(await get('/api/admin/statistics?range=today')).json()).today.views,2,'Invalid, cross-origin, opted-out and admin beacons must not count');
 await post({token});await post({token});assert.equal((await(await get('/api/admin/statistics?range=today')).json()).today.views,3,'Valid signed beacon counts once');
 await db.query('DELETE FROM directory_listings WHERE id=1');const deleted=await(await get('/api/admin/statistics/listings?range=week')).json();assert.equal(deleted.items[0].status,'deleted');assert.equal(deleted.items[0].contacts,1);assert.equal(deleted.items[0].url,null);
 state.ready=false;assert.equal((await get('/api/admin/statistics')).status,503);assert.equal((await post({token})).status,204);
 console.log('PASS transactional backfill, day/week dedup, replay protection, concurrent views, inquiry persistence, private summaries/search/pagination, and invalid beacon exclusion');
}
main().catch(error=>{console.error(error);process.exitCode=1;}).finally(async()=>{service?.stop();if(server)await new Promise(resolve=>server.close(resolve));await db.end();await admin.query('DROP SCHEMA IF EXISTS '+schema+' CASCADE').catch(()=>{});await admin.end();});
