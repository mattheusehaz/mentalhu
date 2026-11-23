'use strict';

const SITE_URL = 'https://mental.hu';
const SITE_NAME = 'MENTÁL.hu';
const HOME_TITLE = 'MENTÁL.hu – Pszichológia és mentális egészség';
const HOME_DESCRIPTION = 'Pszichológiai cikkek, friss kutatások és mentális egészség közérthetően. Keress szakembert, szolgáltatást vagy programot a MENTÁL.hu-n.';
const DEFAULT_IMAGE = '/assets/mental-og.png?v=20261123';
const VERSION = '20261123';
const escape = value => String(value ?? '').replace(/[&<>"']/g, character => ({'&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'}[character]));
const plain = value => String(value ?? '').replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();

function absoluteUrl(value, fallback = '/') {
  if (typeof value !== 'string' || /[\\\u0000-\u0020]/.test(value)) return SITE_URL + fallback;
  try {
    const url = new URL(value, SITE_URL);
    if (url.origin !== SITE_URL || !value.startsWith('/') && !value.startsWith(SITE_URL + '/')) return SITE_URL + fallback;
    url.hash = '';
    return url.href;
  } catch { return SITE_URL + fallback; }
}

function pageTitle(value) {
  const title = plain(value);
  if (!title) return HOME_TITLE;
  if (title === SITE_NAME || title.startsWith(SITE_NAME + ' – ')) return title;
  return title.replace(/(?:\s*[–—|:\-]\s*MENTÁL\.hu)+$/gi, '').trim() + ' – ' + SITE_NAME;
}

function isoDate(value) {
  if (!value) return '';
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : '';
}

function siteMetadata(title, {description = HOME_DESCRIPTION, canonical = '/', image = '', imageAlt = '', type = 'website', publishedAt, modifiedAt, section = '', robots = ''} = {}) {
  const fullTitle = pageTitle(title);
  const summary = plain(description) || HOME_DESCRIPTION;
  const url = absoluteUrl(canonical);
  const imageUrl = absoluteUrl(image || DEFAULT_IMAGE, DEFAULT_IMAGE);
  const fallbackImage = imageUrl === SITE_URL + DEFAULT_IMAGE;
  const alt = plain(imageAlt) || (fallbackImage ? 'MENTÁL.hu – Pszichológia, mentális egészség, magazin és szakemberkereső' : fullTitle);
  const meta = (name, value, attribute = 'property') => '<meta ' + attribute + '="' + name + '" content="' + escape(value) + '">';
  const imageType = fallbackImage ? 'image/png' : /\.jpe?g(?:\?|$)/i.test(imageUrl) ? 'image/jpeg' : /\.png(?:\?|$)/i.test(imageUrl) ? 'image/png' : /\.webp(?:\?|$)/i.test(imageUrl) ? 'image/webp' : '';
  const tags = [
    '<title>' + escape(fullTitle) + '</title>',
    meta('description', summary, 'name'),
    meta('theme-color', '#183c33', 'name'),
    '<link rel="canonical" href="' + escape(url) + '">',
    meta('og:site_name', SITE_NAME), meta('og:locale', 'hu_HU'),
    meta('og:type', type === 'article' ? 'article' : 'website'),
    meta('og:title', fullTitle), meta('og:description', summary), meta('og:url', url),
    meta('og:image', imageUrl), meta('og:image:secure_url', imageUrl), meta('og:image:alt', alt),
    imageType ? meta('og:image:type', imageType) : '',
    fallbackImage ? meta('og:image:width', '1200') + meta('og:image:height', '630') : '',
    meta('twitter:card', 'summary_large_image', 'name'),
    meta('twitter:title', fullTitle, 'name'), meta('twitter:description', summary, 'name'),
    meta('twitter:image', imageUrl, 'name'), meta('twitter:image:alt', alt, 'name'),
    '<link rel="icon" href="/favicon.ico?v=' + VERSION + '" sizes="16x16 32x32 48x48">',
    '<link rel="icon" type="image/png" href="/favicon-32x32.png?v=' + VERSION + '" sizes="32x32">',
    '<link rel="icon" type="image/svg+xml" href="/favicon.svg?v=' + VERSION + '" sizes="any">',
    '<link rel="apple-touch-icon" href="/apple-touch-icon.png?v=' + VERSION + '" sizes="180x180">'
  ];
  if (robots) tags.push(meta('robots', robots, 'name'));
  if (type === 'article') {
    const published = isoDate(publishedAt), modified = isoDate(modifiedAt);
    if (published) tags.push(meta('article:published_time', published));
    if (modified) tags.push(meta('article:modified_time', modified));
    if (section) tags.push(meta('article:section', plain(section)));
  }
  return tags.filter(Boolean).join('\n');
}

module.exports = { siteMetadata, pageTitle, absoluteUrl, HOME_TITLE, HOME_DESCRIPTION };
