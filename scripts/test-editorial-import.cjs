'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { prepareArticle, articleRevision, validateApprovedPackage, legacyArticle, importApprovedArticles } = require('../lib/editorial-import.cjs');

// These fixtures are never published or written to content/approved-articles.
function article() {
  return prepareArticle({ external_id:'test-research-20261123',slug:'test-research',title:'Tesztcikk',category:'Kutatások',excerpt:'Teszt bevezető.',content_html:'<p>' + 'Ellenőrzött tesztszöveg kizárólag az automatikus teszthez. '.repeat(4) + '</p>',sources:[{title:'Tesztforrás',url:'https://pubmed.ncbi.nlm.nih.gov/12345678/',doi:'10.1000/test',published_at:'2026-11-22',kind:'peer-reviewed'}]});
}
function approved(a = article()) { return {schema_version:1,article:a,approval:{decision:'publish',method:'explicit-chat-approval',approved_by:'owner',approved_at:'2026-11-23T10:00:00Z',revision_sha256:articleRevision(a),reference:'chat-message:test-fixture-only'}}; }
const now = new Date('2026-11-23T12:00:00Z');

test('approval binds every reviewed field including source and image metadata', () => {
  const original = approved();
  assert.equal(validateApprovedPackage(original, now).revision, original.approval.revision_sha256);
  for (const mutate of [a=>a.title+='!', a=>a.content_html+='<p>Hozzáadott mondat.</p>', a=>a.sources[0].title+='!', a=>a.hero_image_caption='Más képaláírás']) {
    const changed = structuredClone(original); mutate(changed.article);
    assert.throws(()=>validateApprovedPackage(changed, now), {code:'APPROVAL_REVISION_MISMATCH'});
  }
  const reordered = Object.fromEntries(Object.entries(original.article).reverse());
  assert.equal(articleRevision(reordered), original.approval.revision_sha256);
});

test('approval must be explicit, current and attached to a prepared payload', () => {
  const noApproval = approved(); delete noApproval.approval;
  assert.throws(()=>validateApprovedPackage(noApproval, now));
  const implicit = approved(); implicit.approval.method='scheduled';
  assert.throws(()=>validateApprovedPackage(implicit, now), {code:'EXPLICIT_APPROVAL_REQUIRED'});
  const future = approved(); future.approval.approved_at='2026-11-24T10:00:00Z';
  assert.throws(()=>validateApprovedPackage(future, now), {code:'INVALID_APPROVAL_TIME'});
  const unprepared = approved(); unprepared.article.content_html += '<script>alert(1)</script>';
  assert.throws(()=>validateApprovedPackage(unprepared, now), {code:'ARTICLE_NOT_PREPARED'});
});

test('unsafe URLs, image traversal and invalid dates cannot enter a research package', () => {
  for (const url of ['javascript:alert(1)','http://example.com','https://user:password@example.com','https://127.0.0.1/private','//example.com']) {
    const a=article(); a.sources[0].url=url; assert.throws(()=>prepareArticle(a));
  }
  const a=article(); a.hero_image_path='/assets/../secrets.png';
  assert.throws(()=>prepareArticle(a), {code:'INVALID_HERO_IMAGE_PATH'});
  const b=article(); b.sources[0].published_at='2026-02-30';
  assert.throws(()=>prepareArticle(b), {code:'INVALID_SOURCE_DATE'});
});

test('all legacy articles retain complete content, known dates and illustration disclosures', () => {
  const root=path.join(__dirname,'..','cikkek');
  const articles=fs.readdirSync(root).filter(x=>x.endsWith('.html')).map(file=>legacyArticle(fs.readFileSync(path.join(root,file),'utf8'),file));
  assert.equal(articles.length,10);
  assert.equal(articles.filter(a=>a.published_at==='2026-09-10T12:00:00Z').length,8);
  assert.equal(articles.find(a=>a.slug==='amikor-elfaradunk-egymasban').published_at,null);
  for (const a of articles) { assert.ok(a.content_html.length>1000); assert.ok(a.hero_image_path.startsWith('/assets/')); assert.doesNotMatch(a.content_html,/<script|onload=|onclick=/i); }
  assert.match(articles.find(a=>a.slug==='a-szorongas-nem-mindig-latvanyos').hero_image_caption,/MI-generált/);
  assert.match(articles.find(a=>a.slug==='a-szorongas-nem-mindig-latvanyos').content_html,/Ezt az árat is érdemes komolyan venni/);
});

test('no approval directory is a harmless no-op; invalid files cannot reach the database', async () => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'mental-editorial-'));
  const pool={connect:()=>{throw new Error('invalid payload must never reach database');}};
  const logger={error:()=>{}};
  try {
    assert.deepEqual(await importApprovedArticles({pool,root,logger,now}),{imported:0,skipped:0,errors:[]});
    fs.mkdirSync(path.join(root,'content/approved-articles'),{recursive:true});
    fs.writeFileSync(path.join(root,'content/approved-articles/unapproved.json'),JSON.stringify({schema_version:1,article:article()}));
    const result=await importApprovedArticles({pool,root,logger,now});
    assert.equal(result.imported,0); assert.equal(result.errors.length,1); assert.equal(result.errors[0].code,'INVALID_APPROVAL');
  } finally { fs.rmSync(root,{recursive:true,force:true}); }
});
