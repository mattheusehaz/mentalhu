'use strict';
const crypto = require('node:crypto');
const EMAIL = /^[A-Za-z0-9.!#$%&'*+\/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?\.[A-Za-z]{2,63}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const CONSENT_VERSION = 'contact-2026-11-v1';
const esc = v => String(v ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const clean = (v,max=200) => typeof v === 'string' ? v.trim().slice(0,max) : '';
const isEmail = v => typeof v === 'string' && v.length<=254 && EMAIL.test(v) && !/[\r\n\0]/.test(v);
function failure(code,status=400) { return Object.assign(new Error(code),{code,httpStatus:status}); }
function createContactService({pool,auth,dbState,audit=()=>{},env=process.env,transport=null}) {
  const secret=env.CONTACT_DATA_KEY || env.CMS_JWT_SECRET;
  const key=secret && crypto.createHash('sha256').update('mental-contact-storage-v1\0'+secret).digest();
  let cache=null,cacheAt=0,busy=false,lastCleanup=0,timer;
  const hash = v => { if(!key)throw failure('CONTACT_KEY_MISSING',503); return crypto.createHmac('sha256',key).update(v).digest('hex'); };
  function seal(value) {
    if(!key)throw failure('CONTACT_KEY_MISSING',503);
    const iv=crypto.randomBytes(12),c=crypto.createCipheriv('aes-256-gcm',key,iv);
    const data=Buffer.concat([c.update(JSON.stringify(value),'utf8'),c.final()]);
    return ['v1',iv.toString('base64url'),c.getAuthTag().toString('base64url'),data.toString('base64url')].join('.');
  }
  function unseal(value) {
    if(!value)return null;
    if(!key)throw failure('CONTACT_KEY_MISSING',503);
    try {const [v,i,t,d]=value.split('.');if(v!=='v1')throw Error();const c=crypto.createDecipheriv('aes-256-gcm',key,Buffer.from(i,'base64url'));c.setAuthTag(Buffer.from(t,'base64url'));return JSON.parse(Buffer.concat([c.update(Buffer.from(d,'base64url')),c.final()]).toString('utf8'));}
    catch {throw failure('CONTACT_DATA_KEY_MISMATCH',503);}
  }
  async function settings(force=false) {
    if(!force&&cache&&Date.now()-cacheAt<5000)return cache;
    const defaults={enabled:false,controller_name:env.CONTACT_CONTROLLER_NAME||'',controller_address:env.CONTACT_CONTROLLER_ADDRESS||'',privacy_email:env.CONTACT_PRIVACY_EMAIL||'',retention_days:90,provider:env.RESEND_API_KEY?'resend':env.BREVO_API_KEY?'brevo':env.SMTP_HOST?'smtp':'',api_key:env.RESEND_API_KEY||env.BREVO_API_KEY||'',from_email:env.CONTACT_FROM_EMAIL||env.MAIL_FROM||env.SMTP_FROM||'',smtp_host:env.SMTP_HOST||'',smtp_port:Number(env.SMTP_PORT||587),smtp_user:env.SMTP_USER||'',smtp_password:env.SMTP_PASSWORD||'',consent_version:CONSENT_VERSION};
    const r=await pool.query('SELECT settings_ciphertext FROM directory_contact_settings WHERE id=1');
    cache={...defaults,...(r.rows[0]?unseal(r.rows[0].settings_ciphertext):{})};cacheAt=Date.now();return cache;
  }
  const privacyReady=s=>!!key&&!!s.enabled&&s.controller_name.length>=3&&s.controller_address.length>=5&&isEmail(s.privacy_email);
  const mailReady=s=>isEmail(s.from_email)&&((['resend','brevo'].includes(s.provider)&&!!s.api_key)||(s.provider==='smtp'&&!!s.smtp_host&&!!s.smtp_user&&!!s.smtp_password));
  function consentText(s,name) {return 'Hozzájárulok, hogy '+s.controller_name+' a nevemet, e-mail-címemet, az általam megadott telefonszámot és a kiválasztott szolgáltató adatait a kapcsolatfelvételi kérésem rögzítéséhez és a következő címzettnek való továbbításához kezelje: '+name+'. A megőrzési idő legfeljebb '+s.retention_days+' nap. Tudomásul veszem, hogy az egészségügyi szolgáltató kiválasztásából az egészségi állapotomra következtetés lehet levonható; ehhez az adatkezeléshez is kifejezetten hozzájárulok. A hozzájárulás önkéntes, és a '+s.privacy_email+' címen visszavonható. Hírlevélre nem iratkozom fel.';}
  function getCookie(req,res) {
    let value=req.cookies?.mental_contact_session;
    if(!/^[a-f0-9]{48}$/.test(value||'')){value=crypto.randomBytes(24).toString('hex');res.cookie('mental_contact_session',value,{httpOnly:true,secure:env.NODE_ENV==='production',sameSite:'strict',maxAge:7200000,path:'/'});}
    return value;
  }
  function csrf(req,res,scope) {const c=getCookie(req,res),stamp=String(Date.now());return stamp+'.'+hash('csrf\0'+scope+'\0'+c+'\0'+stamp);}
  function protect(req,scope) {
    const token=req.get('X-Contact-CSRF')||req.body?.csrf_token||'';const [stamp,sig]=String(token).split('.');const c=req.cookies?.mental_contact_session;
    if(!/^\d{13}$/.test(stamp||'')||!/^[a-f0-9]{64}$/.test(sig||'')||!/^[a-f0-9]{48}$/.test(c||'')||Date.now()-Number(stamp)>7200000||Number(stamp)>Date.now()+10000)throw failure('FORM_EXPIRED',403);
    const expected=hash('csrf\0'+scope+'\0'+c+'\0'+stamp);
    if(!crypto.timingSafeEqual(Buffer.from(expected),Buffer.from(sig)))throw failure('FORM_EXPIRED',403);
    const origin=req.get('Origin');
    if(origin){let parsed;try{parsed=new URL(origin)}catch{throw failure('ORIGIN_REJECTED',403)}if(parsed.host!==req.get('host'))throw failure('ORIGIN_REJECTED',403);}
    if(req.get('Sec-Fetch-Site')==='cross-site')throw failure('ORIGIN_REJECTED',403);
  }
  const event = (client,id,type,actor='system',details={}) => client.query('INSERT INTO directory_contact_events(inquiry_id,event_type,actor,details) VALUES($1,$2,$3,$4)',[id,type,actor,details]);
  function validate(body) {
    const name=clean(body.name,121),email=clean(body.email,255).toLowerCase(),phone=clean(body.phone,31),preference=clean(body.preference,30)||'email';
    if(name.length<2||name.length>120||/[\r\n\0<>]/.test(name)||!isEmail(email)||phone.length>30||(phone&&!/^\+?[0-9 ()\-/.]{6,30}$/.test(phone))||!['email','phone','either'].includes(preference)||(preference==='phone'&&!phone))throw failure('INVALID_CONTACT_DATA');
    if(body.consent!==true||body.adult!==true)throw failure('CONSENT_REQUIRED');
    if(!UUID.test(body.request_key||''))throw failure('REQUEST_KEY_REQUIRED');
    return {name,email,phone,preference};
  }
  function safeSettings(s) {return {enabled:s.enabled,controller_name:s.controller_name,controller_address:s.controller_address,privacy_email:s.privacy_email,retention_days:s.retention_days,provider:s.provider,from_email:s.from_email,smtp_host:s.smtp_host,smtp_port:s.smtp_port,smtp_user:s.smtp_user,has_api_key:!!s.api_key,has_smtp_password:!!s.smtp_password,mail_ready:mailReady(s),privacy_ready:privacyReady(s),encryption_ready:!!key,consent_version:CONSENT_VERSION};}
  async function deliver(s,to,payload,id) {
    const subject='Új kapcsolatfelvételi kérés – MENTÁL.hu';
    const text='A MENTÁL.hu katalógusában kapcsolatfelvételi kérést küldtek az Ön adatlapjára.\n\nCímzett adatlap: '+payload.listing_name+'\nNév: '+payload.name+'\nE-mail: '+payload.email+'\nTelefon: '+(payload.phone||'nem adta meg')+'\nKért kapcsolat: '+({email:'e-mail',phone:'telefon',either:'e-mail vagy telefon'}[payload.preference]||'e-mail')+'\n\nA jelentkező kizárólag kapcsolatfelvételt kért; ez nem időpontfoglalás és nem diagnosztikai adatlap. Egészségügyi dokumentumot nem gyűjtöttünk. A levélre válaszolva közvetlenül a jelentkezővel veheti fel a kapcsolatot.\nÜgyazonosító: '+id+'\n\nAdatkezelési kérdés: '+s.privacy_email;
    if(transport)return transport({to,from:s.from_email,replyTo:payload.email,subject,text,id});
    if(s.provider==='smtp') {
      const nodemailer=require('nodemailer');
      const tr=nodemailer.createTransport({host:s.smtp_host,port:s.smtp_port,secure:s.smtp_port===465,requireTLS:true,auth:{user:s.smtp_user,pass:s.smtp_password},tls:{rejectUnauthorized:true,minVersion:'TLSv1.2'},connectionTimeout:15000,greetingTimeout:15000,socketTimeout:20000,disableFileAccess:true,disableUrlAccess:true});
      try{const r=await tr.sendMail({from:{name:'MENTÁL.hu',address:s.from_email},to:{address:to},replyTo:{name:payload.name,address:payload.email},subject,text,messageId:'<'+id+'@mental.hu>',disableFileAccess:true,disableUrlAccess:true});if(!r.accepted?.length)throw failure('MAIL_REJECTED',502);return {id:r.messageId};}finally{tr.close();}
    }
    const isResend=s.provider==='resend';
    const url=isResend?'https://api.resend.com/emails':'https://api.brevo.com/v3/smtp/email';
    const headers=isResend?{'Authorization':'Bearer '+s.api_key,'Idempotency-Key':'mental-contact/'+id}:{'api-key':s.api_key};
    const body=isResend?{from:'MENTÁL.hu <'+s.from_email+'>',to:[to],reply_to:payload.email,subject,text}:{sender:{name:'MENTÁL.hu',email:s.from_email},to:[{email:to}],replyTo:{name:payload.name,email:payload.email},subject,textContent:text};
    let r;try{r=await fetch(url,{method:'POST',headers:{...headers,'Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(20000)});}catch{throw failure('MAIL_RESULT_UNCERTAIN',502);}
    if(!r.ok)throw failure('MAIL_HTTP_'+r.status,502);
    const result=await r.json();return {id:String(result.id||result.messageId||'accepted').slice(0,250)};
  }
  async function runWorker() {
    if(busy||!dbState.ready||!key)return;busy=true;
    try {
      if(Date.now()-lastCleanup>3600000) {
        await pool.query("UPDATE directory_contact_inquiries SET payload_ciphertext=NULL,requester_hash=NULL,ip_hash=NULL,listing_id=NULL,provider_message_id=NULL,error_code=NULL,delivery_status='expired',updated_at=now() WHERE expires_at<=now() AND delivery_status<>'expired'");
        await pool.query("UPDATE directory_contact_inquiries SET delivery_status='uncertain',error_code='WORKER_INTERRUPTED',updated_at=now() WHERE delivery_status='sending' AND sending_since<now()-interval '5 minutes'");lastCleanup=Date.now();
      }
      const s=await settings();if(!privacyReady(s)||!mailReady(s))return;
      const client=await pool.connect();let row;
      try {await client.query('BEGIN');const q=await client.query("SELECT * FROM directory_contact_inquiries WHERE delivery_status='queued' AND next_attempt_at<=now() AND expires_at>now() ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1");row=q.rows[0];if(row){await client.query("UPDATE directory_contact_inquiries SET delivery_status='sending',sending_since=now(),attempts=attempts+1,updated_at=now() WHERE id=$1",[row.id]);await event(client,row.id,'sending');}await client.query('COMMIT');}catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}
      if(!row)return;
      let state='accepted',code=null,messageId=null;
      try {
        const payload=unseal(row.payload_ciphertext);const r=await pool.query("SELECT email,contact_disabled FROM directory_listings WHERE id=$1 AND status='published'",[row.listing_id]);const listing=r.rows[0];
        if(!listing||listing.contact_disabled)throw failure('LISTING_DISABLED');
        if(!isEmail(listing.email))throw failure('RECIPIENT_MISSING');
        if(payload.recipient!==listing.email.toLowerCase())throw failure('RECIPIENT_CHANGED');
        const result=await deliver(s,payload.recipient,payload,row.id);messageId=result.id;
      }catch(e){code=['ETIMEDOUT','ESOCKET','ECONNRESET','ECONNECTION','EPIPE'].includes(e.code)?'MAIL_RESULT_UNCERTAIN':/^[A-Z0-9_]{2,60}$/.test(e.code||'')?e.code:'MAIL_RESULT_UNCERTAIN';state=code==='RECIPIENT_MISSING'||code==='RECIPIENT_CHANGED'?'needs_recipient':code==='MAIL_RESULT_UNCERTAIN'?'uncertain':'failed';}
      await pool.query('UPDATE directory_contact_inquiries SET delivery_status=$2,provider_message_id=$3,error_code=$4,accepted_at=CASE WHEN $2=\'accepted\' THEN now() ELSE accepted_at END,updated_at=now() WHERE id=$1',[row.id,state,messageId,code]);
      await event(pool,row.id,state,'system',code?{code}:{});
    }catch(e){console.error('[contact-worker]',/^[A-Z0-9_]{2,60}$/.test(e.code||'')?e.code:'CONTACT_WORKER_ERROR');}finally{busy=false;}
  }
  const wrap=fn=>async(req,res,next)=>{res.set('Cache-Control','no-store');try{await fn(req,res,next)}catch(e){if(e.httpStatus)return res.status(e.httpStatus).json({ok:false,code:e.code,error:({INVALID_CONTACT_DATA:'Ellenőrizd a nevet, e-mail-címet és telefonszámot.',CONSENT_REQUIRED:'A saját elérhetőségek megadása és a hozzájárulás szükséges.',FORM_EXPIRED:'Az űrlap lejárt. Töltsd újra az oldalt.',CONTACT_NOT_CONFIGURED:'Az online kapcsolatfelvétel még nincs engedélyezve. Használd a szolgáltató saját elérhetőségét.',RATE_LIMITED:'Túl sok megkeresés. Próbáld később.',RECIPIENT_MISSING:'A címzett e-mail-címét előbb a szolgáltatói adatlapon kell beállítani.',MAIL_NOT_CONFIGURED:'A levélküldés még nincs beállítva.'}[e.code]||'A művelet nem hajtható végre. Ellenőrizd a beállításokat.')});next(e);}};
  function register(app) {
    app.get('/api/contact/form/:slug',wrap(async(req,res)=>{
      const q=await pool.query("SELECT id,name,slug,email,contact_disabled,website_url,source_url FROM directory_listings WHERE slug=$1 AND status='published'",[req.params.slug]);const x=q.rows[0];if(!x)return res.status(404).json({ok:false});
      const s=await settings(),enabled=privacyReady(s)&&!x.contact_disabled;
      res.json({enabled,listing_name:x.name,recipient_ready:isEmail(x.email),mail_ready:mailReady(s),csrf_token:key?csrf(req,res,'listing:'+x.id):null,request_key:crypto.randomUUID(),consent_text:enabled?consentText(s,x.name):'',privacy_url:'/kapcsolatfelvetel-adatkezeles',retention_days:s.retention_days,controller_name:s.controller_name,privacy_email:s.privacy_email});
    }));
    app.post('/api/contact/inquiries/:slug',wrap(async(req,res)=>{
      const q=await pool.query("SELECT id,name,slug,email,contact_disabled FROM directory_listings WHERE slug=$1 AND status='published'",[req.params.slug]);const x=q.rows[0];if(!x)return res.status(404).json({ok:false});
      const s=await settings();if(!privacyReady(s)||x.contact_disabled)throw failure('CONTACT_NOT_CONFIGURED',503);
      protect(req,'listing:'+x.id);if(req.body.website)return res.status(400).json({ok:false,error:'A kérés nem fogadható.'});const p=validate(req.body);
      const ip=hash('ip\0'+new Date().toISOString().slice(0,10)+'\0'+req.ip),eh=hash('email\0'+p.email),client=await pool.connect();let id,state;
      try {
        await client.query('BEGIN');await client.query('SELECT pg_advisory_xact_lock(hashtext($1))',['contact:'+eh]);await client.query('SELECT pg_advisory_xact_lock(hashtext($1))',['contact-ip:'+ip]);
        const exists=(await client.query('SELECT id,listing_id,requester_hash,delivery_status FROM directory_contact_inquiries WHERE request_key=$1',[req.body.request_key])).rows[0];
        if(exists){if(exists.requester_hash!==eh||String(exists.listing_id)!==String(x.id))throw failure('REQUEST_KEY_CONFLICT',409);await client.query('COMMIT');return res.status(200).json({ok:true,id:exists.id,status:exists.delivery_status,message:'Ezt a megkeresést már rögzítettük; nem hoztunk létre újabb példányt.'});}
        const rates=(await client.query("SELECT count(*) FILTER(WHERE ip_hash=$1 AND created_at>now()-interval '15 minutes')::int AS ip_count,count(*) FILTER(WHERE requester_hash=$2 AND created_at>now()-interval '1 hour')::int AS email_count FROM directory_contact_inquiries WHERE created_at>now()-interval '1 hour'",[ip,eh])).rows[0];
        if(rates.ip_count>=5||rates.email_count>=5)throw failure('RATE_LIMITED',429);
        id=crypto.randomUUID();state=!isEmail(x.email)?'needs_recipient':!mailReady(s)?'needs_mail':'queued';
        const payload={...p,listing_name:x.name,listing_slug:x.slug,recipient:isEmail(x.email)?x.email.toLowerCase():'',consent_text:consentText(s,x.name)};
        await client.query('INSERT INTO directory_contact_inquiries(id,request_key,listing_id,payload_ciphertext,requester_hash,ip_hash,delivery_status,consent_version,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,now()+($9::int*interval \'1 day\'))',[id,req.body.request_key,x.id,seal(payload),eh,ip,state,CONSENT_VERSION,s.retention_days]);
        await event(client,id,'created','visitor',{delivery_status:state,consent_version:CONSENT_VERSION});await client.query('COMMIT');
      }catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}
      const messages={queued:'A megkeresést rögzítettük, és e-mail-küldésre sorba állítottuk. Ez nem visszaigazolt időpontfoglalás.',needs_recipient:'A megkeresést rögzítettük, de a szolgáltatóhoz még nincs használható e-mail-cím, ezért nem továbbítottuk. Szerkesztőségi ellenőrzés szükséges.',needs_mail:'A megkeresést rögzítettük, de a levélküldés még nincs beállítva, ezért e-mailt nem küldtünk.'};
      res.status(201).json({ok:true,id,status:state,message:messages[state]});setImmediate(runWorker);
    }));
    app.get('/kapcsolatfelvetel-adatkezeles',wrap(async(req,res)=>{
      const s=await settings();res.type('html').send('<!doctype html><html lang="hu"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Kapcsolatfelvétel – adatkezelés</title><link rel="stylesheet" href="/contact.css"><main class="contact-privacy"><a href="/">MENTÁL.hu</a><h1>Kapcsolatfelvételi adatkezelési tájékoztató</h1>'+(!privacyReady(s)?'<p>Az online kapcsolatfelvételi adatkezelés nincs engedélyezve. Ezen a felületen megkeresést még nem fogadunk.</p>':'<p><strong>Adatkezelő:</strong> '+esc(s.controller_name)+'<br><strong>Cím:</strong> '+esc(s.controller_address)+'<br><strong>Adatvédelmi kapcsolat:</strong> '+esc(s.privacy_email)+'</p><h2>Cél és adatok</h2><p>A kiválasztott szolgáltatóval történő kapcsolatfelvétel közvetítése. Név, e-mail-cím, önként megadott telefonszám, kapcsolattartási mód, választott szolgáltató, hozzájárulás és technikai kézbesítési napló. Nem kérünk tünetleírást, leletet, gyermekadatot vagy teszteredményt. A kiválasztott szolgáltató egészségügyi érdeklődést is jelezhet.</p><h2>Hozzájárulás és címzettek</h2><p>Az adatkezelés önkéntes hozzájáruláson alapul: GDPR 6. cikk (1) a), az egészségügyi következtetés lehetősége miatt kifejezett hozzájárulás a 9. cikk (2) a) szerint is. Az adatokat kizárólag az űrlapon megnevezett szolgáltatónak továbbítjuk, illetve a portál arra jogosult adminisztrátorai férhetnek hozzá. Marketinglistára nem kerülnek.</p><h2>Tárolás és továbbítás</h2><p>A megkeresés adatait titkosítva tároljuk a portál adatbázisában. Az alkalmazás és adatbázis tárhelyszolgáltatója DigitalOcean; a levelezési továbbító: '+esc(s.provider==='brevo'?'Brevo':s.provider==='resend'?'Resend':s.provider==='smtp'?'az adatkezelő által megadott SMTP-szolgáltató':'még nincs beállítva')+'. A szolgáltatók adatfeldolgozási és esetleges nemzetközi adattovábbítási feltételeinek rendezése az adatkezelő feladata. A levél átadása nem garantálja, hogy a címzett elolvasta.</p><h2>Megőrzés és jogok</h2><p>A megkeresés személyes adatait legfeljebb '+s.retention_days+' napig őrizzük, majd töröljük vagy személyhez nem köthetővé tesszük. Hozzáférést, helyesbítést, törlést, korlátozást, hordozhatóságot és hozzájárulás-visszavonást a fenti adatvédelmi címen kérhetsz. A visszavonás nem érinti a korábbi adatkezelés jogszerűségét. Az önálló szolgáltatóhoz már eljutott adatok kezeléséről a szolgáltatónál is érdeklődj. Panasz a Nemzeti Adatvédelmi és Információszabadság Hatósághoz nyújtható be (naih.hu). Automatizált döntéshozatalt nem végzünk.</p>')+'<p>Tájékoztató-verzió: '+CONSENT_VERSION+'</p></main></html>');
    }));
    app.get('/api/admin/contact/settings',auth,wrap(async(req,res)=>{res.json({...safeSettings(await settings()),csrf_token:key?csrf(req,res,'admin:'+req.user.email):null});}));
    app.put('/api/admin/contact/settings',auth,wrap(async(req,res)=>{
      protect(req,'admin:'+req.user.email);const old=await settings(),b=req.body;
      const s={...old,enabled:b.enabled===true,controller_name:clean(b.controller_name,200),controller_address:clean(b.controller_address,400),privacy_email:clean(b.privacy_email,254).toLowerCase(),retention_days:Number(b.retention_days),provider:clean(b.provider,20),from_email:clean(b.from_email,254).toLowerCase(),smtp_host:clean(b.smtp_host,200),smtp_port:Number(b.smtp_port||587),smtp_user:clean(b.smtp_user,254),consent_version:CONSENT_VERSION};
      if(![30,60,90,180,365].includes(s.retention_days)||!['','resend','brevo','smtp'].includes(s.provider))throw failure('INVALID_SETTINGS');
      if(b.api_key)s.api_key=clean(b.api_key,1000);if(b.smtp_password)s.smtp_password=clean(b.smtp_password,1000);
      if(b.clear_credentials===true){s.api_key='';s.smtp_password='';}
      if(s.from_email&&!isEmail(s.from_email))throw failure('INVALID_SETTINGS');
      if(s.provider==='smtp'&&(!/^(?=.{4,200}$)[A-Za-z0-9.-]+\.[A-Za-z]{2,63}$/.test(s.smtp_host)||/^(localhost|127\.|10\.|192\.168\.)/i.test(s.smtp_host)||![465,587,2525].includes(s.smtp_port)))throw failure('INVALID_SMTP_SETTINGS');
      if(s.enabled&&!privacyReady(s))throw failure('PRIVACY_DETAILS_REQUIRED');
      await pool.query('INSERT INTO directory_contact_settings(id,settings_ciphertext) VALUES(1,$1) ON CONFLICT(id) DO UPDATE SET settings_ciphertext=EXCLUDED.settings_ciphertext,updated_at=now()',[seal(s)]);cache=null;audit('configure','contact',null,req.user.email,{enabled:s.enabled,provider:s.provider});res.json({ok:true,...safeSettings(s)});
    }));
    app.post('/api/admin/contact/test-email',auth,wrap(async(req,res)=>{
      protect(req,'admin:'+req.user.email);const s=await settings();if(!mailReady(s))throw failure('MAIL_NOT_CONFIGURED',409);
      const recipient=clean(req.user.email,254);if(!isEmail(recipient))throw failure('ADMIN_EMAIL_INVALID');
      const result=await deliver(s,recipient,{listing_name:'Adminisztrátori teszt – nem valós megkeresés',name:'MENTÁL.hu teszt',email:recipient,phone:'',preference:'email'},crypto.randomUUID());audit('test_email','contact',null,req.user.email,{accepted:true});res.json({ok:true,message:'A tesztlevelet a levélküldő átvette az adminisztrátor e-mail-címére.',provider_id:result.id});
    }));
    app.get('/api/admin/contact/inquiries',auth,wrap(async(req,res)=>{
      const page=Math.min(100000,Math.max(1,parseInt(req.query.page,10)||1)),status=clean(req.query.status,30),values=[];let where="delivery_status<>'expired'";
      if(['needs_mail','needs_recipient','queued','sending','accepted','failed','uncertain','cancelled'].includes(status)){values.push(status);where+=' AND delivery_status=$1';}
      const total=(await pool.query('SELECT count(*)::int AS total FROM directory_contact_inquiries WHERE '+where,values)).rows[0].total;
      const q=await pool.query('SELECT * FROM directory_contact_inquiries WHERE '+where+' ORDER BY created_at DESC LIMIT 50 OFFSET $'+(values.length+1),[...values,(page-1)*50]);
      const items=q.rows.map(r=>{const p=unseal(r.payload_ciphertext)||{};return {id:r.id,listing_id:r.listing_id,listing_name:p.listing_name||'',listing_slug:p.listing_slug||'',name:p.name||'',email:p.email||'',phone:p.phone||'',created_at:r.created_at,delivery_status:r.delivery_status,processing_status:r.processing_status,attempts:r.attempts,error_code:r.error_code,accepted_at:r.accepted_at,expires_at:r.expires_at};});
      audit('read','contact_list',null,req.user.email,{page});res.json({items,total,page,pages:Math.max(1,Math.ceil(total/50))});
    }));
    app.get('/api/admin/contact/inquiries/:id',auth,wrap(async(req,res)=>{
      if(!UUID.test(req.params.id))throw failure('INVALID_ID');const r=(await pool.query('SELECT * FROM directory_contact_inquiries WHERE id=$1',[req.params.id])).rows[0];if(!r)return res.status(404).json({ok:false});
      const events=(await pool.query('SELECT event_type,actor,details,created_at FROM directory_contact_events WHERE inquiry_id=$1 ORDER BY created_at,id',[r.id])).rows;
      audit('read','contact',r.id,req.user.email);res.json({id:r.id,created_at:r.created_at,status:r.delivery_status,processing_status:r.processing_status,expires_at:r.expires_at,consent_at:r.consent_at,consent_version:r.consent_version,payload:unseal(r.payload_ciphertext),events});
    }));
    app.post('/api/admin/contact/inquiries/:id/action',auth,wrap(async(req,res)=>{
      protect(req,'admin:'+req.user.email);if(!UUID.test(req.params.id))throw failure('INVALID_ID');const action=clean(req.body.action,30),s=await settings(),client=await pool.connect();
      try {await client.query('BEGIN');const r=(await client.query('SELECT * FROM directory_contact_inquiries WHERE id=$1 FOR UPDATE',[req.params.id])).rows[0];if(!r)throw failure('NOT_FOUND',404);
        if(action==='erase') {if(r.delivery_status==='sending')throw failure('DELIVERY_IN_PROGRESS',409);await client.query("UPDATE directory_contact_inquiries SET payload_ciphertext=NULL,requester_hash=NULL,ip_hash=NULL,listing_id=NULL,provider_message_id=NULL,error_code=NULL,delivery_status='expired',expires_at=now(),updated_at=now() WHERE id=$1",[r.id]);}
        else if(['new','in_progress','closed'].includes(action))await client.query('UPDATE directory_contact_inquiries SET processing_status=$2,updated_at=now() WHERE id=$1',[r.id,action]);
        else if(action==='cancel') {if(r.delivery_status==='sending')throw failure('DELIVERY_IN_PROGRESS',409);await client.query("UPDATE directory_contact_inquiries SET delivery_status='cancelled',updated_at=now() WHERE id=$1",[r.id]);}
        else if(action==='retry') {
          if(!privacyReady(s)||!mailReady(s))throw failure('MAIL_NOT_CONFIGURED',409);
          if(!['failed','needs_mail','needs_recipient','uncertain'].includes(r.delivery_status)||new Date(r.expires_at)<=new Date())throw failure('RETRY_NOT_ALLOWED',409);
          if(r.delivery_status==='uncertain'&&req.body.confirm_duplicate_risk!==true)throw failure('CONFIRM_DUPLICATE_RISK',409);
          const listing=(await client.query("SELECT email,contact_disabled FROM directory_listings WHERE id=$1 AND status='published'",[r.listing_id])).rows[0];if(!listing||listing.contact_disabled||!isEmail(listing.email))throw failure('RECIPIENT_MISSING',409);
          const p=unseal(r.payload_ciphertext);p.recipient=listing.email.toLowerCase();await client.query("UPDATE directory_contact_inquiries SET payload_ciphertext=$2,delivery_status='queued',next_attempt_at=now(),error_code=NULL,updated_at=now() WHERE id=$1",[r.id,seal(p)]);
        } else throw failure('INVALID_ACTION');
        await event(client,r.id,action,req.user.email);await client.query('COMMIT');
      }catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}
      audit(action,'contact',req.params.id,req.user.email);res.json({ok:true});if(action==='retry')setImmediate(runWorker);
    }));
  }
  function markup(listing) {return '<section id="kapcsolat" class="contact-panel" data-contact-slug="'+esc(listing.slug)+'"><h2>Kapcsolatfelvétel</h2><p>Visszajelzést kérhetsz erről az adatlapról: <strong>'+esc(listing.name)+'</strong>. Ez nem időpontfoglalás és nem sürgősségi segítségkérés.</p><p id="contactAvailability" role="status">A kapcsolatfelvételi lehetőség ellenőrzése…</p><form id="contactInquiryForm" hidden><label>Neved<input name="name" autocomplete="name" minlength="2" maxlength="120" required></label><label>E-mail-címed<input name="email" type="email" autocomplete="email" maxlength="254" required></label><label>Telefonszámod <small>(nem kötelező)</small><input name="phone" type="tel" autocomplete="tel" maxlength="30"></label><label>Hogyan keressenek?<select name="preference"><option value="email">E-mailben</option><option value="phone">Telefonon</option><option value="either">E-mailben vagy telefonon</option></select></label><label class="contact-honeypot" aria-hidden="true">Weboldal<input name="website" tabindex="-1" autocomplete="off"></label><p>Csak a saját elérhetőségeidet add meg. Ne küldj gyermekadatot, leletet, diagnózist vagy tünetleírást.</p><label class="contact-check"><input name="adult" type="checkbox" required><span>Elmúltam 18 éves, és a saját elérhetőségeimet adom meg.</span></label><label class="contact-check"><input name="consent" type="checkbox" required><span id="contactConsentText"></span></label><p><a href="/kapcsolatfelvetel-adatkezeles" target="_blank" rel="noopener">Adatkezelési tájékoztató</a></p><button type="submit">Kapcsolatfelvétel kérése</button><p id="contactInquiryMessage" role="status" aria-live="polite"></p></form></section><link rel="stylesheet" href="/contact.css"><script src="/contact.js" defer></script>';}
  function start(){timer=setInterval(runWorker,10000);timer.unref();return ()=>clearInterval(timer);}
  return {register,markup,start,runWorker,settings,seal,unseal,validate,mailReady,privacyReady};
}
module.exports={createContactService,isEmail,CONSENT_VERSION};
