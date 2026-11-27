'use strict';
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const fs=require('node:fs');
const path=require('node:path');
const express=require('express');
const {Pool}=require('pg');
const {createSubmissionService}=require('../lib/directory-submissions.cjs');
const connectionString=process.env.TEST_DATABASE_URL;
assert(connectionString,'TEST_DATABASE_URL is required');
const location=new URL(connectionString);
assert(['localhost','127.0.0.1','[::1]'].includes(location.hostname)&&/test/.test(location.pathname),'Disposable loopback test database required');
const schema='submission_test_'+crypto.randomBytes(8).toString('hex');
const admin=new Pool({connectionString,ssl:false});
const db=new Pool({connectionString,ssl:false,options:'-c search_path='+schema});
let server,base='',failApproval=false,workerRuns=0;
const audits=[];
const csrf='isolated-test-csrf';
const accounts={
  csrfFor:()=>csrf,
  protect:req=>{if(req.get('X-Provider-CSRF')!==csrf||req.get('Origin')!==base)throw Object.assign(Error('CSRF_INVALID'),{code:'CSRF_INVALID',httpStatus:403});},
  approveSubmission:async(client,row,{resend=false}={})=>{
    const account=(await client.query('INSERT INTO provider_accounts(email,display_name,approved_at) VALUES(lower($1),$2,now()) ON CONFLICT(email) DO UPDATE SET approved_at=COALESCE(provider_accounts.approved_at,now()) RETURNING id',[row.email,row.name])).rows[0];
    let mail=(await client.query('SELECT id,delivery_status FROM provider_account_mail WHERE submission_id=$1 ORDER BY created_at DESC,id DESC LIMIT 1',[row.id])).rows[0];
    if(!mail||resend){const id=crypto.randomUUID();mail=(await client.query("INSERT INTO provider_account_mail(id,dedupe_key,account_id,submission_id,kind,delivery_status,expires_at) VALUES($1,$2,$3,$4,'invite','needs_mail',now()+interval '7 days') RETURNING id,delivery_status",[id,'isolated:'+id,account.id,row.id])).rows[0];}
    if(failApproval)throw Error('Internal fixture failure should never leak SQL or credentials');
    return {account_id:account.id,mail_id:mail.id,mail_status:mail.delivery_status};
  },
  cancelSubmissionInvitation:async(client,id)=>{await client.query("UPDATE provider_account_mail SET delivery_status='cancelled' WHERE submission_id=$1 AND delivery_status IN ('needs_mail','queued','failed')",[id]);},
  runWorker:async()=>{workerRuns++;}
};
async function call(route,{method='GET',data,authorized=true,protectedRequest=true}={}){
  const response=await fetch(base+route,{method,headers:{'Content-Type':'application/json',Origin:base,...(authorized?{Authorization:'test-admin'}:{}),...(protectedRequest?{'X-Provider-CSRF':csrf}:{})},...(data?{body:JSON.stringify(data)}:{})});
  return {status:response.status,headers:response.headers,body:await response.json()};
}
async function main(){
  await admin.query('CREATE SCHEMA '+schema);
  await db.query(`CREATE TABLE directory_submissions(id BIGSERIAL PRIMARY KEY,name TEXT NOT NULL,contact_name TEXT NOT NULL DEFAULT '',email TEXT NOT NULL,phone TEXT NOT NULL DEFAULT '',website_url TEXT NOT NULL DEFAULT '',category_slugs TEXT NOT NULL DEFAULT '',city TEXT NOT NULL DEFAULT '',online_available BOOLEAN NOT NULL DEFAULT false,description TEXT NOT NULL DEFAULT '',qualifications TEXT NOT NULL DEFAULT '',consent BOOLEAN NOT NULL DEFAULT true,status TEXT NOT NULL DEFAULT 'new',created_at TIMESTAMPTZ NOT NULL DEFAULT now(),updated_at TIMESTAMPTZ NOT NULL DEFAULT now());
    INSERT INTO directory_submissions(name,email,phone,status) VALUES('Visszaállítható jelentkezés','one@example.test','+36 20 555 0101','reviewed'),('Elfogadásra váró','two@example.test','','new'),('Hibateszt','three@example.test','','new');`);
  // Use the production schema, in its production dependency order, and verify replay safety.
  for(let pass=0;pass<2;pass++)for(const name of ['016_provider_accounts.sql','017_submission_trash.sql','019_submission_notifications.sql','021_reader_accounts.sql']){
    await db.query(fs.readFileSync(path.join(__dirname,'../migrations',name),'utf8'));
  }
  const app=express();app.use(express.json());
  const auth=(req,res,next)=>{if(req.get('Authorization')!=='test-admin')return res.status(401).json({error:'auth'});req.user={email:'admin@example.test',role:'admin'};next();};
  createSubmissionService({pool:db,dbState:{ready:true},auth,accounts,audit:(...args)=>audits.push(args)}).register(app);
  server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});base='http://127.0.0.1:'+server.address().port;
  const prefix='/api/admin/directory/submissions';
  assert.equal((await call(prefix,{authorized:false})).status,401);
  assert.equal((await call(prefix+'/1/trash',{method:'POST',authorized:false,data:{}})).status,401);
  const session=await call(prefix+'/session');assert.equal(session.body.csrf_token,csrf);assert.match(session.headers.get('cache-control'),/private.*no-store/);
  assert.equal((await call(prefix+'/1/trash',{method:'POST',protectedRequest:false,data:{}})).status,403);
  assert.equal((await call(prefix+'/0/trash',{method:'POST',data:{}})).status,400);
  assert.equal((await call(prefix+'/1',{method:'PUT',data:{status:'deleted'}})).status,400);
  const initial=await call(prefix+'?paginated=true&page_size=2');assert.equal(initial.body.total,3);assert.equal(initial.body.pages,2);assert.equal(initial.body.trash_count,0);
  const linked=await call(prefix+'?paginated=true&submission_id=2');assert.equal(linked.body.total,1);assert.equal(linked.body.items[0].id,'2');
  assert.equal((await call(prefix+'?paginated=true&submission_id=2%20OR%201=1')).status,400);
  assert(Array.isArray((await call(prefix)).body),'Legacy GET remains an array');
  const trash=await call(prefix+'/1/trash',{method:'POST',data:{}});assert.equal(trash.status,200);assert.equal(trash.body.status,'reviewed');assert(trash.body.deleted_at);assert.equal(trash.body.phone,'+36 20 555 0101');
  const again=await call(prefix+'/1/trash',{method:'POST',data:{}});assert.equal(again.body.deleted_at,trash.body.deleted_at,'Repeated trash does not lose original trash timestamp');
  let active=await call(prefix+'?paginated=true');assert.equal(active.body.total,2);assert.equal(active.body.trash_count,1);assert(active.body.items.every(x=>!x.deleted_at));
  const trashed=await call(prefix+'?paginated=true&trash=true');assert.equal(trashed.body.total,1);assert.equal(trashed.body.items[0].id,'1');
  const beforeRestoreMails=Number((await db.query('SELECT count(*) AS n FROM provider_account_mail')).rows[0].n);
  const restored=await call(prefix+'/1/restore',{method:'POST',data:{}});assert.equal(restored.body.status,'reviewed');assert.equal(restored.body.deleted_at,null);assert.equal(restored.body.phone,'+36 20 555 0101');
  assert.equal(Number((await db.query('SELECT count(*) AS n FROM provider_account_mail')).rows[0].n),beforeRestoreMails,'Restoring never sends an invitation');
  const approved=await call(prefix+'/2',{method:'PUT',data:{status:'accepted'}});assert.equal(approved.status,200);assert.equal(approved.body.status,'accepted');assert(approved.body.provider_account_id);assert.equal(approved.body.mail_status,'needs_mail');assert.match(approved.body.message,/még nem küldtünk e-mailt/);
  const duplicate=await call(prefix+'/2',{method:'PUT',data:{status:'accepted'}});assert.equal(duplicate.body.invitation.mail_id,approved.body.invitation.mail_id);assert.equal(Number((await db.query('SELECT count(*) AS n FROM provider_account_mail')).rows[0].n),1);
  const resent=await call(prefix+'/2/invitation',{method:'POST',data:{}});assert.equal(resent.status,200);assert.notEqual(resent.body.invitation.mail_id,approved.body.invitation.mail_id);
  await call(prefix+'/2/trash',{method:'POST',data:{}});
  assert.equal((await call(prefix+'/2',{method:'PUT',data:{status:'accepted'}})).status,409);assert.equal((await call(prefix+'/2/invitation',{method:'POST',data:{}})).status,409);
  assert((await db.query('SELECT delivery_status FROM provider_account_mail WHERE submission_id=2')).rows.every(x=>x.delivery_status==='cancelled'));
  await call(prefix+'/2/restore',{method:'POST',data:{}});assert.equal(Number((await db.query('SELECT count(*) AS n FROM provider_account_mail')).rows[0].n),2);
  assert.equal((await call(prefix+'/1/invitation',{method:'POST',data:{}})).status,409);
  failApproval=true;const failed=await call(prefix+'/3',{method:'PUT',data:{status:'accepted'}});failApproval=false;assert.equal(failed.status,503);assert(!JSON.stringify(failed.body).includes('fixture failure'));
  const unchanged=(await db.query('SELECT status,provider_account_id FROM directory_submissions WHERE id=3')).rows[0];assert.equal(unchanged.status,'new');assert.equal(unchanged.provider_account_id,null);assert.equal((await db.query("SELECT id FROM provider_accounts WHERE email='three@example.test'")).rowCount,0,'Failed approval rolls account and mail back too');
  const search=await call(prefix+'?paginated=true&q='+encodeURIComponent("%' OR 1=1 --"));assert.equal(search.body.total,0);
  assert(audits.some(args=>args[0]==='trash'));assert(audits.some(args=>args[0]==='restore'));assert(workerRuns>=1);
  console.log('SUBMISSION_TRASH_DB_OK',JSON.stringify({reversibleTrash:true,activeTrashCounts:true,pagination:true,search:true,auth:true,csrf:true,approvalAtomic:true,approvalIdempotent:true,noRestoreEmail:true,realEmailsSent:0}));
}
main().catch(error=>{console.error(error);process.exitCode=1;}).finally(async()=>{if(server)await new Promise(resolve=>server.close(resolve));await db.end();await admin.query('DROP SCHEMA IF EXISTS '+schema+' CASCADE').catch(()=>{});await admin.end();});
