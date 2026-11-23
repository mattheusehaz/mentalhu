const express = require('express');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cookieParser = require('cookie-parser');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const multer = require('multer');
const sanitizeHtml = require('sanitize-html');
const slugify = require('slugify');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 8080;
const ROOT = __dirname;
const DATABASE_URL = process.env.DATABASE_URL;
const JWT_SECRET = process.env.CMS_JWT_SECRET || crypto.randomBytes(48).toString('hex');
const ADMIN_EMAIL = (process.env.CMS_ADMIN_EMAIL || 'admin@mental.hu').toLowerCase();
const ADMIN_PASSWORD_HASH = process.env.CMS_ADMIN_PASSWORD_HASH || '';
const ADMIN_PASSWORD = process.env.CMS_ADMIN_PASSWORD || '';

if (!DATABASE_URL) console.warn('DATABASE_URL is not set: CMS database features will fail.');
if (!process.env.CMS_JWT_SECRET) console.warn('CMS_JWT_SECRET is not set: using an ephemeral secret. Set it in production.');

const { buildDatabaseConfig } = require('./lib/database-config.cjs');
const pool = new Pool(buildDatabaseConfig());

// Database readiness repair v1
const dbState = { phase: 'initializing', ready: false, error: null };
pool.on('error', err => console.error('[db] idle connection error:', err.code || 'CONNECTION_ERROR'));
function safeDbCode(err) {
  if (typeof err?.code === 'string' && /^[A-Z0-9_]{2,40}$/.test(err.code)) return err.code;
  return /timeout|timed out/i.test(err?.message || '') ? 'DB_CONNECTION_TIMEOUT' : 'DATABASE_ERROR';
}
function unavailable(req, res) {
  res.set('Cache-Control', 'no-store');
  res.set('Retry-After', '15');
  res.status(503);
  if (req.path.startsWith('/api/') || req.path.startsWith('/health/')) {
    return res.json({ ok: false, error: 'A katalógus adatbázisa átmenetileg nem elérhető.', code: 'DATABASE_UNAVAILABLE' });
  }
  return res.type('html').send(directoryShell('A katalógus átmenetileg nem elérhető', '<main id="tartalom" class="shell catalog-main"><section class="catalog-status"><p class="eyebrow">MENTÁL.HU KATALÓGUS</p><h1>A katalógus átmenetileg nem elérhető</h1><p>Az adatbázis-kapcsolat jelenleg nem működik. Kérjük, próbáld újra később.</p><a class="button button-green" href="/">Vissza a főoldalra</a></section></main>'));
}
app.set('trust proxy', 1);
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      imgSrc: ["'self'", 'data:', 'blob:'],
      styleSrc: ["'self'", "'unsafe-inline'"],
      scriptSrc: ["'self'"],
      connectSrc: ["'self'"],
      fontSrc: ["'self'", 'data:'],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      frameAncestors: ["'none'"]
    }
  }
}));
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true, limit: '2mb' }));
app.use(cookieParser());

const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 20, standardHeaders: true, legacyHeaders: false });
const newsletterLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 25, standardHeaders: true, legacyHeaders: false });

function auth(req, res, next) {
  try {
    const token = req.cookies.mental_cms;
    if (!token) return res.status(401).json({ error: 'Nincs bejelentkezve.' });
    req.user = jwt.verify(token, JWT_SECRET);
    if(req.user.role!=='admin')return res.status(403).json({error:'Adminisztrátori jogosultság szükséges.'});
    next();
  } catch {
    res.clearCookie('mental_cms');
    res.status(401).json({ error: 'A munkamenet lejárt.' });
  }
}

function audit(action, entityType, entityId, actorEmail, details = {}) {
  pool.query(
    'INSERT INTO cms_audit_log(action, entity_type, entity_id, actor_email, details) VALUES($1,$2,$3,$4,$5)',
    [action, entityType, entityId ? String(entityId) : null, actorEmail || null, details]
  ).catch(err => console.error('audit error', err));
}

function cleanHtml(html = '') {
  return sanitizeHtml(html, {
    allowedTags: [
      'p','h2','h3','h4','strong','em','b','i','u','blockquote','ul','ol','li',
      'a','br','hr','figure','figcaption'
    ],
    allowedAttributes: {
      a: ['href','target','rel'],
      figure: ['class'],
      figcaption: ['class']
    },
    allowedSchemes: ['http','https','mailto'],
    transformTags: {
      a: sanitizeHtml.simpleTransform('a', { rel: 'noopener noreferrer' }, true)
    }
  });
}

function readingMinutes(html = '') {
  const text = sanitizeHtml(html, { allowedTags: [], allowedAttributes: {} }).trim();
  const words = text ? text.split(/\s+/).length : 0;
  return Math.max(1, Math.ceil(words / 220));
}

function articleSlug(input, fallbackTitle) {
  const raw = (input || '').trim() || fallbackTitle || 'cikk';
  return slugify(raw, { lower: true, strict: true, locale: 'hu' }).slice(0, 120);
}

async function migrate() {
  const fs = require('fs');
  const zlib = require('zlib');
  const steps = ['001_init.sql', '002_directory.sql', '003_public_seed.sql'].map(name => ({
    name, sql: fs.readFileSync(path.join(ROOT, 'migrations', name), 'utf8')
  }));
  const parts = [0,1,2,3].map(i => fs.readFileSync(path.join(ROOT, 'migrations', '004_directory_expansion.sql.gz.b64.part' + i), 'utf8').trim());
  steps.push({ name: '004_directory_expansion', sql: zlib.gunzipSync(Buffer.from(parts.join(''), 'base64'), { maxOutputLength: 5 * 1024 * 1024 }).toString('utf8') });
  steps.push({ name: '005_restore_import_category_links.sql', sql: fs.readFileSync(path.join(ROOT, 'migrations', '005_restore_import_category_links.sql'), 'utf8') });
  for (const name of ['006_extended_categories.sql','007_sourced_catalog_expansion.sql','008_contact_inquiries.sql','009_articles_editorial.sql','010_editorial_hero_updates.sql']) steps.push({name,sql:fs.readFileSync(path.join(ROOT,'migrations',name),'utf8')});
  const client = await pool.connect();
  let locked = false;
  try {
    await client.query('SELECT pg_advisory_lock($1)', [6938035]);
    locked = true;
    await client.query('CREATE TABLE IF NOT EXISTS cms_schema_migrations (name TEXT PRIMARY KEY, checksum TEXT NOT NULL, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())');
    for (const step of steps) {
      const applied = await client.query('SELECT name FROM cms_schema_migrations WHERE name=$1', [step.name]);
      if (applied.rowCount) continue;
      await client.query('BEGIN');
      try {
        await client.query(step.sql);
        await client.query('INSERT INTO cms_schema_migrations(name,checksum) VALUES($1,$2)', [step.name, crypto.createHash('sha256').update(step.sql).digest('hex')]);
        await client.query('COMMIT');
        console.log('[migration] applied:', step.name);
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        console.error('[migration] failed:', step.name, safeDbCode(err));
        throw err;
      }
    }
  } finally {
    if (locked) await client.query('SELECT pg_advisory_unlock($1)', [6938035]).catch(() => {});
    client.release();
  }
}

app.get('/health', (_req, res) => {
  res.status(200).json({ ok: true, service: 'mentalhu' });
});

app.get(['/health/db', '/health/ready'], async (_req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    await pool.query('SELECT 1');
    if (!dbState.ready) return res.status(503).json({ ok: false, database: true, migrations: false, phase: dbState.phase, code: dbState.error });
    const { rows } = await pool.query("SELECT (SELECT count(*)::int FROM directory_categories WHERE active=true) AS categories, (SELECT count(*)::int FROM directory_listings WHERE status='published') AS listings");
    res.status(200).json({ ok: true, database: true, migrations: true, ...rows[0] });
  } catch (err) {
    res.status(503).json({ ok: false, database: false, migrations: dbState.ready, phase: dbState.phase, code: safeDbCode(err) });
  }
});

// A fallback menu is not evidence that the database is ready.
app.use((req, res, next) => {
  const prefixes = ['/api/contact/', '/api/admin/contact/', '/api/public/', '/api/directory/', '/api/newsletter/', '/api/admin/articles', '/api/admin/media', '/api/admin/subscribers', '/api/admin/directory/', '/kereses', '/kategoria/', '/szolgaltato/', '/media/', '/leiratkozas/'];
  if (!dbState.ready && prefixes.some(prefix => req.path.startsWith(prefix))) return unavailable(req, res);
  next();
});

// API-only direct publication for explicitly approved, immutable editorial packages.
require('./lib/editorial-api.cjs').registerEditorialApi(app, {pool, dbState, root: ROOT});

const contactService = require('./lib/contact-inquiries.cjs').createContactService({pool,auth,dbState,audit});
contactService.register(app);
contactService.start();

app.post('/api/admin/login', authLimiter, async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  if (email !== ADMIN_EMAIL || !password) return res.status(401).json({ error: 'Hibás belépési adatok.' });

  let valid = false;
  if (ADMIN_PASSWORD_HASH) valid = await bcrypt.compare(password, ADMIN_PASSWORD_HASH);
  else if (ADMIN_PASSWORD) valid = password.length === ADMIN_PASSWORD.length && crypto.timingSafeEqual(Buffer.from(password), Buffer.from(ADMIN_PASSWORD));
  if (!valid) return res.status(401).json({ error: 'Hibás belépési adatok.' });

  const token = jwt.sign({ email, role: 'admin' }, JWT_SECRET, { expiresIn: '12h' });
  res.cookie('mental_cms', token, {
    httpOnly: true, secure: process.env.NODE_ENV === 'production' || req.secure, sameSite: 'strict', maxAge: 12 * 60 * 60 * 1000
  });
  audit('login', 'admin', email, email);
  res.json({ ok: true, email });
});

app.post('/api/admin/logout', auth, (req, res) => {
  res.clearCookie('mental_cms');
  audit('logout', 'admin', req.user.email, req.user.email);
  res.json({ ok: true });
});

app.get('/api/admin/me', auth, (req, res) => res.json({ email: req.user.email, role: req.user.role }));

app.get('/api/admin/articles', auth, async (req, res) => {
  const { rows } = await pool.query(`
    SELECT a.*, m.filename AS hero_filename
    FROM articles a LEFT JOIN media m ON m.id=a.hero_image_id
    ORDER BY COALESCE(a.published_at,a.created_at) DESC
  `);
  res.json(rows);
});

app.get('/api/admin/articles/:id', auth, async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM articles WHERE id=$1', [req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: 'A cikk nem található.' });
  res.json(rows[0]);
});

app.get('/api/admin/articles/:id/preview', auth, async (req, res) => {
  const {rows} = await pool.query('SELECT * FROM articles WHERE id=$1', [req.params.id]);
  if (!rows[0]) return res.status(404).json({error:'A cikk nem található.'});
  const article = require('./lib/public-articles.cjs').publicArticle(rows[0]);
  article.content_html = cleanHtml(article.content_html);
  res.set('Cache-Control','private, no-store');
  res.set('X-Robots-Tag','noindex, nofollow, noarchive');
  const content = require('./lib/article-views.cjs').renderArticle(article);
  res.type('html').send(content.replace('<main ', '<div role="status" class="editorial-preview-notice">Szerkesztőségi előnézet – a mentett változat. ' + (article.status === 'draft' ? 'Ez a piszkozat nem nyilvános.' : 'A cikk publikált.') + '</div><main '));
});

app.post('/api/admin/articles', auth, async (req, res) => {
  const title = String(req.body.title || '').trim();
  if (!title) return res.status(400).json({ error: 'A cím kötelező.' });

  const slug = articleSlug(req.body.slug, title);
  const content = cleanHtml(req.body.content_html || '');
  const status = req.body.status === 'published' ? 'published' : 'draft';
  const values = [
    slug, title, String(req.body.category || 'Önismeret'), String(req.body.excerpt || ''),
    content, String(req.body.author_name || 'MENTÁL.hu'),
    req.body.hero_image_id || null, String(req.body.hero_image_alt || ''),
    status, Boolean(req.body.featured), String(req.body.seo_title || ''),
    String(req.body.seo_description || ''), readingMinutes(content),
    status === 'published' ? new Date() : null
  ];
  try {
    const { rows } = await pool.query(`
      INSERT INTO articles(
        slug,title,category,excerpt,content_html,author_name,hero_image_id,hero_image_alt,
        status,featured,seo_title,seo_description,reading_minutes,published_at
      ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
      RETURNING *
    `, values);
    audit('create', 'article', rows[0].id, req.user.email, { title, status });
    res.status(201).json(rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Ez a slug már foglalt.' });
    throw err;
  }
});

app.put('/api/admin/articles/:id', auth, async (req, res) => {
  const title = String(req.body.title || '').trim();
  if (!title) return res.status(400).json({ error: 'A cím kötelező.' });

  const current = await pool.query('SELECT * FROM articles WHERE id=$1', [req.params.id]);
  if (!current.rows[0]) return res.status(404).json({ error: 'A cikk nem található.' });

  const slug = articleSlug(req.body.slug, title);
  const content = cleanHtml(req.body.content_html || '');
  const status = req.body.status === 'published' ? 'published' : 'draft';
  const wasPublished = current.rows[0].status === 'published';
  const publishedAt = status === 'published' ? (wasPublished ? current.rows[0].published_at : new Date()) : null;

  try {
    const { rows } = await pool.query(`
      UPDATE articles SET
        slug=$1,title=$2,category=$3,excerpt=$4,content_html=$5,author_name=$6,
        hero_image_id=$7,hero_image_alt=$8,status=$9,featured=$10,seo_title=$11,
        seo_description=$12,reading_minutes=$13,published_at=$14,updated_at=now()
      WHERE id=$15 RETURNING *
    `, [
      slug,title,String(req.body.category || 'Önismeret'),String(req.body.excerpt || ''),content,
      String(req.body.author_name || 'MENTÁL.hu'),req.body.hero_image_id || null,
      String(req.body.hero_image_alt || ''),status,Boolean(req.body.featured),
      String(req.body.seo_title || ''),String(req.body.seo_description || ''),
      readingMinutes(content),publishedAt,req.params.id
    ]);
    audit('update', 'article', req.params.id, req.user.email, { title, status });
    res.json(rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Ez a slug már foglalt.' });
    throw err;
  }
});

app.delete('/api/admin/articles/:id', auth, async (req, res) => {
  const { rowCount } = await pool.query('DELETE FROM articles WHERE id=$1', [req.params.id]);
  if (!rowCount) return res.status(404).json({ error: 'A cikk nem található.' });
  audit('delete', 'article', req.params.id, req.user.email);
  res.json({ ok: true });
});

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 12 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => {
    const ok = ['image/jpeg','image/png','image/webp','image/avif'].includes(file.mimetype);
    cb(ok ? null : new Error('Csak JPG, PNG, WEBP vagy AVIF kép tölthető fel.'), ok);
  }
});

app.post('/api/admin/media', auth, upload.single('image'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Nincs feltöltött kép.' });
  const alt = String(req.body.alt_text || '').slice(0, 300);
  const filename = req.file.originalname || 'image';
  const { rows } = await pool.query(
    'INSERT INTO media(filename,mime_type,data,width,height,alt_text) VALUES($1,$2,$3,$4,$5,$6) RETURNING id,filename,mime_type,width,height,alt_text,created_at',
    [filename, req.file.mimetype, req.file.buffer, null, null, alt]
  );
  audit('upload', 'media', rows[0].id, req.user.email, { filename });
  res.status(201).json({ ...rows[0], url: '/media/' + rows[0].id });
});

app.get('/api/admin/media', auth, async (_req, res) => {
  const { rows } = await pool.query('SELECT id,filename,mime_type,width,height,alt_text,created_at FROM media ORDER BY created_at DESC LIMIT 200');
  res.json(rows.map(x => ({ ...x, url: '/media/' + x.id })));
});

app.get('/media/:id', async (req, res) => {
  const { rows } = await pool.query('SELECT mime_type,data FROM media WHERE id=$1', [req.params.id]);
  if (!rows[0]) return res.status(404).end();
  res.set('Content-Type', rows[0].mime_type);
  res.set('Cache-Control', 'public, max-age=31536000, immutable');
  res.send(rows[0].data);
});

app.get('/api/admin/subscribers', auth, async (_req, res) => {
  const { rows } = await pool.query('SELECT id,email,status,source,consent_at,created_at,updated_at FROM newsletter_subscribers ORDER BY created_at DESC');
  res.json(rows);
});

app.get('/api/admin/subscribers.csv', auth, async (_req, res) => {
  const { rows } = await pool.query("SELECT email,status,source,consent_at,created_at FROM newsletter_subscribers ORDER BY created_at DESC");
  const esc = v => '"' + String(v ?? '').replace(/"/g, '""') + '"';
  const csv = ['email,status,source,consent_at,created_at', ...rows.map(r => [r.email,r.status,r.source,r.consent_at,r.created_at].map(esc).join(','))].join('\n');
  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Content-Disposition', 'attachment; filename="mentalhu-hirlevel.csv"');
  res.send('\ufeff' + csv);
});

app.post('/api/newsletter/subscribe', newsletterLimiter, async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const source = String(req.body.source || 'website').slice(0, 80);
  const consent = String(req.body.consent_text || 'Feliratkozom a MENTÁL.hu hírlevelére.').slice(0, 500);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Érvényes e-mail-cím szükséges.' });
  const token = crypto.randomBytes(32).toString('hex');
  await pool.query(`
    INSERT INTO newsletter_subscribers(email,status,source,consent_text,unsubscribe_token)
    VALUES($1,'active',$2,$3,$4)
    ON CONFLICT (email) DO UPDATE SET
      status='active',source=EXCLUDED.source,consent_text=EXCLUDED.consent_text,
      consent_at=now(),updated_at=now()
  `, [email, source, consent, token]);
  res.json({ ok: true, message: 'Sikeres feliratkozás.' });
});

app.get('/leiratkozas/:token', async (req, res) => {
  await pool.query("UPDATE newsletter_subscribers SET status='unsubscribed',updated_at=now() WHERE unsubscribe_token=$1", [req.params.token]);
  res.type('html').send(directoryShell('Sikeres leiratkozás', '<main id="tartalom" class="shell catalog-main"><section class="catalog-status"><p class="eyebrow">MENTÁL.HU HÍRLEVÉL</p><h1>Sikeres leiratkozás</h1><p>Az e-mail-címedet leiratkoztattuk a MENTÁL.hu hírleveléről.</p><a class="button button-green" href="/">Vissza a főoldalra</a></section></main>', {canonical:'/',active:'magazin'}));
});


// Article routes and the homepage share the same publication-aware query.
const articleService = require('./lib/public-articles.cjs').createArticleService({pool,dbState,cleanHtml});
articleService.register(app);

// Public catalog pagination v1
require('./lib/public-catalog.cjs').registerPublicCatalog(app, { pool, dbState, unavailable, directoryShell, listingCards, root: ROOT, homeArticles: articleService.homeMarkup });

app.get('/api/public/categories', async (_req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT c.id,c.slug,c.name,c.group_name,c.description,c.icon,c.verification_level,
             COUNT(lc.listing_id) FILTER (WHERE l.status='published')::int AS listing_count
      FROM directory_categories c
      LEFT JOIN directory_listing_categories lc ON lc.category_id=c.id
      LEFT JOIN directory_listings l ON l.id=lc.listing_id
      WHERE c.active=true
      GROUP BY c.id
      ORDER BY c.sort_order,c.name
    `);
    res.json(rows);
  } catch (err) {
    console.error('[categories]', safeDbCode(err));
    return unavailable(_req, res);
  }
});

app.get('/api/public/listings/:slug', async (req, res) => {
  const { rows } = await pool.query(`
    SELECT l.*,
      COALESCE(json_agg(DISTINCT jsonb_build_object('slug',c.slug,'name',c.name,'group_name',c.group_name,'description',c.description,'verification_level',c.verification_level))
        FILTER (WHERE c.id IS NOT NULL),'[]') AS categories
    FROM directory_listings l
    LEFT JOIN directory_listing_categories lc ON lc.listing_id=l.id
    LEFT JOIN directory_categories c ON c.id=lc.category_id
    WHERE l.slug=$1 AND l.status='published'
    GROUP BY l.id
  `, [req.params.slug]);
  if (!rows[0]) return res.status(404).json({error:'Nem található.'});
  const x=rows[0];
  const {admin_notes,email_source_url,contact_disabled,...publicListing}=x;
  res.json({...publicListing,profile_image_url:x.profile_image_id?'/media/'+x.profile_image_id:null,logo_image_url:x.logo_image_id?'/media/'+x.logo_image_id:null});
});

app.post('/api/directory/submit', newsletterLimiter, async (req, res) => {
  const email = String(req.body.email||'').trim().toLowerCase();
  const name = String(req.body.name||'').trim();
  if (!name || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({error:'Név és érvényes e-mail-cím szükséges.'});
  const { rows } = await pool.query(`
    INSERT INTO directory_submissions(name,contact_name,email,phone,website_url,category_slugs,city,online_available,description,qualifications,consent)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id
  `, [name,String(req.body.contact_name||''),email,String(req.body.phone||''),String(req.body.website_url||''),String(req.body.category_slugs||''),String(req.body.city||''),Boolean(req.body.online_available),String(req.body.description||''),String(req.body.qualifications||''),Boolean(req.body.consent)]);
  res.status(201).json({ok:true,id:rows[0].id,message:'Köszönjük, a beküldést ellenőrizzük.'});
});

app.get('/api/admin/directory/categories', auth, async (_req,res)=>{
  const {rows}=await pool.query('SELECT * FROM directory_categories ORDER BY sort_order,name'); res.json(rows);
});
app.get('/api/admin/directory/listings', auth, async (_req,res)=>{
  const {rows}=await pool.query(`
    SELECT l.*,COALESCE(array_agg(c.slug) FILTER (WHERE c.slug IS NOT NULL),'{}') AS category_slugs
    FROM directory_listings l LEFT JOIN directory_listing_categories lc ON lc.listing_id=l.id
    LEFT JOIN directory_categories c ON c.id=lc.category_id
    GROUP BY l.id ORDER BY l.updated_at DESC
  `); res.json(rows);
});
app.get('/api/admin/directory/listings/:id', auth, async (req,res)=>{
  const {rows}=await pool.query(`
    SELECT l.*,COALESCE(array_agg(c.slug) FILTER (WHERE c.slug IS NOT NULL),'{}') AS category_slugs
    FROM directory_listings l LEFT JOIN directory_listing_categories lc ON lc.listing_id=l.id
    LEFT JOIN directory_categories c ON c.id=lc.category_id WHERE l.id=$1 GROUP BY l.id
  `,[req.params.id]); if(!rows[0])return res.status(404).json({error:'Nem található.'}); res.json(rows[0]);
});
app.post('/api/admin/directory/listings', auth, async (req,res)=>{
  const name=String(req.body.name||'').trim(); if(!name)return res.status(400).json({error:'A név kötelező.'});
  const slug=articleSlug(req.body.slug,name), status=['draft','pending','published','rejected'].includes(req.body.status)?req.body.status:'draft';
  const client=await pool.connect();
  try{
    await client.query('BEGIN');
    const {rows}=await client.query(`INSERT INTO directory_listings(slug,name,kind,short_description,description,city,county,address,online_available,website_url,booking_url,email,phone,price_info,qualifications,specialties,languages,profile_image_id,logo_image_id,verified,featured,status,event_start,event_end,source_url,admin_notes,published_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27) RETURNING *`,
      [slug,name,req.body.kind||'provider',req.body.short_description||'',req.body.description||'',req.body.city||'',req.body.county||'',req.body.address||'',!!req.body.online_available,req.body.website_url||'',req.body.booking_url||'',req.body.email||'',req.body.phone||'',req.body.price_info||'',req.body.qualifications||'',req.body.specialties||'',req.body.languages||'Magyar',req.body.profile_image_id||null,req.body.logo_image_id||null,!!req.body.verified,!!req.body.featured,status,req.body.event_start||null,req.body.event_end||null,req.body.source_url||'',req.body.admin_notes||'',status==='published'?new Date():null]);
    const listing=rows[0];
    for(const cat of (req.body.category_slugs||[])){await client.query(`INSERT INTO directory_listing_categories(listing_id,category_id) SELECT $1,id FROM directory_categories WHERE slug=$2 ON CONFLICT DO NOTHING`,[listing.id,cat]);}
    await client.query('COMMIT'); audit('create','directory_listing',listing.id,req.user.email,{name,status}); res.status(201).json(listing);
  }catch(e){await client.query('ROLLBACK');if(e.code==='23505')return res.status(409).json({error:'Ez a slug már foglalt.'});throw e;}finally{client.release();}
});
app.put('/api/admin/directory/listings/:id', auth, async (req,res)=>{
  const current=await pool.query('SELECT * FROM directory_listings WHERE id=$1',[req.params.id]); if(!current.rows[0])return res.status(404).json({error:'Nem található.'});
  const name=String(req.body.name||'').trim(); if(!name)return res.status(400).json({error:'A név kötelező.'});
  const slug=articleSlug(req.body.slug,name),status=['draft','pending','published','rejected'].includes(req.body.status)?req.body.status:'draft';
  const publishedAt=status==='published'?(current.rows[0].published_at||new Date()):null; const client=await pool.connect();
  try{await client.query('BEGIN');
    const {rows}=await client.query(`UPDATE directory_listings SET slug=$1,name=$2,kind=$3,short_description=$4,description=$5,city=$6,county=$7,address=$8,online_available=$9,website_url=$10,booking_url=$11,email=$12,phone=$13,price_info=$14,qualifications=$15,specialties=$16,languages=$17,profile_image_id=$18,logo_image_id=$19,verified=$20,featured=$21,status=$22,event_start=$23,event_end=$24,source_url=$25,admin_notes=$26,published_at=$27,updated_at=now() WHERE id=$28 RETURNING *`,
      [slug,name,req.body.kind||'provider',req.body.short_description||'',req.body.description||'',req.body.city||'',req.body.county||'',req.body.address||'',!!req.body.online_available,req.body.website_url||'',req.body.booking_url||'',req.body.email||'',req.body.phone||'',req.body.price_info||'',req.body.qualifications||'',req.body.specialties||'',req.body.languages||'Magyar',req.body.profile_image_id||null,req.body.logo_image_id||null,!!req.body.verified,!!req.body.featured,status,req.body.event_start||null,req.body.event_end||null,req.body.source_url||'',req.body.admin_notes||'',publishedAt,req.params.id]);
    await client.query('DELETE FROM directory_listing_categories WHERE listing_id=$1',[req.params.id]);
    for(const cat of (req.body.category_slugs||[])){await client.query(`INSERT INTO directory_listing_categories(listing_id,category_id) SELECT $1,id FROM directory_categories WHERE slug=$2 ON CONFLICT DO NOTHING`,[req.params.id,cat]);}
    await client.query('COMMIT');audit('update','directory_listing',req.params.id,req.user.email,{name,status});res.json(rows[0]);
  }catch(e){await client.query('ROLLBACK');if(e.code==='23505')return res.status(409).json({error:'Ez a slug már foglalt.'});throw e;}finally{client.release();}
});
app.delete('/api/admin/directory/listings/:id', auth, async(req,res)=>{await pool.query('DELETE FROM directory_listings WHERE id=$1',[req.params.id]);audit('delete','directory_listing',req.params.id,req.user.email);res.json({ok:true})});
app.get('/api/admin/directory/submissions', auth, async(_req,res)=>{const{rows}=await pool.query('SELECT * FROM directory_submissions ORDER BY created_at DESC');res.json(rows)});
app.put('/api/admin/directory/submissions/:id', auth, async(req,res)=>{const status=['new','reviewed','accepted','rejected'].includes(req.body.status)?req.body.status:'reviewed';const{rows}=await pool.query('UPDATE directory_submissions SET status=$1,updated_at=now() WHERE id=$2 RETURNING *',[status,req.params.id]);res.json(rows[0])});



function directoryShell(title, body, options = {}) {
  return require('./lib/site-shell.cjs').siteShell(title, body, {
    active: 'szakemberek', bodyClass: 'directory-page',
    styles: ['/catalog-design.css?v=folio-20261123'], ...options
  });
}

function listingCards(rows) {
  return require('./lib/directory-views.cjs').listingCards(rows);
}

app.get('/szolgaltato/:slug', async(req,res,next)=>{
  const {rows}=await pool.query(`SELECT l.*,COALESCE(json_agg(DISTINCT jsonb_build_object('slug',c.slug,'name',c.name,'verification_level',c.verification_level,'group_name',c.group_name)) FILTER(WHERE c.id IS NOT NULL),'[]') AS categories FROM directory_listings l LEFT JOIN directory_listing_categories lc ON lc.listing_id=l.id LEFT JOIN directory_categories c ON c.id=lc.category_id WHERE l.slug=$1 AND l.status='published' GROUP BY l.id`,[req.params.slug]); const x=rows[0]; if(!x)return next();
  const body = require('./lib/directory-views.cjs').renderProfile(x, { contactMarkup: contactService.markup(x) });
  res.type('html').send(directoryShell(x.name, body, {canonical:'/szolgaltato/'+encodeURIComponent(x.slug),description:x.short_description || ''}));
});

function escapeHtml(s='') {
  return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[c]));
}

// Do not expose application code, migrations or research snapshots as static pages.
app.use((req,res,next)=>{let p;try{p=path.posix.normalize(decodeURIComponent(req.path)).toLowerCase();}catch{return res.status(404).end();}if(/^\/(?:cikkek|rovatok|content|docs|research|scripts|lib|migrations|node_modules|\.git|\.github|test|tests)(?:\/|$)/.test(p)||/^\/(?:server\.js|package(?:-lock)?\.json|procfile|dockerfile|readme(?:\.md)?|\.env.*)$/.test(p))return res.status(404).end();next();});
app.use('/admin', express.static(path.join(ROOT, 'admin'), { index: 'index.html' }));
app.use(express.static(ROOT, { extensions: ['html'], index: 'index.html' }));

app.use((err, req, res, _next) => {
  const code = safeDbCode(err);
  console.error('[request]', req.path, code);
  if (res.headersSent) return _next(err);
  if (/^(?:ECONN|ETIMEDOUT|ENOTFOUND|EHOST|ENET|DB_CONNECTION|DATABASE_ERROR|08|57P)/.test(code)) return unavailable(req, res);
  res.status(500).json({ error: 'A kérés feldolgozása nem sikerült.', code: 'REQUEST_FAILED' });
});

async function initializeDatabase() {
  dbState.phase = 'migrating';
  try {
    if (!DATABASE_URL) throw Object.assign(new Error('Missing database configuration'), { code: 'DATABASE_URL_MISSING' });
    await migrate();
    await require('./lib/editorial-import.cjs').importEditorialContent({pool,root:ROOT});
    const heroImport = await require('./lib/editorial-hero-import.cjs').importApprovedHeroAssignments({pool,root:ROOT});
    if (heroImport.errors.length) console.error('[editorial-heroes] errors:', heroImport.errors.length);
    dbState.ready = true;
    dbState.phase = 'ready';
    dbState.error = null;
    console.log('Database migrations completed');
  } catch (err) {
    dbState.ready = false;
    dbState.phase = 'failed';
    dbState.error = safeDbCode(err);
    console.error('[db] initialization failed:', dbState.error, 'Check DATABASE_URL, VPC routing and database trusted sources.');
    setTimeout(initializeDatabase, 15000).unref();
  }
}
app.listen(PORT, '0.0.0.0', () => {
  console.log('MENTÁL.hu CMS listening on 0.0.0.0:' + PORT);
  initializeDatabase();
});
