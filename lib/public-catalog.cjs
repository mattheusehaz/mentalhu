'use strict';
const fs = require('node:fs');
const path = require('node:path');
const RELEASE = 'catalog-pagination-1';
const html = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const integer = (value, fallback, max) => /^\d+$/.test(String(value ?? '')) && Number(value) > 0 && Number.isSafeInteger(Number(value)) ? Math.min(Number(value), max) : fallback;
const text = value => typeof value === 'string' ? value.trim().slice(0, 250) : '';
function filters(query = {}, forcedCategory) {
  return { q: text(query.q), category: forcedCategory ?? text(query.category), city: text(query.city), online: query.online === 'true' || query.online === '1' };
}
function whereClause(filter) {
  const values = [], terms = ["l.status='published'"];
  const bind = value => { values.push(value); return '$' + values.length; };
  if (filter.category) terms.push('EXISTS (SELECT 1 FROM directory_listing_categories f JOIN directory_categories fc ON fc.id=f.category_id WHERE f.listing_id=l.id AND fc.active=true AND fc.slug=' + bind(filter.category) + ')');
  if (filter.city) terms.push('lower(l.city)=lower(' + bind(filter.city) + ')');
  if (filter.online) terms.push('l.online_available=true');
  if (filter.q) {
    const p = bind('%' + filter.q.replace(/[\\%_]/g, '\\$&') + '%');
    terms.push('(l.name ILIKE ' + p + ' OR l.short_description ILIKE ' + p + ' OR l.specialties ILIKE ' + p + ' OR l.city ILIKE ' + p + ')');
  }
  return { clause: terms.join(' AND '), values };
}
async function pageOfListings(pool, filter, requestedPage, pageSize) {
  const { clause, values } = whereClause(filter);
  const count = await pool.query('SELECT count(*)::int AS total FROM directory_listings l WHERE ' + clause, values);
  const total = count.rows[0].total, pages = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(requestedPage, pages), offset = (page - 1) * pageSize;
  const params = [...values, pageSize, offset];
  const { rows } = await pool.query(`
    SELECT l.id,l.slug,l.name,l.kind,l.short_description,l.city,l.county,l.online_available,
      l.website_url,l.booking_url,l.price_info,l.qualifications,l.specialties,l.languages,
      l.profile_image_id,l.logo_image_id,l.verified,l.featured,
      COALESCE((SELECT json_agg(json_build_object('slug',c.slug,'name',c.name,'group_name',c.group_name,'verification_level',c.verification_level) ORDER BY c.sort_order,c.name)
        FROM directory_listing_categories lc JOIN directory_categories c ON c.id=lc.category_id
        WHERE lc.listing_id=l.id AND c.active=true),'[]'::json) AS categories
    FROM directory_listings l WHERE ${clause}
    ORDER BY l.featured DESC,l.verified DESC,lower(l.name),l.id
    LIMIT $${values.length + 1} OFFSET $${values.length + 2}`, params);
  return { items: rows.map(x => ({ ...x, profile_image_url: x.profile_image_id ? '/media/' + x.profile_image_id : null, logo_image_url: x.logo_image_id ? '/media/' + x.logo_image_id : null, url: '/szolgaltato/' + encodeURIComponent(x.slug) })), total, page, pageSize, pages, hasNext: page < pages, from: rows.length ? offset + 1 : 0, to: offset + rows.length };
}
async function summary(pool) {
  const { rows } = await pool.query("SELECT (SELECT count(*)::int FROM directory_listings WHERE status='published') AS total,(SELECT count(*)::int FROM directory_categories WHERE active=true) AS categories");
  return { ...rows[0], release: RELEASE };
}
function summaryMarkup(data) {
  return '<div class="catalog-summary" id="catalogSummary" data-total="' + data.total + '" aria-live="polite"><div><strong>' + data.total + ' adatlap</strong><span> ' + data.categories + ' kategóriában. A főoldal csak ízelítő; a teljes lista itt érhető el.</span></div><a class="solid-btn" href="/szolgaltatok">Mind a ' + data.total + ' adatlap megtekintése →</a></div>';
}
function pageLink(base, filter, number) {
  const qs = new URLSearchParams();
  for (const key of ['q','category','city']) if (filter[key]) qs.set(key, filter[key]);
  if (filter.online) qs.set('online','true');
  if (number > 1) qs.set('page', String(number));
  return base + (qs.size ? '?' + qs.toString() : '');
}
function pagination(data, base, filter) {
  if (data.pages <= 1) return '';
  const selected = [...new Set([1, data.pages, data.page - 2, data.page - 1, data.page, data.page + 1, data.page + 2])].filter(n => n > 0 && n <= data.pages).sort((a,b) => a-b);
  let previous = 0;
  const links = selected.map(number => {
    const gap = previous && number > previous + 1 ? '<span class="page-gap" aria-hidden="true">…</span>' : '';
    previous = number;
    return gap + (number === data.page ? '<span class="page-link current" aria-current="page" aria-label="' + number + '. oldal, jelenlegi">' + number + '</span>' : '<a class="page-link" aria-label="' + number + '. oldal" href="' + html(pageLink(base,filter,number)) + '">' + number + '</a>');
  }).join('');
  const back = data.page > 1 ? '<a class="page-link" rel="prev" href="' + html(pageLink(base,filter,data.page-1)) + '">← Előző</a>' : '';
  const next = data.hasNext ? '<a class="page-link" rel="next" href="' + html(pageLink(base,filter,data.page+1)) + '">Következő →</a>' : '';
  return '<nav class="catalog-pagination" aria-label="Találati oldalak">' + back + links + next + '</nav>';
}
function searchForm(filter, cats) {
  return '<form class="catalog-filter" action="/kereses" method="get"><label>Keresés<input name="q" value="' + html(filter.q) + '" placeholder="Név vagy szakterület"></label><label>Kategória<select name="category"><option value="">Minden kategória</option>' + cats.map(c => '<option value="' + html(c.slug) + '"' + (filter.category===c.slug?' selected':'') + '>' + html(c.name) + '</option>').join('') + '</select></label><label>Város<input name="city" value="' + html(filter.city) + '" placeholder="Országosan"></label><label class="catalog-online"><input type="checkbox" name="online" value="true"' + (filter.online?' checked':'') + '> Online is</label><button class="solid-btn" type="submit">Keresés</button><a href="/szolgaltatok">Szűrők törlése</a></form>';
}
function registerPublicCatalog(app, { pool, dbState, unavailable, directoryShell, listingCards, root }) {
  const template = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const wrap = handler => async (req,res,next) => { try { await handler(req,res,next); } catch (err) { next(err); } };
  const ready = (req,res) => {
    res.set('Cache-Control','no-store'); res.set('X-Mental-Release',RELEASE);
    if (!dbState.ready) { unavailable(req,res); return false; }
    return true;
  };
  const shell = (title, body) => directoryShell(title, body).replace('</head>','<link rel="stylesheet" href="/catalog-pagination.css?v=' + RELEASE + '"></head>').replace('href="/#kiemeltek"','href="/szolgaltatok"').replace('>KIEMELTEK<','>Összes adatlap<');
  app.get('/api/public/directory-summary', wrap(async (req,res) => {
    if (!ready(req,res)) return;
    res.json(await summary(pool));
  }));
  app.get('/api/public/listings', wrap(async (req,res) => {
    if (!ready(req,res)) return;
    const size = integer(req.query.page_size ?? req.query.limit,30,100);
    const data = await pageOfListings(pool, filters(req.query), integer(req.query.page,1,1000000), size);
    res.set('X-Total-Count',String(data.total)); res.set('X-Page',String(data.page)); res.set('X-Page-Size',String(size));
    // The existing homepage expects an array. Opt-in metadata keeps it compatible.
    res.json(['true','1'].includes(req.query.paginated) ? data : data.items);
  }));
  async function renderList(req,res,category) {
    if (!ready(req,res)) return;
    const filter = filters(req.query, category?.slug);
    const data = await pageOfListings(pool,filter,integer(req.query.page,1,1000000),24);
    const cats = (await pool.query('SELECT slug,name FROM directory_categories WHERE active=true ORDER BY sort_order,name')).rows;
    const all = !filter.q && !filter.category && !filter.city && !filter.online;
    const title = category?.name || (all ? 'A teljes katalógus' : 'Keresési találatok');
    const note = category?.verification_level === 'alternative' ? 'Alternatív / spirituális kategória. A megjelenés nem jelent egészségügyi ajánlást, és nem helyettesíti az egészségügyi ellátást.' : 'A megjelenés tájékoztató jellegű, nem jelent automatikus szakmai ajánlást.';
    const base = category ? '/kategoria/' + encodeURIComponent(category.slug) : '/kereses';
    const body = '<main class="catalog-main" data-catalog-total="' + data.total + '" data-catalog-page="' + data.page + '"><nav class="catalog-breadcrumb" aria-label="Útvonal"><a href="/">Főoldal</a><span> / </span><a href="/szolgaltatok">Teljes katalógus</a>' + (category?'<span> / '+html(category.name)+'</span>':'') + '</nav><header class="catalog-heading"><span class="section-label">' + (category?html(category.group_name):'Szakemberek, szolgáltatások és programok') + '</span><h1>' + html(title) + '</h1>' + (category?.description?'<p>'+html(category.description)+'</p>':'') + '<p>Összesen <strong class="catalog-total">' + data.total + ' adatlap</strong>' + (all?' az adatbázisban.':' a megadott feltételekkel.') + '</p></header>' + searchForm(filter,cats) + '<div class="catalog-result-head"><p class="catalog-range">Megjelenítve: <strong>' + data.from + '–' + data.to + '</strong> / ' + data.total + ' adatlap · ' + data.page + ' / ' + data.pages + '. oldal</p>' + (all?'':'<a href="/szolgaltatok">Az összes adatlap →</a>') + '</div><div class="listing-grid">' + listingCards(data.items) + '</div>' + pagination(data,base,filter) + '<p class="catalog-disclosure">' + note + '</p></main>';
    res.type('html').send(shell(title, body));
  }
  app.get(['/szolgaltatok','/kereses'],wrap((req,res)=>renderList(req,res,null)));
  app.get('/kategoria/:slug',wrap(async(req,res,next)=>{
    if (!ready(req,res)) return;
    const category = (await pool.query('SELECT * FROM directory_categories WHERE slug=$1 AND active=true',[req.params.slug])).rows[0];
    if (!category) return res.status(404).type('html').send(shell('Nem található kategória','<main class="catalog-main"><h1>Ez a kategória nem található.</h1><a href="/szolgaltatok">Teljes katalógus →</a></main>'));
    await renderList(req,res,category);
  }));
  // The total is server rendered too: it does not depend on homepage JavaScript.
  app.get(['/','/index.html'],wrap(async(req,res)=>{
    res.set('Cache-Control','no-store'); res.set('X-Mental-Release',RELEASE);
    let content = template;
    if (dbState.ready) {
      try {
        const data = await summary(pool);
        content = content.replace(/<!-- catalog-summary:start -->[\s\S]*?<!-- catalog-summary:end -->/, () => '<!-- catalog-summary:start -->' + summaryMarkup(data) + '<!-- catalog-summary:end -->');
      } catch { /* Leave the honest static link; never invent a total. */ }
    }
    res.type('html').send(content);
  }));
}
module.exports = { registerPublicCatalog, pageOfListings, whereClause, filters };
