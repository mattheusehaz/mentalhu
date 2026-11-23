'use strict';

const html = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const articleUrl = article => '/cikk/' + encodeURIComponent(article.slug || '');
const validImage = value => typeof value === 'string' && /^\/(?:assets\/[a-zA-Z0-9._/-]+|media\/\d+)$/.test(value) && !value.includes('..') ? value : '';
function sourceUrl(value) {
  try { const u = new URL(value); return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : ''; } catch { return ''; }
}
function dateInfo(value) {
  const d = value ? new Date(value) : null;
  if (!d || !Number.isFinite(d.getTime())) return '';
  return '<time datetime="' + d.toISOString() + '">' + html(new Intl.DateTimeFormat('hu-HU', {year:'numeric',month:'long',day:'numeric',timeZone:'Europe/Budapest'}).format(d)) + '</time>';
}
const logo = '<a class="brand-lockup" href="/" aria-label="MENTÁL.hu főoldal"><svg class="brand-symbol" viewBox="0 0 64 54" aria-hidden="true"><path d="M3 49 17 8l9 13-8 28H3Zm19-44c5-4 10 1 13 10l13 34H35L22 13c-1-3-2-5 0-8Zm14 0c6-5 12-1 16 11l11 33H50L39 15c-1-4-3-6-7-6Z"/></svg><span class="brand-copy"><strong class="wordmark">MENTÁL<span>.hu</span></strong><small>mentális egészség és jóllét</small></span></a>';
function editorialShell(title, body, {description = '', canonical = '/cikkek'} = {}) {
  const nav = '<a href="/cikkek" aria-current="page">Cikkek</a><a href="/szolgaltatok">Szakemberek</a><a href="/#kategoriak">Kategóriák</a><a href="/#tudastar">Tudástár</a><a href="/kategoria/konferenciak-es-esemenyek">Események</a>';
  const canonicalUrl = canonical.startsWith('/') && !canonical.startsWith('//') ? 'https://mental.hu' + canonical : 'https://mental.hu/cikkek';
  return '<!doctype html><html lang="hu"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="theme-color" content="#0d3031"><title>' + html(title) + ' – MENTÁL.hu</title><meta name="description" content="' + html(description) + '"><link rel="canonical" href="' + html(canonicalUrl) + '"><link rel="stylesheet" href="/directory.css?v=atelier-1"><link rel="stylesheet" href="/editorial.css?v=reader-white-20261123"></head><body class="editorial-page"><a class="skip-link" href="#tartalom">Ugrás a tartalomhoz</a><header class="dir-header">' + logo + '<nav class="dir-nav" aria-label="Fő navigáció">' + nav + '</nav><div class="dir-actions"><a class="outline-btn" href="/admin">Belépés</a><a class="solid-btn" href="/#felkerules">Regisztráció</a></div><details class="mobile-menu"><summary>Menü</summary><nav aria-label="Mobil navigáció">' + nav + '<a href="/#felkerules">Szolgáltatói regisztráció</a><a href="/admin">Admin belépés</a></nav></details></header>' + body + '<footer class="footer"><div class="footer-inner">' + logo + '<nav aria-label="Lábléc"><a href="/cikkek">Cikkek</a><a href="/szolgaltatok">Szakemberek</a><a href="/#kategoriak">Kategóriák</a><a href="/#felkerules">Felkerülés</a><a href="/admin">Admin</a></nav><p>A MENTÁL.hu ismeretterjesztő írásai a tájékozódást segítik. Egyéni kérdésekben fordulj megfelelő szakemberhez.</p></div></footer></body></html>';
}
function metadata(article, includeAuthor = false) {
  const minutes = Number.isFinite(Number(article.reading_minutes)) && Number(article.reading_minutes) > 0 ? Math.ceil(Number(article.reading_minutes)) : 1;
  return '<div class="story-meta">' + (includeAuthor ? '<span>' + html(article.author_name || 'MENTÁL.hu') + '</span>' : '') + dateInfo(article.published_at) + '<span>' + minutes + ' perc olvasás</span></div>';
}
function image(article, {lead = false} = {}) {
  const url = validImage(article.hero_url);
  return url ? '<div class="story-image"><img src="' + html(url) + '" alt="' + html(article.hero_image_alt || '') + '" loading="lazy" width="800" height="520"></div>' : '<div class="story-image story-without-image" aria-hidden="true"><span>' + html((article.category || 'M').slice(0,1)) + '</span></div>';
}
function card(article, style = 'grid') {
  return '<article class="story story-' + style + '"><a class="story-link" href="' + articleUrl(article) + '">' + image(article,{lead:style === 'lead'}) + '<div class="story-copy"><span class="story-category">' + html(article.category || 'Mentális egészség') + '</span><h3>' + html(article.title) + '</h3>' + (style !== 'compact' ? '<p>' + html(article.excerpt || '') + '</p>' : '') + metadata(article) + (style === 'lead' ? '<span class="story-read">Elolvasom <span aria-hidden="true">↗</span></span>' : '') + '</div></a></article>';
}
function renderHomeFeatured(items = [], {error = false} = {}) {
  const latest = items.slice(0,5);
  if (!latest.length) return '<section class="home-latest home-block" id="friss-cikkek" aria-labelledby="latest-title"><div class="block-head"><div><h2 id="latest-title">Legfrissebb cikkeink</h2></div><a class="text-link" href="/cikkek">Összes cikk ↗</a></div><p class="editorial-empty">' + (error ? 'A cikkek átmenetileg nem tölthetők be.' : 'A legfrissebb cikkek hamarosan itt olvashatók.') + '</p></section>';
  return '<section class="home-latest home-block" id="friss-cikkek" aria-labelledby="latest-title"><div class="block-head"><div><h2 id="latest-title">Legfrissebb cikkeink</h2></div><a class="text-link" href="/cikkek">Összes cikk <span aria-hidden="true">↗</span></a></div><div class="home-stories">' + card(latest[0], 'lead') + (latest.length > 1 ? '<div class="home-story-list">' + latest.slice(1).map(a => card(a,'compact')).join('') + '</div>' : '') + '</div></section>';
}
function renderHomeArticles(items = [], {error = false} = {}) {
  const more = items.slice(5,12);
  const content = more.length ? '<div class="articles-grid">' + more.map(a => card(a,'grid')).join('') + '</div>' : '<p class="editorial-empty">' + (error ? 'A további cikkek most nem tölthetők be.' : 'További cikkekért nézd meg az archívumot.') + '</p>';
  return '<section class="home-block home-editorial" id="cikkek" aria-labelledby="home-articles-title"><div class="block-head"><div><span class="section-label">Cikkek</span><h2 id="home-articles-title">További írásaink</h2></div><a class="text-link" href="/cikkek">Minden cikk <span aria-hidden="true">↗</span></a></div>' + content + '</section>';
}
function archiveUrl(page, q, category) {
  const params = new URLSearchParams();
  if (q) params.set('q',q);
  if (category) params.set('category',category);
  if (page > 1) params.set('page',String(page));
  return '/cikkek' + (params.toString() ? '?' + params.toString() : '');
}
function renderArticlesIndex({items = [],total = 0,page = 1,pages = 1,q = '',category = '',categories = []} = {}) {
  const names = categories.map(c => typeof c === 'string' ? c : c.category || c.name).filter(Boolean);
  const filters = '<form class="article-filters" action="/cikkek" method="get"><label class="article-search"><span>Keresés a cikkek között</span><input type="search" name="q" value="' + html(q) + '" placeholder="Például: szorongás, alvás, kapcsolatok" maxlength="250"></label><label><span>Téma</span><select name="category"><option value="">Minden téma</option>' + names.map(name=>'<option value="' + html(name) + '"' + (name === category ? ' selected' : '') + '>' + html(name) + '</option>').join('') + '</select></label><button type="submit">Keresés <span aria-hidden="true">→</span></button></form>';
  const active = q || category;
  let pager = '';
  if (pages > 1) {
    const numbers = [];
    for (let n = Math.max(1,page - 2); n <= Math.min(pages,page + 2); n++) numbers.push(n);
    pager = '<nav class="article-pagination" aria-label="Cikkek lapozása">' + (page > 1 ? '<a href="' + html(archiveUrl(page - 1,q,category)) + '" rel="prev">← Előző</a>' : '') + numbers.map(n=>'<a href="' + html(archiveUrl(n,q,category)) + '"' + (n === page ? ' aria-current="page"' : '') + '>' + n + '</a>').join('') + (page < pages ? '<a href="' + html(archiveUrl(page + 1,q,category)) + '" rel="next">Következő →</a>' : '') + '</nav>';
  }
  const body = '<main id="tartalom" class="editorial-main"><nav class="editorial-breadcrumb" aria-label="Morzsanavigáció"><a href="/">Főoldal</a><span aria-hidden="true">/</span><span>Cikkek</span></nav><header class="editorial-heading"><div><span class="section-label">Olvasnivaló a MENTÁL.hu-n</span><h1>Cikkek</h1></div><p>Pszichológia, mentális egészség, kapcsolatok és mindennapok. Írások, amelyek segítenek jobban érteni önmagunkat és egymást.</p></header>' + filters + '<div class="article-results"><p><strong>' + html(total) + '</strong> cikk' + (active ? ' a megadott feltételekkel' : ' · a legutóbb megjelentek elöl') + '</p>' + (active ? '<a href="/cikkek">Szűrés törlése</a>' : '') + '</div>' + (items.length ? '<div class="articles-grid">' + items.map(a=>card(a)).join('') + '</div>' : '<div class="editorial-empty"><h2>' + (active ? 'Erre most nincs találat.' : 'Itt gyűjtjük a cikkeinket.') + '</h2><p>' + (active ? 'Próbálj másik kifejezést vagy válassz másik témát.' : 'A publikálás után az új írások automatikusan megjelennek ezen az oldalon.') + '</p></div>') + pager + '</main>';
  return editorialShell('Cikkek',body,{description:'A MENTÁL.hu cikkei pszichológiáról, mentális egészségről, kapcsolatokról és önismeretről.',canonical:archiveUrl(page,q,category)});
}
function renderArticle(article, {related = []} = {}) {
  const sources = Array.isArray(article.sources) ? article.sources.filter(x => x && sourceUrl(x.url)) : [];
  const research = article.publication_origin === 'research-watch';
  const hero = validImage(article.hero_url);
  const sourceSection = sources.length ? '<section class="article-sources" aria-labelledby="article-sources-heading"><h2 id="article-sources-heading">Források</h2><ol>' + sources.map(s=>'<li><a href="' + html(sourceUrl(s.url)) + '" target="_blank" rel="noopener noreferrer">' + html(s.title || s.doi || s.url) + ' <span aria-hidden="true">↗</span></a>' + (s.doi ? '<small>DOI: ' + html(s.doi) + '</small>' : '') + (s.published_at ? '<small>' + dateInfo(s.published_at) + '</small>' : '') + '</li>').join('') + '</ol></section>' : '';
  const body = '<main id="tartalom" class="editorial-main editorial-reader"><nav class="editorial-breadcrumb" aria-label="Morzsanavigáció"><a href="/">Főoldal</a><span aria-hidden="true">/</span><a href="/cikkek">Cikkek</a><span aria-hidden="true">/</span><a href="' + html(archiveUrl(1,'',article.category)) + '">' + html(article.category) + '</a></nav><article><header class="reader-heading"><span class="section-label">' + html(article.category) + '</span><h1>' + html(article.title) + '</h1><p class="reader-lead">' + html(article.excerpt) + '</p>' + metadata(article,true) + '</header>' + (hero ? '<figure class="reader-cover"><img src="' + html(hero) + '" alt="' + html(article.hero_image_alt || '') + '" width="1200" height="650" fetchpriority="high">' + (article.hero_image_caption ? '<figcaption>' + html(article.hero_image_caption) + '</figcaption>' : '') + '</figure>' : '') + '<div class="reader-layout"><aside class="reader-margin"><p class="reader-note">' + (research ? 'Kutatásról közérthetően' : 'Egy kis idő az olvasásra.') + '</p><a href="/cikkek">Minden cikk <span aria-hidden="true">↗</span></a><a href="/szolgaltatok">Szakembert keresek <span aria-hidden="true">↗</span></a></aside><div class="reader-content"><div class="reader-body">' + (article.content_html || '') + '</div>' + sourceSection + '</div></div></article>' + (related.length ? '<section class="reader-related"><div class="block-head"><h2>Érdemes tovább olvasni</h2><a class="text-link" href="/cikkek">Minden cikk ↗</a></div><div class="articles-grid">' + related.slice(0,3).map(a=>card(a)).join('') + '</div></section>' : '') + '</main>';
  return editorialShell(article.seo_title || article.title,body,{description:article.seo_description || article.excerpt,canonical:articleUrl(article)});
}
module.exports = { renderHomeFeatured, renderHomeArticles, renderArticlesIndex, renderArticle, editorialShell };
