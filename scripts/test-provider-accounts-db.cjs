'use strict';

const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const fs=require('node:fs');
const path=require('node:path');
const express=require('express');
const cookieParser=require('cookie-parser');
const {Pool}=require('pg');
const {createProviderAccountService,hash}=require('../lib/provider-accounts.cjs');

const connectionString=process.env.TEST_DATABASE_URL;
assert(connectionString,'TEST_DATABASE_URL must point to disposable local PostgreSQL');
const database=new URL(connectionString);
assert(['localhost','127.0.0.1','[::1]'].includes(database.hostname)&&/test/.test(database.pathname),'Disposable local test database required');
const schema='provider_accounts_test_'+crypto.randomBytes(8).toString('hex');
const admin=new Pool({connectionString,ssl:false});
const db=new Pool({connectionString,ssl:false,options:'-c search_path='+schema});
const key=crypto.randomBytes(32),deliveries=[];
let configured=false,deliveryError=null,emptyDeliveryResult=false,service,server,base;
function seal(value){const iv=crypto.randomBytes(12),cipher=crypto.createCipheriv('aes-256-gcm',key,iv);const body=Buffer.concat([cipher.update(JSON.stringify(value)),cipher.final()]);return [iv,cipher.getAuthTag(),body].map(b=>b.toString('base64url')).join('.');}
function unseal(value){if(!value)return null;const [iv,tag,body]=value.split('.').map(s=>Buffer.from(s,'base64url'));const cipher=crypto.createDecipheriv('aes-256-gcm',key,iv);cipher.setAuthTag(tag);return JSON.parse(Buffer.concat([cipher.update(body),cipher.final()]).toString());}
const mailer={ready:async()=>configured,seal,unseal,send:async message=>{if(deliveryError)throw Object.assign(new Error('Isolated mail failure'),{code:deliveryError});deliveries.push(message);return emptyDeliveryResult?{}:{id:'ci-message-'+message.id};}};
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function transaction(fn){const client=await db.connect();try{await client.query('BEGIN');const value=await fn(client);await client.query('COMMIT');return value;}catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}}
function client(extraCookies={}) {
 const jar={...extraCookies};let csrf;
 return {
  jar,
  async call(route,{method='GET',data,origin=base,includeCsrf=true}={}){
   const response=await fetch(base+route,{method,headers:{'Content-Type':'application/json',Origin:origin,Cookie:Object.entries(jar).map(([name,value])=>name+'='+value).join('; '),...(includeCsrf&&csrf?{'X-Provider-CSRF':csrf}:{})},...(data?{body:JSON.stringify(data)}:{})});
   for(const item of response.headers.getSetCookie()){const [name,value]=item.split(';')[0].split('=');if(value)jar[name]=value;else delete jar[name];}
   const content=response.headers.get('content-type')||'';const body=content.includes('application/json')?await response.json():null;
   if(body?.csrf_token)csrf=body.csrf_token;
   return {status:response.status,body,headers:response.headers};
  },
  async bootstrap(){return this.call('/api/provider/session');}
 };
}
async function latestMail(email,kind){return (await db.query('SELECT m.* FROM provider_account_mail m JOIN provider_accounts a ON a.id=m.account_id WHERE a.email=$1 AND m.kind=$2 ORDER BY m.created_at DESC,m.id DESC LIMIT 1',[email,kind])).rows[0];}
function rawToken(mail){const message=unseal(mail.payload_ciphertext);const match=/#token=([A-Za-z0-9_-]{43})/.exec(message.text);assert(match,'Account email contains fragment token');return match[1];}
async function approve(submissionId,resend=false){return transaction(async connection=>{const row=(await connection.query('SELECT * FROM directory_submissions WHERE id=$1 FOR UPDATE',[submissionId])).rows[0];const result=await service.approveSubmission(connection,row,{resend});await connection.query("UPDATE directory_submissions SET status='accepted',provider_account_id=$2 WHERE id=$1",[submissionId,result.account_id]);return result;});}
async function flush(){for(let i=0;i<12;i++){await service.runWorker();await wait(10);}}

async function main(){
 await admin.query('CREATE SCHEMA '+schema);
 await db.query(`CREATE TABLE directory_submissions(id BIGSERIAL PRIMARY KEY,name TEXT,contact_name TEXT,email TEXT,status TEXT NOT NULL DEFAULT 'new',provider_account_id BIGINT,deleted_at TIMESTAMPTZ);
  INSERT INTO directory_submissions(name,contact_name,email) VALUES('Első szolgáltató','Teszt Jelentkező','invited@example.test'),('Törölhető jelentkező','Törölhető','trash@example.test');`);
 const migration=fs.readFileSync(path.join(__dirname,'../migrations/016_provider_accounts.sql'),'utf8');
 await transaction(connection=>connection.query(migration));
 await transaction(connection=>connection.query(fs.readFileSync(path.join(__dirname,'../migrations/021_reader_accounts.sql'),'utf8')));
 const app=express();app.use(express.json());app.use(cookieParser());
 service=createProviderAccountService({pool:db,dbState:{ready:true},secret:'isolated-provider-account-secret',baseUrl:'http://127.0.0.1',mailer,env:{NODE_ENV:'test'}});
 service.register(app);app.get('/protected',service.requireAccount,(req,res)=>res.json(req.providerUser));
 server=await new Promise(resolve=>{const server=app.listen(0,'127.0.0.1',()=>resolve(server));});base='http://127.0.0.1:'+server.address().port;

 const owner=client(),initial=await owner.bootstrap();assert.equal(initial.body.authenticated,false);assert.equal(initial.body.mail_ready,false);
 assert.match(initial.headers.get('cache-control'),/no-store/);
 assert.equal((await owner.call('/api/provider/register',{method:'POST',data:{email:'not-csrf@example.test',display_name:'Test',consent:true},includeCsrf:false})).status,403);
 assert.equal((await owner.call('/api/provider/register',{method:'POST',data:{email:'cross@example.test',display_name:'Test',consent:true},origin:'https://hostile.example'})).status,403);
 const registration=await owner.call('/api/provider/register',{method:'POST',data:{email:'Invited@Example.Test',display_name:'Teszt Jelentkező',consent:true}});
 assert.equal(registration.status,202);assert.equal(registration.body.mail_ready,false);assert.match(registration.body.message,/folyamatban/);
 const account=(await db.query("SELECT * FROM provider_accounts WHERE email='invited@example.test'")).rows[0];assert(account);assert.equal(account.password_hash,null);assert.equal(account.approved_at,null);
 const setup=await latestMail('invited@example.test','setup');assert.equal(setup.delivery_status,'needs_mail');assert(!setup.payload_ciphertext.includes('invited@example.test'));assert(!setup.payload_ciphertext.includes('#token='));
 await owner.call('/api/provider/register',{method:'POST',data:{email:'invited@example.test',display_name:'Overwrite attempt',consent:true}});
 assert.equal(Number((await db.query("SELECT count(*) FROM provider_account_mail WHERE account_id=$1 AND kind='setup'",[account.id])).rows[0].count),1,'Email cooldown prevents duplicate setup mail');
 assert.equal((await db.query('SELECT display_name FROM provider_accounts WHERE id=$1',[account.id])).rows[0].display_name,'Teszt Jelentkező');
 const honey=await owner.call('/api/provider/register',{method:'POST',data:{email:'honeypot@example.test',display_name:'Spam',consent:true,honey:'https://spam.invalid'}});assert.equal(honey.status,202);
 assert.equal((await db.query("SELECT id FROM provider_accounts WHERE email='honeypot@example.test'")).rowCount,0);

 const approval=await approve(1);assert.equal(approval.account_id,account.id);assert.equal(approval.mail_status,'needs_mail');
 assert.equal((await approve(1)).mail_id,approval.mail_id,'Repeated accept is idempotent');
 const invite=await latestMail('invited@example.test','invite'),token=rawToken(invite);
 const info=await owner.call('/api/provider/token-info',{method:'POST',data:{token}});assert.equal(info.status,200);assert.equal(info.body.kind,'invite');assert.equal(info.body.email,'invited@example.test');
 assert.equal((await db.query('SELECT consumed_at FROM provider_account_tokens WHERE id=$1',[invite.token_id])).rows[0].consumed_at,null,'Reading token info does not claim it');
 assert.equal((await owner.call('/api/provider/activate')).status,404,'GET cannot activate a token');
 const missingConsent=await owner.call('/api/provider/activate',{method:'POST',data:{token,password:'Strong-password-123'}});assert.equal(missingConsent.status,400);assert.equal(missingConsent.body.code,'CONSENT_REQUIRED');
 const activated=await owner.call('/api/provider/activate',{method:'POST',data:{token,password:'Strong-password-123',consent:true}});assert.equal(activated.status,200);assert(activated.body.user.approved&&activated.body.user.email_verified);assert(owner.jar.mental_provider);
 assert(!JSON.stringify(activated.body).includes('password_hash'));
 assert.equal((await owner.call('/protected')).status,200);
 assert.equal((await owner.call('/api/provider/activate',{method:'POST',data:{token,password:'Different-password-123',consent:true}})).status,410,'An invitation is single use');
 assert.equal((await owner.call('/api/provider/activate',{method:'POST',data:{token:rawToken(setup),password:'Different-password-123',consent:true}})).status,410,'Activation invalidates older setup tokens');
 const cmsOnly=client({mental_cms:'this-is-an-admin-cookie-not-provider-auth'});await cmsOnly.bootstrap();assert.equal((await cmsOnly.call('/protected')).status,401);
 const anonymous=client();await anonymous.bootstrap();
 const wrong=await anonymous.call('/api/provider/login',{method:'POST',data:{email:'invited@example.test',password:'Wrong-password-123'}});
 const unknown=await anonymous.call('/api/provider/login',{method:'POST',data:{email:'missing@example.test',password:'Wrong-password-123'}});
 assert.equal(wrong.status,401);assert.deepEqual(wrong.body,unknown.body,'Login does not reveal account existence');
 assert.equal((await anonymous.call('/api/provider/login',{method:'POST',data:{email:'invited@example.test',password:'Strong-password-123'}})).status,200);

 const resetReply=await anonymous.call('/api/provider/forgot-password',{method:'POST',data:{email:'invited@example.test'}});
 const unknownReply=await anonymous.call('/api/provider/forgot-password',{method:'POST',data:{email:'absent@example.test'}});
 assert.deepEqual(resetReply.body,unknownReply.body,'Reset does not reveal account existence');
 const reset=await latestMail('invited@example.test','reset'),resetToken=rawToken(reset);
 assert.equal((await owner.call('/api/provider/reset-password',{method:'POST',data:{token:resetToken,password:'Changed-password-456'}})).status,200);
 assert.equal((await anonymous.call('/protected')).status,401,'Password reset revokes other sessions');
 assert.equal((await owner.call('/protected')).status,401,'Reset does not auto-login');
 assert.equal((await owner.call('/api/provider/reset-password',{method:'POST',data:{token:resetToken,password:'Changed-password-789'}})).status,410);
 assert.equal((await owner.call('/api/provider/login',{method:'POST',data:{email:'invited@example.test',password:'Changed-password-456'}})).status,200);
 await db.query('UPDATE provider_accounts SET disabled_at=now() WHERE id=$1',[account.id]);
 assert.equal((await owner.call('/protected')).status,401,'Suspended accounts cannot use their cookie');
 assert.equal(Number((await db.query('SELECT count(*) FROM provider_account_sessions WHERE account_id=$1',[account.id])).rows[0].count),0);
 await db.query('UPDATE provider_accounts SET disabled_at=NULL WHERE id=$1',[account.id]);
 assert.equal((await owner.call('/protected')).status,401,'Re-enabling does not resurrect old sessions');

 const trashApproval=await approve(2),trashMail=await latestMail('trash@example.test','invite'),trashToken=rawToken(trashMail);
 await transaction(async connection=>{await service.cancelSubmissionInvitation(connection,2);await connection.query('UPDATE directory_submissions SET deleted_at=now() WHERE id=2');});
 assert.equal((await db.query('SELECT approved_at FROM provider_accounts WHERE id=$1',[trashApproval.account_id])).rows[0].approved_at,null,'Unclaimed trash cannot keep a latent approval');
 assert.equal((await owner.call('/api/provider/activate',{method:'POST',data:{token:trashToken,password:'Trash-password-123',consent:true}})).status,410);
 const trashed=client();await trashed.bootstrap();await trashed.call('/api/provider/register',{method:'POST',data:{email:'trash@example.test',display_name:'Trash account',consent:true}});
 const nextSetup=await latestMail('trash@example.test','setup');
 const parallel=await Promise.all([trashed.call('/api/provider/activate',{method:'POST',data:{token:rawToken(nextSetup),password:'Trash-password-123',consent:true}}),trashed.call('/api/provider/activate',{method:'POST',data:{token:rawToken(nextSetup),password:'Other-password-123',consent:true}})]);
 assert.deepEqual(parallel.map(result=>result.status).sort(),[200,410],'Concurrent activation claims only once');
 assert.equal(parallel.find(result=>result.status===200).body.user.approved,false,'Public signup after trash stays unapproved');

 // Existing verified accounts get a dashboard notice, never a password-setting invitation.
 await db.query("UPDATE directory_submissions SET status='new',deleted_at=NULL WHERE id=1");
 configured=true;
 const existingApproval=await approve(1,true),notice=await latestMail('invited@example.test','approved');assert.equal(existingApproval.mail_id,notice.id);
 const payload=unseal(notice.payload_ciphertext);assert(payload.text.includes('/fiokom'));assert(!payload.text.includes('#token='));
 await flush();assert(deliveries.some(message=>message.id===notice.id));
 assert.equal((await db.query('SELECT delivery_status,payload_ciphertext FROM provider_account_mail WHERE id=$1',[notice.id])).rows[0].delivery_status,'accepted');
 assert.equal((await db.query('SELECT payload_ciphertext FROM provider_account_mail WHERE id=$1',[notice.id])).rows[0].payload_ciphertext,null,'Sent tokens are not retained in payloads');

 // An uncertain transmission is recorded once, not silently sent repeatedly.
 await db.query("INSERT INTO directory_submissions(name,email) VALUES('Uncertain mail','uncertain@example.test') RETURNING id").then(async result=>{const pending=await approve(result.rows[0].id);deliveryError='MAIL_RESULT_UNCERTAIN';await flush();const row=(await db.query('SELECT delivery_status,attempts FROM provider_account_mail WHERE id=$1',[pending.mail_id])).rows[0];assert.equal(row.delivery_status,'uncertain');assert.equal(row.attempts,1);deliveryError=null;});
 await db.query("INSERT INTO directory_submissions(name,email) VALUES('Missing receipt','no-receipt@example.test') RETURNING id").then(async result=>{const pending=await approve(result.rows[0].id);emptyDeliveryResult=true;await flush();const row=(await db.query('SELECT delivery_status,accepted_at,attempts FROM provider_account_mail WHERE id=$1',[pending.mail_id])).rows[0];assert.equal(row.delivery_status,'uncertain');assert.equal(row.accepted_at,null);assert.equal(row.attempts,1);emptyDeliveryResult=false;});
 const interruptedId=(await db.query("INSERT INTO directory_submissions(name,email) VALUES('Interrupted delivery','interrupted@example.test') RETURNING id")).rows[0].id;
 const interrupted=await approve(interruptedId);
 await db.query("UPDATE provider_account_mail SET delivery_status='sending',sending_since=now()-interval '6 minutes',attempts=1 WHERE id=$1",[interrupted.mail_id]);
 const recovery=createProviderAccountService({pool:db,dbState:{ready:true},secret:'isolated-provider-account-secret',baseUrl:'http://127.0.0.1',mailer,env:{NODE_ENV:'test'}});
 await recovery.runWorker();
 const recovered=(await db.query('SELECT delivery_status,error_code,accepted_at,attempts FROM provider_account_mail WHERE id=$1',[interrupted.mail_id])).rows[0];
 assert.equal(recovered.delivery_status,'uncertain');assert.equal(recovered.error_code,'WORKER_INTERRUPTED');assert.equal(recovered.accepted_at,null);assert.equal(recovered.attempts,1);
 assert.equal((await owner.call('/api/provider/session')).headers.get('cache-control'),'private, no-store');
 console.log('PROVIDER_ACCOUNTS_DB_OK',JSON.stringify({signup:true,encryptedOutbox:true,mailSetupQueue:true,acceptIdempotent:true,tokenOwnership:true,activationRequiresConsent:true,tokenReplayBlocked:true,concurrentActivation:true,csrf:true,adminIsolation:true,resetRevokesSessions:true,suspensionRevokesSessions:true,trashRevokesUnclaimedApproval:true,existingAccountPasswordPreserved:true,uncertainMailNotRepeated:true,missingReceiptNotAccepted:true,interruptedDeliveryNotRepeated:true,realEmailsSent:0}));
}

main().catch(error=>{console.error(error.stack);process.exitCode=1;}).finally(async()=>{service?.stop();if(server)await new Promise(resolve=>server.close(resolve));await db.end();await admin.query('DROP SCHEMA IF EXISTS '+schema+' CASCADE').catch(()=>{});await admin.end();});
