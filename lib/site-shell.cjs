'use strict';

const RELEASE = 'folio-20261123';
const html = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const icon = name => '<svg class="icon" aria-hidden="true"><use href="#i-' + html(name) + '"/></svg>';
const icons = require('./site-icons.cjs');
const { siteMetadata } = require('./site-metadata.cjs');

function brand(extra = '') {
  return '<a class="brand ' + html(extra) + '" href="/" aria-label="MENTÁL.hu főoldal"><img src="/assets/mental-mark.svg" width="38" height="34" alt=""><span>MENTÁL<span class="brand-domain">.hu</span></span></a>';
}

function siteHeader({active = 'magazin', home = false} = {}) {
  const links = [
    ['magazin', '/cikkek', 'Magazin'],
    ['szakemberek', '/szolgaltatok', 'Szakemberkereső'],
    ['tudastar', '/#tudastar', 'Tudástár'],
    ['programok', '/kategoria/konferenciak-es-esemenyek', 'Programok']
  ];
  const nav = links.map(([key,url,label]) => '<a href="' + url + '"' + (active === key ? ' class="active" aria-current="' + (home ? 'true' : 'page') + '"' : '') + '>' + label + '</a>').join('');
  return '<a class="skip-link" href="#tartalom">Ugrás a tartalomhoz</a>' + icons + '<header class="site-header"><div class="shell header-inner">' + brand() + '<nav class="main-nav dir-nav" aria-label="Főmenü">' + nav + '</nav><div class="header-actions"><button class="icon-button" type="button" data-open-search aria-label="Keresés a cikkek között">' + icon('search') + '</button><button class="icon-button saved-button" type="button" data-open-saved aria-label="Mentett cikkek">' + icon('bookmark') + '<span id="saved-count" hidden>0</span></button><a class="header-login" href="/belepes">Belépés</a><a class="button button-small header-cta" href="' + (home ? '#segitseg' : '/szolgaltatok') + '">Szakembert keresek</a><details class="mobile-menu"><summary aria-label="Menü">' + icon('menu') + '</summary><nav aria-label="Mobil főmenü">' + nav + '<a href="/#kategoriak">Kategóriák</a><a href="/belepes">Belépés</a><a href="/regisztracio">Szolgáltatói regisztráció</a></nav></details></div></div></header>';
}

function siteFooter() {
  return '<footer id="rolunk" class="site-footer"><div class="shell"><div class="footer-top"><div>' + brand('footer-brand') + '<p>Nem újabb válaszokat.<br><em>Jobb kiindulópontokat.</em></p></div><div class="footer-about">Gondolatok, szakemberek és lehetőségek.<br>Egy hely, ahonnan elindulhatsz.</div><nav aria-label="Lábléc"><a href="/cikkek">Magazin</a><a href="/szolgaltatok">Szakemberkereső</a><a href="/#kategoriak">Kategóriák</a><a href="/#tudastar">Tudástár</a><a href="/impresszum">Impresszum</a><a href="/kapcsolatfelvetel-adatkezeles">Adatkezelés</a></nav></div><div class="footer-bottom"><span>© ' + new Date().getFullYear() + ' MENTÁL.hu</span><span>A katalógus tájékoztató jellegű; a megjelenés önmagában nem jelent szakmai ajánlást.</span><a href="#tartalom">Vissza az elejére</a></div></div></footer>';
}

function siteOverlays() {
  return '<dialog id="search-dialog" class="search-dialog" aria-labelledby="search-dialog-title"><div class="dialog-top"><span class="eyebrow">MENTÁL.HU MAGAZIN</span><button class="icon-button" type="button" data-close-dialog aria-label="Kereső bezárása">' + icon('close') + '</button></div><h2 id="search-dialog-title">Mi foglalkoztat <em>most?</em></h2><form action="/cikkek" method="get" class="dialog-search-form"><label class="dialog-search">' + icon('search') + '<input id="article-search" type="search" name="q" maxlength="200" placeholder="Keress a cikkek között…" aria-label="Cikk keresése"></label><button class="button button-green" type="submit">Keresés</button></form><p class="search-hint">Például: alvás, szorongás, család</p><div id="search-results" class="dialog-results" aria-live="polite"></div></dialog><dialog id="saved-dialog" class="search-dialog" aria-labelledby="saved-dialog-title"><div class="dialog-top"><span class="eyebrow">EGY KÉSŐBBI PILLANATRA</span><button class="icon-button" type="button" data-close-dialog aria-label="Mentett cikkek bezárása">' + icon('close') + '</button></div><h2 id="saved-dialog-title">A te <em>olvasnivalóid.</em></h2><p class="search-hint">Az elmentett cikkeket ebben a böngészőben találod meg.</p><div id="saved-results" class="dialog-results"></div></dialog><div id="toast" class="toast" role="status" aria-live="polite"></div>';
}

function siteShell(title, body, {description = '', canonical = '/', active = 'magazin', bodyClass = '', styles = [], scripts = [], ...metadata} = {}) {
  const localResource = value => typeof value === 'string' && value.startsWith('/') && !value.startsWith('//');
  return '<!doctype html><html lang="hu" data-design="' + RELEASE + '"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' + siteMetadata(title, {description, canonical, ...metadata}) + '<link rel="stylesheet" href="/assets/fonts/fonts.css?v=' + RELEASE + '"><link rel="stylesheet" href="/mental.css?v=accounts-20261126">' + styles.filter(localResource).map(url => '<link rel="stylesheet" href="' + html(url) + '">').join('') + '<script src="/mental.js?v=' + RELEASE + '" defer></script>' + scripts.filter(localResource).map(url => '<script src="' + html(url) + '" defer></script>').join('') + '</head><body class="' + html(bodyClass) + '">' + siteHeader({active}) + body + siteFooter() + siteOverlays() + '</body></html>';
}

module.exports = { RELEASE, html, icon, siteShell, siteHeader, siteFooter, siteOverlays };
