'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const {cleanContact,searchTokens,queryTokens,dateValue}=require('../lib/provider-crm.cjs');

test('CRM personal fields are bounded and cannot change ownership/source/versions',()=>{
 const value=cleanContact({name:'  Teszt Kapcsolat  ',email:'Reader@Example.Test',phone:'+36 30 123 4567',notes:'Első sor\r\nMásodik sor',next_action:'Visszahívás',next_followup_at:'2026-12-02T08:00:00Z'});
 assert.equal(value.payload.name,'Teszt Kapcsolat');assert.equal(value.payload.email,'reader@example.test');assert.equal(value.payload.notes,'Első sor\nMásodik sor');assert.equal(value.status,'new');
 for(const body of [{name:'x'},{name:'Név',account_id:9},{name:'Név',source_type:'inquiry'},{name:'Név',source_inquiry_id:crypto.randomUUID()},{name:'Név',email:'bad\r\nBcc:x@example.test'},{name:'Név',status:'admin'},{name:'Név',notes:'x'.repeat(8001)},{name:'Név',next_followup_at:'2026-12-01T10:00:00Z'}])assert.throws(()=>cleanContact(body));
 assert.throws(()=>dateValue('2026-12-01T10:00'),'An explicit timezone is required');
});
test('per-account blind search supports accented names/email/phone prefixes without storing plaintext',()=>{
 const key=crypto.randomBytes(32),other=crypto.randomBytes(32),payload={name:'Őri Ágnes',email:'agnes.ori@example.test',phone:'+36 30 123 4567'};
 const tokens=new Set(searchTokens(payload,key));for(const q of ['ori agn','Őri','agnes.ori@exa','+36 30','3630123'])assert(queryTokens(q,key).every(item=>tokens.has(item)),q);
 assert(searchTokens(payload,key).every(item=>/^[a-f0-9]{64}$/.test(item)));assert(!queryTokens('ori',other).some(item=>tokens.has(item)));
 assert.throws(()=>queryTokens('a',key));assert.throws(()=>queryTokens('x'.repeat(201),key));
});
test('partial updates preserve existing values and notes with a stable explicit status',()=>{
 const previous={status:'active',next_followup_at:null,payload:{name:'Kapcsolat',email:'known@example.test',phone:'',source_label:'Saját',notes:'Megőrzött megjegyzés',next_action:''}};
 const changed=cleanContact({status:'closed',version:3},previous);assert.equal(changed.payload.notes,previous.payload.notes);assert.equal(changed.payload.email,previous.payload.email);assert.equal(changed.status,'closed');
});
