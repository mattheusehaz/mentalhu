'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const {publicUser,safeAccountNext,createProviderAccountService,CONSENT_VERSION}=require('../lib/provider-accounts.cjs');

test('account capabilities distinguish readers from an explicit provider extension',()=>{
  const account={id:1,email:'reader@example.test',display_name:'Olvasó',email_verified_at:new Date(),approved_at:null,disabled_at:null};
  assert.equal(publicUser(account).is_provider,false);assert.equal(publicUser(account).has_provider_profile,false);
  const extended=publicUser({...account,provider_profile_started_at:new Date()});
  assert.equal(extended.is_provider,true);assert.equal(extended.has_provider_profile,true);assert.equal(extended.approved,false,'Starting a profile does not approve publication');
  assert.equal(publicUser({...account,approved_at:new Date()}).is_provider,false,'An unrelated approval flag cannot substitute for explicit profile capability');
  assert.match(CONSENT_VERSION,/reader-account/);
});

test('email return paths are narrow local destinations, never arbitrary redirects',()=>{
  for(const path of ['/fiokom','/fiokom?szolgaltato=1','/fiokom/ugyfelek','/szolgaltato/teszt-szakember','/szolgaltato/teszt-szakember#ertekelesek'])assert.equal(safeAccountNext(path),path);
  for(const path of ['https://evil.example/','//evil.example','/\\evil.example','/szolgaltato/%2f%2fevil.example','/szolgaltato/ok?redirect=https://evil.example','/admin','/fiokom?szolgaltato=1&next=https://evil.example','/fiokom/ugyfelek?next=https://evil.example','/fiokom/ugyfelek/../admin','/szolgaltato/ok\n','javascript:alert(1)',{},null])assert.equal(safeAccountNext(path),'/fiokom');
});

test('generic and legacy CSRF headers protect the same account session',()=>{
  const accounts=createProviderAccountService({pool:{},dbState:{ready:true},secret:'isolated-reader-csrf-secret',mailer:{ready:async()=>false,send:async()=>{},seal:x=>x,unseal:x=>x}});
  const cookies={},headers={host:'mental.hu',origin:'https://mental.hu','sec-fetch-site':'same-origin'};
  const req={cookies,secure:true,protocol:'https',get:name=>headers[name.toLowerCase()]};
  const token=accounts.csrfFor(req,{cookie:(name,value)=>{cookies[name]=value;}});
  headers['x-account-csrf']=token;assert.doesNotThrow(()=>accounts.protect(req));
  delete headers['x-account-csrf'];headers['x-provider-csrf']=token;assert.doesNotThrow(()=>accounts.protect(req));
  headers['x-account-csrf']='bad';assert.throws(()=>accounts.protect(req),{code:'FORM_EXPIRED'},'A malformed generic header cannot fall through to a valid legacy one');
});
