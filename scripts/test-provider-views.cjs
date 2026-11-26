'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {renderProviderPage,PAGES}=require('../lib/provider-views.cjs');
const {siteHeader}=require('../lib/site-shell.cjs');

test('provider account pages are private-indexed and expose no editorial-admin entry',()=>{
 for(const mode of ['login','register','forgot','reset','account']){
  const page=renderProviderPage(mode);
  assert.match(page,/<meta name="robots" content="noindex, nofollow">/);
  assert(page.includes('data-provider-page="'+mode+'"'));
  assert(page.includes('href="https://mental.hu'+PAGES[mode].path+'"'));
  assert.doesNotMatch(page,/href="\/admin(?:\/|"|\?)/);
  const scripts=[...page.matchAll(/<script\b[^>]*src="([^"]+)"/g)].map(match=>match[1]);
  assert(scripts.every(src=>src.startsWith('/')&&!src.startsWith('//')));
 }
});
test('registration requests email ownership before activating a password',()=>{
 const page=renderProviderPage('register');
 const register=page.match(/<form id="providerRegisterForm"[\s\S]*?<\/form>/)[0];
 assert.match(register,/name="email" type="email"/);
 assert.match(register,/name="consent" type="checkbox" required/);
 assert.doesNotMatch(register,/type="password"/);
 assert.match(page,/<form id="providerActivationForm"[^>]*hidden>/);
 assert.match(page,/id="providerActivationEmail"[^>]*readonly/);
 assert.match(page,/id="providerActivationConsent"[^>]*type="checkbox"[^>]*required/);
});
test('own-profile editor does not grant editorial controls or editable verified recipient address',()=>{
 const page=renderProviderPage('account');
 assert.match(page,/id="providerProfile_email"[^>]*readonly/);
 assert.doesNotMatch(page,/<(?:input|select|textarea)[^>]*name="(?:id|account_id|owner_id|status|verified|featured|admin_notes|profile_image_id)"/);
 assert.match(page,/id="providerPublish"[^>]*hidden>/);
 assert.match(page,/id="providerUnpublish"[^>]*hidden>/);
 assert.match(page,/id="providerAccountBody"[^>]*hidden>/);
});
test('page form identifiers and described-by references are unambiguous',()=>{
 for(const mode of Object.keys(PAGES)){
  const page=renderProviderPage(mode);
  const ids=[...page.matchAll(/\bid="([^"]+)"/g)].map(match=>match[1]);
  assert.equal(new Set(ids).size,ids.length,mode+' contains duplicate HTML ids');
  for(const match of page.matchAll(/aria-describedby="([^"]+)"/g)){
   for(const id of match[1].split(/\s+/))assert(ids.includes(id),mode+' missing described-by target '+id);
  }
 }
});
test('public header offers provider login and registration without restoring admin login',()=>{
 const header=siteHeader();
 assert.match(header,/class="header-login" href="\/belepes">Belépés/);
 assert.match(header,/href="\/regisztracio">Szolgáltatói regisztráció/);
 assert.doesNotMatch(header,/href="\/admin/);
 assert.throws(()=>renderProviderPage('administrator'),/Unknown provider page/);
});
