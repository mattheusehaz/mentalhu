'use strict';

const assert = require('node:assert/strict');
const {test} = require('node:test');
const {cleanProfile, listingPublic, LIMITS, FIELDS} = require('../lib/provider-profiles.cjs');

const user = {id:'42',email:'owner@example.test',display_name:'Teszt Szakember',email_verified:true,approved:false,disabled:false};
const complete = {name:'Teszt rendelő',short_description:'Pszichológiai konzultáció személyesen és online.',description:'Ez egy teszt bemutatkozás, amely kellően részletesen ismerteti a rendelő szolgáltatásait és elérhetőségét.',city:'Budapest',category_slugs:['pszichologusok']};

test('a provider draft preserves defaults and fixes contact email to the verified owner',()=>{
  const draft = cleanProfile({name:'  Teszt  '},null,user);
  assert.equal(draft.values.name,'Teszt');
  assert.equal(draft.values.email,user.email);
  assert.equal(draft.values.kind,'provider');
  assert.equal(draft.values.languages,'Magyar');
  assert.equal(draft.values.online_available,false);
  assert.deepEqual(draft.categories,[]);
  assert.equal(draft.action,'save');
  assert.equal(cleanProfile({...complete,email:' OWNER@EXAMPLE.TEST '},null,user).values.email,user.email);
  assert.throws(()=>cleanProfile({...complete,email:'someone-else@example.test'},null,user),{code:'EMAIL_NOT_VERIFIED'});
  assert.throws(()=>cleanProfile({...complete,email:''},null,user),{code:'EMAIL_NOT_VERIFIED'});
});

test('provider requests cannot take over IDs, slugs, publication flags or moderator fields',()=>{
  for(const [field,value] of Object.entries({id:123,account_id:123,provider_account_id:123,listing_id:123,slug:'someone-else',status:'published',verified:true,featured:true,admin_notes:'ignored',approved_at:'2026-11-26',password_hash:'hash',source_url:'https://example.test'})){
    assert.throws(()=>cleanProfile({...complete,[field]:value},null,user),{code:'FIELD_NOT_ALLOWED'},field);
  }
  assert.throws(()=>cleanProfile({...complete,action:'delete'},null,user),{code:'INVALID_ACTION'});
  for(const bad of [null,[],false,'profile'])assert.throws(()=>cleanProfile(bad,null,user),{code:'INVALID_PROFILE'});
});

test('field, category and outbound URL validation reject malformed input',()=>{
  for(const categories of ['pszichologusok',['pszichologusok','pszichologusok'],['../admin'],[123],['a','b','c','d','e','f']]){
    assert.throws(()=>cleanProfile({...complete,category_slugs:categories},null,user),{code:'INVALID_CATEGORIES'});
  }
  for(const url of ['javascript:alert(1)','data:text/html,test','https://name:password@example.test','https://example.test/a b','example.test']){
    assert.throws(()=>cleanProfile({...complete,website_url:url},null,user),{code:'INVALID_URL'});
  }
  assert.equal(cleanProfile({...complete,website_url:'https://example.test/path?subject=hello'},null,user).values.website_url,'https://example.test/path?subject=hello');
  assert.throws(()=>cleanProfile({...complete,name:'x'.repeat(LIMITS.name+1)},null,user),{code:'INVALID_FIELD'});
  assert.throws(()=>cleanProfile({...complete,description:'bad\u0000value'},null,user),{code:'INVALID_FIELD'});
  assert.throws(()=>cleanProfile({...complete,online_available:'true'},null,user),{code:'INVALID_FIELD'});
  assert.throws(()=>cleanProfile({...complete,kind:'admin'},null,user),{code:'INVALID_KIND'});
});

test('publishing requires approval and complete content, while saving retains fields',()=>{
  assert.throws(()=>cleanProfile({...complete,action:'publish'},null,user),{code:'APPROVAL_REQUIRED',httpStatus:403});
  const approved={...user,approved:true};
  assert.equal(cleanProfile({...complete,action:'publish'},null,approved).action,'publish');
  for(const change of [{description:'short'},{short_description:'short'},{city:'',online_available:false},{category_slugs:[]}]){
    assert.throws(()=>cleanProfile({...complete,...change,action:'submit'},null,user),{code:'INCOMPLETE_PROFILE'});
  }
  const previous={...complete,status:'published',website_url:'https://example.test',online_available:true};
  const save=cleanProfile({phone:'+36 1 555 0100'},previous,approved);
  assert.equal(save.values.name,complete.name);
  assert.equal(save.values.website_url,'https://example.test');
  assert.equal(save.values.phone,'+36 1 555 0100');
  assert.deepEqual(save.categories,complete.category_slugs);
  assert.throws(()=>cleanProfile({description:'short'},previous,approved),{code:'INCOMPLETE_PROFILE'});
  assert.equal(cleanProfile({action:'unpublish'},previous,approved).action,'unpublish');
});

test('provider responses expose edit fields but never internal moderation or password data',()=>{
  assert.equal(listingPublic(null),null);
  const listing=listingPublic({...complete,id:'7',slug:'teszt-rendelo',status:'draft',email:user.email,admin_notes:'private',password_hash:'secret',verified:true,featured:true,source_url:'private-source'});
  assert.equal(listing.url,'/szolgaltato/teszt-rendelo');
  assert.equal(listing.email,user.email);
  assert.deepEqual(Object.keys(listing).sort(),['id','slug','status',...FIELDS,'category_slugs','url'].sort());
  for(const field of ['admin_notes','password_hash','verified','featured','source_url'])assert.equal(Object.hasOwn(listing,field),false);
});
