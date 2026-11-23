'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const sanitizeHtml = require('sanitize-html');

const APPROVED_DIRECTORY = 'content/approved-articles';
const LOCK_ID = 6938036;
const MAX_PACKAGE_BYTES = 250000;
const ARTICLE_FIELDS = ['external_id','slug','title','category','excerpt','content_html','author_name','hero_image_path','hero_image_alt','hero_image_caption','seo_title','seo_description','featured','sources'];
const SOURCE_FIELDS = ['title','url','published_at','doi','pmid','kind'];
const APPROVAL_FIELDS = ['decision','method','approved_by','approved_at','revision_sha256','reference'];

function invalid(code) { return Object.assign(new Error(code), { code }); }
function object(value, code) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid(code);
  return value;
}
function keys(value, allowed, code) {
  object(value, code);
  if (Object.keys(value).some(key => !allowed.includes(key))) throw invalid(code);
}
function text(value, max, required = false) {
  if (typeof value !== 'string' || value.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value) || (required && !value.trim())) throw invalid('INVALID_ARTICLE_TEXT');
  return value;
}
function safeSourceUrl(value) {
  text(value, 2000, true);
  let url;
  try { url = new URL(value); } catch { throw invalid('INVALID_SOURCE_URL'); }
  if (url.protocol !== 'https:' || url.username || url.password || /\s/.test(value) || /^(localhost|127\.|0\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|\[)/i.test(url.hostname) || /\.(localhost|internal|local)$/i.test(url.hostname)) throw invalid('INVALID_SOURCE_URL');
  return value;
}
function imagePath(value) {
  text(value, 500);
  if (value && (!/^\/assets\/[a-zA-Z0-9_./-]+\.(?:jpg|jpeg|png|webp|avif|svg)$/i.test(value) || value.includes('..') || value.includes('//'))) throw invalid('INVALID_HERO_IMAGE_PATH');
  return value;
}
function dateOnly(value) {
  if (value === '') return value;
  const parsed = new Date(value + 'T12:00:00Z');
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) throw invalid('INVALID_SOURCE_DATE');
  return value;
}
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}
function digest(value) { return crypto.createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(canonical(value))).digest('hex'); }

function cleanArticleHtml(value) {
  return sanitizeHtml(value, {
    allowedTags: ['p','h2','h3','h4','strong','em','b','i','u','blockquote','ul','ol','li','a','br','hr','figure','figcaption'],
    allowedAttributes: { a: ['href','title','rel'] },
    allowedSchemes: ['https'],
    allowProtocolRelative: false,
    transformTags: {
      a: (tagName, attributes) => {
        const href = attributes.href || '';
        if (href && !href.startsWith('#') && !/^\/(?!\/)/.test(href)) {
          try { safeSourceUrl(href); } catch { delete attributes.href; }
        }
        return { tagName, attribs: attributes };
      }
    }
  });
}

// Produce this normalized, sanitized payload BEFORE showing it for approval.
// The hash covers all of these fields, including each source and image credit.
function prepareArticle(input) {
  keys(input, ARTICLE_FIELDS, 'UNKNOWN_ARTICLE_FIELD');
  const a = {
    external_id: text(input.external_id, 160, true),
    slug: text(input.slug, 120, true),
    title: text(input.title, 220, true),
    category: text(input.category || 'Kutatások', 80, true),
    excerpt: text(input.excerpt || '', 800),
    content_html: cleanArticleHtml(text(input.content_html, 120000, true)),
    author_name: text(input.author_name || 'MENTÁL.hu', 120, true),
    hero_image_path: imagePath(input.hero_image_path || ''),
    hero_image_alt: text(input.hero_image_alt || '', 300),
    hero_image_caption: text(input.hero_image_caption || '', 500),
    seo_title: text(input.seo_title || '', 240),
    seo_description: text(input.seo_description || '', 500),
    featured: input.featured === undefined ? false : input.featured,
    sources: []
  };
  if (!/^[a-z0-9][a-z0-9._:-]{5,159}$/.test(a.external_id)) throw invalid('INVALID_EXTERNAL_ID');
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(a.slug)) throw invalid('INVALID_SLUG');
  if (typeof a.featured !== 'boolean') throw invalid('INVALID_FEATURED');
  if (plainText(a.content_html).length < 100) throw invalid('ARTICLE_TOO_SHORT');
  if (!Array.isArray(input.sources) || input.sources.length < 1 || input.sources.length > 20) throw invalid('SOURCES_REQUIRED');
  a.sources = input.sources.map(source => {
    keys(source, SOURCE_FIELDS, 'UNKNOWN_SOURCE_FIELD');
    const result = {
      title: text(source.title, 500, true), url: safeSourceUrl(source.url),
      published_at: dateOnly(source.published_at || ''),
      doi: text(source.doi || '', 300).toLowerCase(),
      pmid: text(source.pmid || '', 20), kind: source.kind || 'peer-reviewed'
    };
    if (result.doi && !/^10\.\d{4,9}\/\S+$/i.test(result.doi)) throw invalid('INVALID_DOI');
    if (result.pmid && !/^\d{1,12}$/.test(result.pmid)) throw invalid('INVALID_PMID');
    if (!['peer-reviewed','preprint','institutional'].includes(result.kind)) throw invalid('INVALID_SOURCE_KIND');
    return result;
  });
  return a;
}
function articleRevision(article) { return digest(prepareArticle(article)); }
function primarySourceKey(article) {
  const first = article.sources[0];
  return first.doi ? 'doi:' + first.doi : first.pmid ? 'pmid:' + first.pmid : 'url:' + first.url;
}

function validateApprovedPackage(input, now = new Date()) {
  keys(input, ['schema_version','article','approval'], 'UNKNOWN_PACKAGE_FIELD');
  if (input.schema_version !== 1) throw invalid('INVALID_PACKAGE_VERSION');
  const article = prepareArticle(input.article);
  // Require the exact payload that was reviewed, not a lossy normalization on
  // the publishing side. Reordering object keys does not change the revision.
  if (JSON.stringify(canonical(article)) !== JSON.stringify(canonical(input.article))) throw invalid('ARTICLE_NOT_PREPARED');
  keys(input.approval, APPROVAL_FIELDS, 'INVALID_APPROVAL');
  const approval = input.approval;
  if (approval.decision !== 'publish' || approval.method !== 'explicit-chat-approval' || approval.approved_by !== 'owner') throw invalid('EXPLICIT_APPROVAL_REQUIRED');
  text(approval.reference, 500, true);
  if (!/^chat(?:-message|-approval)?:\S.{0,480}$/.test(approval.reference)) throw invalid('INVALID_APPROVAL_REFERENCE');
  if (typeof approval.approved_at !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(approval.approved_at)) throw invalid('INVALID_APPROVAL_TIME');
  const approvedAt = new Date(approval.approved_at);
  if (!Number.isFinite(approvedAt.getTime()) || approvedAt.getTime() > now.getTime() + 60000) throw invalid('INVALID_APPROVAL_TIME');
  const revision = digest(article);
  if (approval.revision_sha256 !== revision) throw invalid('APPROVAL_REVISION_MISMATCH');
  return { article, approval, revision, primarySourceKey: primarySourceKey(article) };
}

function decodeText(value) {
  return value.replace(/&#(x[0-9a-f]+|\d+);|&(amp|lt|gt|quot|apos|nbsp);/gi, (match, numeric, named) => {
    if (numeric) { const point = numeric[0].toLowerCase() === 'x' ? parseInt(numeric.slice(1), 16) : parseInt(numeric, 10); return point <= 0x10ffff ? String.fromCodePoint(point) : match; }
    return { amp:'&',lt:'<',gt:'>',quot:'"',apos:"'",nbsp:' ' }[named.toLowerCase()];
  });
}
function plainText(value) { return decodeText(sanitizeHtml(value, { allowedTags: [], allowedAttributes: {} })).replace(/\s+/g, ' ').trim(); }
function capture(html, regex, fallback = '') { return html.match(regex)?.[1] || fallback; }
function legacyBody(html) {
  const open = /<div\b[^>]*class="article-body"[^>]*>/i.exec(html);
  if (!open) throw invalid('LEGACY_BODY_MISSING');
  const start = open.index + open[0].length;
  const tags = /<\/?div\b[^>]*>/gi;
  tags.lastIndex = start;
  let depth = 1, match;
  while ((match = tags.exec(html))) {
    if (/^<div\b[^>]*class="author-card"/i.test(match[0])) return html.slice(start, match.index);
    depth += /^<\//.test(match[0]) ? -1 : 1;
    if (depth === 0) return html.slice(start, match.index);
  }
  throw invalid('LEGACY_BODY_UNCLOSED');
}
function legacyArticle(html, filename) {
  const slug = path.basename(filename, '.html');
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) throw invalid('INVALID_LEGACY_SLUG');
  const date = capture(html, /<time\b[^>]*datetime="(\d{4}-\d\d-\d\d)"/i) || capture(html, /"datePublished"\s*:\s*"(\d{4}-\d\d-\d\d)"/i);
  if (date) dateOnly(date);
  const heroBlock = capture(html, /<figure\b[^>]*class="article-cover"[^>]*>([\s\S]*?)<\/figure>/i) || capture(html, /<div\b[^>]*class="question-layout"[^>]*>([\s\S]*?)<div\b[^>]*class="article-layout"/i);
  const category = plainText(capture(html, /<div\b[^>]*class="article-kicker"[^>]*>([\s\S]*?)<\/div>/i, 'Önismeret'));
  const labels = { 'ÖNISMERET':'Önismeret', 'KAPCSOLATOK':'Kapcsolatok', 'CSALÁD':'Család', 'TEST ÉS LÉLEK':'Test és lélek', 'MUNKA':'Munka', 'KÉRDÉS ÉS VÁLASZ':'Kérdés és válasz' };
  const content = cleanArticleHtml(legacyBody(html).replace(/href="(?:\.\.\/)?cikkek\/([a-z0-9-]+)\.html"/g, 'href="/cikk/$1"').replace(/href="([a-z0-9-]+)\.html"/g, 'href="/cikk/$1"').replace(/href="\.\.\/(assets|rovatok)\//g, 'href="/$1/'));
  return {
    slug, title: plainText(capture(html, /<h1\b[^>]*>([\s\S]*?)<\/h1>/i, slug)),
    category: labels[category] || category,
    excerpt: plainText(capture(html, /<p\b[^>]*class="article-lead"[^>]*>([\s\S]*?)<\/p>/i)),
    content_html: content, author_name: 'MENTÁL.hu',
    hero_image_path: imagePath(capture(heroBlock, /<img\b[^>]*src="([^"]+)"/i).replace(/^\.\.\//, '/')),
    hero_image_alt: plainText(capture(heroBlock, /<img\b[^>]*alt="([^"]*)"/i)),
    hero_image_caption: plainText(capture(heroBlock, /<figcaption\b[^>]*>([\s\S]*?)<\/figcaption>/i) || capture(heroBlock, /<p\b[^>]*class="image-note"[^>]*>([\s\S]*?)<\/p>/i)),
    published_at: date ? date + 'T12:00:00Z' : null,
    reading_minutes: Math.max(1, Math.ceil(plainText(content).split(/\s+/).length / 220))
  };
}

async function importOne({pool, article, importKey, importKind, sourcePath, revision, approval, sourceKey}) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1)', [LOCK_ID]);
    const previous = (await client.query('SELECT revision FROM article_import_ledger WHERE import_key=$1', [importKey])).rows[0];
    if (previous) {
      if (importKind === 'approved' && previous.revision !== revision) throw invalid('IMMUTABLE_APPROVED_PACKAGE_CHANGED');
      await client.query('COMMIT');
      return 'skipped';
    }
    const existing = (await client.query('SELECT id FROM articles WHERE slug=$1', [article.slug])).rows[0];
    if (existing && importKind === 'approved') throw invalid('ARTICLE_SLUG_CONFLICT');
    let articleId = existing?.id;
    if (!existing) {
      const publishedAt = importKind === 'legacy' ? article.published_at : new Date();
      const words = plainText(article.content_html).split(/\s+/).length;
      const values = [article.slug, article.title, article.category, article.excerpt, article.content_html,
        article.author_name, article.hero_image_path, article.hero_image_alt, article.hero_image_caption,
        JSON.stringify(article.sources || []), importKind === 'approved' ? article.external_id : null,
        revision, importKind === 'approved' ? 'research-watch' : 'legacy', approval?.approved_at || null,
        approval?.reference || null, sourceKey || null, Boolean(article.featured), article.seo_title || '',
        article.seo_description || '', Math.max(1, Math.ceil(words / 220)), publishedAt];
      const result = await client.query(`INSERT INTO articles
        (slug,title,category,excerpt,content_html,author_name,hero_image_path,hero_image_alt,hero_image_caption,
         sources,external_id,content_revision,publication_origin,approved_at,approval_ref,primary_source_key,
         featured,seo_title,seo_description,reading_minutes,published_at,status)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,'published') RETURNING id`, values);
      articleId = result.rows[0].id;
      await client.query(`INSERT INTO cms_audit_log(action,entity_type,entity_id,actor_email,details)
        VALUES($1,'article',$2,NULL,$3)`, [importKind === 'approved' ? 'publish_approved_article' : 'import_existing_public_article', String(articleId), JSON.stringify({ import_key:importKey, revision, approval_ref:approval?.reference || null, origin:importKind })]);
    }
    await client.query(`INSERT INTO article_import_ledger(import_key,import_kind,source_path,revision,article_id,result)
      VALUES($1,$2,$3,$4,$5,$6)`, [importKey,importKind,sourcePath,revision,articleId,existing ? 'preserved_existing' : 'imported']);
    await client.query('COMMIT');
    return existing ? 'skipped' : 'imported';
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    if (error.code === '23505') throw invalid('ARTICLE_OR_PRIMARY_SOURCE_ALREADY_EXISTS');
    throw error;
  } finally { client.release(); }
}

function filesAt(directory, extension) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes:true }).filter(item => item.isFile() && item.name.endsWith(extension)).map(item => item.name).sort();
}
function logError(logger, file, error) {
  const code = typeof error.code === 'string' && /^[A-Z0-9_]+$/.test(error.code) ? error.code : 'INVALID_EDITORIAL_FILE';
  logger.error('[editorial] skipped', file, code);
  return { file, code };
}
async function importLegacyArticles({pool, root, logger = console}) {
  const stats = { imported:0, skipped:0, errors:[] };
  for (const file of filesAt(path.join(root, 'cikkek'), '.html')) {
    try {
      const html = fs.readFileSync(path.join(root, 'cikkek', file), 'utf8');
      const article = legacyArticle(html, file);
      const result = await importOne({pool,article,importKey:'legacy:' + file,importKind:'legacy',sourcePath:'cikkek/' + file,revision:digest(article)});
      stats[result]++;
    } catch (error) { stats.errors.push(logError(logger, 'cikkek/' + file, error)); }
  }
  return stats;
}
async function importApprovedArticles({pool, root, logger = console, now = new Date()}) {
  const stats = { imported:0, skipped:0, errors:[] };
  for (const file of filesAt(path.join(root, APPROVED_DIRECTORY), '.json')) {
    try {
      const filename = path.join(root, APPROVED_DIRECTORY, file);
      if (fs.statSync(filename).size > MAX_PACKAGE_BYTES) throw invalid('EDITORIAL_PACKAGE_TOO_LARGE');
      const payload = validateApprovedPackage(JSON.parse(fs.readFileSync(filename, 'utf8')), now);
      if (file !== payload.article.external_id + '.json') throw invalid('PACKAGE_FILENAME_MISMATCH');
      if (payload.article.hero_image_path && !fs.existsSync(path.join(root, payload.article.hero_image_path))) throw invalid('HERO_ASSET_MISSING');
      const result = await importOne({pool,article:payload.article,importKey:'approved:' + payload.article.external_id,importKind:'approved',sourcePath:APPROVED_DIRECTORY + '/' + file,revision:payload.revision,approval:payload.approval,sourceKey:payload.primarySourceKey});
      stats[result]++;
    } catch (error) { stats.errors.push(logError(logger, APPROVED_DIRECTORY + '/' + file, error)); }
  }
  return stats;
}
async function importEditorialContent(options) {
  return { legacy: await importLegacyArticles(options), approved: await importApprovedArticles(options) };
}

module.exports = { importEditorialContent, importLegacyArticles, importApprovedArticles, prepareArticle, articleRevision, calculateRevision:articleRevision, canonical, validateApprovedPackage, cleanArticleHtml, legacyArticle, APPROVED_DIRECTORY };
