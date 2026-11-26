'use strict';

const assert=require('node:assert/strict');
const test=require('node:test');
const crypto=require('node:crypto');
const path=require('node:path');
const {Pool}=require('pg');
const {createMcpArticleService,cleanMcpArticleHtml,normalizeArticle,digest}=require('../lib/mcp-articles.cjs');

const fixture=(id='mcp-test-example')=>({external_id:id,title:'Alvás és közérzet – izolált MCP-teszt',
  slug:id,category:'Kutatások',excerpt:'Törlendő, kizárólag izolált tesztadat.',
  content_html:'<p>'+('Ez az izolált tesztszöveg a szerkesztési és publikálási állapotok ellenőrzésére szolgál. '.repeat(3))+'</p>',
  author_name:'MCP teszt',sources:[]});

test('MCP normalization keeps a reviewable article, uses a topic and strips executable HTML',()=>{
  const a=normalizeArticle({...fixture(),content_html:fixture().content_html+'<script>alert(1)</script><p onclick="alert(1)">Utóirat.</p>'});
  assert.equal(a.category,'Alvás');assert(!a.content_html.includes('<script'));assert(!a.content_html.includes('onclick'));
  assert(a.content_html.includes('Utóirat.'));assert.deepEqual(a.sources,[]);
  assert.deepEqual(normalizeArticle(a),a,'Normalization is stable before revision hashing');
  assert.equal(normalizeArticle({...fixture(),hero_image_path:'/media/12'}).hero_image_id,'12');
});

test('MCP body media only references local assets or persisted media',()=>{
  const html=cleanMcpArticleHtml('<figure><img src="/media/12" alt="Kép"><video autoplay src="/media/13" poster="/media/12"></video></figure>');
  assert(html.includes('src="/media/12"'));assert(html.includes('controls'));assert(html.includes('preload="metadata"'));assert(!html.includes('autoplay'));
  for(const url of ['https://example.test/video.mp4','//example.test/x','/assets/../secret.png','file:///etc/passwd']){
    assert.throws(()=>cleanMcpArticleHtml('<video src="'+url+'"></video>'),{code:'INVALID_MEDIA_REFERENCE'});
  }
  assert.throws(()=>normalizeArticle({...fixture(),sources:[{title:'Forrás',url:'http://example.test/source'}]}),{code:'INVALID_SOURCE_URL'});
  assert.throws(()=>normalizeArticle({...fixture(),sources:[{title:'Forrás',url:'https://example.test/source',published_at:'2026-02-31'}]}),{code:'INVALID_SOURCE_DATE'});
});

test('Canonical revisions change for text, image, source and presentation changes',()=>{
  const a=normalizeArticle(fixture());const revision=digest({article:a,assets:[]});
  assert.equal(revision,digest({assets:[],article:Object.fromEntries(Object.entries(a).reverse())}));
  for(const change of [{title:'Másik cím'},{hero_image_id:'12'},{featured:true},{sources:[{title:'Forrás',url:'https://example.test/source'}]}]){
    assert.notEqual(digest({article:{...a,...change},assets:[]}),revision);
  }
  assert.notEqual(digest({article:a,assets:[{url:'/media/12',sha256:'changed'}]}),revision);
});

const databaseValue=process.env.DATABASE_URL;
if(databaseValue){
  const database=new URL(databaseValue);
  assert(['postgres:','postgresql:'].includes(database.protocol)&&['127.0.0.1','localhost','[::1]'].includes(database.hostname)&&/^\/[a-zA-Z0-9_]*test[a-zA-Z0-9_]*$/.test(database.pathname),'MCP integration tests require an isolated loopback test database');
}

test('MCP drafts, publication and media revisions remain private, atomic and retry safe',{skip:!databaseValue},async()=>{
  const pool=new Pool({connectionString:databaseValue,ssl:false});
  const runId=crypto.randomBytes(8).toString('hex');
  const id='mcp-ci-'+runId;
  const actor={email:'mcp-ci@example.test',clientId:'mcp-ci-'+runId};
  const ids=[],mediaIds=[];
  const service=createMcpArticleService({pool,root:path.resolve(__dirname,'..')});
  const expectCode=(promise,code)=>assert.rejects(promise,{code});
  const get=()=>service.getArticle({external_id:id},actor);
  const publicationCount=async()=>Number((await pool.query("SELECT count(*)::int AS count FROM cms_audit_log WHERE action='mcp_publish_article' AND details->>'external_id'=$1",[id])).rows[0].count);
  try{
    const schema=(await pool.query("SELECT to_regclass('mcp_article_drafts') AS drafts,EXISTS(SELECT 1 FROM information_schema.columns WHERE table_name='media' AND column_name='sha256') AS media_ready")).rows[0];
    assert(schema.drafts&&schema.media_ready,'Run application migrations before the MCP integration test');
    const image=Buffer.concat([Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+yP9sAAAAASUVORK5CYII=','base64'),Buffer.from(runId)]);
    const media=(await pool.query("INSERT INTO media(filename,mime_type,data,width,height,sha256,mcp_managed) VALUES($1,'image/png',$2,1,1,$3,true) RETURNING id",[id+'.png',image,digest(image)])).rows[0];
    mediaIds.push(media.id);
    const input={...fixture(id),hero_image_id:Number(media.id),hero_image_alt:'Izolált tesztkép',sources:[{title:'Izolált tesztforrás',url:'https://example.test/'+id,doi:'10.9999/'+id,pmid:'9'+String(Date.now()).slice(-10),kind:'peer-reviewed'}]};

    await expectCode(service.saveDraft({...input,approved:false},actor),'EXPLICIT_DRAFT_APPROVAL_REQUIRED');
    let result=await service.saveDraft({...input,approved:true},actor);ids.push(result.article.id);
    assert.equal(result.article.status,'draft');assert.equal(result.article.live_status,'draft');assert.equal(result.article.category,'Alvás');
    assert.equal(result.article.url,null);assert.equal(result.article.assets[0].sha256,digest(image));
    assert.equal((await pool.query('SELECT status FROM articles WHERE id=$1',[result.article.id])).rows[0].status,'draft');
    const firstRevision=result.article.revision;
    assert.equal((await service.saveDraft({...input,approved:true},actor)).idempotent,true);
    assert.equal((await get()).article.revision,firstRevision);
    assert.equal((await pool.query("SELECT count(*)::int AS count FROM cms_audit_log WHERE action='mcp_save_draft' AND entity_id=$1",[String(result.article.id)])).rows[0].count,1);
    await expectCode(service.publishArticle({external_id:id,expected_revision:firstRevision,confirm_publish:false},actor),'EXPLICIT_PUBLICATION_APPROVAL_REQUIRED');
    await expectCode(service.publishArticle({external_id:id,expected_revision:'0'.repeat(64),confirm_publish:true},actor),'REVISION_CONFLICT');
    assert.equal(await publicationCount(),0);

    result=await service.publishArticle({external_id:id,expected_revision:firstRevision,confirm_publish:true},actor);
    assert.equal(result.article.status,'published');assert.equal(result.article.revision,firstRevision);
    const originalPublishedAt=result.article.published_at;
    assert.equal((await service.publishArticle({external_id:id,expected_revision:firstRevision,confirm_publish:true},actor)).idempotent,true);
    assert.equal(await publicationCount(),1);

    result=await service.setFeatured({external_id:id,expected_revision:firstRevision,featured:true},actor);
    assert.equal(result.article.featured,true);assert.notEqual(result.article.revision,firstRevision);
    const featuredRevision=result.article.revision;
    await expectCode(service.publishArticle({external_id:id,expected_revision:firstRevision,confirm_publish:true},actor),'REVISION_CONFLICT');
    result=await service.updateArticle({external_id:id,expected_revision:featuredRevision,approved:true,title:'Javított tesztcím'},actor);
    assert.equal(result.article.status,'draft');assert.equal(result.article.live_status,'published');assert.equal(result.article.has_pending_changes,true);
    assert.equal((await pool.query('SELECT title FROM articles WHERE id=$1',[result.article.id])).rows[0].title,input.title,'Staging a revision does not change the live title');
    await expectCode(service.updateArticle({external_id:id,expected_revision:'f'.repeat(64),approved:true,title:'Elavult változat'},actor),'REVISION_CONFLICT');
    await expectCode(service.setFeatured({external_id:id,expected_revision:result.article.revision,featured:false},actor),'PENDING_DRAFT_REQUIRES_UPDATE');
    await expectCode(service.saveDraft({...input,external_id:id+'-doi',slug:id+'-doi',approved:true},actor),'ARTICLE_OR_PRIMARY_SOURCE_ALREADY_EXISTS');
    await expectCode(service.saveDraft({...input,external_id:id+'-pmid',slug:id+'-pmid',sources:[{...input.sources[0],doi:'',url:'https://example.test/other-'+id}],approved:true},actor),'ARTICLE_OR_PRIMARY_SOURCE_ALREADY_EXISTS');

    // Another editor's current content must be reviewed before explicitly rebasing.
    await pool.query("UPDATE articles SET excerpt='Közben a CMS-ben módosított kivonat.',updated_at=now() WHERE id=$1",[result.article.id]);
    await expectCode(service.publishArticle({external_id:id,expected_revision:result.article.revision,confirm_publish:true},actor),'ARTICLE_CHANGED_IN_CMS');
    const pending=await get();assert.equal(pending.article.base_conflict,true);
    const live=await service.getArticle({external_id:id,view:'live'},actor);
    assert.equal(live.article.excerpt,'Közben a CMS-ben módosított kivonat.');assert.equal(live.article.status,'published');
    result=await service.updateArticle({external_id:id,expected_revision:live.article.revision,approved:true,title:'A friss élő változat alapján javított cím'},actor);
    assert.equal(result.article.base_conflict,false);assert.equal(result.article.excerpt,live.article.excerpt);
    const pendingRevision=result.article.revision;
    result=await service.publishArticle({external_id:id,expected_revision:pendingRevision,confirm_publish:true},actor);
    assert.equal(result.article.title,'A friss élő változat alapján javított cím');
    assert.equal(new Date(result.article.published_at).toISOString(),new Date(originalPublishedAt).toISOString(),'Editing a publication retains its original date');
    assert.equal(await publicationCount(),2);

    // Image bytes are part of the revision, even when the media ID is unchanged.
    result=await service.updateArticle({external_id:id,expected_revision:result.article.revision,approved:true,title:'Képellenőrzési teszt'},actor);
    await pool.query('UPDATE media SET sha256=$2 WHERE id=$1',[media.id,digest('different image')]);
    await expectCode(service.publishArticle({external_id:id,expected_revision:result.article.revision,confirm_publish:true},actor),'DRAFT_MEDIA_CHANGED');
    await pool.query('UPDATE media SET sha256=$2 WHERE id=$1',[media.id,digest(image)]);
    assert.equal((await get()).article.revision,result.article.revision);
    const listing=await service.listArticles({q:id,status:'draft'},actor);
    assert(listing.items.some(a=>a.external_id===id&&a.has_pending_changes));
    assert((await service.getTopics()).topics.some(t=>t.name==='Alvás'));

    await pool.query('DELETE FROM articles WHERE id=$1',[result.article.id]);
    await expectCode(get(),'ARTICLE_DELETED');
    await expectCode(service.saveDraft({...input,approved:true},actor),'ARTICLE_DELETED');
    assert.equal((await pool.query('SELECT article_id FROM mcp_article_drafts WHERE external_id=$1',[id])).rows[0].article_id,null,'Deletion tombstones prevent accidental resurrection');
  }finally{
    await pool.query("DELETE FROM cms_audit_log WHERE entity_type='article' AND (actor_email=$1 AND details->>'client_id'=$2)",[actor.email,actor.clientId]);
    await pool.query('DELETE FROM mcp_article_drafts WHERE external_id LIKE $1',[id+'%']);
    await pool.query('DELETE FROM articles WHERE external_id LIKE $1',[id+'%']);
    await pool.query('DELETE FROM media WHERE id=ANY($1::bigint[])',[mediaIds]);
    await pool.end();
  }
});
