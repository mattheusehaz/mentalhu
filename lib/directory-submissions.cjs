'use strict';

const STATUSES = new Set(['new','reviewed','accepted','rejected']);
const failure = (code, httpStatus=400) => Object.assign(new Error(code), {code,httpStatus});
const messages = {
  INVALID_ID:'Érvénytelen jelentkezésazonosító.',
  INVALID_STATUS:'Érvénytelen jelentkezési státusz.',
  NOT_FOUND:'A jelentkezés nem található.',
  IN_TRASH:'A jelentkezés a kukában van. A módosítás előtt állítsd vissza.',
  NOT_ACCEPTED:'Meghívó csak elfogadott jelentkezéshez küldhető.',
  ACCOUNT_DISABLED:'A szolgáltatói fiók fel van függesztve. Előbb engedélyezd újra a Felhasználói fiókok menüpontban.',
  MAIL_ALREADY_QUEUED:'Az értesítés küldése már folyamatban van. Az állapot rövidesen frissül.',
  RESEND_TOO_SOON:'Az előző értesítést most vette át a levélküldő. Várj egy percet az újraküldéssel.',
  DATABASE_UNAVAILABLE:'A jelentkezések most nem érhetők el. Próbáld újra később.'
};

function submissionId(value) {
  if (typeof value !== 'string' || !/^[1-9]\d{0,18}$/.test(value) || BigInt(value)>9223372036854775807n) throw failure('INVALID_ID');
  return value;
}
function listFilters(query={}) {
  const status=typeof query.status==='string'?query.status.trim():'';
  if (status && !STATUSES.has(status)) throw failure('INVALID_STATUS');
  const integer=(value,fallback,max)=>/^\d+$/.test(String(value??''))&&Number.isSafeInteger(Number(value))&&Number(value)>0?Math.min(Number(value),max):fallback;
  return {
    trash:query.trash==='true',
    paginated:query.paginated==='true',
    q:typeof query.q==='string'?query.q.trim().slice(0,200):'',
    submissionId:query.submission_id===undefined?'':submissionId(query.submission_id),
    status,page:integer(query.page,1,1000000),pageSize:integer(query.page_size,25,100)
  };
}
function listWhere(filters) {
  const params=[],terms=[filters.trash?'s.deleted_at IS NOT NULL':'s.deleted_at IS NULL'];
  if (filters.submissionId) { params.push(filters.submissionId); terms.push('s.id=$'+params.length); }
  if (filters.status) { params.push(filters.status); terms.push('s.status=$'+params.length); }
  if (filters.q) {
    params.push('%'+filters.q.replace(/[\\%_]/g,'\\$&')+'%');
    const p='$'+params.length;
    terms.push(`(s.name ILIKE ${p} OR s.contact_name ILIKE ${p} OR s.email ILIKE ${p} OR s.city ILIKE ${p})`);
  }
  return {clause:terms.join(' AND '),params};
}
function approvalMessage(status, resend=false) {
  const prefix=resend?'Az új értesítést rögzítettük.':'A jelentkezést elfogadtuk.';
  if (status==='needs_mail') return prefix+' A meghívó a levélküldés beállítására vár; még nem küldtünk e-mailt.';
  if (status==='accepted') return prefix+' Az értesítést a levélküldő átvette.';
  if (status==='uncertain') return prefix+' A levélküldés eredménye bizonytalan; az állapotot ellenőrizni kell.';
  if (status==='failed') return prefix+' A levélküldés sikertelen. Az értesítés külön újraküldhető.';
  if (status==='cancelled') return prefix+' A korábbi meghívó visszavonva; szükség esetén küldj új meghívót.';
  return prefix+' Az értesítő e-mail küldésre vár.';
}

function createSubmissionService({pool,dbState,auth,audit=()=>{},accounts}) {
  if (!accounts || !['approveSubmission','cancelSubmissionInvitation','protect','csrfFor'].every(name=>typeof accounts[name]==='function')) throw new Error('Provider account service required');
  const privateHeaders=(req,res,next)=>{res.set('Cache-Control','private, no-store');res.set('X-Robots-Tag','noindex, nofollow');next();};
  const wrap=handler=>async(req,res)=>{
    if (!dbState.ready) return res.status(503).json({error:messages.DATABASE_UNAVAILABLE,code:'DATABASE_UNAVAILABLE'});
    try { await handler(req,res); }
    catch (error) {
      const known=Number.isInteger(error.httpStatus)&&error.httpStatus>=400&&error.httpStatus<500;
      const status=known?error.httpStatus:503;
      const code=known&&/^[A-Z0-9_]{2,60}$/.test(error.code||'')?error.code:'DATABASE_UNAVAILABLE';
      const message=messages[code] || (code.includes('CSRF')||code.includes('ORIGIN')||code.includes('FORM')?'Az űrlap lejárt vagy a kérés nem ellenőrizhető. Frissítsd az oldalt.':code.includes('EMAIL')?'A jelentkezés e-mail-címe nem használható.':code.includes('RATE')?'Túl sok újraküldési kísérlet. Próbáld később.':'A művelet most nem hajtható végre. Próbáld újra később.');
      res.status(status).json({error:message,code});
    }
  };
  function log(action,row,req,details={}) {
    try { Promise.resolve(audit(action,'directory_submission',row.id,req.user?.email,details)).catch(()=>{}); } catch (_) { /* Audit transport cannot turn a committed action into a retry. */ }
  }
  function dispatchMail() {
    if (typeof accounts.runWorker==='function') Promise.resolve().then(()=>accounts.runWorker()).catch(()=>{});
  }
  async function list(req,res) {
    const filters=listFilters(req.query),where=listWhere(filters);
    const countResult=await pool.query(`SELECT count(*) FILTER(WHERE deleted_at IS NULL)::int AS active_count,count(*) FILTER(WHERE deleted_at IS NOT NULL)::int AS trash_count FROM directory_submissions`);
    const total=Number((await pool.query('SELECT count(*)::int AS total FROM directory_submissions s WHERE '+where.clause,where.params)).rows[0].total);
    const pages=Math.max(1,Math.ceil(total/filters.pageSize)),page=Math.min(filters.page,pages);
    let pagination='';const params=[...where.params];
    if (filters.paginated) { params.push(filters.pageSize,(page-1)*filters.pageSize); pagination=` LIMIT $${params.length-1} OFFSET $${params.length}`; }
    const result=await pool.query(`SELECT s.*,m.delivery_status AS mail_status,m.kind AS mail_kind,m.expires_at AS mail_expires_at,m.created_at AS mail_created_at,m.accepted_at AS mail_accepted_at,
      (a.email_verified_at IS NOT NULL) AS account_activated,n.delivery_status AS admin_notice_status,n.recipient AS admin_notice_recipient
      FROM directory_submissions s
      LEFT JOIN provider_accounts a ON a.id=s.provider_account_id
      LEFT JOIN LATERAL (SELECT delivery_status,kind,expires_at,created_at,accepted_at FROM provider_account_mail
        WHERE submission_id=s.id AND kind IN ('invite','approved') ORDER BY created_at DESC,id DESC LIMIT 1) m ON true
      LEFT JOIN LATERAL (SELECT delivery_status,recipient FROM directory_submission_notifications
        WHERE submission_id=s.id ORDER BY revision DESC LIMIT 1) n ON true
      WHERE ${where.clause} ORDER BY ${filters.trash?'s.deleted_at':'s.created_at'} DESC,s.id DESC${pagination}`,params);
    if (!filters.paginated) return res.json(result.rows);
    res.json({items:result.rows,total,page,pages,page_size:filters.pageSize,...countResult.rows[0]});
  }
  async function mutate(req,res,action) {
    await accounts.protect(req);
    const id=submissionId(req.params.id),status=req.body?.status;
    if (action==='status'&&!STATUSES.has(status)) throw failure('INVALID_STATUS');
    const client=await pool.connect();let row,previous,approval=null,changed=false;
    try {
      await client.query('BEGIN');
      const unlocked=(await client.query('SELECT provider_account_id,email FROM directory_submissions WHERE id=$1',[id])).rows[0];
      if (!unlocked) throw failure('NOT_FOUND',404);
      // Profile writes lock the account before their submission. Match that order.
      const accountEmail=typeof unlocked.email==='string'?unlocked.email.trim().slice(0,255).toLowerCase():'';
      await client.query('SELECT id FROM provider_accounts WHERE id=$1 OR email=$2 ORDER BY id FOR UPDATE',[unlocked.provider_account_id,accountEmail]);
      row=(await client.query('SELECT * FROM directory_submissions WHERE id=$1 FOR UPDATE',[id])).rows[0];
      if (!row) throw failure('NOT_FOUND',404);
      previous=row.status;
      if (action==='trash') {
        if (!row.deleted_at) {
          await accounts.cancelSubmissionInvitation(client,id);
          row=(await client.query('UPDATE directory_submissions SET deleted_at=now(),deleted_by=$2,updated_at=now() WHERE id=$1 RETURNING *',[id,String(req.user?.email||'admin').slice(0,254)])).rows[0];
          changed=true;
        }
      } else if (action==='restore') {
        if (row.deleted_at) {
          row=(await client.query('UPDATE directory_submissions SET deleted_at=NULL,deleted_by=NULL,updated_at=now() WHERE id=$1 RETURNING *',[id])).rows[0];changed=true;
        }
      } else {
        if (row.deleted_at) throw failure('IN_TRASH',409);
        if (action==='invitation'&&row.status!=='accepted') throw failure('NOT_ACCEPTED',409);
        if (action==='invitation'||status==='accepted') {
          approval=await accounts.approveSubmission(client,row,{resend:action==='invitation'});
          row=(await client.query("UPDATE directory_submissions SET status='accepted',provider_account_id=$2,accepted_at=COALESCE(accepted_at,now()),updated_at=now() WHERE id=$1 RETURNING *",[id,approval.account_id])).rows[0];
          changed=true;
        } else if (status!==row.status) {
          if (row.status==='accepted') await accounts.cancelSubmissionInvitation(client,id);
          row=(await client.query('UPDATE directory_submissions SET status=$2,updated_at=now() WHERE id=$1 RETURNING *',[id,status])).rows[0];changed=true;
        }
      }
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK').catch(()=>{}); throw error; }
    finally { client.release(); }
    if (changed) log(action,row,req,{from:previous,to:row.status,trashed:!!row.deleted_at,...(approval?{mail_status:approval.mail_status}:{})});
    const message=action==='trash'?'A jelentkezés a kukába került. Innen bármikor visszaállítható.':action==='restore'?'A jelentkezést visszaállítottuk. Új értesítést nem küldtünk.':approval?approvalMessage(approval.mail_status,action==='invitation'):'A jelentkezés státuszát elmentettük.';
    res.json({...row,ok:true,message,...(approval?{mail_status:approval.mail_status,invitation:approval}:{})});
    if (approval) dispatchMail();
  }
  function register(app) {
    app.get('/api/admin/directory/submissions/session',privateHeaders,auth,wrap(async(req,res)=>res.json({csrf_token:await accounts.csrfFor(req,res)})));
    app.get('/api/admin/directory/submissions',privateHeaders,auth,wrap(list));
    app.put('/api/admin/directory/submissions/:id',privateHeaders,auth,wrap((req,res)=>mutate(req,res,'status')));
    app.post('/api/admin/directory/submissions/:id/trash',privateHeaders,auth,wrap((req,res)=>mutate(req,res,'trash')));
    app.post('/api/admin/directory/submissions/:id/restore',privateHeaders,auth,wrap((req,res)=>mutate(req,res,'restore')));
    app.post('/api/admin/directory/submissions/:id/invitation',privateHeaders,auth,wrap((req,res)=>mutate(req,res,'invitation')));
  }
  return {register};
}
module.exports={createSubmissionService,submissionId,listFilters,listWhere,approvalMessage};
