'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {tokenMatches}=require('../lib/editorial-api.cjs');
const {prepareArticle,articleRevision,validateApprovedPackage}=require('../lib/editorial-import.cjs');

test('editorial bearer token rejects absent, short and wrong credentials',()=>{
 const secret='a'.repeat(40);
 assert.equal(tokenMatches(undefined,secret),false);
 assert.equal(tokenMatches('Bearer '+secret,''),false);
 assert.equal(tokenMatches('Bearer '+secret,'short'),false);
 assert.equal(tokenMatches('Bearer '+secret,'b'.repeat(40)),false);
 assert.equal(tokenMatches('Basic '+secret,secret),false);
 assert.equal(tokenMatches('Bearer '+secret,secret),true);
});

test('only a fully approved unchanged article qualifies for publication',()=>{
 const article=prepareArticle({
  external_id:'mental-test-20261123',slug:'mental-test-article',
  title:'Validálási próbabejegyzés',category:'Kutatások',
  excerpt:'Próba.',
  content_html:'<p>'+'Tesztcikk amelynek tartalma semmilyen formában nem publikálható. '.repeat(5)+'</p>',
  sources:[{title:'Tesztforrás',url:'https://pubmed.ncbi.nlm.nih.gov/12345678/',doi:'10.1000/test',pmid:'12345678',published_at:'2026-11-23',kind:'peer-reviewed'}]
 });
 const pkg={schema_version:1,article,approval:{
  decision:'publish',method:'explicit-chat-approval',approved_by:'owner',
  approved_at:'2026-11-23T11:00:00Z',revision_sha256:articleRevision(article),
  reference:'chat-message:test-only-do-not-publish'
 }};
 assert.equal(validateApprovedPackage(pkg,new Date('2026-11-23T12:00:00Z')).revision,pkg.approval.revision_sha256);
 const changed=structuredClone(pkg);changed.article.title+=' módosítva';
 assert.throws(()=>validateApprovedPackage(changed,new Date('2026-11-23T12:00:00Z')),{code:'APPROVAL_REVISION_MISMATCH'});
 const noApproval=structuredClone(pkg);delete noApproval.approval;
 assert.throws(()=>validateApprovedPackage(noApproval,new Date('2026-11-23T12:00:00Z')));
});
