'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const sanitizeHtml = require('sanitize-html');
const slugify = require('slugify');
const { resolveArticleTopic } = require('./article-topics.cjs');

// Shares the existing editorial import lock, so an MCP draft and a Git import
// cannot both claim the same external ID, slug or primary study concurrently.
const EDITORIAL_LOCK = 6938036;
const ARTICLE_FIELDS = ['external_id','slug','title','category','excerpt','content_html','author_name',
  'hero_image_id','hero_image_path','hero_image_alt','hero_image_caption','seo_title','seo_description','featured','sources'];
const SOURCE_FIELDS = ['title','url','published_at','doi','pmid','kind'];
const CONTROLS = ['article_id','approved','expected_revision'];
const IMAGE_MIMES = new Set(['image/jpeg','image/png','image/webp','image/avif','image/gif','image/svg+xml']);

function fail(code, status = 400, details) {
  throw Object.assign(new Error(code), { code, status, ...(details ? { details } : {}) });
}
function object(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('INVALID_ARGUMENT');
  return value;
}
function text(value, max, required = false) {
  if (typeof value !== 'string' || value.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value) || (required && !value.trim())) fail('INVALID_ARTICLE_TEXT');
  return value;
}
function positiveId(value) {
  if (!/^[1-9]\d{0,15}$/.test(String(value)) || !Number.isSafeInteger(Number(value))) fail('INVALID_ARTICLE_ID');
  return String(value);
}
function externalId(value) {
  if (typeof value !== 'string' || !/^[a-z0-9][a-z0-9._:-]{5,159}$/.test(value)) fail('INVALID_EXTERNAL_ID');
  return value;
}
function expectedRevision(value) {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) fail('EXPECTED_REVISION_REQUIRED');
  return value;
}
function canonical(value) {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}
const digest = value => crypto.createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(canonical(value))).digest('hex');
const plainText = value => sanitizeHtml(value, {allowedTags:[],allowedAttributes:{}}).replace(/\s+/g,' ').trim();
function actorIdentity(actor) {
  if (typeof actor?.email !== 'string' || !actor.email.trim() || actor.email.length > 254 || typeof actor?.clientId !== 'string' || !actor.clientId || actor.clientId.length > 2048) fail('MCP_AUTH_REQUIRED', 401);
  return { email:actor.email, clientId:actor.clientId };
}
function localAsset(value, kind = 'image') {
  if (typeof value !== 'string' || value.length > 500 || value.includes('..') || value.includes('//')) fail('INVALID_MEDIA_REFERENCE');
  if (/^\/media\/[1-9]\d*$/.test(value)) return value;
  if (kind === 'image' && /^\/assets\/[a-zA-Z0-9_./-]+\.(?:jpg|jpeg|png|webp|avif|gif|svg)$/i.test(value)) return value;
  fail('INVALID_MEDIA_REFERENCE');
}
function cleanMcpArticleHtml(value) {
  return sanitizeHtml(value, {
    allowedTags:['p','h2','h3','h4','strong','em','b','i','u','blockquote','ul','ol','li','a','br','hr','figure','figcaption','img','video','source'],
    allowedAttributes:{a:['href','title','rel'],figure:['class'],figcaption:['class'],img:['src','alt','width','height','loading'],video:['src','controls','preload','playsinline','poster','aria-label'],source:['src','type']},
    allowedSchemes:['https'],allowProtocolRelative:false,
    transformTags:{
      a:(tagName,attribs)=>{
        if (attribs.href && !/^\/(?!\/)|^#|^https:\/\//i.test(attribs.href)) delete attribs.href;
        if (attribs.href?.startsWith('https://')) { try { const u=new URL(attribs.href);if(u.username||u.password)delete attribs.href; } catch { delete attribs.href; } }
        return {tagName,attribs};
      },
      img:(tagName,attribs)=>{
        if (attribs.src) localAsset(attribs.src,'image');
        for (const name of ['width','height']) if (attribs[name] && !/^\d{1,5}$/.test(attribs[name])) delete attribs[name];
        attribs.loading='lazy';return {tagName,attribs};
      },
      video:(tagName,attribs)=>{
        if (attribs.src) localAsset(attribs.src,'video');
        if (attribs.poster) localAsset(attribs.poster,'image');
        attribs.controls='';attribs.playsinline='';attribs.preload='metadata';return {tagName,attribs};
      },
      source:(tagName,attribs)=>{
        if (attribs.src) localAsset(attribs.src,'video');
        attribs.type='video/mp4';return {tagName,attribs};
      }
    }
  });
}
function normalizeSources(value = []) {
  if (!Array.isArray(value) || value.length > 20) fail('INVALID_SOURCES');
  return value.map(source=>{
    object(source);
    if (Object.keys(source).some(key=>!SOURCE_FIELDS.includes(key))) fail('UNKNOWN_SOURCE_FIELD');
    const result={title:text(source.title,500,true),url:text(source.url,2000,true),published_at:text(source.published_at||'',10),doi:text(source.doi||'',300).toLowerCase(),pmid:text(source.pmid||'',20),kind:source.kind||'peer-reviewed'};
    let url;try{url=new URL(result.url);}catch{fail('INVALID_SOURCE_URL');}
    if(url.protocol!=='https:'||url.username||url.password)fail('INVALID_SOURCE_URL');
    if(result.doi&&!/^10\.\d{4,9}\/\S+$/i.test(result.doi))fail('INVALID_DOI');
    if(result.pmid&&!/^\d{1,12}$/.test(result.pmid))fail('INVALID_PMID');
    if(result.published_at){const d=new Date(result.published_at+'T12:00:00Z');if(!/^\d{4}-\d\d-\d\d$/.test(result.published_at)||!Number.isFinite(d.getTime())||d.toISOString().slice(0,10)!==result.published_at)fail('INVALID_SOURCE_DATE');}
    if(!['peer-reviewed','preprint','institutional'].includes(result.kind))fail('INVALID_SOURCE_KIND');
    return result;
  });
}
function normalizeArticle(input) {
  const a={
    external_id:externalId(input.external_id),
    slug:text(input.slug||slugify(input.title||'',{lower:true,strict:true,locale:'hu'}).slice(0,120),120,true),
    title:text(input.title,220,true).trim(),category:text(input.category||'',80),
    excerpt:text(input.excerpt||'',800),content_html:cleanMcpArticleHtml(text(input.content_html,180000,true)),
    author_name:text(input.author_name||'MENTÁL.hu',120,true),
    hero_image_id:input.hero_image_id==null?null:positiveId(input.hero_image_id),
    hero_image_path:text(input.hero_image_path||'',500),hero_image_alt:text(input.hero_image_alt||'',300),
    hero_image_caption:text(input.hero_image_caption||'',500),seo_title:text(input.seo_title||'',240),
    seo_description:text(input.seo_description||'',500),featured:input.featured??false,sources:normalizeSources(input.sources)
  };
  if(!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(a.slug))fail('INVALID_SLUG');
  if(plainText(a.content_html).length<100)fail('ARTICLE_TOO_SHORT');
  if(typeof a.featured!=='boolean')fail('INVALID_FEATURED');
  if(a.hero_image_id&&a.hero_image_path)fail('AMBIGUOUS_HERO_IMAGE');
  if(a.hero_image_path)localAsset(a.hero_image_path,'image');
  if(a.hero_image_path.startsWith('/media/')){a.hero_image_id=positiveId(a.hero_image_path.slice(7));a.hero_image_path='';}
  a.category=resolveArticleTopic(a);
  return a;
}
function payloadFromRow(row, selectedExternalId) {
  const payload=Object.fromEntries(ARTICLE_FIELDS.map(key=>[key,row[key]]));
  payload.external_id=selectedExternalId||row.external_id||'mental-article-'+row.id;
  payload.hero_image_id=row.hero_image_id?String(row.hero_image_id):null;
  payload.hero_image_path=row.hero_image_id?'':row.hero_image_path||'';
  payload.hero_image_caption=row.hero_image_caption||'';
  payload.sources=Array.isArray(row.sources)?row.sources:[];
  return payload;
}
function stateHash(row) {
  return digest({article:payloadFromRow(row),status:row.status,published_at:row.published_at,updated_at:row.updated_at,
    content_revision:row.content_revision,primary_source_key:row.primary_source_key,external_id:row.external_id});
}
function primarySourceKey(a) {
  const first=a.sources[0];
  return !first?null:first.doi?'doi:'+first.doi:first.pmid?'pmid:'+first.pmid:'url:'+first.url;
}
function createMcpArticleService({pool,root,baseUrl='https://mental.hu'}) {
  const origin=new URL(baseUrl).origin;
  async function transaction(fn) {
    const client=await pool.connect();
    try{await client.query('BEGIN');await client.query('SELECT pg_advisory_xact_lock($1)',[EDITORIAL_LOCK]);const result=await fn(client);await client.query('COMMIT');return result;}
    catch(error){await client.query('ROLLBACK').catch(()=>{});if(error.code==='23505')fail('ARTICLE_OR_PRIMARY_SOURCE_ALREADY_EXISTS',409);throw error;}
    finally{client.release();}
  }
  async function audit(client,action,id,actor,details) {
    await client.query('INSERT INTO cms_audit_log(action,entity_type,entity_id,actor_email,details) VALUES($1,\'article\',$2,$3,$4)',[action,String(id),actor.email,JSON.stringify({...details,origin:'mcp',client_id:actor.clientId})]);
  }
  async function findArticle(client,args,lock=false) {
    object(args);
    if(args.external_id!==undefined)externalId(args.external_id);
    if(args.article_id!==undefined)positiveId(args.article_id);
    if(!args.external_id&&!args.article_id)fail('ARTICLE_SELECTOR_REQUIRED');
    const values=args.article_id?[positiveId(args.article_id)]:[args.external_id];
    const clause=args.article_id?'a.id=$1':'(a.external_id=$1 OR a.id=(SELECT article_id FROM mcp_article_drafts WHERE external_id=$1))';
    const row=(await client.query('SELECT a.* FROM articles a WHERE '+clause+(lock?' FOR UPDATE OF a':''),values)).rows[0];
    if(row&&args.external_id&&row.external_id&&row.external_id!==args.external_id)fail('ARTICLE_SELECTOR_MISMATCH',409);
    const draft=row?(await client.query('SELECT * FROM mcp_article_drafts WHERE article_id=$1'+(lock?' FOR UPDATE':''),[row.id])).rows[0]:null;
    if(!row&&args.external_id){const tombstone=(await client.query('SELECT external_id FROM mcp_article_drafts WHERE external_id=$1 AND article_id IS NULL',[args.external_id])).rows[0];if(tombstone)fail('ARTICLE_DELETED',410);}
    return {row,draft};
  }
  async function mediaReferences(client,article) {
    const references=new Map();
    const add=(url,kind)=>{localAsset(url,kind);const old=references.get(url);if(old&&old!==kind)fail('MEDIA_TYPE_MISMATCH');references.set(url,kind);};
    if(article.hero_image_id)add('/media/'+article.hero_image_id,'image');
    else if(article.hero_image_path)add(article.hero_image_path,'image');
    sanitizeHtml(article.content_html||'',{allowedTags:['img','video','source'],allowedAttributes:{img:['src'],video:['src','poster'],source:['src']},transformTags:{
      img:(tagName,attribs)=>{if(attribs.src)add(attribs.src,'image');return{tagName,attribs};},
      video:(tagName,attribs)=>{if(attribs.src)add(attribs.src,'video');if(attribs.poster)add(attribs.poster,'image');return{tagName,attribs};},
      source:(tagName,attribs)=>{if(attribs.src)add(attribs.src,'video');return{tagName,attribs};}
    }});
    const ids=[...references.keys()].filter(url=>url.startsWith('/media/')).map(url=>url.slice(7));
    const stored=ids.length?(await client.query('SELECT id,mime_type,sha256,octet_length(data) AS bytes FROM media WHERE id=ANY($1::bigint[])',[ids])).rows:[];
    const rows=new Map(stored.map(row=>[String(row.id),row]));
    const result=[];
    for(const [url,kind]of [...references].sort(([a],[b])=>a.localeCompare(b))){
      let sha256,bytes,mime;
      if(url.startsWith('/media/')){
        const item=rows.get(url.slice(7));if(!item)fail('MEDIA_NOT_FOUND',404);
        mime=item.mime_type;if((kind==='image'&&!IMAGE_MIMES.has(mime))||(kind==='video'&&mime!=='video/mp4'))fail('MEDIA_TYPE_MISMATCH');
        sha256=item.sha256;bytes=Number(item.bytes);
        if(!sha256){const data=(await client.query('SELECT data FROM media WHERE id=$1',[item.id])).rows[0]?.data;if(!data)fail('MEDIA_NOT_FOUND',404);sha256=digest(data);}
      }else{
        const assetsRoot=fs.realpathSync(path.join(root,'assets'));let file;
        try{file=fs.realpathSync(path.join(root,url.slice(1)));}catch{fail('HERO_ASSET_MISSING',404);}
        if(!file.startsWith(assetsRoot+path.sep))fail('INVALID_MEDIA_REFERENCE');
        const data=fs.readFileSync(file);sha256=digest(data);bytes=data.length;
      }
      result.push({url,kind,sha256,bytes,...(mime?{mime_type:mime}:{})});
    }
    return result;
  }
  async function review(client,payload) {
    const assets=await mediaReferences(client,payload);
    return {revision:digest({article:payload,assets}),assets};
  }
  async function describe(client,row,draft,view='current') {
    const hasDraft=draft?.status==='draft';
    const pending=hasDraft&&view!=='live';
    const payload=pending?draft.payload:payloadFromRow(row,draft?.external_id);
    const checked=await review(client,payload);
    if(pending&&checked.revision!==draft.revision)fail('DRAFT_MEDIA_CHANGED',409);
    const liveRevision=pending?(await review(client,payloadFromRow(row,draft.external_id))).revision:checked.revision;
    return {ok:true,article:{...payload,id:Number(row.id),status:pending?'draft':row.status,live_status:row.status,
      revision:checked.revision,has_pending_changes:Boolean(hasDraft&&row.status==='published'),assets:checked.assets,
      live_revision:liveRevision,pending_revision:hasDraft?draft.revision:null,base_conflict:Boolean(hasDraft&&draft.base_state_hash!==stateHash(row)),
      hero_url:payload.hero_image_id?'/media/'+payload.hero_image_id:payload.hero_image_path||null,
      preview_url:origin+'/api/admin/mcp/articles/'+encodeURIComponent(payload.external_id)+'/preview',
      url:row.status==='published'?origin+'/cikk/'+encodeURIComponent(row.slug):null,
      would_publish_to:origin+'/cikk/'+encodeURIComponent(payload.slug),published_at:row.published_at,
      updated_at:pending?draft.updated_at:row.updated_at}};
  }
  async function duplicates(client,payload,id=null) {
    const first=payload.sources[0]||{};
    const duplicate=(await client.query(`SELECT id FROM articles WHERE ($1::bigint IS NULL OR id<>$1)
      AND (external_id=$2 OR slug=$3 OR ($4::text IS NOT NULL AND primary_source_key=$4)
        OR ($5<>'' AND lower(sources->0->>'doi')=$5) OR ($6<>'' AND sources->0->>'pmid'=$6)) LIMIT 1`,
      [id,payload.external_id,payload.slug,primarySourceKey(payload),first.doi||'',first.pmid||''])).rows[0];
    if(duplicate)fail('ARTICLE_OR_PRIMARY_SOURCE_ALREADY_EXISTS',409);
    const staged=(await client.query(`SELECT article_id FROM mcp_article_drafts WHERE status='draft'
      AND article_id IS NOT NULL AND ($1::bigint IS NULL OR article_id<>$1)
      AND (external_id=$2 OR slug=$3 OR ($4::text IS NOT NULL AND primary_source_key=$4)
        OR ($5<>'' AND lower(payload->'sources'->0->>'doi')=$5) OR ($6<>'' AND payload->'sources'->0->>'pmid'=$6)) LIMIT 1`,
      [id,payload.external_id,payload.slug,primarySourceKey(payload),first.doi||'',first.pmid||''])).rows[0];
    if(staged)fail('ARTICLE_OR_PRIMARY_SOURCE_ALREADY_EXISTS',409);
    if(!id){const imported=(await client.query('SELECT import_key FROM article_import_ledger WHERE import_key=$1',['approved:'+payload.external_id])).rows[0];if(imported)fail('ARTICLE_ALREADY_PROCESSED',409);}
  }
  function rowValues(a,revision) {
    return [a.slug,a.title,a.category,a.excerpt,a.content_html,a.author_name,a.hero_image_id,a.hero_image_path,
      a.hero_image_alt,a.hero_image_caption,JSON.stringify(a.sources),a.external_id,revision,primarySourceKey(a),
      a.featured,a.seo_title,a.seo_description,Math.max(1,Math.ceil(plainText(a.content_html).split(/\s+/).length/220))];
  }
  async function writeDraft(args,actor,allowNew) {
    object(args);actor=actorIdentity(actor);
    if(args.approved!==true)fail('EXPLICIT_DRAFT_APPROVAL_REQUIRED',403);
    if(Object.keys(args).some(key=>!ARTICLE_FIELDS.includes(key)&&!CONTROLS.includes(key)))fail('UNKNOWN_ARTICLE_FIELD');
    if(!allowNew)expectedRevision(args.expected_revision);
    return transaction(async client=>{
      let {row,draft}=await findArticle(client,args,true);
      if(!row&&!allowNew)fail('ARTICLE_NOT_FOUND',404);
      if(!row&&args.article_id)fail('ARTICLE_NOT_FOUND',404);
      const stale=Boolean(row&&draft?.status==='draft'&&draft.base_state_hash!==stateHash(row));
      const livePayload=row?payloadFromRow(row,draft?.external_id):null;
      const liveRevision=stale?(await review(client,livePayload)).revision:null;
      if(stale&&args.expected_revision!==liveRevision)fail('ARTICLE_CHANGED_IN_CMS',409,{live_revision:liveRevision,current_draft_revision:draft.revision});
      const base=row?(draft?.status==='draft'&&!stale?draft.payload:livePayload):{};
      const changes=Object.fromEntries(ARTICLE_FIELDS.filter(key=>args[key]!==undefined).map(key=>[key,args[key]]));
      if(changes.hero_image_id!=null)changes.hero_image_path='';
      if(changes.hero_image_path)changes.hero_image_id=null;
      const payload=normalizeArticle({...base,...changes});
      if(row&&row.external_id&&payload.external_id!==row.external_id)fail('EXTERNAL_ID_IMMUTABLE',409);
      if(draft&&payload.external_id!==draft.external_id)fail('EXTERNAL_ID_IMMUTABLE',409);
      const checked=await review(client,payload);
      if(row&&!stale&&draft?.status==='draft'&&draft.revision===checked.revision)return {...await describe(client,row,draft),idempotent:true};
      if(row){const current=draft?.status==='draft'&&!stale?draft.revision:liveRevision||(await review(client,base)).revision;
        if(expectedRevision(args.expected_revision)!==current)fail('REVISION_CONFLICT',409,{current_revision:current});}
      await duplicates(client,payload,row?.id);
      const values=rowValues(payload,checked.revision);
      if(!row){
        row=(await client.query(`INSERT INTO articles(slug,title,category,excerpt,content_html,author_name,
          hero_image_id,hero_image_path,hero_image_alt,hero_image_caption,sources,external_id,content_revision,
          primary_source_key,featured,seo_title,seo_description,reading_minutes,status,publication_origin)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,'draft','mcp') RETURNING *`,values)).rows[0];
      }else if(row.status==='draft'){
        row=(await client.query(`UPDATE articles SET slug=$1,title=$2,category=$3,excerpt=$4,content_html=$5,
          author_name=$6,hero_image_id=$7,hero_image_path=$8,hero_image_alt=$9,hero_image_caption=$10,sources=$11,
          external_id=$12,content_revision=$13,primary_source_key=$14,featured=$15,seo_title=$16,seo_description=$17,
          reading_minutes=$18,updated_at=now() WHERE id=$19 RETURNING *`,[...values,row.id])).rows[0];
      }
      draft=(await client.query(`INSERT INTO mcp_article_drafts(external_id,article_id,slug,primary_source_key,payload,
        revision,base_state_hash,status,created_by,client_id) VALUES($1,$2,$3,$4,$5,$6,$7,'draft',$8,$9)
        ON CONFLICT(external_id) DO UPDATE SET slug=EXCLUDED.slug,primary_source_key=EXCLUDED.primary_source_key,
        payload=EXCLUDED.payload,revision=EXCLUDED.revision,base_state_hash=EXCLUDED.base_state_hash,status='draft',
        client_id=EXCLUDED.client_id,updated_at=now(),published_at=NULL RETURNING *`,
        [payload.external_id,row.id,payload.slug,primarySourceKey(payload),JSON.stringify(payload),checked.revision,stateHash(row),actor.email,actor.clientId])).rows[0];
      await audit(client,'mcp_save_draft',row.id,actor,{external_id:payload.external_id,revision:checked.revision,live_status:row.status});
      return describe(client,row,draft);
    });
  }
  async function listArticles(args={}) {
    object(args);const limit=args.limit??20,offset=args.offset??0,status=args.status??'all';
    if(!Number.isInteger(limit)||limit<1||limit>50||!Number.isInteger(offset)||offset<0||offset>100000||!['all','draft','published'].includes(status))fail('INVALID_LIST_FILTER');
    const q=text(args.q||'',200);
    const {rows}=await pool.query(`SELECT a.id,COALESCE(d.external_id,a.external_id,'mental-article-'||a.id::text) AS external_id,
      CASE WHEN d.status='draft' THEN d.payload->>'title' ELSE a.title END AS title,
      CASE WHEN d.status='draft' THEN d.payload->>'category' ELSE a.category END AS category,
      a.slug,a.status AS live_status,CASE WHEN d.status='draft' THEN 'draft' ELSE a.status END AS status,
      (d.status='draft' AND a.status='published') AS has_pending_changes,
      CASE WHEN d.status='draft' THEN d.revision ELSE NULL END AS draft_revision,a.published_at,
      greatest(a.updated_at,d.updated_at) AS updated_at,count(*) OVER()::int AS total
      FROM articles a LEFT JOIN mcp_article_drafts d ON d.article_id=a.id
      WHERE ($1='all' OR ($1='draft' AND (a.status='draft' OR d.status='draft')) OR ($1='published' AND a.status='published'))
      AND ($2='' OR a.title ILIKE $3 OR a.category ILIKE $3 OR d.payload->>'title' ILIKE $3 OR a.external_id ILIKE $3)
      ORDER BY greatest(a.updated_at,d.updated_at) DESC,a.id DESC LIMIT $4 OFFSET $5`,[status,q,'%'+q+'%',limit,offset]);
    const total=rows[0]?.total??Number((await pool.query(`SELECT count(*)::int AS total FROM articles a LEFT JOIN mcp_article_drafts d ON d.article_id=a.id
      WHERE ($1='all' OR ($1='draft' AND (a.status='draft' OR d.status='draft')) OR ($1='published' AND a.status='published'))
      AND ($2='' OR a.title ILIKE $3 OR a.category ILIKE $3 OR d.payload->>'title' ILIKE $3 OR a.external_id ILIKE $3)`,[status,q,'%'+q+'%'])).rows[0].total);
    return {ok:true,items:rows.map(({total,...row})=>({...row,id:Number(row.id),has_pending_changes:Boolean(row.has_pending_changes),url:row.live_status==='published'?origin+'/cikk/'+encodeURIComponent(row.slug):null,needs_readback:true})),total,limit,offset,next_offset:offset+rows.length<total?offset+rows.length:null};
  }
  async function getArticle(args) {
    object(args);
    if(args.view!==undefined&&!['current','live'].includes(args.view))fail('INVALID_ARTICLE_VIEW');
    const {row,draft}=await findArticle(pool,args);
    if(!row)fail('ARTICLE_NOT_FOUND',404);
    return describe(pool,row,draft,args.view);
  }
  async function publishArticle(args,actor) {
    actor=actorIdentity(actor);object(args);expectedRevision(args.expected_revision);
    if(args.confirm_publish!==true)fail('EXPLICIT_PUBLICATION_APPROVAL_REQUIRED',403);
    return transaction(async client=>{
      let {row,draft}=await findArticle(client,args,true);if(!row)fail('ARTICLE_NOT_FOUND',404);
      if(!draft)fail('SAVED_DRAFT_REQUIRED',409);
      if(draft.revision!==args.expected_revision)fail('REVISION_CONFLICT',409,{current_revision:draft.revision});
      if(draft.base_state_hash!==stateHash(row))fail('ARTICLE_CHANGED_IN_CMS',409);
      const checked=await review(client,draft.payload);if(checked.revision!==draft.revision)fail('DRAFT_MEDIA_CHANGED',409);
      if(draft.status==='published'&&row.status==='published')return {...await describe(client,row,draft),idempotent:true};
      if(draft.status!=='draft')fail('SAVED_DRAFT_REQUIRED',409);
      await duplicates(client,draft.payload,row.id);
      const values=rowValues(draft.payload,draft.revision);
      row=(await client.query(`UPDATE articles SET slug=$1,title=$2,category=$3,excerpt=$4,content_html=$5,
        author_name=$6,hero_image_id=$7,hero_image_path=$8,hero_image_alt=$9,hero_image_caption=$10,sources=$11,
        external_id=$12,content_revision=$13,primary_source_key=$14,featured=$15,seo_title=$16,seo_description=$17,
        reading_minutes=$18,status='published',published_at=COALESCE(published_at,now()),updated_at=now(),
        approved_at=now(),approval_ref='mcp:explicit-tool-confirmation' WHERE id=$19 RETURNING *`,[...values,row.id])).rows[0];
      draft=(await client.query(`UPDATE mcp_article_drafts SET status='published',base_state_hash=$2,published_at=now(),updated_at=now()
        WHERE external_id=$1 RETURNING *`,[draft.external_id,stateHash(row)])).rows[0];
      await audit(client,'mcp_publish_article',row.id,actor,{external_id:draft.external_id,revision:draft.revision,confirm_publish:true,url:origin+'/cikk/'+encodeURIComponent(row.slug)});
      return describe(client,row,draft);
    });
  }
  async function setFeatured(args,actor) {
    actor=actorIdentity(actor);object(args);expectedRevision(args.expected_revision);
    if(typeof args.featured!=='boolean')fail('INVALID_FEATURED');
    return transaction(async client=>{
      let {row,draft}=await findArticle(client,args,true);if(!row)fail('ARTICLE_NOT_FOUND',404);
      if(draft?.status==='draft')fail('PENDING_DRAFT_REQUIRES_UPDATE',409);
      const payload=payloadFromRow(row,draft?.external_id);const current=(await review(client,payload)).revision;
      if(current!==args.expected_revision)fail('REVISION_CONFLICT',409,{current_revision:current});
      if(row.featured===args.featured)return {...await describe(client,row,draft),idempotent:true};
      const revision=(await review(client,{...payload,featured:args.featured})).revision;
      row=(await client.query('UPDATE articles SET featured=$2,content_revision=$3,updated_at=now() WHERE id=$1 RETURNING *',[row.id,args.featured,revision])).rows[0];
      // The completed publication receipt is no longer the current live revision;
      // updating it also keeps a delayed publish retry from undoing this choice.
      if(draft){draft=(await client.query(`UPDATE mcp_article_drafts SET payload=$2,revision=$3,base_state_hash=$4,updated_at=now() WHERE external_id=$1 RETURNING *`,[draft.external_id,JSON.stringify({...payload,featured:args.featured}),revision,stateHash(row)])).rows[0];}
      await audit(client,'mcp_set_featured',row.id,actor,{featured:args.featured,revision});
      return describe(client,row,draft);
    });
  }
  async function getTopics() {
    const {rows}=await pool.query("SELECT category AS name,count(*) FILTER(WHERE status='published' AND (published_at IS NULL OR published_at<=now()))::int AS published_count FROM articles GROUP BY category ORDER BY category");
    return {ok:true,topics:rows};
  }
  return {listArticles,getArticle,saveDraft:(args,actor)=>writeDraft(args,actor,true),updateArticle:(args,actor)=>writeDraft(args,actor,false),publishArticle,setFeatured,getTopics};
}

module.exports={createMcpArticleService,cleanMcpArticleHtml,normalizeArticle,canonical,digest,stateHash};
