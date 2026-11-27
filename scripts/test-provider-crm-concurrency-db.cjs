'use strict';

// Deterministic race regressions for source-bound CRM copies. The hook only
// coordinates operations in the fixture's disposable local PostgreSQL schema.
const assert=require('node:assert/strict');
const {createFixture}=require('./test-provider-crm-fixture.cjs');
const {createProviderCrmService}=require('../lib/provider-crm.cjs');
let fixture;

function hookedPool(pool,{before=async()=>{},after=async()=>{}}={}){
  async function query(owner,args){
    const sql=typeof args[0]==='string'?args[0]:args[0]?.text||'';
    const values=args[1]||args[0]?.values||[];
    await before(sql,values);const result=await owner.query(...args);await after(sql,values,result);return result;
  }
  return {query:(...args)=>query(pool,args),connect:async()=>{const client=await pool.connect();return {query:(...args)=>query(client,args),release:(...args)=>client.release(...args)};}};
}
function serviceWith(f,pool){return createProviderCrmService({pool,dbState:{ready:true},accounts:f.accounts,seal:f.seal,unseal:f.unseal});}
const selects=(sql,table)=>/^\s*SELECT\b/i.test(sql)&&new RegExp('\\bFROM\\s+'+table+'\\b','i').test(sql);
async function imported(f,owner,listing,name){
  const inquiry=await f.seedInquiry(listing,{name,email:name.toLowerCase().replace(/[^a-z0-9]/g,'')+'@example.test'});
  await f.service.syncInquiries(owner.id);
  const contact=(await f.db.query('SELECT * FROM provider_crm_contacts WHERE source_inquiry_id=$1 AND deleted_at IS NULL',[inquiry.id])).rows[0];
  assert(contact,'The fixture inquiry was imported before the race');return {inquiry,contact};
}
async function lockProbe(db,sql,values,label){
  const client=await db.connect();
  try{await client.query('BEGIN');await client.query("SET LOCAL lock_timeout='250ms'");await assert.rejects(client.query(sql,values),{code:'55P03'},label);}
  finally{await client.query('ROLLBACK').catch(()=>{});client.release();}
}
async function within(promise,label,milliseconds=3000){
  let timer;
  try{return await Promise.race([promise,new Promise((_resolve,reject)=>{timer=setTimeout(()=>reject(new Error('Timed out: '+label)),milliseconds);})]);}
  finally{clearTimeout(timer);}
}

async function main(){
  const f=fixture=await createFixture();
  const owner=await f.seedAccount('race-owner@example.test'),listing=await f.seedListing(owner);

  // Erasure happens after purgeExpired committed, but before the actual read.
  const first=await imported(f,owner,listing,'Race Read');let readHook=false;
  const readService=serviceWith(f,hookedPool(f.db,{before:async(sql,values)=>{
    if(!readHook&&selects(sql,'provider_crm_contacts')&&values.includes(first.contact.id)){
      readHook=true;await f.db.query("UPDATE directory_contact_inquiries SET payload_ciphertext=NULL,delivery_status='cancelled' WHERE id=$1",[first.inquiry.id]);
    }
  }}));
  await assert.rejects(readService.detail(owner.id,first.contact.id),{httpStatus:404},'A source erased after pre-cleanup must not be returned from the private copy');
  assert(readHook,'The read race was exercised at the intended boundary');

  // The same boundary is protected when modifying a source-derived contact.
  const second=await imported(f,owner,listing,'Race Write');let writeHook=false;
  const writeService=serviceWith(f,hookedPool(f.db,{before:async(sql,values)=>{
    const accountLock=selects(sql,'provider_accounts')&&/FOR (?:UPDATE|SHARE)/i.test(sql)&&values.includes(owner.id);
    const contactRead=selects(sql,'provider_crm_contacts')&&values.includes(second.contact.id);
    if(!writeHook&&(accountLock||contactRead)){
      writeHook=true;await f.db.query("UPDATE directory_contact_inquiries SET payload_ciphertext=NULL,delivery_status='cancelled' WHERE id=$1",[second.inquiry.id]);
    }
  }}));
  const eventsBefore=(await f.db.query('SELECT count(*)::int AS n FROM provider_crm_events WHERE contact_id=$1',[second.contact.id])).rows[0].n;
  await assert.rejects(writeService.updateContact(owner.id,second.contact.id,{version:second.contact.version,notes:'This must not be saved after source erasure'}),{httpStatus:404});
  assert(writeHook);assert((await f.db.query('SELECT count(*)::int AS n FROM provider_crm_events WHERE contact_id=$1',[second.contact.id])).rows[0].n<=eventsBefore,'Invalidated source cannot gain a new CRM event');

  // A listing's new owner cannot import old, unmirrored recipient-specific data.
  const oldOwner=await f.seedAccount('old-recipient@example.test'),newOwner=await f.seedAccount('new-recipient@example.test'),transferredListing=await f.seedListing(oldOwner);
  const oldInquiry=await f.seedInquiry(transferredListing,{name:'Original recipient only',email:'old-private-lead@example.test'});
  await f.db.query('UPDATE provider_listing_owners SET account_id=$1 WHERE listing_id=$2',[newOwner.id,transferredListing.id]);
  await f.db.query('UPDATE directory_listings SET email=$1 WHERE id=$2',[newOwner.email,transferredListing.id]);
  await f.service.syncInquiries(newOwner.id);
  assert.equal((await f.service.listContacts(newOwner.id)).total,0,'Current ownership alone cannot override the original verified recipient');
  assert.equal((await f.db.query('SELECT count(*)::int AS n FROM provider_crm_contacts WHERE source_inquiry_id=$1 AND payload_ciphertext IS NOT NULL',[oldInquiry.id])).rows[0].n,0,'No plaintext-bearing encrypted copy of the prior recipient data is retained for the new owner');
  await f.service.syncInquiries(newOwner.id);
  assert.equal((await f.service.listContacts(newOwner.id)).total,0,'Repeated sync cannot reintroduce the rejected historical inquiry');

  // Once a sync reads an inquiry for copying, source erasure and ownership
  // mutation must wait until that transaction finishes. Probes roll back.
  const syncOwner=await f.seedAccount('sync-lock-owner@example.test'),syncListing=await f.seedListing(syncOwner),syncInquiry=await f.seedInquiry(syncListing,{name:'Locked source',email:'locked-lead@example.test'});
  let syncHook=false;
  const syncService=serviceWith(f,hookedPool(f.db,{after:async(sql,values)=>{
    if(!syncHook&&selects(sql,'directory_contact_inquiries')&&/FOR (?:KEY )?SHARE/i.test(sql)){
      syncHook=true;
      await lockProbe(f.db,'UPDATE directory_contact_inquiries SET payload_ciphertext=NULL WHERE id=$1',[syncInquiry.id],'A sync holds its source until the encrypted copy is committed');
      await lockProbe(f.db,'DELETE FROM provider_listing_owners WHERE account_id=$1 AND listing_id=$2',[syncOwner.id,syncListing.id],'A sync holds the ownership relation while copying');
    }
  }}));
  await syncService.syncInquiries(syncOwner.id);assert(syncHook,'Sync used explicit source row locking');
  assert.equal((await f.service.listContacts(syncOwner.id)).total,1,'The valid original recipient can import normally after the probes');

  // Account deletion already owns the account lock. A concurrent contact edit
  // must wait there instead of taking a contact lock and deadlocking the cascade.
  const deleting=await f.seedAccount('deleting-owner@example.test'),manual=await f.service.createContact(deleting.id,{name:'Deletion race contact',notes:'Original private note'});
  const blocker=await f.db.connect();let blockerOpen=false,editing;
  let notifyAttempt;const attempt=new Promise(resolve=>{notifyAttempt=resolve;});let notified=false;
  const deleteService=serviceWith(f,hookedPool(f.db,{before:async(sql,values)=>{
    if(!notified&&selects(sql,'provider_accounts')&&/FOR (?:UPDATE|SHARE)/i.test(sql)&&values.includes(deleting.id)){notified=true;notifyAttempt('account');}
  },after:async(sql,values)=>{
    if(!notified&&selects(sql,'provider_crm_contacts')&&/FOR UPDATE/i.test(sql)&&values.includes(manual.id)){notified=true;notifyAttempt('contact');}
  }}));
  try{
    await blocker.query('BEGIN');blockerOpen=true;await blocker.query("SET LOCAL lock_timeout='750ms'");
    await blocker.query('SELECT id FROM provider_accounts WHERE id=$1 FOR UPDATE',[deleting.id]);
    editing=deleteService.updateContact(deleting.id,manual.id,{version:manual.version,notes:'Concurrent edit'}).then(value=>({value}),error=>({error}));
    await within(attempt,'CRM edit begins its state-changing lock sequence');
    await blocker.query('DELETE FROM provider_accounts WHERE id=$1',[deleting.id]);
    await blocker.query('COMMIT');blockerOpen=false;
    const result=await within(editing,'Concurrent edit resolves after account deletion');
    assert(result.error&&result.error.httpStatus>=400&&result.error.httpStatus<500,'A deleted account receives a controlled authorization/not-found rejection');
    assert.equal((await f.db.query('SELECT count(*)::int AS n FROM provider_crm_contacts WHERE account_id=$1',[deleting.id])).rows[0].n,0);
  }finally{
    if(blockerOpen)await blocker.query('ROLLBACK').catch(()=>{});blocker.release();
    if(editing)await within(editing,'Pending edit cleanup').catch(()=>{});
  }
  assert.equal(f.mailAttempts,0);
  console.log('PROVIDER_CRM_CONCURRENCY_DB_OK',JSON.stringify({sourceErasureAfterCleanupRead:true,sourceErasureAfterCleanupWrite:true,originalRecipientPreservedOnTransfer:true,sourceAndOwnershipLockedDuringSync:true,accountDeleteContactEditNoDeadlock:true,realEmailsSent:0}));
}
main().catch(error=>{console.error(error.stack);process.exitCode=1;}).finally(async()=>{await fixture?.close();});
