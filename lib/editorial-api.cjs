'use strict';

// Direct, owner-approved editorial publishing. No draft writes are exposed to API tokens.
// The bearer credential identifies a trusted publishing operator; it does NOT establish
// that the owner approved any given text. The operator must verify that externally.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const rateLimit = require('express-rate-limit');
const sanitizeHtml = require('sanitize-html');
const { validateApprovedPackage } = require('./editorial-import.cjs');

const LOCK_ID = 6938036;
const MAX_BODY_BYTES = 250000;

function tokenMatches(header, configured) {
  if (typeof configured !== 'string' || configured.length < 32 || typeof header !== 'string') return false;
  const match = /^Bearer ([A-Za-z0-9_~.\-]+)$/.exec(header);
  if (!match) return false;
  const a = crypto.createHash('sha256').update(match[1]).digest();
  const b = crypto.createHash('sha256').update(configured).digest();
  return crypto.timingSafeEqual(a,b);
}
function errorCode(error) {
  if (/^[A-Z][A-Z0-9_]{2,80}$/.test(error?.code || '')) return error.code;
  return 'EDITORIAL_PUBLISH_FAILED';
}
function plainText(html) {
  return sanitizeHtml(html, {allowedTags:[],allowedAttributes:{}}).replace(/\s+/g,' ').trim();
}
function registerEditorialApi(app, {pool, dbState, root, token = process.env.MENTAL_EDITORIAL_API_TOKEN}) {
  const throttle = rateLimit({windowMs:15*60*1000,limit:40,standardHeaders:true,legacyHeaders:false});
  const requirePublisher = (req,res,next) => {
    res.set('Cache-Control','no-store');
    if (!tokenMatches(req.get('authorization'), token)) return res.status(401).json({ok:false,code:'EDITORIAL_UNAUTHORIZED'});
    if (!dbState.ready) return res.status(503).json({ok:false,code:'DATABASE_UNAVAILABLE'});
    next();
  };
  const wrap = fn => async(req,res,next) => {
    try { await fn(req,res); } catch(e) {
      if (['UNKNOWN_ARTICLE_FIELD','INVALID_ARTICLE_TEXT','INVALID_SOURCE_URL','INVALID_SOURCE_DATE','INVALID_DOI','INVALID_PMID','INVALID_SOURCE_KIND','INVALID_HERO_IMAGE_PATH','INVALID_EXTERNAL_ID','INVALID_SLUG','INVALID_FEATURED','ARTICLE_TOO_SHORT','SOURCES_REQUIRED','UNKNOWN_PACKAGE_FIELD','INVALID_PACKAGE_VERSION','INVALID_APPROVAL','EXPLICIT_APPROVAL_REQUIRED','INVALID_APPROVAL_REFERENCE','INVALID_APPROVAL_TIME','APPROVAL_REVISION_MISMATCH','ARTICLE_NOT_PREPARED'].includes(e.code)) {
        return res.status(422).json({ok:false,code:e.code});
      }
      if (e.code === '23505') return res.status(409).json({ok:false,code:'ARTICLE_OR_PRIMARY_SOURCE_ALREADY_EXISTS'});
      console.error('[editorial-api]',errorCode(e));
      next(e);
    }
  };
  // No public draft creation: drafts stay in private owner storage.
  app.get('/api/editorial/articles',throttle,requirePublisher,wrap(async(req,res)=>{
    const limit=Math.min(50,Math.max(1,Number.parseInt(req.query.limit,10)||20));
    const offset=Math.max(0,Math.min(100000,Number.parseInt(req.query.offset,10)||0));
    const rows=await pool.query(`SELECT id,external_id,slug,title,status,content_revision,primary_source_key,published_at
      FROM articles ORDER BY id DESC LIMIT $1 OFFSET $2`,[limit,offset]);
    res.json({ok:true,items:rows.rows,next_offset:rows.rows.length===limit?offset+limit:null});
  }));
  app.get('/api/editorial/articles/:external_id',throttle,requirePublisher,wrap(async(req,res)=>{
    const id=String(req.params.external_id || '');
    if(!/^[a-z0-9][a-z0-9._:-]{5,159}$/.test(id))return res.status(400).json({ok:false,code:'INVALID_EXTERNAL_ID'});
    const row=await pool.query('SELECT id,external_id,slug,title,status,content_revision,primary_source_key,published_at FROM articles WHERE external_id=$1',[id]);
    if(!row.rows[0])return res.status(404).json({ok:false,code:'ARTICLE_NOT_FOUND'});
    res.json({ok:true,article:row.rows[0]});
  }));
  app.post('/api/editorial/publish',throttle,requirePublisher,wrap(async(req,res)=>{
    // An exact prepared and explicitly approved package, not a draft or a free-form CMS write.
    if (!req.is('application/json'))return res.status(415).json({ok:false,code:'JSON_REQUIRED'});
    const bytes=Buffer.byteLength(JSON.stringify(req.body ?? {}),'utf8');
    if(bytes>MAX_BODY_BYTES)return res.status(413).json({ok:false,code:'PACKAGE_TOO_LARGE'});
    const {article,approval,revision,primarySourceKey}=validateApprovedPackage(req.body);
    if(article.hero_image_path && !fs.existsSync(path.join(root,article.hero_image_path.slice(1))))
      return res.status(422).json({ok:false,code:'HERO_ASSET_MISSING'});
    const client=await pool.connect();
    try{
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock($1)',[LOCK_ID]);
      const importKey='approved:'+article.external_id;
      // Ledger survives a deletion/unpublication and prevents resurrection.
      const ledger=await client.query('SELECT revision FROM article_import_ledger WHERE import_key=$1',[importKey]);
      if(ledger.rowCount) {
        await client.query('ROLLBACK');
        return res.status(409).json({ok:false,code:'ARTICLE_ALREADY_PROCESSED'});
      }
      // Check all identifiers, not just published records.
      const duplicate=await client.query('SELECT id FROM articles WHERE external_id=$1 OR slug=$2 OR primary_source_key=$3 LIMIT 1',[article.external_id,article.slug,primarySourceKey]);
      if(duplicate.rowCount) {
        await client.query('ROLLBACK');
        return res.status(409).json({ok:false,code:'ARTICLE_OR_PRIMARY_SOURCE_ALREADY_EXISTS'});
      }
      const values=[article.slug,article.title,article.category,article.excerpt,article.content_html,
        article.author_name,article.hero_image_path,article.hero_image_alt,article.hero_image_caption,
        JSON.stringify(article.sources),article.external_id,revision,'research-watch',approval.approved_at,
        approval.reference,primarySourceKey,article.featured,article.seo_title,article.seo_description,
        Math.max(1,Math.ceil(plainText(article.content_html).split(/\s+/).length/220))];
      const inserted=await client.query(`INSERT INTO articles
        (slug,title,category,excerpt,content_html,author_name,hero_image_path,hero_image_alt,hero_image_caption,
        sources,external_id,content_revision,publication_origin,approved_at,approval_ref,primary_source_key,
        featured,seo_title,seo_description,reading_minutes,published_at,status)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,now(),'published')
        RETURNING id,slug,published_at`,values);
      const created=inserted.rows[0];
      await client.query(`INSERT INTO article_import_ledger(import_key,import_kind,source_path,revision,article_id,result)
        VALUES($1,'approved',$2,$3,$4,'imported')`,[importKey,'api:editorial',revision,created.id]);
      await client.query(`INSERT INTO cms_audit_log(action,entity_type,entity_id,actor_email,details)
        VALUES('publish_approved_article','article',$1,NULL,$2)`,[String(created.id),JSON.stringify({origin:'editorial-api',revision,approval_ref:approval.reference,import_key:importKey})]);
      await client.query('COMMIT');
      res.status(201).json({ok:true,external_id:article.external_id,revision_sha256:revision,slug:created.slug,url:'/cikk/'+encodeURIComponent(created.slug),published_at:created.published_at});
    }catch(e){await client.query('ROLLBACK').catch(()=>{});throw e;}finally{client.release();}
  }));
}
module.exports={registerEditorialApi,tokenMatches};
