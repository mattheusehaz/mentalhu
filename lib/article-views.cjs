'use strict';

const { siteShell, icon, html } = require('./site-shell.cjs');
const HOME_FEATURED_COUNT = 5;
const HOME_GRID_SIZE = 15;
const HOME_ARTICLE_LIMIT = HOME_FEATURED_COUNT + 2 * HOME_GRID_SIZE;
const articleUrl = article => '/cikk/' + encodeURIComponent(article.slug || '');
const validImage = value => typeof value === 'string' && /^\/(?:assets\/[a-zA-Z0-9._/-]+|media\/\d+)$/.test(value) && !value.includes('..') ? value : '';

function sourceUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : '';
  } catch { return ''; }
}

function dateInfo(value) {
  const date = value ? new Date(value) : null;
  if (!date || !Number.isFinite(date.getTime())) return '';
  return '<time datetime="' + date.toISOString() + '">' + html(new Intl.DateTimeFormat('hu-HU', {
    year: 'numeric', month: 'long', day: 'numeric', timeZone: 'Europe/Budapest'
  }).format(date)) + '</time>';
}

function minutes(article) {
  const value = Number(article.reading_minutes);
  return Number.isFinite(value) && value > 0 ? Math.ceil(value) : 1;
}

function archiveUrl(page, q, category) {
  const params = new URLSearchParams();
  if (q) params.set('q', q);
  if (category) params.set('category', category);
  if (page > 1) params.set('page', String(page));
  return '/cikkek' + (params.size ? '?' + params.toString() : '');
}

function editorialShell(title, body, { description = '', canonical = '/cikkek', styles = [], scripts = [], ...metadata } = {}) {
  const content = /<main\b[^>]*\bid=/.test(body) ? body : body.replace(/<main\b/, '<main id="tartalom"');
  return siteShell(title, content, {
    ...metadata,
    description,
    canonical: canonical.startsWith('/') && !canonical.startsWith('//') ? canonical : '/cikkek',
    active: 'magazin',
    bodyClass: 'editorial-page',
    styles: ['/editorial.css?v=providers-20261126', ...styles],
    scripts
  });
}

function categoryLink(article) {
  const category = article.category || 'Mentális egészség';
  return '<a class="category story-category" href="' + html(archiveUrl(1, '', category)) + '">' + html(category) + '</a>';
}

function metadata(article, includeAuthor = false) {
  return '<div class="story-meta">' + (includeAuthor
    ? '<span class="reader-author">' + html(article.author_name || 'MENTÁL.hu') + '</span>' + dateInfo(article.published_at)
    : categoryLink(article)) + '<span class="reading-time">' + minutes(article) + ' perc olvasás</span></div>';
}

function bookmark(article, extraClass = '') {
  return '<button type="button" class="bookmark-button' + (extraClass ? ' ' + extraClass : '') + '"'
    + ' data-save-article="' + html(articleUrl(article)) + '"'
    + ' data-article-title="' + html(article.title) + '"'
    + ' data-article-image="' + html(validImage(article.hero_url)) + '"'
    + ' data-article-category="' + html(article.category || '') + '"'
    + ' data-article-minutes="' + minutes(article) + '"'
    + ' aria-label="Cikk mentése: ' + html(article.title) + '" aria-pressed="false">'
    + icon('bookmark') + '</button>';
}

function image(article, { lead = false, compact = false } = {}) {
  const url = validImage(article.hero_url);
  if (!url) return '<div class="story-without-image" aria-hidden="true">' + icon('book') + '</div>';
  return '<img class="' + (lead ? 'lead-image' : 'story-image') + '" src="' + html(url) + '" alt="'
    + html(article.hero_image_alt || article.title || '') + '" width="' + (compact ? 140 : 1000)
    + '" height="' + (compact ? 140 : 600) + '"'
    + (lead ? ' fetchpriority="high"' : ' loading="lazy"') + '>';
}

function card(article, style = 'grid') {
  const url = html(articleUrl(article));
  const title = html(article.title);
  const pictureLabel = ' aria-label="' + title + '"';
  if (style === 'lead') {
    return '<article class="lead-story story story-lead"><div class="lead-image-wrap">'
      + '<a class="story-link" href="' + url + '"' + pictureLabel + '>' + image(article, {lead: true}) + '</a>'
      + '<span class="image-badge">KIEMELT TÖRTÉNET</span>' + bookmark(article) + '</div>'
      + metadata(article) + '<h2><a href="' + url + '">' + title + '</a></h2>'
      + (article.excerpt ? '<p class="lead-excerpt">' + html(article.excerpt) + '</p>' : '') + '</article>';
  }
  if (style === 'compact') {
    return '<article class="latest-story story story-compact"><div class="latest-copy">'
      + categoryLink(article) + '<h3><a class="story-link" href="' + url + '">' + title + '</a></h3></div>'
      + '<a class="latest-thumbnail" href="' + url + '"' + pictureLabel + '>' + image(article, {compact: true}) + '</a></article>';
  }
  return '<article class="article-card story story-grid"><div class="card-image-wrap">'
    + '<a class="story-link" href="' + url + '"' + pictureLabel + '>' + image(article) + '</a>' + bookmark(article) + '</div>'
    + metadata(article) + '<h3><a href="' + url + '">' + title + '</a></h3>'
    + '<div class="card-footer">' + dateInfo(article.published_at)
    + '<a class="card-read" href="' + url + '" aria-label="Tovább olvasom: ' + title + '">Tovább olvasom</a></div></article>';
}

function renderHomeFeatured(items = [], { error = false } = {}) {
  const latest = items.slice(0, HOME_FEATURED_COUNT);
  if (!latest.length) {
    return '<section class="shell cover-grid home-latest cover-empty" id="friss-cikkek" aria-labelledby="latest-title">'
      + '<div class="editorial-empty"><h2 id="latest-title">Legfrissebb cikkeink</h2><p>'
      + (error ? 'A cikkek átmenetileg nem tölthetők be.' : 'A legfrissebb cikkek hamarosan itt olvashatók.')
      + '</p><a class="text-link" href="/cikkek">A teljes magazin</a></div></section>';
  }
  return '<section class="shell cover-grid home-latest" id="friss-cikkek" aria-label="Kiemelt és friss cikkek">'
    + card(latest[0], 'lead')
    + (latest.length > 1 ? '<div class="latest-column"><div class="latest-heading"><h2 id="latest-title">Most a magazinban</h2>'
      + '<span>Friss nézőpontok</span></div><div class="home-story-list">' + latest.slice(1).map(article => card(article, 'compact')).join('') + '</div></div>' : '')
    + '</section>';
}

function renderHomeArticles(items = [], { error = false } = {}) {
  const more = items.slice(HOME_FEATURED_COUNT, HOME_FEATURED_COUNT + HOME_GRID_SIZE);
  const tabs = [['', 'Összes'], ['Szorongás', 'Szorongás'], ['Depresszió', 'Depresszió'], ['Alvás', 'Alvás'], ['Kapcsolatok', 'Kapcsolatok']];
  const content = more.length
    ? '<div class="article-grid articles-grid">' + more.map(article => card(article)).join('') + '</div>'
    : '<div class="editorial-empty"><p>' + (error ? 'A további cikkek most nem tölthetők be.' : 'További cikkekért nézd meg az archívumot.') + '</p><a href="/cikkek">A teljes magazin</a></div>';
  return '<section class="shell stories-section home-editorial" id="cikkek" aria-labelledby="home-articles-title">'
    + '<div class="section-heading"><div><p class="eyebrow">ÉRDEMES ELIDŐZNI</p><h2 id="home-articles-title">Gondolatok, amelyek <em>veled maradnak.</em></h2></div>'
    + '<a class="text-link" href="/cikkek">A teljes magazin</a></div>'
    + '<div class="article-toolbar"><nav class="filter-tabs" aria-label="Cikkek téma szerint">'
    + tabs.map(([category, label], index) => '<a' + (index === 0 ? ' class="selected"' : '') + ' href="' + html(archiveUrl(1, '', category)) + '">' + label + '</a>').join('')
    + '</nav><span class="article-count">' + more.length + ' olvasnivaló</span></div>' + content + '</section>';
}

function renderHomeMoreArticles(items = []) {
  const more = items.slice(HOME_FEATURED_COUNT + HOME_GRID_SIZE, HOME_ARTICLE_LIMIT);
  if (!more.length) return '';
  return '<section class="shell stories-section home-editorial home-editorial-more" id="tovabbi-cikkek" aria-labelledby="home-more-articles-title">'
    + '<div class="section-heading"><h2 id="home-more-articles-title">További cikkek</h2>'
    + '<a class="text-link" href="/cikkek">A teljes magazin</a></div>'
    + '<div class="article-grid articles-grid">' + more.map(article => card(article)).join('') + '</div></section>';
}

function renderArticlesIndex({ items = [], total = 0, page = 1, pages = 1, q = '', category = '', categories = [] } = {}) {
  const names = [...new Set(categories.map(item => typeof item === 'string' ? item : item.category || item.name).filter(Boolean))];
  const filters = '<form class="article-filters" action="/cikkek" method="get">'
    + '<label class="article-search"><span>Keresés a cikkek között</span><span class="archive-input">' + icon('search')
    + '<input type="search" name="q" value="' + html(q) + '" placeholder="Például: szorongás, alvás, kapcsolatok" maxlength="250"></span></label>'
    + '<label><span>Téma</span><span class="archive-select"><select name="category"><option value="">Minden téma</option>'
    + names.map(name => '<option value="' + html(name) + '"' + (name === category ? ' selected' : '') + '>' + html(name) + '</option>').join('')
    + '</select></span></label><button class="button button-green" type="submit">Keresés' + icon('search') + '</button></form>';
  const active = Boolean(q || category);
  let pager = '';
  if (pages > 1) {
    const numbers = [...new Set([1, pages, page - 2, page - 1, page, page + 1, page + 2])].filter(n => n > 0 && n <= pages).sort((a, b) => a - b);
    let previous = 0;
    const links = numbers.map(number => {
      const gap = previous && number > previous + 1 ? '<span class="page-gap" aria-hidden="true">…</span>' : '';
      previous = number;
      return gap + (number === page
        ? '<span class="article-page-number current" aria-current="page" aria-label="' + number + '. oldal, jelenlegi">' + number + '</span>'
        : '<a class="article-page-number" href="' + html(archiveUrl(number, q, category)) + '" aria-label="' + number + '. oldal">' + number + '</a>');
    }).join('');
    pager = '<nav class="article-pagination" aria-label="Cikkek lapozása">'
      + (page > 1 ? '<a href="' + html(archiveUrl(page - 1, q, category)) + '" rel="prev">Előző</a>' : '') + links
      + (page < pages ? '<a href="' + html(archiveUrl(page + 1, q, category)) + '" rel="next">Következő</a>' : '') + '</nav>';
  }
  const body = '<main id="tartalom" class="shell editorial-main archive-main">'
    + '<nav class="editorial-breadcrumb" aria-label="Morzsanavigáció"><a href="/">Főoldal</a><span aria-hidden="true">/</span><span>Cikkek</span></nav>'
    + '<header class="editorial-heading"><div><p class="eyebrow">OLVASNIVALÓ A MENTÁL.HU-N</p><h1>' + (category ? html(category) : 'A MENTÁL.hu <em>magazinja.</em>') + '</h1></div>'
    + '<p>Pszichológia, mentális egészség, kapcsolatok és mindennapok. Írások, amelyek segítenek jobban érteni önmagunkat és egymást.</p></header>'
    + filters + '<div class="article-results"><p><strong>' + html(total) + '</strong> cikk' + (active ? ' a megadott feltételekkel' : ' · a legutóbb megjelentek elöl') + '</p>'
    + (active ? '<a class="text-link" href="/cikkek">Szűrés törlése</a>' : '') + '</div>'
    + (items.length ? '<div class="article-grid articles-grid">' + items.map(article => card(article)).join('') + '</div>'
      : '<div class="editorial-empty"><h2>' + (active ? 'Erre most nincs találat.' : 'Itt gyűjtjük a cikkeinket.') + '</h2><p>'
      + (active ? 'Próbálj másik kifejezést vagy válassz másik témát.' : 'A publikálás után az új írások automatikusan megjelennek ezen az oldalon.') + '</p></div>')
    + pager + '</main>';
  const metaTitle = (q ? 'Keresés: ' + q : category ? category + ' – Cikkek' : 'Cikkek és kutatások') + (page > 1 ? ' – ' + page + '. oldal' : '');
  return editorialShell(metaTitle, body, {
    description: 'A MENTÁL.hu cikkei pszichológiáról, mentális egészségről, kapcsolatokról és önismeretről.',
    canonical: archiveUrl(page, q, category)
  });
}

function renderArticleEmbeddedMedia(content) {
  return String(content || '').replace(/<p>\s*\[\[VIDEO_(?:AI_IDENTITAS|VESZTESEGEK)\]\]\s*<\/p>/g, '');
}

function renderRelatedProviders(providers = [], { articleSlug = '', location = null } = {}) {
  const seen = new Set();
  const items = (Array.isArray(providers) ? providers : []).filter(provider => {
    if (!provider || !provider.slug || !provider.name || seen.has(provider.slug)) return false;
    seen.add(provider.slug);
    return true;
  }).slice(0, 4);
  const city = location && location.id && location.name ? location : null;
  const source = city && ['manual', 'browser'].includes(city.source) ? city.source : 'ip';
  const citySource = city ? (source === 'manual' ? 'Választott település' : source === 'browser' ? 'Helyzet alapján' : 'Becsült hely') : 'Közeli szakembert keresel?';
  const locationControls = articleSlug ? '<div class="provider-location">'
    + '<p class="provider-location-label" data-provider-location-source>' + html(citySource) + '</p>'
    + '<p class="provider-location-current">' + icon('pin') + '<strong data-provider-location-name>' + html(city ? city.name : 'Válassz települést') + '</strong></p>'
    + '<p class="provider-location-hint" data-provider-location-hint>' + (city ? 'Először a közelben elérhető, majd az online szakembereket mutatjuk.' : 'A közeli találatokhoz add meg a településed. Addig online szakembereket mutatunk.') + '</p>'
    + '<div class="provider-location-controls" data-provider-location-controls hidden>'
    + '<details class="provider-city-picker" data-provider-city-picker><summary>' + (city ? 'Település módosítása' : 'Település kiválasztása') + '</summary>'
    + '<form class="provider-city-form" data-provider-city-form role="search" aria-label="Település keresése">'
    + '<label for="provider-city-query">Település neve</label><div class="provider-city-search"><input id="provider-city-query" name="city" type="search" maxlength="100" autocomplete="off" placeholder="Például Budapest" aria-controls="provider-city-results"><button type="submit">Keresés</button></div>'
    + '<p class="provider-city-status" data-provider-city-status role="status" aria-live="polite"></p><ul id="provider-city-results" class="provider-city-results" data-provider-city-results aria-label="Településtalálatok"></ul></form></details>'
    + '<div class="provider-location-actions"><button type="button" class="provider-location-button" data-provider-use-location>Helyzetem használata</button>'
    + '<button type="button" class="provider-location-button" data-provider-reset-location' + (city && source !== 'ip' ? '' : ' hidden') + '>Automatikus hely</button></div>'
    + '<p class="provider-location-memory">A választott települést megjegyezzük ezen az eszközön.</p></div>'
    + '<p class="provider-location-status" data-provider-location-status role="status" aria-live="polite" aria-atomic="true" hidden></p>'
    + '<button type="button" class="provider-location-button provider-location-retry" data-provider-location-retry hidden>Újrapróbálom</button>'
    + '<p class="provider-location-attribution">Helyadatok: <a href="https://www.geonames.org/" target="_blank" rel="noopener noreferrer">GeoNames</a> · <a href="https://db-ip.com/" target="_blank" rel="noopener noreferrer">DB-IP</a></p></div>' : '';
  return '<section class="reader-providers" aria-labelledby="reader-providers-title"' + (articleSlug ? ' data-related-providers data-article-slug="' + html(articleSlug) + '" data-provider-city-id="' + html(city ? city.id : '') + '" data-provider-city-name="' + html(city ? city.name : '') + '" data-provider-city-source="' + html(city ? source : '') + '"' : '') + '>'
    + '<p class="reader-providers-kicker">Szakemberkereső</p><h2 id="reader-providers-title">A témához kapcsolódó szolgáltatók</h2>'
    + locationControls + '<div data-provider-results>'
    + (items.length ? '<ul class="reader-provider-list">' + items.map(provider => {
      const online = provider.match_type === 'online';
      const nearby = provider.match_type === 'nearby' && Number.isFinite(provider.distance_km) && provider.distance_km >= 0;
      const locationText = [provider.city, nearby ? 'kb. ' + Math.round(provider.distance_km) + ' km' : '', !online && provider.online_available ? 'Online is' : ''].filter(Boolean).join(' · ');
      return '<li><a class="reader-provider-card" href="' + html('/szolgaltato/' + encodeURIComponent(provider.slug)) + '">'
        + (provider.category_name ? '<span class="reader-provider-category">' + html(provider.category_name) + '</span>' : '')
        + '<h3>' + html(provider.name) + '</h3>'
        + (online ? '<span class="reader-provider-match">Online konzultáció</span>' : '')
        + (locationText ? '<span class="reader-provider-location"' + (nearby ? ' title="Településközpontok közötti becsült távolság"' : '') + '>' + html(locationText) + '</span>' : '')
        + '<span class="reader-provider-open">Adatlap megnyitása <span aria-hidden="true">↗</span></span></a></li>';
    }).join('') + '</ul>'
      : '<p class="reader-providers-empty">Böngéssz a katalógusban szakterület és település szerint.</p>')
    + '</div><p class="reader-providers-note">Válogatás a katalógusból. A megjelenés nem személyre szabott szakmai ajánlás.</p>'
    + '<a class="reader-providers-more" href="/szolgaltatok">További szakemberek <span aria-hidden="true">→</span></a></section>';
}

function renderArticle(article, { related = [], providers = [], providerLocation = null } = {}) {
  const sources = Array.isArray(article.sources) ? article.sources.filter(source => source && sourceUrl(source.url)) : [];
  const research = article.publication_origin === 'research-watch';
  const hero = validImage(article.hero_url);
  const sourceSection = sources.length ? '<section class="article-sources" aria-labelledby="article-sources-heading"><h2 id="article-sources-heading">Források</h2><ol>'
    + sources.map(source => '<li><a href="' + html(sourceUrl(source.url)) + '" target="_blank" rel="noopener noreferrer">' + html(source.title || source.doi || source.url) + '</a>'
      + (source.doi ? '<small>DOI: ' + html(source.doi) + '</small>' : '') + (source.published_at ? '<small>' + dateInfo(source.published_at) + '</small>' : '') + '</li>').join('') + '</ol></section>' : '';
  const body = '<main id="tartalom" class="shell editorial-main editorial-reader">'
    + '<nav class="editorial-breadcrumb" aria-label="Morzsanavigáció"><a href="/">Főoldal</a><span aria-hidden="true">/</span><a href="/cikkek">Cikkek</a><span aria-hidden="true">/</span>'
    + '<a href="' + html(archiveUrl(1, '', article.category)) + '">' + html(article.category) + '</a></nav>'
    + '<article class="reader-article"><header class="reader-heading">' + categoryLink(article) + '<h1>' + html(article.title) + '</h1>'
    + (article.excerpt ? '<p class="reader-lead">' + html(article.excerpt) + '</p>' : '')
    + '<div class="reader-tools">' + metadata(article, true) + '<div class="reader-save">' + bookmark(article, 'reader-bookmark') + '<span>Elteszem későbbre</span></div></div></header>'
    + (hero ? '<figure class="reader-cover"><img src="' + html(hero) + '" alt="' + html(article.hero_image_alt || '') + '" width="1200" height="650" fetchpriority="high">'
      + (article.hero_image_caption ? '<figcaption>' + html(article.hero_image_caption) + '</figcaption>' : '') + '</figure>' : '')
    + '<div class="reader-layout"><aside class="reader-margin reader-margin--providers">' + renderRelatedProviders(providers, { articleSlug: article.slug, location: providerLocation })
    + '<div class="reader-margin-reading"><p class="reader-note">' + icon('book') + (research ? 'Kutatásról közérthetően' : 'Egy kis idő az olvasásra.') + '</p><a href="/cikkek">Minden cikk →</a></div></aside>'
    + '<div class="reader-content"><div class="reader-body">' + renderArticleEmbeddedMedia(article.content_html) + '</div>' + sourceSection + '</div></div></article>'
    + (related.length ? '<section class="reader-related" aria-labelledby="related-title"><div class="section-heading"><h2 id="related-title">Érdemes <em>tovább olvasni.</em></h2>'
      + '<a class="text-link" href="/cikkek">Minden cikk</a></div><div class="article-grid articles-grid">' + related.slice(0, 3).map(item => card(item)).join('') + '</div></section>' : '')
    + '</main>';
  return editorialShell(article.seo_title || article.title, body, {
    description: article.seo_description || article.excerpt,
    canonical: articleUrl(article),
    type: 'article',
    image: hero,
    imageAlt: article.hero_image_alt || article.title,
    publishedAt: article.published_at,
    modifiedAt: article.updated_at,
    section: article.category,
    styles: ['/related-providers.css?v=geo-20261127'],
    scripts: ['/related-providers.js?v=geo-20261127']
  });
}

module.exports = { HOME_ARTICLE_LIMIT, renderHomeFeatured, renderHomeArticles, renderHomeMoreArticles, renderArticlesIndex, renderArticle, renderRelatedProviders, editorialShell };
