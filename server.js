const express = require('express');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cookieParser = require('cookie-parser');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const multer = require('multer');
const sharp = require('sharp');
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

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: process.env.PGSSLMODE === 'disable' ? false : { rejectUnauthorized: false }
});

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
  const sql = require('fs').readFileSync(path.join(ROOT, 'migrations', '001_init.sql'), 'utf8');
  await pool.query(sql);
}

app.get('/health', async (_req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ ok: true, database: true });
  } catch {
    res.status(503).json({ ok: false, database: false });
  }
});

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
    httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'strict', maxAge: 12 * 60 * 60 * 1000
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
  const image = sharp(req.file.buffer).rotate();
  const metadata = await image.metadata();
  const maxWidth = 2400;
  const processed = await image
    .resize({ width: Math.min(metadata.width || maxWidth, maxWidth), withoutEnlargement: true })
    .webp({ quality: 88, effort: 4 })
    .toBuffer();
  const outMeta = await sharp(processed).metadata();
  const filename = (req.file.originalname.replace(/\.[^.]+$/, '') || 'image') + '.webp';
  const { rows } = await pool.query(
    'INSERT INTO media(filename,mime_type,data,width,height,alt_text) VALUES($1,$2,$3,$4,$5,$6) RETURNING id,filename,mime_type,width,height,alt_text,created_at',
    [filename, 'image/webp', processed, outMeta.width, outMeta.height, alt]
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
  res.type('html').send('<!doctype html><meta charset="utf-8"><title>Leiratkozás</title><body style="font-family:Arial;padding:60px;background:#f7f3eb;color:#173c2f"><h1>Sikeres leiratkozás</h1><p>Az e-mail-címedet leiratkoztattuk a MENTÁL.hu hírleveléről.</p><p><a href="/">Vissza a MENTÁL.hu oldalra</a></p></body>');
});

app.get('/api/public/articles', async (req, res) => {
  const category = String(req.query.category || '').trim();
  const limit = Math.min(50, Math.max(1, Number(req.query.limit || 12)));
  const params = [];
  let where = "WHERE a.status='published'";
  if (category) { params.push(category); where += ` AND lower(a.category)=lower($${params.length})`; }
  params.push(limit);
  const { rows } = await pool.query(`
    SELECT a.id,a.slug,a.title,a.category,a.excerpt,a.author_name,a.hero_image_id,a.hero_image_alt,
           a.reading_minutes,a.published_at,a.featured
    FROM articles a ${where}
    ORDER BY a.featured DESC, a.published_at DESC
    LIMIT $${params.length}
  `, params);
  res.json(rows.map(a => ({ ...a, url: '/cikk/' + a.slug, hero_url: a.hero_image_id ? '/media/' + a.hero_image_id : null })));
});

app.get('/cikk/:slug', async (req, res, next) => {
  const { rows } = await pool.query(`
    SELECT a.*, m.id AS media_id FROM articles a
    LEFT JOIN media m ON m.id=a.hero_image_id
    WHERE a.slug=$1 AND a.status='published'
  `, [req.params.slug]);
  const a = rows[0];
  if (!a) return next();
  const hero = a.media_id ? `/media/${a.media_id}` : '/assets/hero-hq.jpg';
  res.type('html').send(`<!doctype html><html lang="hu"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(a.seo_title || a.title)} – MENTÁL.hu</title><meta name="description" content="${escapeHtml(a.seo_description || a.excerpt)}"><link rel="stylesheet" href="/styles.css?v=cms"><link rel="stylesheet" href="/portal-article.css?v=cms"></head><body class="article-page"><header class="topbar"><div class="brand-wrap"><a class="logo" href="/">MENTÁL<span>.hu</span></a><span class="brand-tagline">Jobb emberek. Teljesebb életek.</span></div><nav class="nav"><a href="/rovatok/onismeret.html">ÖNISMERET</a><a href="/rovatok/kapcsolatok.html">KAPCSOLATOK</a><a href="/rovatok/csalad.html">CSALÁD</a><a href="/rovatok/test-es-lelek.html">TEST ÉS LÉLEK</a><a href="/rovatok/munka.html">MUNKA</a></nav></header><main class="article-shell"><nav class="breadcrumb"><a href="/">Főoldal</a><span>›</span><span>${escapeHtml(a.category)}</span></nav><article><header class="article-heading"><div class="article-kicker">${escapeHtml(a.category)}</div><h1>${escapeHtml(a.title)}</h1><p class="article-lead">${escapeHtml(a.excerpt)}</p><div class="article-meta"><strong>${escapeHtml(a.author_name)}</strong><span>◷ ${a.reading_minutes} perc olvasás</span></div></header><figure class="article-cover" style="grid-template-columns:1fr"><img src="${hero}" alt="${escapeHtml(a.hero_image_alt || a.title)}"></figure><div class="article-layout" style="grid-template-columns:minmax(0,820px) 310px"><div class="article-body">${a.content_html}</div><aside class="article-aside"><h3 class="aside-title">MENTÁL.HU</h3><div class="margin-word hand-note">Jobb emberek. Teljesebb életek.</div></aside></div></article></main></body></html>`);
});

function escapeHtml(s='') {
  return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[c]));
}

app.use('/admin', express.static(path.join(ROOT, 'admin'), { index: 'index.html' }));
app.use(express.static(ROOT, { extensions: ['html'], index: 'index.html' }));

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: err.message || 'Szerverhiba.' });
});

migrate()
  .then(() => app.listen(PORT, () => console.log(`MENTÁL.hu CMS listening on ${PORT}`)))
  .catch(err => { console.error('Migration failed', err); process.exit(1); });
