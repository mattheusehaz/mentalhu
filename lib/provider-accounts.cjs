'use strict';

const crypto = require('node:crypto');
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');

const SESSION_DAYS = 14;
const SETUP_SECONDS = 7 * 24 * 3600;
const RESET_SECONDS = 3600;
const CSRF_SECONDS = 2 * 3600;
const CONSENT_VERSION = 'provider-account-20261126';
const EMAIL = /^[A-Za-z0-9.!#$%&'*+\/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?\.[A-Za-z]{2,63}$/;
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const input = (value,max=200) => typeof value==='string' ? value.trim().slice(0,max) : '';
const emailOf = value => input(value,255).toLowerCase();
const validEmail = value => {
  if(typeof value!=='string'||value.length>254||!EMAIL.test(value)||/[\r\n\0]/.test(value))return false;
  const [local,domain]=value.split('@');
  return local.length<=64&&!local.startsWith('.')&&!local.endsWith('.')&&!local.includes('..')&&domain.split('.').every(label=>/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(label));
};
const validToken = value => typeof value==='string' && /^[A-Za-z0-9_-]{43}$/.test(value);
const validPassword = value => typeof value==='string' && [...value].length>=10 && Buffer.byteLength(value,'utf8')<=72 && !/[\0]/.test(value);
const failure = (code,httpStatus=400) => Object.assign(new Error(code),{code,httpStatus});
const safeEqual = (a,b) => typeof a==='string' && typeof b==='string' && Buffer.byteLength(a)===Buffer.byteLength(b) && crypto.timingSafeEqual(Buffer.from(a),Buffer.from(b));
const publicUser = row => ({id:row.id,email:row.email,display_name:row.display_name,email_verified:!!row.email_verified_at,approved:!!row.approved_at,disabled:!!row.disabled_at});
const dummyPasswordHash = bcrypt.hashSync('mental-provider-placeholder-password',12);

function trustedBase(value) {
  const base=new URL(value);
  if(base.username||base.password||base.search||base.hash||!['','/'].includes(base.pathname)||
    (base.protocol!=='https:' && !(base.protocol==='http:' && ['localhost','127.0.0.1','[::1]'].includes(base.hostname)))) throw new Error('PROVIDER_BASE_URL_INVALID');
  return base.origin;
}

function createProviderAccountService({pool,dbState,secret,baseUrl='https://mental.hu',mailer,audit=()=>{},env=process.env}) {
  if(typeof secret!=='string'||secret.length<16) throw new Error('PROVIDER_SECRET_REQUIRED');
  if(!mailer||!['ready','send','seal','unseal'].every(name=>typeof mailer[name]==='function')) throw new Error('PROVIDER_MAILER_REQUIRED');
  const origin=trustedBase(baseUrl);
  const keyedHash=value=>crypto.createHmac('sha256',secret).update(value).digest('hex');
  let timer=null,busy=false,lastCleanup=0;

  function cookieOptions(req,maxAge) {
    return {httpOnly:true,secure:env.NODE_ENV==='production'||req.secure,sameSite:'lax',path:'/',maxAge};
  }
  function csrfFor(req,res) {
    let seed=req.cookies?.mental_provider_csrf;
    if(!/^[a-f0-9]{48}$/.test(seed||'')) {
      seed=crypto.randomBytes(24).toString('hex');
      res.cookie('mental_provider_csrf',seed,cookieOptions(req,CSRF_SECONDS*1000));
      if(!req.cookies)req.cookies={};req.cookies.mental_provider_csrf=seed;
    }
    const timestamp=String(Date.now());
    return timestamp+'.'+keyedHash('provider-csrf\0'+seed+'\0'+timestamp);
  }
  function protect(req) {
    const [stamp,sig,...rest]=String(req.get('X-Provider-CSRF')||'').split('.');
    const seed=req.cookies?.mental_provider_csrf;
    if(rest.length||!/^\d{13}$/.test(stamp||'')||!/^[a-f0-9]{64}$/.test(sig||'')||!/^[a-f0-9]{48}$/.test(seed||'')||
      Date.now()-Number(stamp)>CSRF_SECONDS*1000||Number(stamp)>Date.now()+10000||
      !safeEqual(sig,keyedHash('provider-csrf\0'+seed+'\0'+stamp)))throw failure('FORM_EXPIRED',403);
    let supplied;
    try{supplied=new URL(req.get('Origin'));}catch{throw failure('ORIGIN_REJECTED',403);}
    if(supplied.origin!==req.protocol+'://'+req.get('host')||req.get('Sec-Fetch-Site')==='cross-site')throw failure('ORIGIN_REJECTED',403);
  }
  async function getAccount(req) {
    const token=req.cookies?.mental_provider;
    if(!/^[a-f0-9]{64}$/.test(token||''))return null;
    const row=(await pool.query(`SELECT a.* FROM provider_account_sessions s JOIN provider_accounts a ON a.id=s.account_id
      WHERE s.session_hash=$1 AND s.expires_at>now() AND a.disabled_at IS NULL AND a.email_verified_at IS NOT NULL`,[hash(token)])).rows[0];
    return row?publicUser(row):null;
  }
  async function requireAccount(req,res,next) {
    res.set('Cache-Control','private, no-store');
    if(!dbState.ready)return res.status(503).json({error:'A fiókkezelés átmenetileg nem elérhető.',code:'ACCOUNT_UNAVAILABLE'});
    try {
      const user=await getAccount(req);
      if(!user){res.clearCookie('mental_provider',{path:'/'});return res.status(401).json({error:'Jelentkezz be a szolgáltatói fiókodba.',code:'LOGIN_REQUIRED'});}
      req.providerUser=user;next();
    }catch(error){next(error);}
  }
  async function sessionFor(client,accountId) {
    const token=crypto.randomBytes(32).toString('hex');
    await client.query("INSERT INTO provider_account_sessions(session_hash,account_id,expires_at) VALUES($1,$2,now()+interval '14 days')",[hash(token),accountId]);
    return token;
  }
  function setSession(req,res,token){res.cookie('mental_provider',token,cookieOptions(req,SESSION_DAYS*24*3600*1000));}
  async function transaction(fn) {
    const client=await pool.connect();
    try{await client.query('BEGIN');const result=await fn(client);await client.query('COMMIT');return result;}
    catch(error){await client.query('ROLLBACK').catch(()=>{});throw error;}
    finally{client.release();}
  }
  async function event(client,accountId,type,submissionId=null,details={},actor='system') {
    await client.query('INSERT INTO provider_account_events(account_id,submission_id,event_type,actor,details) VALUES($1,$2,$3,$4,$5)',[accountId,submissionId,type,actor,details]);
  }
  async function mailReady(client) {try{return !!await mailer.ready(client);}catch{return false;}}
  async function takeEmailBudget(client,purpose,email) {
    const key=keyedHash('provider-request\0'+purpose+'\0'+email);
    const result=await client.query(`INSERT INTO provider_account_limits(scope_key) VALUES($1)
      ON CONFLICT(scope_key) DO UPDATE SET
      request_count=CASE WHEN provider_account_limits.window_started_at<now()-interval '1 day' THEN 1 ELSE provider_account_limits.request_count+1 END,
      window_started_at=CASE WHEN provider_account_limits.window_started_at<now()-interval '1 day' THEN now() ELSE provider_account_limits.window_started_at END,
      last_requested_at=now()
      WHERE provider_account_limits.last_requested_at<now()-interval '5 minutes'
        AND (provider_account_limits.window_started_at<now()-interval '1 day' OR provider_account_limits.request_count<5)
      RETURNING scope_key`,[key]);
    return !!result.rowCount;
  }
  async function tokenFor(client,accountId,kind,submissionId=null) {
    const token=crypto.randomBytes(32).toString('base64url'),id=crypto.randomUUID();
    const seconds=kind==='reset'?RESET_SECONDS:SETUP_SECONDS;
    const expires=new Date(Date.now()+seconds*1000);
    await client.query('INSERT INTO provider_account_tokens(id,account_id,submission_id,kind,token_hash,expires_at) VALUES($1,$2,$3,$4,$5,$6)',[id,accountId,submissionId,kind,hash(token),expires]);
    return {id,token,expires};
  }
  function emailMessage(kind,account,token=null,submission=null) {
    const name=account.display_name||'Kedves jelentkező';
    const greeting='Kedves '+name+'!\n\n';
    if(kind==='approved')return {subject:'Elfogadtuk a jelentkezésedet – MENTÁL.hu',text:greeting+'Elfogadtuk a MENTÁL.hu szolgáltatói jelentkezésedet.\n\nA meglévő fiókodba belépve kitöltheted vagy frissítheted az adatlapodat, kiválaszthatod a megfelelő kategóriákat, majd közzéteheted:\n'+origin+'/fiokom\n\nÜdvözlettel:\nMENTÁL.hu'};
    if(kind==='password_changed')return {subject:'Megváltozott a jelszavad – MENTÁL.hu',text:greeting+'A szolgáltatói fiókod jelszava megváltozott. A korábbi bejelentkezéseket kijelentkeztettük.\n\nHa nem te kérted a változtatást, kérj új jelszót itt:\n'+origin+'/elfelejtett-jelszo\n\nMENTÁL.hu'};
    const link=origin+(kind==='reset'?'/jelszo-visszaallitas':'/regisztracio')+'#token='+token.token;
    if(kind==='reset')return {subject:'Jelszó-visszaállítás – MENTÁL.hu',text:greeting+'Az alábbi linken állíthatsz be új jelszót a szolgáltatói fiókodhoz:\n'+link+'\n\nA link egyszer használható, és 1 óráig érvényes. Ha nem te kérted, hagyd figyelmen kívül ezt a levelet; a jelszavad nem változik meg.\n\nMENTÁL.hu'};
    const acceptance=kind==='invite'?'Elfogadtuk a MENTÁL.hu szolgáltatói jelentkezésedet'+(submission?.name?' ('+submission.name+')':'')+'.':'A MENTÁL.hu szolgáltatói fiókjának létrehozásához erősítsd meg az e-mail-címedet.';
    return {subject:kind==='invite'?'Elfogadtuk a jelentkezésedet – hozd létre a fiókodat':'Szolgáltatói fiók létrehozása – MENTÁL.hu',text:greeting+acceptance+'\n\nAz alábbi linken választhatsz jelszót és létrehozhatod a saját fiókodat:\n'+link+'\n\nEzután kitöltheted az adatlapodat és kiválaszthatod a megfelelő kategóriákat.'+(kind==='setup'?' A nyilvános megjelenéshez a jelentkezés szerkesztőségi elfogadása is szükséges.':'')+'\n\nA link egyszer használható, és 7 napig érvényes. Ha nem te jelentkeztél, hagyd figyelmen kívül ezt a levelet.\n\nÜdvözlettel:\nMENTÁL.hu'};
  }
  async function enqueue(client,{account,kind,token=null,submission=null,configured=false,dedupeKey}) {
    const id=crypto.randomUUID(),message=emailMessage(kind,account,token,submission);
    const status=configured?'queued':'needs_mail';
    const expires=token?.expires||new Date(Date.now()+SETUP_SECONDS*1000);
    await client.query(`INSERT INTO provider_account_mail(id,dedupe_key,account_id,submission_id,token_id,kind,payload_ciphertext,delivery_status,expires_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,[id,dedupeKey,account.id,submission?.id||null,token?.id||null,kind,mailer.seal({to:account.email,...message}),status,expires]);
    await event(client,account.id,'mail_queued',submission?.id||null,{mail_id:id,kind,delivery_status:status});
    return {account_id:account.id,mail_id:id,mail_status:status};
  }
  async function invalidateTokens(client,accountId,kind,submissionId) {
    const params=[accountId,kind],scope=submissionId===undefined?'':' AND submission_id=$3';if(submissionId!==undefined)params.push(submissionId);
    const result=await client.query(`UPDATE provider_account_tokens SET cancelled_at=now() WHERE account_id=$1 AND kind=$2${scope} AND consumed_at IS NULL AND cancelled_at IS NULL RETURNING id`,params);
    if(result.rows.length)await client.query("UPDATE provider_account_mail SET delivery_status='cancelled',payload_ciphertext=NULL,error_code='TOKEN_REPLACED',updated_at=now() WHERE token_id=ANY($1::uuid[]) AND delivery_status IN ('needs_mail','queued','failed','uncertain')",[result.rows.map(row=>row.id)]);
  }

  async function approveSubmission(client,submission,{resend=false}={}) {
    const email=emailOf(submission.email);
    if(!validEmail(email))throw failure('INVALID_EMAIL');
    const configured=await mailReady(client);
    await client.query('INSERT INTO provider_accounts(email,display_name) VALUES($1,$2) ON CONFLICT(email) DO NOTHING',[email,input(submission.contact_name||submission.name,200)]);
    const account=(await client.query('SELECT * FROM provider_accounts WHERE email=$1 FOR UPDATE',[email])).rows[0];
    if(account.disabled_at)throw failure('ACCOUNT_DISABLED',409);
    const previous=(await client.query("SELECT id,delivery_status,created_at FROM provider_account_mail WHERE submission_id=$1 AND kind IN ('invite','approved') ORDER BY created_at DESC,id DESC LIMIT 1",[submission.id])).rows[0];
    if(previous&&!resend&&submission.status==='accepted')return {account_id:account.id,mail_id:previous.id,mail_status:previous.delivery_status};
    if(previous&&resend&&['queued','sending'].includes(previous.delivery_status))throw failure('MAIL_ALREADY_QUEUED',409);
    if(previous&&resend&&previous.delivery_status==='accepted'&&Date.now()-new Date(previous.created_at).getTime()<60000)throw failure('RESEND_TOO_SOON',429);
    await client.query('UPDATE provider_accounts SET approved_at=COALESCE(approved_at,now()),updated_at=now() WHERE id=$1',[account.id]);
    let token=null,kind='approved';
    if(!account.email_verified_at){kind='invite';await invalidateTokens(client,account.id,'invite',submission.id);token=await tokenFor(client,account.id,'invite',submission.id);}
    const result=await enqueue(client,{account,kind,token,submission,configured,dedupeKey:'submission:'+submission.id+':'+(resend||previous?crypto.randomUUID():'approval')});
    await event(client,account.id,resend?'invitation_resent':'application_accepted',submission.id,{mail_id:result.mail_id},'admin');
    return result;
  }
  async function cancelSubmissionInvitation(client,submissionId) {
    const accounts=(await client.query(`SELECT a.id FROM provider_accounts a WHERE a.id IN
      (SELECT provider_account_id FROM directory_submissions WHERE id=$1 UNION SELECT account_id FROM provider_account_tokens WHERE submission_id=$1)
      ORDER BY a.id FOR UPDATE`,[submissionId])).rows;
    for(const account of accounts) {
      await invalidateTokens(client,account.id,'invite',submissionId);
      await client.query(`UPDATE provider_accounts SET approved_at=NULL,updated_at=now() WHERE id=$1 AND email_verified_at IS NULL
        AND NOT EXISTS(SELECT 1 FROM directory_submissions WHERE provider_account_id=$1 AND id<>$2 AND status='accepted' AND deleted_at IS NULL)`,[account.id,submissionId]);
      await event(client,account.id,'invitation_cancelled',submissionId,{},'admin');
    }
    await client.query("UPDATE provider_account_mail SET delivery_status='cancelled',payload_ciphertext=NULL,error_code='APPLICATION_REMOVED',updated_at=now() WHERE submission_id=$1 AND delivery_status IN ('needs_mail','queued','failed','uncertain')",[submissionId]);
  }

  async function lookupToken(client,raw,{lock=false}={}) {
    if(!validToken(raw))throw failure('TOKEN_INVALID',410);
    const token=(await client.query('SELECT * FROM provider_account_tokens WHERE token_hash=$1',[hash(raw)])).rows[0];
    if(!token)throw failure('TOKEN_INVALID',410);
    // All state-changing paths lock the account before its token to avoid deadlocks with trash/reset.
    const account=(await client.query('SELECT * FROM provider_accounts WHERE id=$1'+(lock?' FOR UPDATE':''),[token.account_id])).rows[0];
    const current=lock?(await client.query('SELECT * FROM provider_account_tokens WHERE id=$1 FOR UPDATE',[token.id])).rows[0]:token;
    if(!account||account.disabled_at||!current||current.consumed_at||current.cancelled_at||new Date(current.expires_at)<=new Date()||
      (current.kind!=='reset'&&account.email_verified_at)||(current.kind==='reset'&&!account.email_verified_at))throw failure('TOKEN_INVALID',410);
    return {token:current,account};
  }

  function errors(error) {
    return {
      INVALID_EMAIL:'Adj meg érvényes e-mail-címet.',INVALID_NAME:'Add meg a nevedet vagy a szolgáltató nevét.',
      CONSENT_REQUIRED:'A fiók létrehozásához fogadd el az adatkezelési tájékoztatót.',
      INVALID_PASSWORD:'Legalább 10 karakteres jelszót adj meg, legfeljebb 72 UTF-8 bájt hosszal.',
      INVALID_LOGIN:'Hibás e-mail-cím vagy jelszó.',FORM_EXPIRED:'Az űrlap lejárt. Töltsd újra az oldalt.',
      ORIGIN_REJECTED:'A kérés forrása nem ellenőrizhető. Töltsd újra az oldalt.',
      TOKEN_INVALID:'Ez a link már nem használható vagy lejárt. Kérj új levelet.',
      ACCOUNT_DISABLED:'Ez a fiók jelenleg nem használható.',CURRENT_PASSWORD_INVALID:'A jelenlegi jelszó nem megfelelő.',
      MAIL_ALREADY_QUEUED:'A meghívó küldése már folyamatban van.',RESEND_TOO_SOON:'Várj egy percet az újraküldéssel.'
    }[error.code]||'A fiókkezelés most nem elérhető. Próbáld újra később.';
  }
  function wrap(fn,{write=false}={}) {
    return async(req,res,next)=>{
      res.set('Cache-Control','private, no-store');res.set('X-Robots-Tag','noindex, nofollow');
      if(!dbState.ready)return res.status(503).json({error:'A fiókkezelés átmenetileg nem elérhető.',code:'ACCOUNT_UNAVAILABLE'});
      try{if(write)protect(req);await fn(req,res,next);}catch(error){
        const status=error.httpStatus||503;
        if(!error.httpStatus)console.error('[provider-account]',/^[A-Z0-9_]{2,50}$/.test(error.code||'')?error.code:'ACCOUNT_ERROR');
        res.status(status).json({ok:false,code:error.httpStatus?error.code:'ACCOUNT_UNAVAILABLE',error:errors(error)});
      }
    };
  }
  function wake(){setImmediate(()=>{void runWorker();});}
  function queuedReply(res,configured,reset=false) {
    const message=reset?'Ha ehhez az e-mail-címhez aktív fiók tartozik, elküldjük a jelszó-visszaállító linket.':'Ha a megadott e-mail-címmel létrehozható fiók, elküldjük a fiók beállításához szükséges linket.';
    res.status(202).json({ok:true,mail_ready:configured,message:message+(configured?' Nézd meg a beérkező leveleket és a levélszemét mappát is.':' A levélküldés beállítása még folyamatban van; a rögzített kérések leveleit ezután indítjuk el.')});
  }

  function register(app) {
    const limiter=rateLimit({windowMs:15*60*1000,limit:40,standardHeaders:true,legacyHeaders:false,handler:(_req,res)=>res.status(429).json({error:'Túl sok próbálkozás. Kérjük, próbáld később.',code:'RATE_LIMITED'})});
    const mailLimiter=rateLimit({windowMs:60*60*1000,limit:20,standardHeaders:true,legacyHeaders:false,handler:(_req,res)=>res.status(429).json({error:'Túl sok levélkérés. Kérjük, próbáld később.',code:'RATE_LIMITED'})});
    app.get('/api/provider/session',wrap(async(req,res)=>{
      const [user,configured]=await Promise.all([getAccount(req),mailReady()]);
      res.json({authenticated:!!user,...(user?{user}:{}),csrf_token:csrfFor(req,res),mail_ready:configured});
    }));
    app.post('/api/provider/register',mailLimiter,wrap(async(req,res)=>{
      const configured=await mailReady();
      if(input(req.body.honey||req.body.website,400)){queuedReply(res,configured);return;}
      const email=emailOf(req.body.email),name=input(req.body.display_name,201);
      if(!validEmail(email))throw failure('INVALID_EMAIL');
      if(name.length<2||name.length>200||/[\r\n\0<>]/.test(name))throw failure('INVALID_NAME');
      if(req.body.consent!==true)throw failure('CONSENT_REQUIRED');
      await transaction(async client=>{
        if(!await takeEmailBudget(client,'setup',email))return;
        await client.query('INSERT INTO provider_accounts(email,display_name,consent_at,consent_version) VALUES($1,$2,now(),$3) ON CONFLICT(email) DO NOTHING',[email,name,CONSENT_VERSION]);
        const account=(await client.query('SELECT * FROM provider_accounts WHERE email=$1 FOR UPDATE',[email])).rows[0];
        if(account.email_verified_at||account.disabled_at)return;
        // Repeated public signup must not replace an admin's trusted prefilled name.
        await invalidateTokens(client,account.id,'setup');
        const token=await tokenFor(client,account.id,'setup');
        await enqueue(client,{account,kind:'setup',token,configured,dedupeKey:'setup:'+token.id});
        await event(client,account.id,'registration_requested');
      });
      queuedReply(res,configured);wake();
    },{write:true}));
    app.post('/api/provider/login',limiter,wrap(async(req,res)=>{
      const email=emailOf(req.body.email),password=typeof req.body.password==='string'?req.body.password:'';
      const key=keyedHash('provider-login\0'+email);
      const account=validEmail(email)?(await pool.query('SELECT * FROM provider_accounts WHERE email=$1',[email])).rows[0]:null;
      const attempt=(await pool.query('SELECT locked_until FROM provider_login_attempts WHERE email_hash=$1',[key])).rows[0];
      const locked=attempt?.locked_until&&new Date(attempt.locked_until)>new Date();
      const accepted=await bcrypt.compare(Buffer.byteLength(password)<=72?password:'invalid-overlong-password',!locked&&account?.password_hash?account.password_hash:dummyPasswordHash);
      if(!accepted||locked||!account?.email_verified_at||account.disabled_at||!validPassword(password)) {
        await pool.query(`INSERT INTO provider_login_attempts(email_hash,failures) VALUES($1,1)
          ON CONFLICT(email_hash) DO UPDATE SET
          failures=CASE WHEN provider_login_attempts.window_started_at<now()-interval '15 minutes' THEN 1 ELSE provider_login_attempts.failures+1 END,
          locked_until=CASE WHEN provider_login_attempts.window_started_at>=now()-interval '15 minutes' AND provider_login_attempts.failures>=9 THEN now()+interval '15 minutes' ELSE NULL END,
          window_started_at=CASE WHEN provider_login_attempts.window_started_at<now()-interval '15 minutes' THEN now() ELSE provider_login_attempts.window_started_at END`,[key]);
        throw failure('INVALID_LOGIN',401);
      }
      const token=await transaction(async client=>{
        const current=(await client.query('SELECT * FROM provider_accounts WHERE id=$1 FOR UPDATE',[account.id])).rows[0];
        if(!current||current.disabled_at||current.password_hash!==account.password_hash)throw failure('INVALID_LOGIN',401);
        await client.query('DELETE FROM provider_login_attempts WHERE email_hash=$1',[key]);
        return sessionFor(client,current.id);
      });
      setSession(req,res,token);res.json({ok:true,user:publicUser(account),csrf_token:csrfFor(req,res)});
    },{write:true}));
    app.post('/api/provider/logout',wrap(async(req,res)=>{
      const token=req.cookies?.mental_provider;
      if(/^[a-f0-9]{64}$/.test(token||''))await pool.query('DELETE FROM provider_account_sessions WHERE session_hash=$1',[hash(token)]);
      res.clearCookie('mental_provider',{path:'/'});res.json({ok:true});
    },{write:true}));
    app.post('/api/provider/forgot-password',mailLimiter,wrap(async(req,res)=>{
      const configured=await mailReady(),email=emailOf(req.body.email);
      if(validEmail(email)&&!input(req.body.honey||req.body.website,400))await transaction(async client=>{
        if(!await takeEmailBudget(client,'reset',email))return;
        const account=(await client.query('SELECT * FROM provider_accounts WHERE email=$1 FOR UPDATE',[email])).rows[0];
        if(!account?.email_verified_at||account.disabled_at)return;
        await invalidateTokens(client,account.id,'reset');
        const token=await tokenFor(client,account.id,'reset');
        await enqueue(client,{account,kind:'reset',token,configured,dedupeKey:'reset:'+token.id});
        await event(client,account.id,'password_reset_requested');
      });
      queuedReply(res,configured,true);wake();
    },{write:true}));
    app.post('/api/provider/token-info',limiter,wrap(async(req,res)=>{
      const {token,account}=await lookupToken(pool,req.body.token);
      res.json({kind:token.kind,email:account.email,display_name:account.display_name,expires_at:token.expires_at});
    },{write:true}));
    app.post('/api/provider/activate',limiter,wrap(async(req,res)=>{
      if(req.body.consent!==true)throw failure('CONSENT_REQUIRED');
      if(!validPassword(req.body.password))throw failure('INVALID_PASSWORD');
      const passwordHash=await bcrypt.hash(req.body.password,12);
      const result=await transaction(async client=>{
        const {token,account}=await lookupToken(client,req.body.token,{lock:true});
        if(!['setup','invite'].includes(token.kind))throw failure('TOKEN_INVALID',410);
        const name=input(req.body.display_name,201)||account.display_name;
        if(name.length<2||name.length>200||/[\r\n\0<>]/.test(name))throw failure('INVALID_NAME');
        const updated=(await client.query(`UPDATE provider_accounts SET password_hash=$2,display_name=$3,email_verified_at=now(),
          consent_at=CASE WHEN $5 THEN COALESCE(consent_at,now()) ELSE consent_at END,
          consent_version=CASE WHEN $5 THEN $4 ELSE consent_version END,updated_at=now() WHERE id=$1 RETURNING *`,[account.id,passwordHash,name,CONSENT_VERSION,req.body.consent===true])).rows[0];
        await client.query('UPDATE provider_account_tokens SET consumed_at=now() WHERE id=$1',[token.id]);
        await invalidateTokens(client,account.id,'setup');await invalidateTokens(client,account.id,'invite');
        await client.query('DELETE FROM provider_account_sessions WHERE account_id=$1',[account.id]);
        await event(client,account.id,'account_activated',token.submission_id);
        return {user:publicUser(updated),session:await sessionFor(client,account.id)};
      });
      setSession(req,res,result.session);res.json({ok:true,user:result.user,csrf_token:csrfFor(req,res)});
    },{write:true}));
    app.post('/api/provider/reset-password',limiter,wrap(async(req,res)=>{
      if(!validPassword(req.body.password))throw failure('INVALID_PASSWORD');
      const passwordHash=await bcrypt.hash(req.body.password,12),configured=await mailReady();
      await transaction(async client=>{
        const {token,account}=await lookupToken(client,req.body.token,{lock:true});
        if(token.kind!=='reset')throw failure('TOKEN_INVALID',410);
        await client.query('UPDATE provider_accounts SET password_hash=$2,updated_at=now() WHERE id=$1',[account.id,passwordHash]);
        await client.query('UPDATE provider_account_tokens SET consumed_at=now() WHERE id=$1',[token.id]);
        await invalidateTokens(client,account.id,'reset');
        await client.query('DELETE FROM provider_account_sessions WHERE account_id=$1',[account.id]);
        await enqueue(client,{account,kind:'password_changed',configured,dedupeKey:'password-changed:'+token.id});
        await event(client,account.id,'password_reset');
      });
      res.clearCookie('mental_provider',{path:'/'});res.json({ok:true,message:'Az új jelszót elmentettük. Jelentkezz be az új jelszóval.'});wake();
    },{write:true}));
    app.post('/api/provider/change-password',limiter,requireAccount,wrap(async(req,res)=>{
      if(!validPassword(req.body.password))throw failure('INVALID_PASSWORD');
      const account=(await pool.query('SELECT * FROM provider_accounts WHERE id=$1',[req.providerUser.id])).rows[0];
      const current=typeof req.body.current_password==='string'?req.body.current_password:'';
      if(Buffer.byteLength(current)>72||!await bcrypt.compare(current,account?.password_hash||dummyPasswordHash))throw failure('CURRENT_PASSWORD_INVALID',403);
      const nextHash=await bcrypt.hash(req.body.password,12),configured=await mailReady();
      await transaction(async client=>{
        const locked=(await client.query('SELECT * FROM provider_accounts WHERE id=$1 FOR UPDATE',[account.id])).rows[0];
        if(!locked||locked.disabled_at||locked.password_hash!==account.password_hash)throw failure('CURRENT_PASSWORD_INVALID',403);
        await client.query('UPDATE provider_accounts SET password_hash=$2,updated_at=now() WHERE id=$1',[account.id,nextHash]);
        await client.query('DELETE FROM provider_account_sessions WHERE account_id=$1',[account.id]);
        await invalidateTokens(client,account.id,'reset');
        await enqueue(client,{account,kind:'password_changed',configured,dedupeKey:'password-changed:'+crypto.randomUUID()});
        await event(client,account.id,'password_changed');
      });
      res.clearCookie('mental_provider',{path:'/'});res.json({ok:true,message:'A jelszavad megváltozott. Jelentkezz be az új jelszóval.'});wake();
    },{write:true}));
  }

  async function runWorker() {
    if(busy||!dbState.ready)return;busy=true;
    try {
      if(Date.now()-lastCleanup>3600000) {
        await pool.query('DELETE FROM provider_account_sessions WHERE expires_at<=now()');
        await pool.query("UPDATE provider_account_mail SET delivery_status='uncertain',error_code='WORKER_INTERRUPTED',updated_at=now() WHERE delivery_status='sending' AND sending_since<now()-interval '5 minutes'");
        await pool.query("UPDATE provider_account_mail SET delivery_status='cancelled',payload_ciphertext=NULL,error_code='LINK_EXPIRED',updated_at=now() WHERE expires_at<=now() AND delivery_status IN ('needs_mail','queued','failed','uncertain')");
        await pool.query("UPDATE provider_account_mail SET payload_ciphertext=NULL WHERE created_at<now()-interval '30 days' AND payload_ciphertext IS NOT NULL");
        await pool.query("DELETE FROM provider_account_limits WHERE last_requested_at<now()-interval '2 days'");
        await pool.query("DELETE FROM provider_login_attempts WHERE window_started_at<now()-interval '2 days'");
        lastCleanup=Date.now();
      }
      if(!await mailReady()) {
        await pool.query("UPDATE provider_account_mail SET delivery_status='needs_mail',updated_at=now() WHERE delivery_status='queued'");return;
      }
      const row=await transaction(async client=>{
        const row=(await client.query("SELECT * FROM provider_account_mail WHERE delivery_status IN ('queued','needs_mail') AND next_attempt_at<=now() AND expires_at>now() AND attempts<3 ORDER BY created_at,id FOR UPDATE SKIP LOCKED LIMIT 1")).rows[0];
        if(!row)return null;
        await client.query("UPDATE provider_account_mail SET delivery_status='sending',sending_since=now(),attempts=attempts+1,updated_at=now() WHERE id=$1",[row.id]);return row;
      });
      if(!row)return;
      let status='accepted',code=null,messageId=null;
      try {
        const live=(await pool.query(`SELECT m.delivery_status,a.disabled_at,t.cancelled_at,t.consumed_at,t.expires_at AS token_expires
          FROM provider_account_mail m JOIN provider_accounts a ON a.id=m.account_id LEFT JOIN provider_account_tokens t ON t.id=m.token_id WHERE m.id=$1`,[row.id])).rows[0];
        if(!live||live.delivery_status!=='sending'||live.disabled_at||(row.token_id&&(live.cancelled_at||live.consumed_at||!live.token_expires||new Date(live.token_expires)<=new Date())))throw failure('MAIL_CANCELLED');
        const payload=mailer.unseal(row.payload_ciphertext);
        if(!payload||!validEmail(payload.to))throw failure('MAIL_PAYLOAD_INVALID');
        const sent=await mailer.send({id:row.id,...payload});
        if(typeof sent?.id!=='string'||!sent.id.trim())throw failure('MAIL_RESULT_UNCERTAIN');
        messageId=sent.id.slice(0,250);
      }catch(error) {
        code=/^[A-Z0-9_]{2,60}$/.test(error.code||'')?error.code:'MAIL_RESULT_UNCERTAIN';
        status=code==='MAIL_CANCELLED'?'cancelled':code==='MAIL_NOT_CONFIGURED'?'needs_mail':/UNCERTAIN|ETIMEDOUT|ESOCKET|ECONNRESET|ECONNECTION|EPIPE/.test(code)?'uncertain':'failed';
      }
      await pool.query(`UPDATE provider_account_mail SET delivery_status=$2,error_code=$3,provider_message_id=$4,
        accepted_at=CASE WHEN $2='accepted' THEN now() ELSE accepted_at END,
        payload_ciphertext=CASE WHEN $2 IN ('accepted','cancelled') THEN NULL ELSE payload_ciphertext END,updated_at=now()
        WHERE id=$1 AND delivery_status='sending'`,[row.id,status,code,messageId]);
      await event(pool,row.account_id,'mail_'+status,row.submission_id,{mail_id:row.id,kind:row.kind,...(code?{code}:{})});
    }catch(error){console.error('[provider-mail]',/^[A-Z0-9_]{2,50}$/.test(error.code||'')?error.code:'WORKER_ERROR');}
    finally{busy=false;}
  }
  function start(){if(!timer){timer=setInterval(()=>{void runWorker();},10000);timer.unref();wake();}}
  function stop(){if(timer)clearInterval(timer);timer=null;}
  return {register,start,stop,requireAccount,protect,csrfFor,getAccount,approveSubmission,cancelSubmissionInvitation,runWorker};
}

module.exports={createProviderAccountService,validEmail,emailOf,validPassword,validToken,trustedBase,publicUser,hash,SESSION_DAYS,CONSENT_VERSION};
