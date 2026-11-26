'use strict';

const views = require('./article-views.cjs');
const { selectRelatedProviders } = require('./related-providers.cjs');
const RELEASE = 'articles-20261123-1';
const integer = (value, fallback, max) => /^\d+$/.test(String(value ?? '')) && Number.isSafeInteger(Number(value)) && Number(value) > 0 ? Math.min(Number(value), max) : fallback;
const text = value => typeof value === 'string' ? value.trim().slice(0, 200) : '';
const FIELDS = 'a.id,a.slug,a.title,a.category,a.excerpt,a.author_name,a.hero_image_id,a.hero_image_path,a.hero_image_alt,a.hero_image_caption,a.reading_minutes,a.published_at,a.featured,a.sources,a.publication_origin';

function publicArticle(row) {
  return { ...row, url: '/cikk/' + encodeURIComponent(row.slug), hero_url: row.hero_image_id ? '/media/' + row.hero_image_id : row.hero_image_path || null };
}

function articleFilter(query = {}) {
  const values = [], terms = ["a.status='published'", '(a.published_at IS NULL OR a.published_at <= now())'];
  const q = text(query.q), category = text(query.category);
  if (q) {
    values.push('%' + q + '%');
    terms.push('(a.title ILIKE $' + values.length + ' OR a.excerpt ILIKE $' + values.length + ')');
  }
  if (category) { values.push(category); terms.push('lower(a.category)=lower($' + values.length + ')'); }
  return { q, category, values, where: ' WHERE ' + terms.join(' AND ') };
}

async function pageOfArticles(pool, query = {}, pageSize = 12) {
  const filter = articleFilter(query);
  const total = (await pool.query('SELECT count(*)::int AS total FROM articles a' + filter.where, filter.values)).rows[0].total;
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(integer(query.page, 1, 1000000), pages);
  const values = [...filter.values, pageSize, (page - 1) * pageSize];
  const { rows } = await pool.query('SELECT ' + FIELDS + ' FROM articles a' + filter.where + ' ORDER BY a.published_at DESC NULLS LAST,a.id DESC LIMIT $' + (values.length - 1) + ' OFFSET $' + values.length, values);
  return { items: rows.map(publicArticle), total, page, pages, page_size: pageSize, q: filter.q, category: filter.category };
}

function createArticleService({ pool, dbState, cleanHtml }) {
  function ready(req, res) {
    res.set('Cache-Control', 'no-store');
    res.set('X-Mental-Articles', RELEASE);
    if (dbState.ready) return true;
    res.set('Retry-After', '15');
    if (req.path.startsWith('/api/')) res.status(503).json({ error: 'A cikkek átmenetileg nem elérhetők.', code: 'ARTICLES_UNAVAILABLE' });
    else res.status(503).type('html').send(views.editorialShell('A cikkek átmenetileg nem elérhetők', '<main class="editorial-main"><h1>A cikkek átmenetileg nem elérhetők.</h1><p>Kérjük, próbáld újra egy kicsit később.</p><a href="/">Vissza a főoldalra</a></main>'));
    return false;
  }
  const wrap = fn => async (req,res,next) => { try { await fn(req,res,next); } catch (error) { next(error); } };
  async function homeMarkup() {
    if (!dbState.ready) return {featured:views.renderHomeFeatured([],{error:true}),more:views.renderHomeArticles([],{error:true}),continued:''};
    try {
      const items = (await pageOfArticles(pool, {}, views.HOME_ARTICLE_LIMIT)).items;
      return {featured:views.renderHomeFeatured(items),more:views.renderHomeArticles(items),continued:views.renderHomeMoreArticles(items)};
    } catch (error) {
      console.error('[articles] homepage unavailable:', error.code || 'READ_FAILED');
      return {featured:views.renderHomeFeatured([],{error:true}),more:views.renderHomeArticles([],{error:true}),continued:''};
    }
  }
  function register(app) {
    app.get('/api/public/articles', wrap(async(req,res) => {
      if (!ready(req,res)) return;
      const result = await pageOfArticles(pool, req.query, integer(req.query.limit ?? req.query.page_size, 12, 50));
      res.set('X-Total-Count', String(result.total)); res.set('X-Page', String(result.page));
      res.set('X-Page-Size', String(result.page_size));
      res.json(['1','true'].includes(req.query.paginated) ? result : result.items);
    }));
    app.get(['/cikkek','/cikkek/index.html'], wrap(async(req,res) => {
      if (!ready(req,res)) return;
      const [result, categories] = await Promise.all([
        pageOfArticles(pool, req.query),
        pool.query("SELECT DISTINCT category FROM articles WHERE status='published' AND (published_at IS NULL OR published_at<=now()) ORDER BY category")
      ]);
      res.type('html').send(views.renderArticlesIndex({...result, categories:categories.rows.map(r=>r.category)}));
    }));
    app.get(['/rovatok','/rovatok/index.html'], (_req,res)=>res.redirect(301,'/cikkek'));
    app.get('/rovatok/:section', (req,res)=>{
      const categories = {'onismeret':'Önismeret','kapcsolatok':'Kapcsolatok','csalad':'Család','test-es-lelek':'Test és lélek','munka':'Munka','kerdes-valasz':'Kérdés és válasz'};
      const category = categories[req.params.section.replace(/\.html$/,'')];
      if (!category) return res.redirect(302,'/cikkek');
      return res.redirect(301,'/cikkek?category='+encodeURIComponent(category));
    });
    app.get('/cikk/:slug', wrap(async(req,res) => {
      if (!ready(req,res)) return;
      const {rows} = await pool.query("SELECT " + FIELDS + ",a.content_html,a.seo_title,a.seo_description,a.updated_at FROM articles a WHERE a.slug=$1 AND a.status='published' AND (a.published_at IS NULL OR a.published_at<=now())", [req.params.slug]);
      if (!rows[0]) return res.status(404).type('html').send(views.editorialShell('A cikk nem található', '<main class="editorial-main"><h1>A cikk nem található.</h1><p>Lehet, hogy még nem jelent meg, vagy már nem érhető el.</p><a href="/cikkek">Az összes cikk →</a></main>'));
      const a = publicArticle(rows[0]); a.content_html = cleanHtml(a.content_html);
      const [relatedResult, providers] = await Promise.all([
        pool.query('SELECT ' + FIELDS + " FROM articles a WHERE a.status='published' AND a.id<>$1 AND (a.published_at IS NULL OR a.published_at<=now()) ORDER BY (a.category=$2) DESC,a.published_at DESC NULLS LAST,a.id DESC LIMIT 3", [a.id,a.category]),
        selectRelatedProviders(pool, a).catch(() => {
          // Optional directory recommendations must never take an article offline.
          console.warn('[articles] Related providers temporarily unavailable.');
          return [];
        })
      ]);
      const related = relatedResult.rows.map(publicArticle);
      res.type('html').send(views.renderArticle(a, {related, providers}));
    }));
    // Legacy URLs follow the CMS publication state; unpublished copies cannot leak through static serving.
    app.get('/cikkek/:legacy', wrap(async(req,res) => {
      if (!ready(req,res)) return;
      const slug = req.params.legacy.replace(/\.html$/, '');
      const {rows} = await pool.query("SELECT slug FROM articles WHERE slug=$1 AND status='published' AND (published_at IS NULL OR published_at<=now())", [slug]);
      if (rows[0]) return res.redirect(301, '/cikk/' + encodeURIComponent(rows[0].slug));
      return res.status(404).type('html').send(views.editorialShell('A cikk nem található', '<main class="editorial-main"><h1>A cikk nem található.</h1><a href="/cikkek">Az összes cikk →</a></main>'));
    }));
  }
  return {register, homeMarkup};
}

module.exports = {createArticleService, pageOfArticles, articleFilter, publicArticle, RELEASE};
