'use strict';
const crypto = require('node:crypto');
const rateLimit = require('express-rate-limit');

const TIMEZONE='Europe/Budapest';
const TOKEN_SECONDS=6*60*60;
const VISITOR_RETENTION_DAYS=15;
const BOT=/bot\b|crawler|spider|slurp|preview|facebookexternalhit|whatsapp|telegram|headlesschrome|lighthouse|pagespeed|pingdom|uptimerobot|curl\/|wget\/|python|node-fetch|undici/i;
const formatter=new Intl.DateTimeFormat('en-CA',{timeZone:TIMEZONE,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'});
function parts(date){return Object.fromEntries(formatter.formatToParts(date).filter(p=>p.type!=='literal').map(p=>[p.type,p.value]));}
function dayOf(date){const p=parts(date);return `${p.year}-${p.month}-${p.day}`;}
function addDays(day,amount){const d=new Date(day+'T00:00:00Z');d.setUTCDate(d.getUTCDate()+amount);return d.toISOString().slice(0,10);}
function weekOf(day){const dayNumber=new Date(day+'T00:00:00Z').getUTCDay();return addDays(day,-((dayNumber+6)%7));}
function midnight(day){
 const base=Date.parse(day+'T00:00:00Z');let utc=base;
 for(let i=0;i<3;i++){const p=parts(new Date(utc));const zoned=Date.UTC(+p.year,+p.month-1,+p.day,+p.hour,+p.minute,+p.second);utc=base-(zoned-utc);}
 return new Date(utc).toISOString();
}
function calendar(now=new Date()){
 const day=dayOf(now),week=weekOf(day);
 return {day,week,today:{start:midnight(day),end:midnight(addDays(day,1))},thisWeek:{start:midnight(week),end:midnight(addDays(week,7))}};
}
function periodOf(range,now,earliest){
 const c=calendar(now);const key=['today','week','30days','all'].includes(range)?range:'week';
 const startDay=key==='today'?c.day:key==='week'?c.week:key==='30days'?addDays(c.day,-29):dayOf(new Date(earliest));
 return {key,label:{today:'Ma',week:'Ezen a héten','30days':'Az elmúlt 30 nap',all:'Összes adat'}[key],start:midnight(startDay),end:midnight(addDays(c.day,1)),startDay,endDay:addDays(c.day,1)};
}
function pageFor(path){
 path=path.length>1?path.replace(/\/+$/,''):path;
 if(['/','/index.html','/cikkek','/szolgaltatok','/kereses','/impresszum','/kapcsolatfelvetel-adatkezeles'].includes(path))return {kind:'site',slug:''};
 const match=/^\/(cikk|szolgaltato|kategoria)\/([^/]{1,240})\/?$/.exec(path);
 if(!match)return null;
 try{const slug=decodeURIComponent(match[2]);if(slug.length>160||/[\x00-\x20\/\\]/.test(slug))return null;return {kind:match[1]==='cikk'?'article':match[1]==='szolgaltato'?'listing':'site',slug:match[1]==='kategoria'?'':slug};}catch(_){return null;}
}
function ignored(req,isAdmin=()=>false){
 const ua=String(req.get('user-agent')||'');
 return !ua||BOT.test(ua)||req.get('dnt')==='1'||req.get('sec-gpc')==='1'||/prefetch|prerender/i.test([req.get('purpose'),req.get('sec-purpose'),req.get('x-purpose')].join(' '))||Boolean(isAdmin(req));
}
function mac(secret,text){return crypto.createHmac('sha256',secret).update(text).digest('base64url');}
function signToken(secret,page,now=new Date()){
 const value=Buffer.from(JSON.stringify({v:1,k:page.kind,s:page.slug,n:crypto.randomBytes(16).toString('hex'),t:Math.floor(now.getTime()/1000)})).toString('base64url');
 return value+'.'+mac(secret,'view:'+value);
}
function verifyToken(secret,token,now=new Date()){
 if(typeof token!=='string'||token.length>1200)return null;
 const [value,sig,...rest]=token.split('.');if(rest.length||!value||!sig||!/^[A-Za-z0-9_-]{43}$/.test(sig)||!/^[A-Za-z0-9_-]+$/.test(value))return null;
 const expected=mac(secret,'view:'+value);if(sig.length!==expected.length||!crypto.timingSafeEqual(Buffer.from(sig),Buffer.from(expected)))return null;
 try{
  const data=JSON.parse(Buffer.from(value,'base64url').toString());const age=Math.floor(now.getTime()/1000)-data.t;
  if(data.v!==1||!['site','article','listing'].includes(data.k)||typeof data.s!=='string'||data.s.length>160||!/^([a-f0-9]{32})$/.test(data.n)||!Number.isSafeInteger(data.t)||age< -30||age>TOKEN_SECONDS)return null;
  if(data.k!=='site'&&(!data.s||/[\x00-\x20\/\\]/.test(data.s)))return null;
  return {kind:data.k,slug:data.s,nonce:data.n,expires:new Date((data.t+TOKEN_SECONDS+60)*1000)};
 }catch(_){return null;}
}
function visitorKey(secret,req,week){
 // A week-specific key prevents cross-week linkage. No original IP/browser string is stored.
 const key=crypto.createHmac('sha256',secret).update('site-visitors:'+week).digest();
 return crypto.createHmac('sha256',key).update(String(req.ip||req.socket?.remoteAddress||'unknown')+'\n'+String(req.get('user-agent')||'').trim().replace(/\s+/g,' ').slice(0,512)).digest('hex');
}
function sameOrigin(req){
 try{const origin=new URL(req.get('origin'));return ['http:','https:'].includes(origin.protocol)&&origin.host===req.get('host')&&origin.protocol===req.protocol+':';}catch(_){return false;}
}
function counts(row={}){return Object.fromEntries(['visitors','views','article_views','listing_views','contacts'].map(key=>[key,Number(row[key]||0)]));}
const totalColumns='COALESCE(sum(views),0) AS views,COALESCE(sum(article_views),0) AS article_views,COALESCE(sum(listing_views),0) AS listing_views,COALESCE(sum(contacts),0) AS contacts';

async function saveView(pool,{page,nonce,expires,visitor,now}){
 const c=calendar(now);const client=await pool.connect();
 try{
  await client.query('BEGIN');
  await client.query("SET LOCAL statement_timeout='2000ms'");
  await client.query("SET LOCAL lock_timeout='500ms'");
  const receipt=await client.query('INSERT INTO site_statistics_receipts(nonce,expires_at) VALUES($1,$2) ON CONFLICT DO NOTHING RETURNING nonce',[nonce,expires]);
  if(!receipt.rowCount){await client.query('ROLLBACK');return false;}
  let entity=null;
  if(page.kind==='article')entity=(await client.query("SELECT id FROM articles WHERE slug=$1 AND status='published' AND (published_at IS NULL OR published_at<=now())",[page.slug])).rows[0];
  else if(page.kind==='listing')entity=(await client.query("SELECT id FROM directory_listings WHERE slug=$1 AND status='published'",[page.slug])).rows[0];
  if(page.kind!=='site'&&!entity){await client.query('ROLLBACK');return false;}
  const daily=await client.query("INSERT INTO site_statistics_visitors(scope,bucket,visitor_key) VALUES('day',$1,$2) ON CONFLICT DO NOTHING RETURNING bucket",[c.day,visitor]);
  const weekly=await client.query("INSERT INTO site_statistics_visitors(scope,bucket,visitor_key) VALUES('week',$1,$2) ON CONFLICT DO NOTHING RETURNING bucket",[c.week,visitor]);
  await client.query(`INSERT INTO site_statistics_days(day,visitors,views,article_views,listing_views) VALUES($1,$2,1,$3,$4)
   ON CONFLICT(day) DO UPDATE SET visitors=site_statistics_days.visitors+EXCLUDED.visitors,views=site_statistics_days.views+1,article_views=site_statistics_days.article_views+EXCLUDED.article_views,listing_views=site_statistics_days.listing_views+EXCLUDED.listing_views`,[c.day,daily.rowCount?1:0,page.kind==='article'?1:0,page.kind==='listing'?1:0]);
  if(weekly.rowCount)await client.query('INSERT INTO site_statistics_weeks(week_start,visitors) VALUES($1,1) ON CONFLICT(week_start) DO UPDATE SET visitors=site_statistics_weeks.visitors+1',[c.week]);
  if(entity)await client.query('INSERT INTO site_statistics_pages(day,kind,entity_id,views) VALUES($1,$2,$3,1) ON CONFLICT(day,kind,entity_id) DO UPDATE SET views=site_statistics_pages.views+1',[c.day,page.kind,entity.id]);
  await client.query('COMMIT');return true;
 }catch(error){await client.query('ROLLBACK').catch(()=>{});throw error;}finally{client.release();}
}

function createStatisticsService({pool,auth,dbState,secret,isAdmin=()=>false,now=()=>new Date()}){
 if(typeof secret!=='string'||secret.length<16)throw new Error('A stable statistics signing secret is required.');
 let cleanupAfter=0,cleanupTimer=null;
 async function cleanup(){
  const current=now();if(!dbState.ready||current.getTime()<cleanupAfter)return;cleanupAfter=current.getTime()+60*60*1000;
  try{
   await pool.query('DELETE FROM site_statistics_visitors WHERE bucket<$1::date',[addDays(dayOf(current),1-VISITOR_RETENTION_DAYS)]);
   await pool.query('DELETE FROM site_statistics_receipts WHERE expires_at<$1',[current]);
  }catch(_){/* Cleanup retries after the next interval, without affecting page delivery. */}
 }
 function publicMiddleware(req,res,next){
  const page=pageFor(req.path);
  if(req.method!=='GET'||!page||ignored(req,isAdmin))return next();
  const send=res.send;
  res.send=function(body){
   if(res.statusCode===200&&typeof body==='string'&&/text\/html/i.test(String(res.get('Content-Type')))&&/<\/body>/i.test(body)){
    try{
     const token=signToken(secret,page,now());
     body=body.replace(/<\/body>/i,`<script src="/statistics.js?v=20261126" defer data-token="${token}"></script></body>`);
     // Instrumented HTML can also contain a reader's city-specific provider
     // selection. Never remove its private response directive here.
     res.set('Cache-Control','private, no-store');
     // Keep same-origin POST origins usable without sending referrers to external sites.
     res.set('Referrer-Policy','same-origin');
    }catch(_){/* Counting must never break HTML responses. */}
   }
   return send.call(this,body);
  };
  next();
 }
 async function metadata(){
  const row=(await pool.query('SELECT measurement_started_at,contacts_started_at FROM site_statistics_settings WHERE id=1')).rows[0];
  if(!row)throw new Error('Statistics metadata is unavailable.');
  return {...row,earliest:row.contacts_started_at&&new Date(row.contacts_started_at)<new Date(row.measurement_started_at)?row.contacts_started_at:row.measurement_started_at};
 }
 const privateHeaders=(req,res,next)=>{res.set('Cache-Control','private, no-store');res.set('X-Robots-Tag','noindex, nofollow');next();};
 const wrap=handler=>async(req,res)=>{
  if(!dbState.ready)return res.status(503).json({error:'A statisztikák átmenetileg nem elérhetők.'});
  try{await handler(req,res);}catch(_){res.status(503).json({error:'A statisztikák most nem tölthetők be. Próbáld újra később.'});}
 };
 async function overview(req,res){
  const current=now(),meta=await metadata(),c=calendar(current),period=periodOf(req.query.range,current,meta.earliest);
  const [todayRows,weekRows,weekVisitors,periodRows,trendRows]=await Promise.all([
   pool.query('SELECT visitors,views,article_views,listing_views,contacts FROM site_statistics_days WHERE day=$1',[c.day]),
   pool.query(`SELECT ${totalColumns} FROM site_statistics_days WHERE day>=$1::date AND day<$2::date`,[c.week,addDays(c.day,1)]),
   pool.query('SELECT visitors FROM site_statistics_weeks WHERE week_start=$1',[c.week]),
   pool.query(`SELECT ${totalColumns} FROM site_statistics_days WHERE day>=$1::date AND day<$2::date`,[period.startDay,period.endDay]),
   pool.query(`SELECT d.day::date::text AS date,COALESCE(s.visitors,0) AS visitors,COALESCE(s.views,0) AS views,COALESCE(s.contacts,0) AS contacts
    FROM generate_series($1::date,$2::date,'1 day'::interval) AS d(day) LEFT JOIN site_statistics_days s ON s.day=d.day::date ORDER BY d.day`,[addDays(c.day,-13),c.day])
  ]);
  const today={...c.today,...counts(todayRows.rows[0])};
  const week={...c.thisWeek,...counts({...weekRows.rows[0],visitors:weekVisitors.rows[0]?.visitors})};
  const totals=counts(periodRows.rows[0]);delete totals.visitors;
  const {startDay,endDay,...publicPeriod}=period;
  res.json({measurement_started_at:meta.measurement_started_at,contacts_started_at:meta.contacts_started_at,timezone:TIMEZONE,generated_at:current.toISOString(),period:publicPeriod,today,week,totals,
   visitor_method:'Becsült egyedi látogatók, sütik nélkül; hetente változó, hálózati és böngészőadatokból képzett azonosítóval. Nyers IP-címet, böngészőadatot és személyhez kötött oldalelőzményt nem tárolunk.',
   trend:trendRows.rows.map(row=>({date:row.date,visitors:Number(row.visitors),views:Number(row.views),contacts:Number(row.contacts)}))});
  void cleanup();
 }
 async function table(req,res,kind){
  const current=now(),meta=await metadata(),period=periodOf(req.query.range,current,meta.earliest);
  const article=kind==='article',source=article?'articles':'directory_listings',name=article?'title':'name';
  const query=typeof req.query.q==='string'?req.query.q.trim().slice(0,160):'';
  const params=[period.startDay,period.endDay,kind];
  let search='';
  if(query){params.push('%'+query.replace(/[\\%_]/g,'\\$&')+'%');search=`WHERE (label ILIKE $4 OR COALESCE(slug,'') ILIKE $4${article?'':" OR COALESCE(city,'') ILIKE $4"})`;}
  const cte=`WITH page_counts AS (SELECT entity_id,sum(views)::bigint AS views,sum(contacts)::bigint AS contacts FROM site_statistics_pages WHERE day>=$1::date AND day<$2::date AND kind=$3 GROUP BY entity_id),
   entries AS (SELECT COALESCE(e.id,p.entity_id) AS id,e.slug,COALESCE(e.${name},'${article?'Törölt cikk':'Törölt adatlap'} #'||p.entity_id::text) AS label,COALESCE(e.status,'deleted') AS status,(e.status='published'${article?' AND (e.published_at IS NULL OR e.published_at<=now())':''}) AS is_public,${article?"''::text":'e.city'} AS city,COALESCE(p.views,0) AS views,COALESCE(p.contacts,0) AS contacts
    FROM ${source} e FULL OUTER JOIN page_counts p ON p.entity_id=e.id WHERE (e.status='published'${article?' AND (e.published_at IS NULL OR e.published_at<=now())':''}) OR COALESCE(p.views,0)>0 OR COALESCE(p.contacts,0)>0)
   `;
  const total=Number((await pool.query(cte+'SELECT count(*) AS total FROM entries '+search,params)).rows[0].total);
  const integer=(value,fallback,max)=>/^\d+$/.test(String(value??''))&&Number(value)>0&&Number.isSafeInteger(Number(value))?Math.min(Number(value),max):fallback;
  const pageSize=integer(req.query.page_size,25,100),pages=Math.max(1,Math.ceil(total/pageSize)),page=Math.min(integer(req.query.page,1,1000000),pages);
  const result=await pool.query(cte+`SELECT * FROM entries ${search} ORDER BY views DESC,contacts DESC,lower(label),id LIMIT $${params.length+1} OFFSET $${params.length+2}`,[...params,pageSize,(page-1)*pageSize]);
  res.json({items:result.rows.map(row=>({id:row.id,[name]:row.label,slug:row.slug,url:row.slug&&row.is_public?(article?'/cikk/':'/szolgaltato/')+encodeURIComponent(row.slug):null,status:row.status,views:Number(row.views),...(article?{}:{city:row.city||'',contacts:Number(row.contacts)})})),total,page,page_size:pageSize,pages});
 }
 function register(app){
  const limiter=rateLimit({windowMs:60*1000,limit:120,standardHeaders:false,legacyHeaders:false,handler:(_req,res)=>res.status(204).end()});
  app.post('/api/public/statistics/view',limiter,async(req,res)=>{
   res.set('Cache-Control','no-store');
   if(!dbState.ready||ignored(req,isAdmin)||!sameOrigin(req))return res.status(204).end();
   const current=now(),token=verifyToken(secret,req.body?.token,current);
   if(!token)return res.status(204).end();
   try{await saveView(pool,{page:token,nonce:token.nonce,expires:token.expires,visitor:visitorKey(secret,req,calendar(current).week),now:current});void cleanup();}catch(_){/* A failed optional beacon does not leak database details. */}
   res.status(204).end();
  });
  app.get('/api/admin/statistics',privateHeaders,auth,wrap(overview));
  app.get('/api/admin/statistics/articles',privateHeaders,auth,wrap((req,res)=>table(req,res,'article')));
  app.get('/api/admin/statistics/listings',privateHeaders,auth,wrap((req,res)=>table(req,res,'listing')));
 }
 function start(){if(!cleanupTimer){cleanupTimer=setInterval(()=>{void cleanup();},60*60*1000);cleanupTimer.unref();void cleanup();}}
 function stop(){if(cleanupTimer)clearInterval(cleanupTimer);cleanupTimer=null;}
 return {register,publicMiddleware,start,stop};
}
module.exports={createStatisticsService,calendar,dayOf,weekOf,midnight,addDays,periodOf,pageFor,signToken,verifyToken,visitorKey,ignored,sameOrigin,saveView,TIMEZONE,TOKEN_SECONDS};
