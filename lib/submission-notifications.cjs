'use strict';

const crypto=require('node:crypto');
const rateLimit=require('express-rate-limit');
const {validEmail}=require('./mail-transport.cjs');
const {trustedBase}=require('./provider-accounts.cjs');
const RECIPIENT='den@proptechdigital.com';
const failure=(code,httpStatus=502)=>Object.assign(new Error(code),{code,httpStatus});
const clean=(value,max=5000)=>String(value??'').replace(/\r\n?/g,'\n').replace(/[\0\u0001-\u0008\u000b\u000c\u000e-\u001f]/g,'').trim().slice(0,max);

function notificationMessage(row,origin='https://mental.hu') {
  origin=trustedBase(origin);
  if(!/^[1-9]\d{0,18}$/.test(String(row.id)))throw failure('INVALID_SUBMISSION_ID',400);
  const when=new Date(row.notification_created_at||row.created_at);
  const date=Number.isNaN(when.valueOf())?'':new Intl.DateTimeFormat('hu-HU',{timeZone:'Europe/Budapest',dateStyle:'long',timeStyle:'short'}).format(when);
  const categories=Array.isArray(row.category_names)&&row.category_names.length?row.category_names.join(', '):row.category_slugs;
  const text=[
    row.event_type==='resubmitted'?'Egy szolgáltató javította és újra beküldte a katalógusjelentkezését.':'Új szolgáltatói jelentkezés érkezett a MENTÁL.hu katalógusába.',
    '',
    'Szolgáltató / szakember: '+clean(row.name,200),
    'Kapcsolattartó: '+(clean(row.contact_name,200)||'nem adta meg'),
    'E-mail: '+clean(row.email,254),
    'Telefon: '+(clean(row.phone,60)||'nem adta meg'),
    'Kategóriák: '+(clean(categories,1000)||'nem adta meg'),
    'Település: '+(clean(row.city,120)||'nem adta meg'),
    'Online elérhető: '+(row.online_available?'igen':'nem'),
    'Weboldal: '+(clean(row.website_url,500)||'nem adta meg'),
    ...(date?['Beküldés időpontja: '+date]:[]),
    '', 'Bemutatkozás:',clean(row.description,5000)||'nem adta meg',
    '', 'Képesítések:',clean(row.qualifications,3000)||'nem adta meg',
    '', 'Jelentkezés megnyitása az adminban:',origin+'/admin/?submission='+encodeURIComponent(String(row.id)),
    '', 'Az elfogadásról az adminban dönthetsz. A levélre válaszolva közvetlenül a jelentkezőnek írhatsz.'
  ].join('\n');
  return {to:RECIPIENT,...(validEmail(row.email)?{replyTo:row.email}:{}),
    subject:row.event_type==='resubmitted'?'Újra beküldött katalógusjelentkezés – MENTÁL.hu':'Új katalógusjelentkezés – MENTÁL.hu',text,scope:'mental-submission'};
}

function createSubmissionNotificationService({pool,dbState,auth,accounts,mailer,baseUrl='https://mental.hu',audit=()=>{}}) {
  if(!mailer||typeof mailer.ready!=='function'||typeof mailer.send!=='function')throw new Error('SUBMISSION_MAILER_REQUIRED');
  const origin=trustedBase(baseUrl);
  let busy=false,timer=null;
  const ready=async()=>{try{return !!await mailer.ready();}catch{return false;}};
  function log(action,id,actor,details) {try{Promise.resolve(audit(action,'directory_submission',id,actor,details)).catch(()=>{});}catch{}}
  async function runWorker() {
    if(busy||!dbState.ready)return;busy=true;
    try {
      await pool.query("UPDATE directory_submission_notifications SET delivery_status='uncertain',error_code='WORKER_INTERRUPTED',updated_at=now() WHERE delivery_status='sending' AND sending_since<now()-interval '5 minutes'");
      await pool.query(`UPDATE directory_submission_notifications n SET delivery_status='cancelled',error_code='APPLICATION_REMOVED',updated_at=now()
        FROM directory_submissions s WHERE s.id=n.submission_id AND (s.deleted_at IS NOT NULL OR s.consent IS NOT TRUE)
        AND n.delivery_status IN ('queued','needs_mail','failed')`);
      if(!await ready()){
        await pool.query("UPDATE directory_submission_notifications SET delivery_status='needs_mail',updated_at=now() WHERE delivery_status='queued'");return;
      }
      const client=await pool.connect();let row;
      try {
        await client.query('BEGIN');
        row=(await client.query(`SELECT * FROM directory_submission_notifications WHERE delivery_status IN ('queued','needs_mail')
          AND next_attempt_at<=now() AND attempts<3 ORDER BY created_at,id FOR UPDATE SKIP LOCKED LIMIT 1`)).rows[0];
        if(row)await client.query("UPDATE directory_submission_notifications SET delivery_status='sending',sending_since=now(),attempts=attempts+1,updated_at=now() WHERE id=$1",[row.id]);
        await client.query('COMMIT');
      }catch(error){await client.query('ROLLBACK').catch(()=>{});throw error;}finally{client.release();}
      if(!row)return;
      let status='accepted',code=null,messageId=null;
      try {
        const live=(await pool.query(`SELECT s.*,n.delivery_status,n.event_type,n.created_at AS notification_created_at,
          ARRAY(SELECT c.name FROM directory_categories c WHERE c.slug=ANY(string_to_array(s.category_slugs,',')) ORDER BY c.name) AS category_names
          FROM directory_submission_notifications n JOIN directory_submissions s ON s.id=n.submission_id WHERE n.id=$1`,[row.id])).rows[0];
        if(!live||live.delivery_status!=='sending'||live.deleted_at||!live.consent)throw failure('APPLICATION_REMOVED');
        if(row.recipient!==RECIPIENT)throw failure('INVALID_RECIPIENT');
        const sent=await mailer.send({id:row.id,...notificationMessage(live,origin)});
        if(typeof sent?.id!=='string'||!sent.id.trim())throw failure('MAIL_RESULT_UNCERTAIN');
        messageId=sent.id.slice(0,250);
      }catch(error){
        code=/^[A-Z0-9_]{2,60}$/.test(error.code||'')?error.code:'MAIL_RESULT_UNCERTAIN';
        status=code==='APPLICATION_REMOVED'?'cancelled':code==='MAIL_NOT_CONFIGURED'?'needs_mail':
          code==='MAIL_HTTP_429'&&row.attempts<2?'queued':/UNCERTAIN|ETIMEDOUT|ESOCKET|ECONNRESET|ECONNECTION|EPIPE|MAIL_HTTP_(408|5\d\d)/.test(code)?'uncertain':'failed';
      }
      await pool.query(`UPDATE directory_submission_notifications SET delivery_status=$2,error_code=$3,provider_message_id=$4,
        accepted_at=CASE WHEN $2='accepted' THEN now() ELSE accepted_at END,
        attempts=CASE WHEN $2='needs_mail' THEN GREATEST(attempts-1,0) ELSE attempts END,
        next_attempt_at=CASE WHEN $2='queued' THEN now()+interval '2 minutes' ELSE next_attempt_at END,updated_at=now()
        WHERE id=$1 AND delivery_status='sending'`,[row.id,status,code,messageId]);
      log('admin_notification_'+status,row.submission_id,'system',{notification_id:row.id,recipient:RECIPIENT,...(code?{code}:{})});
    }catch(error){console.error('[submission-notification]',/^[A-Z0-9_]{2,60}$/.test(error.code||'')?error.code:'WORKER_ERROR');}
    finally{busy=false;}
  }
  function register(app) {
    const headers=(_req,res,next)=>{res.set({'Cache-Control':'private, no-store','X-Robots-Tag':'noindex, nofollow'});next();};
    const wrap=handler=>async(req,res)=>{
      if(!dbState.ready)return res.status(503).json({error:'A jelentkezések most nem érhetők el.',code:'DATABASE_UNAVAILABLE'});
      try{await handler(req,res);}catch(error){
        const code=/^[A-Z0-9_]{2,60}$/.test(error.code||'')?error.code:'MAIL_RESULT_UNCERTAIN';
        const status=Number.isInteger(error.httpStatus)&&error.httpStatus>=400&&error.httpStatus<=599?error.httpStatus:502;
        res.status(status).json({error:code==='MAIL_NOT_CONFIGURED'?'A levélküldés még nincs beállítva.':status===403?'Az űrlap lejárt. Frissítsd az oldalt.':/UNCERTAIN|MAIL_HTTP_5/.test(code)?'A tesztküldés eredménye bizonytalan. Újraküldés előtt ellenőrizd a levélküldő naplóját.':'A tesztértesítést nem sikerült elküldeni. Ellenőrizd a levélküldés beállításait.',code});
      }
    };
    app.get('/api/admin/directory/submission-notifications',headers,auth,wrap(async(_req,res)=>res.json({recipient:RECIPIENT,mail_ready:await ready()})));
    const limiter=rateLimit({windowMs:60*60*1000,limit:3,standardHeaders:true,legacyHeaders:false,handler:(_req,res)=>res.status(429).json({error:'Legfeljebb három tesztértesítés küldhető óránként.',code:'TEST_RATE_LIMITED'})});
    app.post('/api/admin/directory/submission-notifications/test',headers,auth,limiter,wrap(async(req,res)=>{
      await accounts.protect(req);
      if(!await ready())throw failure('MAIL_NOT_CONFIGURED',409);
      const id=crypto.randomUUID();
      const sent=await mailer.send({id,to:RECIPIENT,subject:'Teszt – katalógusjelentkezések értesítése – MENTÁL.hu',scope:'mental-submission-test',
        text:'Ez a MENTÁL.hu katalógusjelentkezésekről küldött adminértesítés tesztje.\n\nAz új jelentkezésekről erre a címre küldünk értesítést: '+RECIPIENT+'.\nA levél tartalmazza a jelentkező adatait, kategóriáit, bemutatkozását és az adott jelentkezés adminhivatkozását.\n\nBeküldések az adminban:\n'+origin+'/admin/?view=submissions\n\nEz tesztlevél; nem jött létre új jelentkezés.'});
      if(typeof sent?.id!=='string'||!sent.id.trim())throw failure('MAIL_RESULT_UNCERTAIN');
      log('admin_notification_test',null,req.user?.email,{recipient:RECIPIENT,provider_message_id:sent.id.slice(0,250)});
      res.json({ok:true,recipient:RECIPIENT,provider_message_id:sent.id.slice(0,250),message:'A tesztértesítést a levélküldő átvette a '+RECIPIENT+' címre.'});
    }));
  }
  function start(){if(!timer){timer=setInterval(()=>{void runWorker();},10000);timer.unref();void runWorker();}}
  function stop(){if(timer)clearInterval(timer);timer=null;}
  return {register,start,stop,runWorker};
}

module.exports={RECIPIENT,notificationMessage,createSubmissionNotificationService};
