'use strict';

const crypto = require('node:crypto');
const rateLimit = require('express-rate-limit');
const {validEmail, trustedBase} = require('./provider-accounts.cjs');
const {NEWSLETTER_TOPICS, normalizeTopics, topicLabels, articleMatchesTopics} = require('./newsletter-topics.cjs');
const {digestMessage, confirmationMessage} = require('./newsletter-mail.cjs');
const views = require('./newsletter-views.cjs');

const TIMEZONE = 'Europe/Budapest';
const SEND_HOUR = 8;
const DAY = 86400000;
const CONFIRM_DAYS = 7;
const PREFERENCES_DAYS = 180;
const CONSENT_VERSION = 'newsletter-20261126-v1';
const CONSENT_TEXT = 'Kifejezetten hozzájárulok, hogy a Proptech Digital Investment Zrt. a nevem, az e-mail-címem és a választott témáim alapján személyre szabott MENTÁL.hu-hírlevelet küldjön. Tudomásul veszem, hogy a témaválasztás egészséggel kapcsolatos érdeklődésre is utalhat; hozzájárulásomat bármikor visszavonhatom.';
const TEST_RECIPIENT = 'den@proptechdigital.com';
const HASH = value => crypto.createHash('sha256').update(String(value)).digest('hex');
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const VALID_TOKEN = /^[A-Za-z0-9_-]{32,128}$/;
const failure = (code, httpStatus = 400) => Object.assign(new Error(code), {code, httpStatus});
const safeCode = error => /^[A-Z0-9_]{2,60}$/.test(error?.code || '') ? error.code : 'NEWSLETTER_ERROR';
const formatter = new Intl.DateTimeFormat('en-GB', {timeZone:TIMEZONE, year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'});

function localParts(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.valueOf())) throw failure('INVALID_DATE');
  return Object.fromEntries(formatter.formatToParts(date).filter(part => part.type !== 'literal').map(part => [part.type, Number(part.value)]));
}
function fromLocal(year, month, day, hour = SEND_HOUR) {
  const target = Date.UTC(year, month - 1, day, hour);
  let value = target;
  // The 08:00 slot is never inside Budapest's skipped/repeated clock hour.
  for (let index = 0; index < 3; index++) {
    const p = localParts(value);
    value += target - Date.UTC(p.year,p.month-1,p.day,p.hour,p.minute,p.second);
  }
  return new Date(value);
}
function fridaySlot(value, next = false) {
  const now = new Date(value), p = localParts(now);
  const calendar = new Date(Date.UTC(p.year,p.month-1,p.day));
  calendar.setUTCDate(calendar.getUTCDate() - (calendar.getUTCDay() + 2) % 7);
  let slot = fromLocal(calendar.getUTCFullYear(),calendar.getUTCMonth()+1,calendar.getUTCDate());
  if (slot > now) {calendar.setUTCDate(calendar.getUTCDate()-7);slot=fromLocal(calendar.getUTCFullYear(),calendar.getUTCMonth()+1,calendar.getUTCDate());}
  if (next) {calendar.setUTCDate(calendar.getUTCDate()+7);slot=fromLocal(calendar.getUTCFullYear(),calendar.getUTCMonth()+1,calendar.getUTCDate());}
  return slot;
}
function editionWindow(value) {
  const end = fridaySlot(value), p = localParts(end);
  const previous = new Date(Date.UTC(p.year,p.month-1,p.day-7));
  return {start:fromLocal(previous.getUTCFullYear(),previous.getUTCMonth()+1,previous.getUTCDate()),end};
}
function nameOf(value) {
  if (typeof value !== 'string' || /[\u0000-\u001f\u007f]/.test(value) || value.trim().length < 2 || value.trim().length > 120) throw failure('INVALID_NAME');
  return value.trim().replace(/\s+/g,' ');
}
function signupData(body = {}) {
  const name = nameOf(body.name);
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  if (!validEmail(email)) throw failure('INVALID_EMAIL');
  if (body.consent !== true) throw failure('CONSENT_REQUIRED');
  return {name,email,topics:normalizeTopics(body.topics)};
}
function parsePreviewTopics(value) {
  if (value == null || value === '') return ['all'];
  if (typeof value !== 'string' || value.length > 1000) throw failure('INVALID_TOPICS');
  return normalizeTopics(value.split(','));
}
function deliveryOutcome(error, attempts) {
  const code = safeCode(error);
  if (code === 'MAIL_NOT_CONFIGURED') return {status:'needs_mail',code};
  if (code === 'MAIL_HTTP_429' && attempts < 3) return {status:'queued',code};
  if (/^(?:MAIL_HTTP_(?:400|401|403|404|409|422|429)|INVALID_MAIL_ENVELOPE|INVALID_UNSUBSCRIBE_URL|MAIL_REJECTED|EAUTH|EENVELOPE)$/.test(code)) return {status:'failed',code};
  // A timeout or unknown result may already have reached the recipient. Never
  // replay it automatically, including after a process crash or an SMTP error.
  return {status:'uncertain',code:code === 'NEWSLETTER_ERROR' ? 'MAIL_RESULT_UNCERTAIN' : code};
}
function subscriberView(row) {
  return {id:row.id,email:row.email,name:row.name,status:row.status,topics:row.topics,topic_labels:topicLabels(row.topics),
    needs_preferences:row.status === 'active' && (!row.confirmed_at || !row.topics?.length),confirmed_at:row.confirmed_at,
    consent_at:row.consent_at,last_sent_at:row.last_sent_at,created_at:row.created_at,updated_at:row.updated_at};
}
function csvCell(value) {
  let text = String(value ?? '').replace(/[\r\n]+/g,' ');
  if (/^[\s]*[=+@-]/.test(text)) text = "'" + text;
  return '"' + text.replace(/"/g,'""') + '"';
}

function createNewsletterService({pool,dbState,auth,accounts,mailer,baseUrl='https://mental.hu',audit=()=>{},clock=()=>new Date()}) {
  if (!mailer || !['ready','send','seal','unseal'].every(key => typeof mailer[key] === 'function')) throw new Error('NEWSLETTER_MAILER_REQUIRED');
  const origin = trustedBase(baseUrl);
  let workerBusy = false, schedulerBusy = false, timer = null, lastCleanup = 0;
  const now = () => new Date(clock());
  const log = (action,id,actor,details={}) => {try{Promise.resolve(audit(action,'newsletter',id,actor,details)).catch(()=>{});}catch{}};
  const ready = async () => {try{return !!await mailer.ready();}catch{return false;}};
  async function transaction(callback) {
    const client = await pool.connect();
    try {await client.query('BEGIN');const result=await callback(client);await client.query('COMMIT');return result;}
    catch(error){await client.query('ROLLBACK').catch(()=>{});throw error;}
    finally{client.release();}
  }
  function requireOrigin(req) {
    let supplied;
    try {supplied = new URL(req.get('Origin')).origin;} catch {throw failure('ORIGIN_REJECTED',403);}
    if (supplied !== req.protocol + '://' + req.get('host') || req.get('Sec-Fetch-Site') === 'cross-site' || !req.is('application/json')) throw failure('ORIGIN_REJECTED',403);
  }
  function tokenOf(value) {
    if (typeof value !== 'string' || !VALID_TOKEN.test(value)) throw failure('TOKEN_INVALID',410);
    return value;
  }
  async function newToken(client,subscriberId,kind,payload=null) {
    const raw = crypto.randomBytes(32).toString('base64url'), id = crypto.randomUUID();
    const expires = kind === 'unsubscribe' ? null : new Date(now().valueOf() + (kind === 'confirm' ? CONFIRM_DAYS : PREFERENCES_DAYS)*DAY);
    await client.query('INSERT INTO newsletter_tokens(id,subscriber_id,kind,token_hash,payload_ciphertext,expires_at) VALUES($1,$2,$3,$4,$5,$6)',
      [id,subscriberId,kind,HASH(raw),payload ? mailer.seal(payload) : null,expires]);
    return {raw,id,expires};
  }
  async function validToken(client,raw,kinds,{lock=false}={}) {
    const row = (await client.query(`SELECT t.* FROM newsletter_tokens t WHERE t.token_hash=$1 AND t.kind=ANY($2::text[])
      AND t.revoked_at IS NULL AND t.consumed_at IS NULL AND (t.expires_at IS NULL OR t.expires_at>$3)${lock?' FOR UPDATE':''}`,[HASH(tokenOf(raw)),kinds,now()])).rows[0];
    if (!row) throw failure('TOKEN_INVALID',410);
    return row;
  }
  async function reserveRequest(client,scope,limit=3,minimumSeconds=300) {
    const inserted=await client.query('INSERT INTO newsletter_request_limits(scope_key,request_count,window_started_at,last_requested_at) VALUES($1,0,$2,$2) ON CONFLICT(scope_key) DO NOTHING RETURNING scope_key',[scope,now()]);
    const row=(await client.query('SELECT * FROM newsletter_request_limits WHERE scope_key=$1 FOR UPDATE',[scope])).rows[0];
    const current=now().valueOf(),expired=current-new Date(row.window_started_at).valueOf()>=3600000;
    if (!inserted.rowCount && !expired && (row.request_count>=limit || current-new Date(row.last_requested_at).valueOf()<minimumSeconds*1000)) return false;
    await client.query('UPDATE newsletter_request_limits SET request_count=$2,window_started_at=$3,last_requested_at=$4 WHERE scope_key=$1',
      [scope,expired?1:row.request_count+1,expired?now():row.window_started_at,now()]);
    return true;
  }
  async function subscribe(data) {
    const configured=await ready();
    return transaction(async client=>{
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))',['newsletter-address:'+data.email]);
      if (!await reserveRequest(client,'subscribe:'+HASH(data.email))) return;
      let subscriber=(await client.query('SELECT * FROM newsletter_subscribers WHERE lower(btrim(email))=$1 AND merged_into_id IS NULL FOR UPDATE',[data.email])).rows[0];
      if (!subscriber) subscriber=(await client.query(`INSERT INTO newsletter_subscribers(email,status,name,topics,consent_text,consent_version,unsubscribe_token)
        VALUES($1,'pending','','{}',$2,$3,$4) RETURNING *`,[data.email,CONSENT_TEXT,CONSENT_VERSION,crypto.randomBytes(32).toString('hex')])).rows[0];
      // An unauthenticated form never changes an existing reader's identity,
      // consent, active status or interests before mailbox ownership is proved.
      const token=await newToken(client,subscriber.id,'confirm',{...data,preferences_version:subscriber.preferences_version,requested_at:now().toISOString()});
      const id=crypto.randomUUID(),message=confirmationMessage({id,to:data.email,name:data.name,topics:topicLabels(data.topics),confirmationUrl:origin+'/hirlevel/megerosites#token='+token.raw,baseUrl:origin});
      await client.query(`INSERT INTO newsletter_mail_jobs(id,kind,subscriber_id,token_id,payload_ciphertext,delivery_status,expires_at)
        VALUES($1,'confirmation',$2,$3,$4,$5,$6)`,[id,subscriber.id,token.id,mailer.seal(message),configured?'queued':'needs_mail',token.expires]);
      log('subscription_requested',subscriber.id,'public',{consent_version:CONSENT_VERSION});
    });
  }
  async function confirm(raw) {
    return transaction(async client=>{
      const initial=await validToken(client,raw,['confirm']);
      await client.query('SELECT id FROM newsletter_subscribers WHERE id=$1 FOR UPDATE',[initial.subscriber_id]);
      const token=await validToken(client,raw,['confirm'],{lock:true});
      const subscriber=(await client.query('SELECT * FROM newsletter_subscribers WHERE id=$1 AND merged_into_id IS NULL FOR UPDATE',[token.subscriber_id])).rows[0];
      const payload=mailer.unseal(token.payload_ciphertext);
      if (!subscriber || !payload || payload.preferences_version!==subscriber.preferences_version || payload.email!==subscriber.email.trim().toLowerCase()) throw failure('TOKEN_INVALID',410);
      const data=signupData({...payload,consent:true});
      await client.query(`UPDATE newsletter_subscribers SET name=$2,topics=$3,status='active',confirmed_at=$4,consent_text=$5,
        consent_version=$6,consent_at=$7,preferences_version=preferences_version+1,updated_at=$4 WHERE id=$1`,
        [subscriber.id,data.name,data.topics,now(),CONSENT_TEXT,CONSENT_VERSION,payload.requested_at]);
      await client.query("UPDATE newsletter_tokens SET consumed_at=$2,payload_ciphertext=NULL WHERE id=$1",[token.id,now()]);
      await client.query("UPDATE newsletter_tokens SET revoked_at=$2,payload_ciphertext=NULL WHERE subscriber_id=$1 AND kind IN ('confirm','preferences') AND id<>$3 AND revoked_at IS NULL",[subscriber.id,now(),token.id]);
      await client.query("UPDATE newsletter_mail_jobs SET delivery_status='skipped',error_code='PREFERENCES_CHANGED',payload_ciphertext=NULL,updated_at=$2 WHERE subscriber_id=$1 AND delivery_status IN ('queued','needs_mail')",[subscriber.id,now()]);
      const preferences=await newToken(client,subscriber.id,'preferences');
      log('subscription_confirmed',subscriber.id,'subscriber',{consent_version:CONSENT_VERSION});
      return {ok:true,message:'Megerősítetted a feliratkozást. Péntekenként a választott témáidból küldünk olvasnivalót.',preferences_token:preferences.raw};
    });
  }
  async function readPreferences(raw) {
    const token=await validToken(pool,raw,['preferences']);
    const row=(await pool.query('SELECT * FROM newsletter_subscribers WHERE id=$1 AND merged_into_id IS NULL',[token.subscriber_id])).rows[0];
    if (!row) throw failure('TOKEN_INVALID',410);
    return subscriberView(row);
  }
  async function updatePreferences(raw,body) {
    const name=nameOf(body.name),topics=normalizeTopics(body.topics);
    return transaction(async client=>{
      const initial=await validToken(client,raw,['preferences']);
      await client.query('SELECT id FROM newsletter_subscribers WHERE id=$1 FOR UPDATE',[initial.subscriber_id]);
      const token=await validToken(client,raw,['preferences'],{lock:true});
      const row=(await client.query('SELECT * FROM newsletter_subscribers WHERE id=$1 AND merged_into_id IS NULL FOR UPDATE',[token.subscriber_id])).rows[0];
      if (!row || row.status!=='active' || !row.confirmed_at) throw failure('SUBSCRIPTION_INACTIVE',409);
      await client.query('UPDATE newsletter_subscribers SET name=$2,topics=$3,preferences_version=preferences_version+1,updated_at=$4 WHERE id=$1',[row.id,name,topics,now()]);
      await client.query("UPDATE newsletter_tokens SET revoked_at=$2,payload_ciphertext=NULL WHERE subscriber_id=$1 AND kind='confirm' AND revoked_at IS NULL",[row.id,now()]);
      await client.query("UPDATE newsletter_mail_jobs SET delivery_status='skipped',error_code='PREFERENCES_CHANGED',payload_ciphertext=NULL,updated_at=$2 WHERE subscriber_id=$1 AND delivery_status IN ('queued','needs_mail')",[row.id,now()]);
      log('preferences_updated',row.id,'subscriber');
      return {ok:true,message:'A nevedet és a választott témáidat elmentettük.'};
    });
  }
  async function unsubscribeSubscriber(client,id,actor='subscriber') {
    const row=(await client.query('SELECT id,merged_into_id FROM newsletter_subscribers WHERE id=$1',[id])).rows[0];
    if (!row) throw failure('SUBSCRIBER_NOT_FOUND',404);
    const canonicalId=row.merged_into_id||row.id;
    // All old case-variant links lock their shared group in the same order.
    // Concurrent opt-outs through different historical links cannot deadlock.
    const ids=(await client.query('SELECT id FROM newsletter_subscribers WHERE id=$1 OR merged_into_id=$1 ORDER BY id FOR UPDATE',[canonicalId])).rows.map(item=>item.id);
    await client.query(`UPDATE newsletter_subscribers SET status='unsubscribed',name='',topics='{}',preferences_version=preferences_version+1,updated_at=$2
      WHERE id=ANY($1::bigint[]) OR merged_into_id=ANY($1::bigint[])`,[ids,now()]);
    await client.query(`UPDATE newsletter_tokens SET revoked_at=$2,payload_ciphertext=NULL WHERE subscriber_id IN
      (SELECT id FROM newsletter_subscribers WHERE id=ANY($1::bigint[]) OR merged_into_id=ANY($1::bigint[])) AND kind IN ('confirm','preferences') AND revoked_at IS NULL`,[ids,now()]);
    await client.query(`UPDATE newsletter_mail_jobs SET delivery_status='skipped',error_code='UNSUBSCRIBED',payload_ciphertext=NULL,updated_at=$2
      WHERE subscriber_id IN (SELECT id FROM newsletter_subscribers WHERE id=ANY($1::bigint[]) OR merged_into_id=ANY($1::bigint[]))
      AND delivery_status IN ('queued','needs_mail')`,[ids,now()]);
    log('unsubscribed',row.merged_into_id||row.id,actor);
  }
  async function unsubscribe(raw,{oneClick=false}={}) {
    tokenOf(raw);
    return transaction(async client=>{
      // Old email links are purpose-limited unsubscribe capabilities and remain
      // valid after migration, even when a case-variant row was merged.
      let row=(await client.query('SELECT id FROM newsletter_subscribers WHERE unsubscribe_token=$1',[raw])).rows[0];
      if (!row) {
        const token=await validToken(client,raw,oneClick?['unsubscribe']:['unsubscribe','preferences']);
        row={id:token.subscriber_id};
      }
      await unsubscribeSubscriber(client,row.id);
      return {ok:true,message:'Leiratkoztál a MENTÁL.hu hírleveléről. Erre a címre nem küldünk további heti válogatást.'};
    });
  }
  async function articlesFor(client,start,end,ids=null) {
    const values=[start,end];
    if (ids) values.push(ids);
    const rows=(await client.query(`SELECT id,slug,title,category,excerpt,reading_minutes,hero_image_id,hero_image_path,published_at FROM articles
      WHERE status='published' AND published_at >= $1 AND published_at < $2 AND published_at <= now()
      ${ids?'AND id=ANY($3::bigint[])':''} ORDER BY published_at DESC,id DESC`,values)).rows;
    return rows.map(row=>({...row,hero_url:row.hero_image_id?'/media/'+row.hero_image_id:row.hero_image_path||null}));
  }
  async function refreshCampaigns(client=pool) {
    await client.query(`UPDATE newsletter_campaigns c SET recipient_count=s.total,accepted_count=s.accepted,failed_count=s.failed,
      uncertain_count=s.uncertain,skipped_count=s.skipped,queued_count=s.queued,
      status=CASE WHEN s.total=0 OR s.skipped=s.total THEN 'empty' WHEN s.sending>0 THEN 'sending'
        WHEN s.queued>0 THEN 'queued' WHEN s.failed+s.uncertain>0 THEN 'completed_with_errors' ELSE 'completed' END,updated_at=now()
      FROM (SELECT c2.id,count(j.id)::int AS total,count(j.id) FILTER(WHERE j.delivery_status='accepted')::int AS accepted,
        count(j.id) FILTER(WHERE j.delivery_status='failed')::int AS failed,count(j.id) FILTER(WHERE j.delivery_status='uncertain')::int AS uncertain,
        count(j.id) FILTER(WHERE j.delivery_status='skipped')::int AS skipped,count(j.id) FILTER(WHERE j.delivery_status IN ('queued','needs_mail'))::int AS queued,
        count(j.id) FILTER(WHERE j.delivery_status='sending')::int AS sending
        FROM newsletter_campaigns c2 LEFT JOIN newsletter_mail_jobs j ON j.campaign_id=c2.id GROUP BY c2.id) s WHERE c.id=s.id`);
  }
  async function runScheduler(at=now()) {
    if (schedulerBusy || !dbState.ready) return false;
    schedulerBusy=true;
    try {
      const window=editionWindow(at),scheduled=window.end;
      if (new Date(at).valueOf()-scheduled.valueOf()>=DAY) return false;
      return await transaction(async client=>{
        const locked=(await client.query('SELECT pg_try_advisory_xact_lock(hashtext($1)) AS acquired',['newsletter-edition:'+scheduled.toISOString()])).rows[0].acquired;
        if (!locked) return false;
        const settings=(await client.query('SELECT * FROM newsletter_settings WHERE id=1 FOR UPDATE')).rows[0];
        if (!settings?.enabled || scheduled < new Date(settings.first_due_at)) return false;
        const campaignId=crypto.randomUUID();
        const inserted=await client.query(`INSERT INTO newsletter_campaigns(id,scheduled_at,window_start,window_end)
          VALUES($1,$2,$3,$4) ON CONFLICT(scheduled_at) DO NOTHING RETURNING id`,[campaignId,scheduled,window.start,window.end]);
        if (!inserted.rowCount) return false;
        const articles=await articlesFor(client,window.start,window.end);
        const subscribers=(await client.query("SELECT * FROM newsletter_subscribers WHERE status='active' AND confirmed_at IS NOT NULL AND cardinality(topics)>0 AND merged_into_id IS NULL ORDER BY id")).rows;
        const configured=await ready(),expires=new Date(scheduled.valueOf()+DAY);
        for (const subscriber of subscribers) {
          const matching=articles.filter(article=>articleMatchesTopics(article,subscriber.topics));
          const selected=matching.slice(0,12),id=crypto.randomUUID();
          let payload=null,token=null;
          if (selected.length) {
            token=await newToken(client,subscriber.id,'preferences');
            const preferencesUrl=origin+'/hirlevel/beallitasok#token='+token.raw;
            const unsubscribeUrl=origin+'/leiratkozas/'+subscriber.unsubscribe_token;
            payload=mailer.seal({...digestMessage({id,to:subscriber.email.trim().toLowerCase(),name:subscriber.name,topics:topicLabels(subscriber.topics),articles:selected,articleCount:matching.length,
              windowStart:window.start,windowEnd:window.end,preferencesUrl,unsubscribeUrl,baseUrl:origin}),_preferencesUrl:preferencesUrl,_unsubscribeUrl:unsubscribeUrl});
          }
          await client.query(`INSERT INTO newsletter_mail_jobs(id,kind,subscriber_id,campaign_id,token_id,payload_ciphertext,preferences_version,
            article_ids,article_count,delivery_status,error_code,expires_at) VALUES($1,'digest',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
            [id,subscriber.id,campaignId,token?.id||null,payload,subscriber.preferences_version,selected.map(article=>article.id),selected.length,
              selected.length?(configured?'queued':'needs_mail'):'skipped',selected.length?null:'NO_MATCHING_ARTICLES',expires]);
        }
        await refreshCampaigns(client);
        log('campaign_queued',campaignId,'system',{scheduled_at:scheduled.toISOString(),recipient_count:subscribers.length});
        return true;
      });
    } finally {schedulerBusy=false;}
  }
  async function processJob(job) {
    const client=await pool.connect();
    try {
      await client.query('BEGIN');
      const fresh=(await client.query('SELECT * FROM newsletter_mail_jobs WHERE id=$1 FOR UPDATE',[job.id])).rows[0];
      if (!fresh || fresh.delivery_status!=='sending') {await client.query('COMMIT');return;}
      let skip=null,subscriber=null,payload;
      if (new Date(fresh.expires_at)<=now()) skip='EDITION_EXPIRED';
      if (fresh.subscriber_id) subscriber=(await client.query('SELECT * FROM newsletter_subscribers WHERE id=$1 FOR UPDATE',[fresh.subscriber_id])).rows[0];
      if (fresh.subscriber_id&&!subscriber) skip='SUBSCRIBER_REMOVED';
      if (fresh.kind==='confirmation') {
        const token=(await client.query('SELECT * FROM newsletter_tokens WHERE id=$1',[fresh.token_id])).rows[0];
        if (!token || token.revoked_at || token.consumed_at || new Date(token.expires_at)<=now()) skip='CONFIRMATION_EXPIRED';
      }
      if (fresh.kind==='digest') {
        if (subscriber?.status!=='active'||!subscriber?.confirmed_at||subscriber?.merged_into_id) skip='UNSUBSCRIBED';
        else if (subscriber.preferences_version!==fresh.preferences_version) skip='PREFERENCES_CHANGED';
        const settings=(await client.query('SELECT enabled FROM newsletter_settings WHERE id=1')).rows[0];
        if (!settings?.enabled) {
          await client.query("UPDATE newsletter_mail_jobs SET delivery_status='queued',attempts=GREATEST(attempts-1,0),sending_since=NULL,updated_at=now() WHERE id=$1",[fresh.id]);
          await client.query('COMMIT');return;
        }
      }
      if (!skip) {
        payload=mailer.unseal(fresh.payload_ciphertext);
        if (!payload || subscriber && payload.to!==subscriber.email.trim().toLowerCase() || fresh.kind==='test'&&payload.to!==TEST_RECIPIENT) skip='RECIPIENT_CHANGED';
      }
      if (!skip && fresh.kind==='digest') {
        const campaign=(await client.query('SELECT * FROM newsletter_campaigns WHERE id=$1',[fresh.campaign_id])).rows[0];
        const matching=(await articlesFor(client,campaign.window_start,campaign.window_end)).filter(article=>articleMatchesTopics(article,subscriber.topics));
        const articles=matching.slice(0,12);
        if (!articles.length) skip='NO_MATCHING_ARTICLES';
        else {
          payload=digestMessage({id:fresh.id,to:subscriber.email.trim().toLowerCase(),name:subscriber.name,topics:topicLabels(subscriber.topics),articles,articleCount:matching.length,
            windowStart:campaign.window_start,windowEnd:campaign.window_end,preferencesUrl:payload._preferencesUrl,unsubscribeUrl:payload._unsubscribeUrl,baseUrl:origin});
          await client.query('UPDATE newsletter_mail_jobs SET article_ids=$2,article_count=$3 WHERE id=$1',[fresh.id,articles.map(article=>article.id),articles.length]);
        }
      }
      let status='skipped',code=skip,messageId=null;
      if (!skip) {
        try {
          const result=await mailer.send(payload);
          if(typeof result?.id!=='string'||!result.id.trim()) throw failure('MAIL_RESULT_UNCERTAIN',502);
          status='accepted';messageId=result.id.slice(0,250);code=null;
        } catch(error) {({status,code}=deliveryOutcome(error,fresh.attempts));}
      }
      await client.query(`UPDATE newsletter_mail_jobs SET delivery_status=$2,error_code=$3,provider_message_id=$4,
        accepted_at=CASE WHEN $2='accepted' THEN $5 ELSE accepted_at END,
        payload_ciphertext=CASE WHEN $2 IN ('accepted','skipped') THEN NULL ELSE payload_ciphertext END,
        attempts=CASE WHEN $2='needs_mail' THEN GREATEST(attempts-1,0) ELSE attempts END,
        next_attempt_at=CASE WHEN $2='queued' THEN $5+interval '2 minutes' ELSE next_attempt_at END,updated_at=$5 WHERE id=$1`,[fresh.id,status,code,messageId,now()]);
      if (status==='accepted'&&fresh.kind==='digest') await client.query('UPDATE newsletter_subscribers SET last_sent_at=$2 WHERE id=$1',[fresh.subscriber_id,now()]);
      await client.query('COMMIT');
      log('mail_'+status,fresh.id,'system',{kind:fresh.kind,...(code?{code}:{})});
    } catch(error) {await client.query('ROLLBACK').catch(()=>{});throw error;}
    finally {client.release();}
  }
  async function cleanup() {
    if (Date.now()-lastCleanup<3600000) return;
    lastCleanup=Date.now();
    await pool.query(`DELETE FROM newsletter_subscribers s WHERE s.status='pending' AND s.confirmed_at IS NULL AND s.merged_into_id IS NULL AND s.created_at<now()-interval '7 days'
      AND NOT EXISTS(SELECT 1 FROM newsletter_tokens t WHERE t.subscriber_id=s.id AND t.kind='confirm' AND t.revoked_at IS NULL AND t.consumed_at IS NULL AND t.expires_at>now())`);
    await pool.query("UPDATE newsletter_mail_jobs SET payload_ciphertext=NULL WHERE expires_at<=now() AND payload_ciphertext IS NOT NULL");
    await pool.query("DELETE FROM newsletter_campaigns WHERE created_at<now()-interval '90 days'");
    await pool.query("DELETE FROM newsletter_mail_jobs WHERE created_at<now()-interval '90 days'");
    await pool.query("DELETE FROM newsletter_tokens WHERE COALESCE(revoked_at,consumed_at,expires_at)<now()-interval '30 days'");
    await pool.query("DELETE FROM newsletter_request_limits WHERE last_requested_at<now()-interval '2 days'");
  }
  async function runWorker({limit=5}={}) {
    if (workerBusy || !dbState.ready) return;
    workerBusy=true;
    try {
      await pool.query("UPDATE newsletter_mail_jobs SET delivery_status='uncertain',error_code='WORKER_INTERRUPTED',updated_at=now() WHERE delivery_status='sending' AND sending_since<now()-interval '5 minutes'");
      await pool.query("UPDATE newsletter_mail_jobs SET delivery_status='skipped',error_code='EDITION_EXPIRED',payload_ciphertext=NULL,updated_at=now() WHERE delivery_status IN ('queued','needs_mail') AND expires_at<=now()");
      if (!await ready()) {
        await pool.query("UPDATE newsletter_mail_jobs SET delivery_status='needs_mail',updated_at=now() WHERE delivery_status='queued'");
      } else {
        for(let index=0;index<Math.min(20,limit);index++) {
          const job=await transaction(async client=>{
            const row=(await client.query(`SELECT j.* FROM newsletter_mail_jobs j WHERE j.delivery_status IN ('queued','needs_mail')
              AND j.next_attempt_at<=now() AND j.expires_at>now() AND j.attempts<3
              AND (j.kind<>'digest' OR EXISTS(SELECT 1 FROM newsletter_settings WHERE id=1 AND enabled))
              ORDER BY CASE WHEN j.kind='confirmation' THEN 0 ELSE 1 END,j.created_at,j.id FOR UPDATE SKIP LOCKED LIMIT 1`)).rows[0];
            if(row)await client.query("UPDATE newsletter_mail_jobs SET delivery_status='sending',sending_since=now(),attempts=attempts+1,updated_at=now() WHERE id=$1",[row.id]);
            return row;
          });
          if(!job)break;
          await processJob(job);
        }
      }
      await refreshCampaigns();
      await cleanup();
    } catch(error) {console.error('[newsletter-worker]',safeCode(error));}
    finally {workerBusy=false;}
  }
  async function listSubscribers(query={}) {
    const values=[],terms=['merged_into_id IS NULL'];
    const q=typeof query.q==='string'?query.q.trim().slice(0,200):'';
    if(q){values.push('%'+q.replace(/[\\%_]/g,'\\$&')+'%');terms.push('(email ILIKE $'+values.length+' OR name ILIKE $'+values.length+')');}
    const conditions={active:"status='active' AND confirmed_at IS NOT NULL AND cardinality(topics)>0",pending:"status='pending'",unsubscribed:"status='unsubscribed'",needs_preferences:"status='active' AND (confirmed_at IS NULL OR cardinality(topics)=0)"};
    if(query.status){if(!conditions[query.status])throw failure('INVALID_FILTER');terms.push(conditions[query.status]);}
    const where=' WHERE '+terms.join(' AND '),total=(await pool.query('SELECT count(*)::int AS total FROM newsletter_subscribers'+where,values)).rows[0].total;
    const pageSize=25,pages=Math.max(1,Math.ceil(total/pageSize));
    const page=Math.min(pages,/^[1-9]\d{0,6}$/.test(String(query.page||''))?Number(query.page):1);
    const items=(await pool.query('SELECT * FROM newsletter_subscribers'+where+' ORDER BY created_at DESC,id DESC LIMIT $'+(values.length+1)+' OFFSET $'+(values.length+2),[...values,pageSize,(page-1)*pageSize])).rows.map(subscriberView);
    return {items,total,page,pages,page_size:pageSize};
  }
  async function dashboard(req,res) {
    const [settings,counts,campaigns,mailReady]=await Promise.all([
      pool.query('SELECT * FROM newsletter_settings WHERE id=1'),
      pool.query(`SELECT count(*) FILTER(WHERE status='active' AND confirmed_at IS NOT NULL AND cardinality(topics)>0)::int AS active,
        count(*) FILTER(WHERE status='pending')::int AS pending,count(*) FILTER(WHERE status='unsubscribed')::int AS unsubscribed,
        count(*) FILTER(WHERE status='active' AND (confirmed_at IS NULL OR cardinality(topics)=0))::int AS needs_preferences
        FROM newsletter_subscribers WHERE merged_into_id IS NULL`),
      pool.query('SELECT * FROM newsletter_campaigns ORDER BY scheduled_at DESC LIMIT 30'),ready()
    ]);
    const config=settings.rows[0],next=fridaySlot(now(),true),first=new Date(config.first_due_at);
    return {enabled:config.enabled,mail_ready:mailReady,test_recipient:TEST_RECIPIENT,next_send_at:(first>next?first:next).toISOString(),
      timezone:TIMEZONE,hour:SEND_HOUR,counts:counts.rows[0],topics:NEWSLETTER_TOPICS,campaigns:campaigns.rows,csrf_token:accounts.csrfFor(req,res)};
  }
  async function preview(topics) {
    const end=now(),start=new Date(end.valueOf()-7*DAY),articles=(await articlesFor(pool,start,end)).filter(article=>articleMatchesTopics(article,topics));
    return digestMessage({id:crypto.randomUUID(),to:TEST_RECIPIENT,name:'Szerkesztőség',topics:topicLabels(topics),articles,articleCount:articles.length,
      windowStart:start,windowEnd:end,preferencesUrl:origin+'/admin/?view=subscribers',baseUrl:origin,test:true});
  }
  function register(app) {
    const headers=(_req,res,next)=>{res.set({'Cache-Control':'private, no-store','X-Robots-Tag':'noindex, nofollow','Referrer-Policy':'no-referrer'});next();};
    const wrap=handler=>async(req,res)=>{
      if(!dbState.ready)return res.status(503).json({error:'A hírlevél most nem érhető el. Kérjük, próbáld újra később.',code:'DATABASE_UNAVAILABLE'});
      try{await handler(req,res);}catch(error){
        const code=safeCode(error),status=Number.isInteger(error.httpStatus)&&error.httpStatus>=400&&error.httpStatus<=599?error.httpStatus:500;
        const messages={INVALID_NAME:'Adj meg egy 2–120 karakter hosszú nevet.',INVALID_EMAIL:'Adj meg érvényes e-mail-címet.',INVALID_TOPICS:'Válassz legalább egy érvényes témát.',
          CONSENT_REQUIRED:'A feliratkozáshoz az adatkezelési hozzájárulás szükséges.',TOKEN_INVALID:'A hivatkozás lejárt vagy már nem használható. Indíts új feliratkozást, vagy nyisd meg a legutóbbi hírleveledet.',
          SUBSCRIPTION_INACTIVE:'A feliratkozás már nem aktív. Új feliratkozást a Hírlevél oldalon indíthatsz.',MAIL_NOT_CONFIGURED:'A levélküldés még nincs beállítva.',RATE_LIMITED:'Túl sok kérés érkezett. Kérjük, próbáld újra később.',
          ORIGIN_REJECTED:'Az űrlap nem erről az oldalról érkezett. Frissítsd az oldalt.',FORM_EXPIRED:'Az űrlap lejárt. Frissítsd az oldalt.'};
        if(status>=500)console.error('[newsletter-api]',code);
        res.status(status).json({error:messages[code]||'A művelet most nem sikerült. Kérjük, próbáld újra később.',code});
      }
    };
    const publicLimiter=rateLimit({windowMs:15*60*1000,limit:100,standardHeaders:true,legacyHeaders:false,handler:(_req,res)=>res.status(429).json({error:'Túl sok kérés érkezett. Kérjük, próbáld újra később.',code:'RATE_LIMITED'})});
    const signupLimiter=rateLimit({windowMs:15*60*1000,limit:25,standardHeaders:true,legacyHeaders:false});
    app.get('/api/newsletter/topics',headers,(_req,res)=>res.json({items:NEWSLETTER_TOPICS}));
    app.post('/api/newsletter/subscribe',headers,signupLimiter,wrap(async(req,res)=>{
      requireOrigin(req);
      if(!req.body?.website)await subscribe(signupData(req.body));
      res.status(202).json({ok:true,message:'A feliratkozási kérést fogadtuk. E-mailben kérünk megerősítést; a levél megérkezéséig kis türelmet kérünk.'});
    }));
    app.post('/api/newsletter/confirm',headers,publicLimiter,wrap(async(req,res)=>{requireOrigin(req);res.json(await confirm(req.body?.token));}));
    app.post('/api/newsletter/preferences/read',headers,publicLimiter,wrap(async(req,res)=>{requireOrigin(req);res.json(await readPreferences(req.body?.token));}));
    app.post('/api/newsletter/preferences',headers,publicLimiter,wrap(async(req,res)=>{requireOrigin(req);res.json(await updatePreferences(req.body?.token,req.body));}));
    app.post('/api/newsletter/unsubscribe',headers,publicLimiter,wrap(async(req,res)=>{requireOrigin(req);res.json(await unsubscribe(req.body?.token));}));
    app.get('/hirlevel-adatkezeles',headers,async(_req,res)=>{let provider='';try{provider=typeof mailer.provider==='function'?await mailer.provider():'';}catch{}res.type('html').send(views.renderNewsletterPrivacy({provider}));});
    for(const [route,mode] of Object.entries({'/hirlevel':'subscribe','/hirlevel/megerosites':'confirm','/hirlevel/beallitasok':'preferences','/hirlevel/leiratkozas':'unsubscribe'})) {
      app.get(route,headers,(_req,res)=>res.type('html').send(views.renderNewsletterPage({mode,topics:NEWSLETTER_TOPICS})));
    }
    app.get('/leiratkozas/:token',headers,(req,res)=>{
      if(!VALID_TOKEN.test(req.params.token))return res.status(404).end();
      res.type('html').send(views.renderNewsletterPage({mode:'unsubscribe',token:req.params.token}));
    });
    app.post('/leiratkozas/:token',headers,publicLimiter,wrap(async(req,res)=>{
      if(!req.is('application/x-www-form-urlencoded')||req.body?.['List-Unsubscribe']!=='One-Click')throw failure('INVALID_UNSUBSCRIBE_REQUEST');
      await unsubscribe(req.params.token,{oneClick:true});res.status(200).type('text').send('Leiratkozás rögzítve.');
    }));
    app.get('/api/admin/newsletter',headers,auth,wrap(async(req,res)=>res.json(await dashboard(req,res))));
    app.get('/api/admin/newsletter/subscribers',headers,auth,wrap(async(req,res)=>res.json(await listSubscribers(req.query))));
    app.get('/api/admin/subscribers',headers,auth,wrap(async(req,res)=>res.json((await listSubscribers(req.query)).items)));
    app.get('/api/admin/subscribers.csv',headers,auth,wrap(async(_req,res)=>{
      const rows=(await pool.query('SELECT * FROM newsletter_subscribers WHERE merged_into_id IS NULL ORDER BY created_at DESC,id DESC')).rows;
      const csv=[['Név','E-mail','Állapot','Témák','Megerősítve','Feliratkozás','Utolsó küldés'],...rows.map(row=>[row.name,row.email,row.status,topicLabels(row.topics).join(', '),row.confirmed_at?.toISOString()||'',row.created_at?.toISOString()||'',row.last_sent_at?.toISOString()||''])].map(row=>row.map(csvCell).join(',')).join('\r\n');
      res.set({'Content-Type':'text/csv; charset=utf-8','Content-Disposition':'attachment; filename="mentalhu-hirlevel.csv"'}).send('\ufeff'+csv);
    }));
    app.post('/api/admin/newsletter/settings',headers,auth,wrap(async(req,res)=>{
      await accounts.protect(req);if(typeof req.body?.enabled!=='boolean')throw failure('INVALID_SETTINGS');
      await pool.query('UPDATE newsletter_settings SET enabled=$1,updated_at=now() WHERE id=1',[req.body.enabled]);
      log('schedule_updated',1,req.user?.email,{enabled:req.body.enabled});res.json({ok:true,enabled:req.body.enabled});
    }));
    app.post('/api/admin/newsletter/subscribers/:id/unsubscribe',headers,auth,wrap(async(req,res)=>{
      await accounts.protect(req);if(!/^[1-9]\d{0,18}$/.test(req.params.id))throw failure('INVALID_SUBSCRIBER');
      await transaction(client=>unsubscribeSubscriber(client,req.params.id,req.user?.email));res.json({ok:true,message:'A feliratkozót leiratkoztattuk.'});
    }));
    app.get('/api/admin/newsletter/campaigns',headers,auth,wrap(async(_req,res)=>res.json({items:(await pool.query('SELECT * FROM newsletter_campaigns ORDER BY scheduled_at DESC LIMIT 30')).rows})));
    app.get('/api/admin/newsletter/campaigns/:id',headers,auth,wrap(async(req,res)=>{
      if(!UUID.test(req.params.id))throw failure('INVALID_CAMPAIGN');
      const campaign=(await pool.query('SELECT * FROM newsletter_campaigns WHERE id=$1',[req.params.id])).rows[0];if(!campaign)throw failure('CAMPAIGN_NOT_FOUND',404);
      const items=(await pool.query(`SELECT j.id,s.email,s.name,j.delivery_status,j.article_count,j.article_ids,j.attempts,j.error_code,j.accepted_at,j.created_at
        FROM newsletter_mail_jobs j LEFT JOIN newsletter_subscribers s ON s.id=j.subscriber_id WHERE j.campaign_id=$1 ORDER BY s.email,j.id LIMIT 1000`,[campaign.id])).rows;
      res.json({campaign,items});
    }));
    app.get('/api/admin/newsletter/preview',headers,auth,wrap(async(req,res)=>res.type('html').send((await preview(parsePreviewTopics(req.query.topics))).html)));
    app.post('/api/admin/newsletter/test',headers,auth,wrap(async(req,res)=>{
      await accounts.protect(req);if(!await ready())throw failure('MAIL_NOT_CONFIGURED',409);
      const topics=normalizeTopics(req.body?.topics||['all']);
      const message=await preview(topics),id=message.id;
      await transaction(async client=>{
        await client.query('SELECT pg_advisory_xact_lock(hashtext($1))',['newsletter-admin-test']);
        if(!await reserveRequest(client,'newsletter-admin-test',3,30))throw failure('RATE_LIMITED',429);
        await client.query("INSERT INTO newsletter_mail_jobs(id,kind,payload_ciphertext,expires_at) VALUES($1,'test',$2,$3)",[id,mailer.seal(message),new Date(now().valueOf()+DAY)]);
      });
      log('test_queued',id,req.user?.email,{recipient:TEST_RECIPIENT});
      res.status(202).json({ok:true,recipient:TEST_RECIPIENT,delivery_status:'queued',message:'A tesztlevelet küldésre váró sorba tettük a '+TEST_RECIPIENT+' címre.'});
    }));
  }
  async function tick() {
    try{await runScheduler();}catch(error){console.error('[newsletter-scheduler]',safeCode(error));}
    await runWorker();
  }
  function start(){if(!timer){timer=setInterval(()=>{void tick();},10000);timer.unref();void tick();}}
  function stop(){if(timer)clearInterval(timer);timer=null;}
  return {register,start,stop,runWorker,runScheduler,subscribe,confirm,readPreferences,updatePreferences,unsubscribe,listSubscribers,preview,cleanup};
}

module.exports={createNewsletterService,fridaySlot,editionWindow,localParts,fromLocal,signupData,nameOf,parsePreviewTopics,deliveryOutcome,csvCell,
  CONSENT_TEXT,CONSENT_VERSION,TIMEZONE,SEND_HOUR,TEST_RECIPIENT};
