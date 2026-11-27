'use strict';

const crypto=require('node:crypto');
const {validEmail}=require('./provider-accounts.cjs');
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const STATUSES=Object.freeze([{key:'new',label:'Új érdeklődő'},{key:'contacted',label:'Kapcsolatfelvétel'},{key:'appointment',label:'Egyeztetett időpont'},{key:'active',label:'Folyamatban'},{key:'closed',label:'Lezárva'},{key:'lost',label:'Nem aktuális'}]);
const STATUS_KEYS=new Set(STATUSES.map(item=>item.key));
const EVENT_TYPES=new Set(['note','call','email','meeting']);
const LIMITS=Object.freeze({name:180,email:254,phone:60,source_label:160,notes:8000,next_action:500});
const fail=(code,message,httpStatus=400)=>Object.assign(new Error(message),{code,httpStatus});
const normalize=value=>String(value||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/\s+/g,' ').trim();
function text(value,key,max,{multiline=false}={}) {
 if(typeof value!=='string'||value.length>max||/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)||(!multiline&&/[\r\n]/.test(value)))throw fail('INVALID_FIELD','Ellenőrizd ezt a mezőt: '+key+'.');
 return value.replace(/\r\n?/g,'\n').trim();
}
function dateValue(value) {
 if(value===null||value==='')return null;
 if(typeof value!=='string'||!/^\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d(?:\.\d{1,3})?)?(?:Z|[+-]\d\d:\d\d)$/.test(value))throw fail('INVALID_DATE','Adj meg érvényes utánkövetési időpontot.');
 const date=new Date(value);if(!Number.isFinite(date.valueOf())||date.getUTCFullYear()<2000||date.getUTCFullYear()>2100)throw fail('INVALID_DATE','Adj meg érvényes utánkövetési időpontot.');
 return date.toISOString();
}
function cleanContact(body,previous=null) {
 if(!body||typeof body!=='object'||Array.isArray(body))throw fail('INVALID_CONTACT','Érvénytelen kapcsolati adatok.');
 const allowed=new Set([...Object.keys(LIMITS),'status','next_followup_at','version']);
 if(Object.keys(body).some(key=>!allowed.has(key)))throw fail('FIELD_NOT_ALLOWED','A kérés nem módosítható mezőt tartalmaz.');
 const payload={...Object.fromEntries(Object.keys(LIMITS).map(key=>[key,''])),...(previous?.payload||{})};
 for(const [key,max] of Object.entries(LIMITS))if(Object.hasOwn(body,key))payload[key]=text(body[key],({name:'név',email:'e-mail-cím',phone:'telefonszám',source_label:'forrás',notes:'megjegyzés',next_action:'következő lépés'})[key],max,{multiline:key==='notes'});
 if(payload.name.length<2)throw fail('NAME_REQUIRED','Legalább két karakteres nevet adj meg.');
 payload.email=payload.email.toLowerCase();if(payload.email&&!validEmail(payload.email))throw fail('INVALID_EMAIL','Adj meg érvényes e-mail-címet, vagy hagyd üresen.');
 const status=body.status??previous?.status??'new';if(!STATUS_KEYS.has(status))throw fail('INVALID_STATUS','Válassz érvényes állapotot.');
 const next_followup_at=Object.hasOwn(body,'next_followup_at')?dateValue(body.next_followup_at):previous?.next_followup_at||null;
 if(next_followup_at&&!payload.next_action)throw fail('NEXT_ACTION_REQUIRED','Az időpont mellé írd be a következő lépést is.');
 if(!previous&&!payload.source_label)payload.source_label='Saját kapcsolat';
 return {payload,status,next_followup_at};
}
function searchWords(value) {
 const normalized=normalize(value),words=normalized.split(/[^\p{L}\p{N}]+/u).filter(word=>word.length>=2);
 if(normalized.includes('@')&&!/\s/.test(normalized))words.push(normalized);
 const digits=normalized.replace(/\D/g,'');if(digits.length>=3)words.push(digits);
 return [...new Set(words)].slice(0,80);
}
function searchTokens(payload,key) {
 const tokens=new Set();
 for(const value of [payload.name,payload.email,payload.phone])for(const word of searchWords(value))for(let length=2;length<=Math.min(60,word.length);length++)tokens.add(crypto.createHmac('sha256',key).update(word.slice(0,length)).digest('hex'));
 return [...tokens];
}
function queryTokens(value,key) {
 if(value==null||value==='')return [];
 if(typeof value!=='string'||value.length>200)throw fail('INVALID_SEARCH','A keresés legfeljebb 200 karakter lehet.');
 const words=searchWords(value).slice(0,8);if(!words.length)throw fail('SEARCH_TOO_SHORT','A kereséshez legalább két betűt vagy számot adj meg.');
 return words.map(word=>crypto.createHmac('sha256',key).update(word.slice(0,60)).digest('hex'));
}
const idOf=value=>{if(typeof value!=='string'||!UUID.test(value))throw fail('CONTACT_NOT_FOUND','A kapcsolat nem található.',404);return value;};
const versionOf=value=>{if(!Number.isSafeInteger(value)||value<1)throw fail('VERSION_REQUIRED','Frissítsd a kapcsolatot a mentés előtt.',409);return value;};
// Cleanup erases stale copies; this predicate also checks access in the statement
// that reads or locks the data, so cleanup/read gaps never grant stale access.
const liveContact=(alias='c')=>`${alias}.deleted_at IS NULL AND ${alias}.payload_ciphertext IS NOT NULL AND (${alias}.source_type='manual' OR (${alias}.expires_at>now()
 AND EXISTS(SELECT 1 FROM directory_contact_inquiries live_i JOIN provider_listing_owners live_o ON live_o.listing_id=live_i.listing_id
  WHERE live_i.id=${alias}.source_inquiry_id AND live_i.listing_id=${alias}.source_listing_id AND live_o.account_id=${alias}.account_id
   AND live_i.payload_ciphertext IS NOT NULL AND live_i.expires_at>now() AND live_i.delivery_status NOT IN ('expired','cancelled'))))`;

function createProviderCrmService({pool,dbState,accounts,seal,unseal,audit=()=>{}}) {
 if(!pool||!accounts||typeof seal!=='function'||typeof unseal!=='function')throw new Error('CRM_DEPENDENCIES_REQUIRED');
 let timer=null,cleaning=false;
 const log=(action,id,actor,details={})=>{try{Promise.resolve(audit(action,'provider_crm',id,actor,details)).catch(()=>{});}catch{}};
 async function tx(fn){const client=await pool.connect();try{await client.query('BEGIN');const result=await fn(client);await client.query('COMMIT');return result;}catch(error){await client.query('ROLLBACK').catch(()=>{});throw error;}finally{client.release();}}
 function userOf(req) {
  const user=req.accountUser||req.providerUser;
  if(!user||(!user.is_provider&&!user.has_provider_profile))throw fail('PROVIDER_PROFILE_REQUIRED','Az ügyfélkezelőhöz előbb hozz létre szolgáltatói profilt a fiókodban.',403);
  return user;
 }
 async function lockProvider(client,accountId) {
  // Parent first: account suspension/deletion must serialize before child writes
  // and their FK checks, rather than racing a contact/event lock.
  const account=(await client.query('SELECT id,email FROM provider_accounts WHERE id=$1 AND email_verified_at IS NOT NULL AND disabled_at IS NULL AND provider_profile_started_at IS NOT NULL FOR SHARE',[accountId])).rows[0];
  if(!account)throw fail('PROVIDER_PROFILE_REQUIRED','Az ügyfélkezelőhöz aktív, megerősített szolgáltatói fiók szükséges.',403);
  return account;
 }
 async function accountKey(client,accountId) {
  let row=(await client.query('SELECT search_key_ciphertext FROM provider_crm_settings WHERE account_id=$1',[accountId])).rows[0];
  if(!row){await client.query('INSERT INTO provider_crm_settings(account_id,search_key_ciphertext) VALUES($1,$2) ON CONFLICT(account_id) DO NOTHING',[accountId,seal({key:crypto.randomBytes(32).toString('hex')})]);row=(await client.query('SELECT search_key_ciphertext FROM provider_crm_settings WHERE account_id=$1',[accountId])).rows[0];}
  const key=unseal(row.search_key_ciphertext)?.key;if(typeof key!=='string'||!/^[a-f0-9]{64}$/.test(key))throw new Error('CRM_SEARCH_KEY_UNAVAILABLE');return Buffer.from(key,'hex');
 }
 async function purgeExpired(accountId=null) {
  const values=accountId?[accountId]:[];
  return tx(async client=>{
   const expired=await client.query(`UPDATE provider_crm_contacts c SET payload_ciphertext=NULL,search_tokens='{}',next_followup_at=NULL,deleted_at=now(),deleted_reason='source_expired',version=version+1,updated_at=now()
    WHERE c.deleted_at IS NULL AND c.source_type='inquiry' ${accountId?'AND c.account_id=$1':''}
    AND (c.expires_at<=now() OR NOT EXISTS(SELECT 1 FROM provider_listing_owners o WHERE o.account_id=c.account_id AND o.listing_id=c.source_listing_id)
     OR NOT EXISTS(SELECT 1 FROM directory_contact_inquiries i WHERE i.id=c.source_inquiry_id AND i.payload_ciphertext IS NOT NULL AND i.expires_at>now() AND i.delivery_status NOT IN ('expired','cancelled'))) RETURNING c.id,c.account_id`,values);
   for(const row of expired.rows)await client.query('DELETE FROM provider_crm_events WHERE contact_id=$1 AND account_id=$2',[row.id,row.account_id]);
   return expired.rowCount;
  });
 }
 async function ownedListing(client,accountId,{lock=false}={}) {
  const listing=(await client.query('SELECT l.id,l.name,l.slug,l.status FROM provider_listing_owners o JOIN directory_listings l ON l.id=o.listing_id WHERE o.account_id=$1',[accountId])).rows[0]||null;
  if(!listing||!lock)return listing;
  // Match the listing -> ownership -> inquiry order of parent deletion cascades.
  const stable=(await client.query('SELECT id,name,slug,status FROM directory_listings WHERE id=$1 FOR SHARE',[listing.id])).rows[0];
  if(!stable)return null;
  const owner=(await client.query('SELECT account_id FROM provider_listing_owners WHERE account_id=$1 AND listing_id=$2 FOR SHARE',[accountId,listing.id])).rows[0];
  return owner?stable:null;
 }
 async function addEvent(client,accountId,contactId,eventType,payload,occurredAt=null) {
  await client.query('INSERT INTO provider_crm_events(id,account_id,contact_id,event_type,payload_ciphertext,occurred_at) VALUES($1,$2,$3,$4,$5,COALESCE($6::timestamptz,now()))',[crypto.randomUUID(),accountId,contactId,eventType,seal(payload),occurredAt]);
 }
 async function syncInquiries(accountId) {
  await purgeExpired(accountId);
  return tx(async client=>{
   const account=await lockProvider(client,accountId);
   await client.query('SELECT pg_advisory_xact_lock(hashtext($1))',['provider-crm-sync:'+accountId]);
   const listing=await ownedListing(client,accountId,{lock:true});if(!listing)return {imported:0,remaining:0};
   const key=await accountKey(client,accountId);
   const rows=(await client.query(`SELECT i.*,l.name AS listing_name FROM directory_contact_inquiries i
    JOIN provider_listing_owners o ON o.listing_id=i.listing_id AND o.account_id=$1
    JOIN directory_listings l ON l.id=i.listing_id
    LEFT JOIN provider_crm_contacts c ON c.source_inquiry_id=i.id
    WHERE c.id IS NULL AND i.listing_id=$2 AND i.payload_ciphertext IS NOT NULL AND i.expires_at>now() AND i.delivery_status NOT IN ('expired','cancelled')
    ORDER BY i.created_at,i.id LIMIT 200 FOR SHARE OF i,o`,[accountId,listing.id])).rows;
   let imported=0;
   for(const inquiry of rows) {
    const source=unseal(inquiry.payload_ciphertext);
    const recipientMatches=typeof source?.recipient==='string'&&source.recipient.trim().toLowerCase()===account.email.trim().toLowerCase();
    if(!recipientMatches||typeof source.name!=='string'||source.name.trim().length<2){
     // Retain only opaque identifiers: transferred listings must never reveal a
     // former recipient's leads, and repeated sync must not reconsider them.
     await client.query(`INSERT INTO provider_crm_contacts(id,account_id,source_type,source_inquiry_id,source_listing_id,source_created_at,expires_at,deleted_at,deleted_reason)
      VALUES($1,$2,'inquiry',$3,$4,$5,$6,now(),$7) ON CONFLICT DO NOTHING`,[crypto.randomUUID(),accountId,inquiry.id,inquiry.listing_id,inquiry.created_at,inquiry.expires_at,recipientMatches?'invalid_source':'recipient_changed']);
     continue;
    }
    const payload={name:source.name.slice(0,180),email:typeof source.email==='string'?source.email.toLowerCase().slice(0,254):'',phone:typeof source.phone==='string'?source.phone.slice(0,60):'',
     source_label:'MENTÁL.hu · '+inquiry.listing_name.slice(0,145),notes:'',next_action:'Kapcsolatfelvétel az érdeklődővel',preference:['email','phone','either'].includes(source.preference)?source.preference:'email'};
    const id=crypto.randomUUID();
    const inserted=await client.query(`INSERT INTO provider_crm_contacts(id,account_id,source_type,source_inquiry_id,source_listing_id,source_created_at,payload_ciphertext,search_tokens,expires_at)
     VALUES($1,$2,'inquiry',$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING RETURNING id`,[id,accountId,inquiry.id,inquiry.listing_id,inquiry.created_at,seal(payload),searchTokens(payload,key),inquiry.expires_at]);
    if(inserted.rowCount){imported++;await addEvent(client,accountId,id,'inquiry_received',{text:'Új érdeklődés érkezett a MENTÁL.hu adatlapról.',preference:payload.preference},inquiry.created_at);}
   }
   const remaining=(await client.query(`SELECT count(*)::int AS n FROM directory_contact_inquiries i JOIN provider_listing_owners o ON o.listing_id=i.listing_id AND o.account_id=$1
    LEFT JOIN provider_crm_contacts c ON c.source_inquiry_id=i.id WHERE c.id IS NULL AND i.payload_ciphertext IS NOT NULL AND i.expires_at>now() AND i.delivery_status NOT IN ('expired','cancelled')`,[accountId])).rows[0].n;
   return {imported,remaining};
  });
 }
 function publicContact(row,{detail=false}={}) {
  const payload=unseal(row.payload_ciphertext);if(!payload)throw new Error('CRM_CONTACT_PAYLOAD_MISSING');
  return {id:row.id,source_type:row.source_type,status:row.status,status_label:STATUSES.find(item=>item.key===row.status)?.label||row.status,
   name:payload.name||'',email:payload.email||'',phone:payload.phone||'',source_label:payload.source_label||'',next_action:payload.next_action||'',
   ...(detail?{notes:payload.notes||'',preference:payload.preference||null}:{}),next_followup_at:row.next_followup_at,expires_at:row.expires_at,
   source_created_at:row.source_created_at,created_at:row.created_at,updated_at:row.updated_at,version:row.version};
 }
 async function getContact(client,accountId,id,{lock=false}={}) {
  const row=(await client.query('SELECT c.* FROM provider_crm_contacts c WHERE c.id=$1 AND c.account_id=$2 AND '+liveContact()+(lock?' FOR UPDATE OF c':''),[idOf(id),accountId])).rows[0];
  if(!row)throw fail('CONTACT_NOT_FOUND','A kapcsolat nem található.',404);return row;
 }
 async function overview(accountId) {
  await purgeExpired(accountId);
  const [counts,upcoming,listing]=await Promise.all([
   pool.query(`SELECT count(*)::int AS total,count(*) FILTER(WHERE status='new')::int AS new,
    count(*) FILTER(WHERE source_type='inquiry')::int AS inquiries,count(*) FILTER(WHERE status NOT IN ('closed','lost'))::int AS open,
    count(*) FILTER(WHERE status='closed')::int AS closed,count(*) FILTER(WHERE status='lost')::int AS lost,
    count(*) FILTER(WHERE next_followup_at<now() AND status NOT IN ('closed','lost'))::int AS overdue,
    count(*) FILTER(WHERE next_followup_at>=now() AND next_followup_at<=now()+interval '7 days' AND status NOT IN ('closed','lost'))::int AS upcoming
    FROM provider_crm_contacts c WHERE account_id=$1 AND ${liveContact()}`,[accountId]),
   pool.query("SELECT c.* FROM provider_crm_contacts c WHERE account_id=$1 AND "+liveContact()+" AND next_followup_at IS NOT NULL AND status NOT IN ('closed','lost') ORDER BY next_followup_at,id LIMIT 6",[accountId]),ownedListing(pool,accountId)
  ]);
  return {counts:counts.rows[0],upcoming:upcoming.rows.map(row=>publicContact(row)),listing,statuses:STATUSES,timezone:'Europe/Budapest'};
 }
 async function listContacts(accountId,query={}) {
  await purgeExpired(accountId);
  const key=await accountKey(pool,accountId),tokens=queryTokens(query.q,key),values=[accountId],where=['c.account_id=$1',liveContact()];
  if(tokens.length){values.push(tokens);where.push('search_tokens @> $'+values.length+'::text[]');}
  if(query.status==='open')where.push("status NOT IN ('closed','lost')");
  else if(query.status){if(!STATUS_KEYS.has(query.status))throw fail('INVALID_STATUS','Ismeretlen állapot.');values.push(query.status);where.push('status=$'+values.length);}
  if(query.source){if(!['manual','inquiry'].includes(query.source))throw fail('INVALID_SOURCE','Ismeretlen forrás.');values.push(query.source);where.push('source_type=$'+values.length);}
  if(query.due){if(!['overdue','upcoming','any'].includes(query.due))throw fail('INVALID_DUE','Ismeretlen határidőszűrő.');where.push("status NOT IN ('closed','lost')");where.push(query.due==='overdue'?'next_followup_at<now()':query.due==='upcoming'?"next_followup_at>=now() AND next_followup_at<=now()+interval '7 days'":'next_followup_at IS NOT NULL');}
  const filter=' WHERE '+where.join(' AND '),total=(await pool.query('SELECT count(*)::int AS total FROM provider_crm_contacts c'+filter,values)).rows[0].total;
  const pages=Math.max(1,Math.ceil(total/25)),page=Math.min(pages,/^[1-9]\d{0,6}$/.test(String(query.page||''))?Number(query.page):1);
  const rows=(await pool.query('SELECT c.* FROM provider_crm_contacts c'+filter+' ORDER BY updated_at DESC,id LIMIT $'+(values.length+1)+' OFFSET $'+(values.length+2),[...values,25,(page-1)*25])).rows;
  return {items:rows.map(row=>publicContact(row)),total,page,pages,page_size:25};
 }
 async function events(accountId,id,pageValue=1) {
  await getContact(pool,accountId,id);
  const filter=' FROM provider_crm_events e JOIN provider_crm_contacts c ON c.id=e.contact_id AND c.account_id=e.account_id WHERE e.account_id=$1 AND e.contact_id=$2 AND '+liveContact();
  const total=(await pool.query('SELECT count(*)::int AS total'+filter,[accountId,id])).rows[0].total;
  const pages=Math.max(1,Math.ceil(total/30)),page=Math.min(pages,/^[1-9]\d{0,6}$/.test(String(pageValue))?Number(pageValue):1);
  const rows=(await pool.query('SELECT e.id,e.event_type,e.payload_ciphertext,e.occurred_at,e.created_at'+filter+' ORDER BY e.occurred_at DESC,e.created_at DESC,e.id DESC LIMIT 30 OFFSET $3',[accountId,id,(page-1)*30])).rows;
  return {items:rows.map(row=>({id:row.id,event_type:row.event_type,...unseal(row.payload_ciphertext),occurred_at:row.occurred_at,created_at:row.created_at})),total,page,pages};
 }
 async function detail(accountId,id) {
  await purgeExpired(accountId);
  const timeline=await events(accountId,id),row=await getContact(pool,accountId,id);
  return {contact:publicContact(row,{detail:true}),timeline};
 }
 async function createContact(accountId,body) {
  const clean=cleanContact(body),id=crypto.randomUUID();
  return tx(async client=>{
   await lockProvider(client,accountId);
   const key=await accountKey(client,accountId);
   await client.query('INSERT INTO provider_crm_contacts(id,account_id,source_type,payload_ciphertext,search_tokens,status,next_followup_at) VALUES($1,$2,\'manual\',$3,$4,$5,$6)',[id,accountId,seal(clean.payload),searchTokens(clean.payload,key),clean.status,clean.next_followup_at]);
   await addEvent(client,accountId,id,'created',{text:'Saját kapcsolat rögzítve.',status:clean.status});
   return publicContact(await getContact(client,accountId,id),{detail:true});
  });
 }
 async function updateContact(accountId,id,body) {
  await purgeExpired(accountId);
  return tx(async client=>{
   await lockProvider(client,accountId);
   const row=await getContact(client,accountId,id,{lock:true});if(versionOf(body?.version)!==row.version)throw fail('CONTACT_CHANGED','A kapcsolatot közben másik ablakban módosítottad. Töltsd újra a friss adatokat.',409);
   const previous=unseal(row.payload_ciphertext),clean=cleanContact(body,{...row,payload:previous}),key=await accountKey(client,accountId);
   const labels={name:'Név',email:'E-mail-cím',phone:'Telefonszám',source_label:'Forrás',notes:'Megjegyzés',next_action:'Következő lépés'};
   const changes=Object.keys(LIMITS).filter(field=>previous[field]!==clean.payload[field]).map(field=>labels[field]);
   if(row.status!==clean.status)changes.push('Állapot');
   if((row.next_followup_at?.toISOString()||null)!==(clean.next_followup_at?new Date(clean.next_followup_at).toISOString():null))changes.push('Utánkövetés időpontja');
   if(!changes.length)return publicContact(row,{detail:true});
   await client.query('UPDATE provider_crm_contacts SET payload_ciphertext=$3,search_tokens=$4,status=$5,next_followup_at=$6,version=version+1,updated_at=now() WHERE id=$1 AND account_id=$2',[id,accountId,seal(clean.payload),searchTokens(clean.payload,key),clean.status,clean.next_followup_at]);
   await addEvent(client,accountId,id,'updated',{text:'Kapcsolat frissítve.',changes,...(row.status!==clean.status?{from_status:row.status,to_status:clean.status}:{})});
   return publicContact(await getContact(client,accountId,id),{detail:true});
  });
 }
 async function recordEvent(accountId,id,body) {
  if(!body||Object.keys(body).some(key=>!['event_type','text','occurred_at'].includes(key))||!EVENT_TYPES.has(body.event_type))throw fail('INVALID_EVENT','Válassz megjegyzést, telefonhívást, e-mailt vagy találkozót.');
  const value=text(body.text,'bejegyzés',5000,{multiline:true});if(!value)throw fail('EVENT_TEXT_REQUIRED','Írd le röviden az egyeztetést vagy a következő teendőt.');
  const occurred=body.occurred_at?dateValue(body.occurred_at):null;
  if(occurred&&new Date(occurred)>new Date(Date.now()+60000))throw fail('FUTURE_EVENT','A naplóba már megtörtént eseményt írj. Jövőbeli teendőhöz használd az utánkövetést.');
  await purgeExpired(accountId);
  await tx(async client=>{await lockProvider(client,accountId);await getContact(client,accountId,id,{lock:true});await addEvent(client,accountId,id,body.event_type,{text:value},occurred);await client.query('UPDATE provider_crm_contacts SET updated_at=now() WHERE id=$1 AND account_id=$2',[id,accountId]);});
 }
 async function completeFollowup(accountId,id,body) {
  await purgeExpired(accountId);
  return tx(async client=>{
   await lockProvider(client,accountId);
   const row=await getContact(client,accountId,id,{lock:true});if(versionOf(body?.version)!==row.version)throw fail('CONTACT_CHANGED','A kapcsolat adatai megváltoztak. Frissítsd az oldalt.',409);
   const payload=unseal(row.payload_ciphertext);if(!row.next_followup_at&&!payload.next_action)throw fail('NO_FOLLOWUP','Ehhez a kapcsolathoz nincs elvégzendő lépés.',409);
   await addEvent(client,accountId,id,'followup_completed',{text:payload.next_action||'Az utánkövetést elvégeztem.',scheduled_at:row.next_followup_at});
   payload.next_action='';await client.query('UPDATE provider_crm_contacts SET payload_ciphertext=$3,next_followup_at=NULL,version=version+1,updated_at=now() WHERE id=$1 AND account_id=$2',[id,accountId,seal(payload)]);
   return publicContact(await getContact(client,accountId,id),{detail:true});
  });
 }
 async function eraseContact(accountId,id,body) {
  return tx(async client=>{
   await lockProvider(client,accountId);
   const row=await getContact(client,accountId,id,{lock:true});if(versionOf(body?.version)!==row.version)throw fail('CONTACT_CHANGED','A kapcsolat adatai megváltoztak. Frissítsd az oldalt.',409);
   await client.query('DELETE FROM provider_crm_events WHERE contact_id=$1 AND account_id=$2',[id,accountId]);
   await client.query("UPDATE provider_crm_contacts SET payload_ciphertext=NULL,search_tokens='{}',next_followup_at=NULL,deleted_at=now(),deleted_reason='owner_erased',version=version+1,updated_at=now() WHERE id=$1 AND account_id=$2",[id,accountId]);
  });
 }
 const headers=(_req,res,next)=>{res.set({'Cache-Control':'private, no-store','X-Robots-Tag':'noindex, nofollow','Referrer-Policy':'no-referrer'});next();};
 const wrap=(handler,{write=false}={})=>async(req,res)=>{
  if(!dbState.ready)return res.status(503).json({error:'Az ügyfélkezelő átmenetileg nem érhető el.',code:'DATABASE_UNAVAILABLE'});
  try{const user=userOf(req);if(write)await accounts.protect(req);await handler(req,res,user);}
  catch(error){const known=error.httpStatus>=400&&error.httpStatus<500;if(!known)console.error('[provider-crm]',/^[A-Z0-9_]{2,60}$/.test(error.code||'')?error.code:'CRM_UNAVAILABLE');res.status(known?error.httpStatus:503).json({error:known?(error.message===error.code?'Az űrlap lejárt. Frissítsd az oldalt.':error.message):'Az ügyfélkezelő most nem tölthető be. Kérjük, próbáld újra.',code:known?error.code:'CRM_UNAVAILABLE'});}
 };
 function register(app) {
  const route=(method,url,handler,options)=>app[method](url,headers,accounts.requireAccount,wrap(handler,options));
  route('get','/api/provider/crm',async(req,res,user)=>res.json({...await overview(user.id),csrf_token:accounts.csrfFor(req,res)}));
  route('post','/api/provider/crm/sync',async(_req,res,user)=>res.json({ok:true,...await syncInquiries(user.id)}),{write:true});
  route('get','/api/provider/crm/contacts',async(req,res,user)=>res.json(await listContacts(user.id,req.query)));
  route('post','/api/provider/crm/contacts',async(req,res,user)=>{const contact=await createContact(user.id,req.body);log('create',contact.id,user.email);res.status(201).json({ok:true,contact,message:'A kapcsolatot elmentettük.'});},{write:true});
  route('get','/api/provider/crm/contacts/:id',async(req,res,user)=>res.json(await detail(user.id,req.params.id)));
  route('put','/api/provider/crm/contacts/:id',async(req,res,user)=>{const contact=await updateContact(user.id,req.params.id,req.body);log('update',contact.id,user.email);res.json({ok:true,contact,message:'A változásokat elmentettük.'});},{write:true});
  route('delete','/api/provider/crm/contacts/:id',async(req,res,user)=>{await eraseContact(user.id,req.params.id,req.body);log('erase',req.params.id,user.email);res.json({ok:true,message:'A kapcsolatot és a hozzá tartozó naplót töröltük.'});},{write:true});
  route('get','/api/provider/crm/contacts/:id/events',async(req,res,user)=>{await purgeExpired(user.id);res.json(await events(user.id,req.params.id,req.query.page));});
  route('post','/api/provider/crm/contacts/:id/events',async(req,res,user)=>{await recordEvent(user.id,req.params.id,req.body);log('event_added',req.params.id,user.email,{event_type:req.body.event_type});res.status(201).json({ok:true,message:'A bejegyzést hozzáadtuk a naplóhoz.'});},{write:true});
  route('post','/api/provider/crm/contacts/:id/followup/complete',async(req,res,user)=>{const contact=await completeFollowup(user.id,req.params.id,req.body);log('followup_completed',contact.id,user.email);res.json({ok:true,contact,message:'Az elvégzett lépést bejegyeztük a naplóba.'});},{write:true});
 }
 async function cleanup(){if(cleaning||!dbState.ready)return;cleaning=true;try{await purgeExpired();}catch(error){console.error('[provider-crm-cleanup]',/^[A-Z0-9_]{2,60}$/.test(error.code||'')?error.code:'CRM_CLEANUP_FAILED');}finally{cleaning=false;}}
 function start(){if(!timer){timer=setInterval(()=>void cleanup(),3600000);timer.unref();void cleanup();}}
 function stop(){if(timer)clearInterval(timer);timer=null;}
 return {register,start,stop,cleanup,syncInquiries,overview,listContacts,detail,createContact,updateContact,recordEvent,completeFollowup,eraseContact};
}

module.exports={createProviderCrmService,cleanContact,dateValue,searchWords,searchTokens,queryTokens,STATUSES,EVENT_TYPES,LIMITS};
