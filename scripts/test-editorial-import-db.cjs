'use strict';

// Integration fixtures are restricted to a disposable loopback test database.
// No production endpoint or email service is used by this test.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { Pool } = require('pg');
const { buildDatabaseConfig } = require('../lib/database-config.cjs');
const { prepareArticle, articleRevision, importApprovedArticles, importLegacyArticles } = require('../lib/editorial-import.cjs');

const database = new URL(process.env.DATABASE_URL || 'http://invalid');
assert(['postgres:', 'postgresql:'].includes(database.protocol) && ['127.0.0.1', 'localhost', '[::1]'].includes(database.hostname) && /^\/[a-zA-Z0-9_]*test[a-zA-Z0-9_]*$/.test(database.pathname), 'Disposable local test database required');
const pool = new Pool(buildDatabaseConfig());
const runId = crypto.randomBytes(8).toString('hex');
const externalId = 'ci-editorial-' + runId;
const duplicateId = externalId + '-duplicate';
const legacySlug = 'ci-legacy-' + runId;
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mental-editorial-db-'));
const approvedDir = path.join(root, 'content/approved-articles');
fs.mkdirSync(approvedDir, {recursive:true});
const originalFile = path.join(approvedDir, externalId + '.json');
const logger = {error:()=>{}};
const ids = [];
const importKeys = ['approved:' + externalId, 'approved:' + duplicateId, 'legacy:' + legacySlug + '.html'];

function fixture(id = externalId) {
  return prepareArticle({
    external_id:id,slug:id,title:'Izolált tesztcikk – nem kutatási eredmény',category:'Kutatások',
    excerpt:'Kizárólag helyi, törlendő adatbázisteszt.',
    content_html:'<p>' + 'Ez a tartalom kizárólag az izolált tesztadatbázisban vizsgálja a publikálási folyamatot. '.repeat(3) + '</p>',
    sources:[{title:'Helyi tesztforrás',url:'https://example.test/research/' + runId,doi:'10.9999/ci-editorial-' + runId,kind:'peer-reviewed'}]
  });
}
function approved(article) {
  return {schema_version:1,article,approval:{decision:'publish',method:'explicit-chat-approval',approved_by:'owner',approved_at:new Date().toISOString(),revision_sha256:articleRevision(article),reference:'chat-message:isolated-test-' + runId}};
}
const write = (filename, value) => fs.writeFileSync(filename, JSON.stringify(value, null, 2));
const runApproved = () => importApprovedArticles({pool,root,logger});

(async()=>{
  const ready = await pool.query("SELECT to_regclass('articles') AS articles,to_regclass('article_import_ledger') AS ledger");
  assert(ready.rows[0].articles && ready.rows[0].ledger, 'Run the application migrations before this integration test');

  // Missing approval is rejected before any publication or audit insert.
  write(originalFile, {schema_version:1,article:fixture()});
  let result = await runApproved();
  assert.equal(result.imported,0);assert.equal(result.errors[0].code,'INVALID_APPROVAL');
  assert.equal((await pool.query('SELECT count(*)::int AS count FROM articles WHERE external_id=$1',[externalId])).rows[0].count,0);

  // A pinned, approved package creates one public record and an audit trail.
  const packageData = approved(fixture());
  write(originalFile, packageData);
  result = await runApproved();
  assert.equal(result.imported,1);assert.deepEqual(result.errors,[]);
  const stored = (await pool.query('SELECT * FROM articles WHERE external_id=$1',[externalId])).rows[0];
  ids.push(stored.id);
  assert.equal(stored.status,'published');assert.equal(stored.publication_origin,'research-watch');
  assert.equal(stored.content_revision,packageData.approval.revision_sha256);
  assert.equal(stored.content_html,packageData.article.content_html);
  assert.equal(stored.approval_ref,packageData.approval.reference);
  assert.equal(stored.primary_source_key,'doi:10.9999/ci-editorial-' + runId);
  assert.deepEqual(stored.sources,packageData.article.sources);
  const audit = (await pool.query("SELECT details FROM cms_audit_log WHERE action='publish_approved_article' AND entity_type='article' AND entity_id=$1",[String(stored.id)])).rows;
  assert.equal(audit.length,1);assert.equal(audit[0].details.revision,stored.content_revision);

  // A redeploy is idempotent and does not create another audit publication.
  result = await runApproved();
  assert.equal(result.imported,0);assert.equal(result.skipped,1);assert.deepEqual(result.errors,[]);
  assert.equal((await pool.query('SELECT count(*)::int AS count FROM articles WHERE external_id=$1',[externalId])).rows[0].count,1);
  assert.equal((await pool.query("SELECT count(*)::int AS count FROM cms_audit_log WHERE action='publish_approved_article' AND entity_id=$1",[String(stored.id)])).rows[0].count,1);

  // A new external ID cannot duplicate the same primary study.
  const duplicateFile = path.join(approvedDir,duplicateId + '.json');
  write(duplicateFile,approved(fixture(duplicateId)));
  result = await runApproved();
  assert.equal(result.imported,0);assert.equal(result.errors.length,1);
  assert.equal(result.errors[0].code,'ARTICLE_OR_PRIMARY_SOURCE_ALREADY_EXISTS');
  assert.equal((await pool.query('SELECT count(*)::int AS count FROM articles WHERE external_id=$1',[duplicateId])).rows[0].count,0);
  fs.unlinkSync(duplicateFile);

  // A changed body cannot reuse the original approval.
  const changed = structuredClone(packageData);
  changed.article.content_html += '<p>A jóváhagyás utáni változtatás.</p>';
  write(originalFile,changed);
  result = await runApproved();
  assert.equal(result.imported,0);assert.equal(result.errors[0].code,'APPROVAL_REVISION_MISMATCH');
  assert.equal((await pool.query('SELECT content_html FROM articles WHERE id=$1',[stored.id])).rows[0].content_html,packageData.article.content_html);

  // Even a separately pinned replacement cannot mutate an immutable import ID.
  write(originalFile,approved(changed.article));
  result = await runApproved();
  assert.equal(result.imported,0);assert.equal(result.errors[0].code,'IMMUTABLE_APPROVED_PACKAGE_CHANGED');
  write(originalFile,packageData);

  // An editor's later unpublish/edit wins over the repository import.
  await pool.query("UPDATE articles SET status='draft',content_html='<p>Szerkesztői módosítás.</p>' WHERE id=$1",[stored.id]);
  result = await runApproved();
  assert.equal(result.skipped,1);assert.deepEqual(result.errors,[]);
  const edited=(await pool.query('SELECT status,content_html FROM articles WHERE id=$1',[stored.id])).rows[0];
  assert.equal(edited.status,'draft');assert.equal(edited.content_html,'<p>Szerkesztői módosítás.</p>');

  // Deletion retains the ledger and a redeploy must not resurrect the record.
  await pool.query('DELETE FROM articles WHERE id=$1',[stored.id]);
  assert.equal((await pool.query('SELECT article_id FROM article_import_ledger WHERE import_key=$1',[importKeys[0]])).rows[0].article_id,null);
  result = await runApproved();
  assert.equal(result.skipped,1);assert.equal(result.imported,0);
  assert.equal((await pool.query('SELECT count(*)::int AS count FROM articles WHERE external_id=$1',[externalId])).rows[0].count,0);

  // Legacy imports also preserve an existing CMS draft and deletion tombstone.
  fs.mkdirSync(path.join(root,'cikkek'));
  fs.copyFileSync(path.join(__dirname,'../cikkek/a-szorongas-nem-mindig-latvanyos.html'),path.join(root,'cikkek',legacySlug + '.html'));
  const legacy = (await pool.query("INSERT INTO articles(slug,title,category,content_html,status) VALUES($1,'Már szerkesztett cím','Teszt','<p>Megőrzendő tartalom.</p>','draft') RETURNING id",[legacySlug])).rows[0];
  ids.push(legacy.id);
  result = await importLegacyArticles({pool,root,logger});
  assert.equal(result.skipped,1);assert.equal(result.imported,0);assert.deepEqual(result.errors,[]);
  const preserved = (await pool.query('SELECT title,content_html,status FROM articles WHERE id=$1',[legacy.id])).rows[0];
  assert.deepEqual(preserved,{title:'Már szerkesztett cím',content_html:'<p>Megőrzendő tartalom.</p>',status:'draft'});
  await pool.query('DELETE FROM articles WHERE id=$1',[legacy.id]);
  result = await importLegacyArticles({pool,root,logger});
  assert.equal(result.skipped,1);assert.equal(result.imported,0);
  assert.equal((await pool.query('SELECT count(*)::int AS count FROM articles WHERE slug=$1',[legacySlug])).rows[0].count,0);

  console.log(JSON.stringify({ok:true,approvedPublication:true,audit:true,idempotent:true,doiDeduplication:true,revisionGuard:true,immutableImports:true,ownerEditsPreserved:true,deletionNotResurrected:true,legacyDraftPreserved:true,productionArticlesCreated:0}));
})().catch(error=>{console.error(error);process.exitCode=1;}).finally(async()=>{
  try {
    await pool.query("DELETE FROM cms_audit_log WHERE entity_type='article' AND (entity_id=ANY($1::text[]) OR details->>'import_key'=ANY($2::text[]))",[ids.map(String),importKeys]);
    await pool.query('DELETE FROM article_import_ledger WHERE import_key=ANY($1::text[])',[importKeys]);
    await pool.query('DELETE FROM articles WHERE external_id=ANY($1::text[]) OR slug=ANY($2::text[])',[[externalId,duplicateId],[externalId,duplicateId,legacySlug]]);
  } finally {
    await pool.end();
    fs.rmSync(root,{recursive:true,force:true});
  }
});
