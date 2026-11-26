'use strict';
const assert=require('node:assert/strict');
const {test}=require('node:test');
const {createProviderAccountService,validEmail,emailOf,validPassword,validToken,trustedBase,publicUser}=require('../lib/provider-accounts.cjs');

test('account validation preserves email identity and does not silently truncate passwords',()=>{
  assert.equal(emailOf('  Example+tag@Example.HU '),'example+tag@example.hu');
  for(const email of ['hello@example.hu','name+tag@sub.example.com',"o'brien@example.hu"])assert(validEmail(email));
  for(const email of ['x@example..hu','x@-example.hu','.name@example.hu','a..b@example.hu','x@example.hu\r\nBcc: victim@example.hu','x'.repeat(65)+'@example.hu'])assert.equal(validEmail(email),false,email);
  assert(validPassword('a'.repeat(10)));assert(validPassword('a'.repeat(72)));
  assert.equal(validPassword('a'.repeat(73)),false);assert.equal(validPassword('123456789'),false);
  assert(validPassword('árvíztűrőtükörfúrógép'));assert.equal(validPassword('😀'.repeat(5)),false);assert.equal(validPassword('😀'.repeat(19)),false);
  assert(validToken('a'.repeat(43)));assert.equal(validToken('../'+ 'a'.repeat(43)),false);
});

test('links use only the configured canonical origin and public users expose no credentials',()=>{
  assert.equal(trustedBase('https://mental.hu/'),'https://mental.hu');
  assert.equal(trustedBase('http://127.0.0.1:12345'),'http://127.0.0.1:12345');
  for(const url of ['http://mental.hu','https://evil@mental.hu','https://mental.hu/path','https://mental.hu?next=evil','javascript:alert(1)'])assert.throws(()=>trustedBase(url));
  const user=publicUser({id:1,email:'test@example.hu',display_name:'Test',password_hash:'secret',email_verified_at:new Date(),approved_at:null,disabled_at:null});
  assert.deepEqual(Object.keys(user),['id','email','display_name','email_verified','approved','disabled']);
  assert.equal(user.approved,false);assert.equal(user.email_verified,true);
});

test('provider CSRF is cookie-bound and rejects malformed, absent and foreign origins',()=>{
  const service=createProviderAccountService({pool:{},dbState:{ready:true},secret:'isolated-provider-csrf-secret',mailer:{ready:async()=>false,send:async()=>{},seal:x=>x,unseal:x=>x}});
  const cookies={};let cookieAttributes;
  const req={cookies,secure:true,protocol:'https',get:name=>({'host':'mental.hu','origin':'https://mental.hu','sec-fetch-site':'same-origin','x-provider-csrf':req.token}[name.toLowerCase()])};
  const res={cookie:(name,value,attributes)=>{cookies[name]=value;cookieAttributes=attributes;}};
  req.token=service.csrfFor(req,res);
  assert(cookieAttributes.httpOnly&&cookieAttributes.secure&&cookieAttributes.sameSite==='lax');
  assert.doesNotThrow(()=>service.protect(req));
  const request=headers=>({...req,get:name=>headers[name.toLowerCase()]??req.get(name)});
  for(const origin of ['null','https://evil.example','http://mental.hu'])assert.throws(()=>service.protect(request({origin})),{code:'ORIGIN_REJECTED'});
  assert.throws(()=>service.protect(request({'sec-fetch-site':'cross-site'})),{code:'ORIGIN_REJECTED'});
  assert.throws(()=>service.protect({...req,cookies:{mental_provider_csrf:'b'.repeat(48)}}),{code:'FORM_EXPIRED'});
  assert.throws(()=>service.protect(request({'x-provider-csrf':Date.now()+'.'+'ő'.repeat(64)})),{code:'FORM_EXPIRED'});
  assert.throws(()=>service.protect(request({'x-provider-csrf':'1.'+'a'.repeat(64)})),{code:'FORM_EXPIRED'});
  assert.throws(()=>service.protect({...req,get:name=>name.toLowerCase()==='origin'?undefined:req.get(name)}),{code:'ORIGIN_REJECTED'});
});

test('CMS admin cookie cannot authenticate as a provider account',async()=>{
  let calls=0;
  const service=createProviderAccountService({pool:{query:async()=>{calls++;return{rows:[]};}},dbState:{ready:true},secret:'isolated-provider-csrf-secret',mailer:{ready:async()=>false,send:async()=>{},seal:x=>x,unseal:x=>x}});
  assert.equal(await service.getAccount({cookies:{mental_cms:'admin-jwt'}}),null);
  assert.equal(calls,0);
  assert.equal(await service.getAccount({cookies:{mental_provider:'../invalid-session'}}),null);
  assert.equal(calls,0);
});
