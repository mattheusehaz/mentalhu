'use strict';

const { html, icon } = require('./site-shell.cjs');

function safeUrl(value) {
  try {
    const url = new URL(String(value || ''));
    return ['http:', 'https:'].includes(url.protocol) ? url.href : '';
  } catch { return ''; }
}

function mediaUrl(value) {
  return /^\d+$/.test(String(value || '')) && Number(value) > 0 ? '/media/' + value : '';
}

function initials(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  return parts.slice(0, 2).map(part => [...part][0] || '').join('').toLocaleUpperCase('hu') || 'M';
}

function categoriesOf(listing) {
  return Array.isArray(listing.categories) ? listing.categories.filter(category => category && category.name) : [];
}

function listingCards(rows = []) {
  if (!rows.length) return '<div class="catalog-empty"><div class="catalog-empty-icon">' + icon('search') + '</div><h2>Nincs találat</h2><p>Próbálj másik kategóriát, várost vagy keresőkifejezést.</p><a class="button button-green" href="/szolgaltatok">A teljes katalógus</a></div>';
  return rows.map(listing => {
    const portrait = mediaUrl(listing.profile_image_id);
    const categories = categoriesOf(listing);
    return '<a class="listing-card' + (listing.featured ? ' featured' : '') + '" href="/szolgaltato/' + encodeURIComponent(listing.slug || '') + '">' +
      '<div class="listing-head">' + (portrait ? '<img class="listing-avatar" src="' + html(portrait) + '" alt="" width="64" height="64" loading="lazy">' : '<div class="listing-avatar listing-monogram" aria-hidden="true">' + html(initials(listing.name)) + '</div>') +
      '<div class="listing-title"><h2>' + html(listing.name) + '</h2>' + (listing.verified ? '<div class="verified">' + icon('check') + '<span>Ellenőrzött adatok</span></div>' : '') + '</div></div>' +
      '<p class="listing-description">' + html(listing.short_description || 'Részletes szolgáltatói profil és elérhetőségek.') + '</p>' +
      '<div class="listing-tags">' + categories.slice(0, 3).map(category => '<span class="chip">' + html(category.name) + '</span>').join('') + (listing.online_available ? '<span class="chip chip-online">Online is</span>' : '') + '</div>' +
      '<div class="listing-foot"><span>' + icon('pin') + html(listing.city || 'Magyarország') + '</span><span class="listing-open">Adatlap és kapcsolat</span></div></a>';
  }).join('');
}

function eventDate(value) {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? new Intl.DateTimeFormat('hu-HU', { dateStyle: 'long', timeStyle: 'short', timeZone: 'Europe/Budapest' }).format(date) : '';
}

function renderProfile(listing, { contactMarkup = '' } = {}) {
  const categories = categoriesOf(listing);
  const isAlternative = categories.some(category => category.verification_level === 'alternative');
  const isHealthcare = categories.some(category => category.verification_level === 'healthcare');
  const disclosure = isAlternative ? 'Alternatív / nem egészségügyi szolgáltatás. Nem helyettesíti az egészségügyi ellátást.' : isHealthcare ? 'Egészségügyi vagy szabályozott szakmai terület. A jogosultságokat érdemes a megfelelő nyilvántartásban is ellenőrizni.' : 'A profil a szolgáltató által megadott és/vagy nyilvánosan elérhető információkat tartalmaz.';
  const portrait = mediaUrl(listing.profile_image_id);
  const website = safeUrl(listing.website_url);
  const booking = safeUrl(listing.booking_url);
  const source = safeUrl(listing.source_url);
  const phone = String(listing.phone || '').trim();
  const phoneHref = phone.replace(/[^+\d]/g, '');
  const start = listing.event_start ? eventDate(listing.event_start) : '';
  const end = listing.event_end ? eventDate(listing.event_end) : '';
  const facts = [
    ['Végzettség / szakmai háttér', listing.qualifications],
    ['Szakterületek', listing.specialties],
    ['Árak', listing.price_info],
    ['Nyelvek', listing.languages],
    ['Cím', listing.address]
  ].filter(([, value]) => value);
  const firstCategory = categories.find(category => category.slug);
  return '<main id="tartalom" class="shell profile-main">' +
    '<nav class="catalog-breadcrumb" aria-label="Morzsanavigáció"><a href="/">Főoldal</a><span aria-hidden="true">/</span><a href="/szolgaltatok">Szakemberek</a>' + (firstCategory ? '<span aria-hidden="true">/</span><a href="/kategoria/' + encodeURIComponent(firstCategory.slug) + '">' + html(firstCategory.name) + '</a>' : '') + '</nav>' +
    '<header class="profile-heading"><div class="profile-heading-copy"><p class="eyebrow">SZOLGÁLTATÓI ADATLAP</p><h1>' + html(listing.name) + '</h1><p class="profile-intro">' + html(listing.short_description || '') + '</p><div class="profile-meta"><span>' + icon('pin') + html(listing.city || 'Magyarország') + '</span>' + (listing.online_available ? '<span class="profile-online">Online is elérhető</span>' : '') + (listing.verified ? '<span class="verified">' + icon('check') + 'Ellenőrzött adatok</span>' : '') + '</div></div>' +
    (portrait ? '<img class="profile-portrait" src="' + html(portrait) + '" alt="' + html(listing.name) + '" width="160" height="160" fetchpriority="high">' : '<div class="profile-monogram" aria-hidden="true">' + html(initials(listing.name)) + '</div>') + '</header>' +
    '<div class="profile-layout"><div class="profile-content"><section class="profile-section"><p class="eyebrow">ISMERD MEG</p><h2>Bemutatkozás</h2><div class="profile-description">' + html(listing.description || listing.short_description || 'Részletesebb bemutatkozásért keresd fel a szolgáltató weboldalát vagy elérhetőségeit.') + '</div></section>' +
    (facts.length ? '<section class="profile-section profile-details"><h2>Részletek</h2><dl>' + facts.map(([label, value]) => '<div><dt>' + html(label) + '</dt><dd>' + html(value) + '</dd></div>').join('') + '</dl></section>' : '') +
    (categories.length ? '<section class="profile-section profile-category-section"><h2>Kapcsolódó területek</h2><div class="profile-categories">' + categories.map(category => category.slug ? '<a class="chip" href="/kategoria/' + encodeURIComponent(category.slug) + '">' + html(category.name) + '</a>' : '<span class="chip">' + html(category.name) + '</span>').join('') + '</div></section>' : '') + '<p class="profile-disclosure">' + html(disclosure) + '</p></div>' +
    '<aside class="profile-contact-card" aria-labelledby="profile-contact-title"><div class="profile-contact-icon">' + icon('dialog') + '</div><p class="eyebrow">A KÖVETKEZŐ LÉPÉS</p><h2 id="profile-contact-title">Kapcsolat</h2><p class="profile-contact-intro">Nézd meg az elérhetőségeket, vagy kérj visszajelzést az alábbi űrlapon.</p><a class="button button-green" href="#kapcsolat">Kapcsolatfelvétel</a>' +
    (booking ? '<a class="button profile-booking" href="' + html(booking) + '" target="_blank" rel="noopener noreferrer">Időpont / foglalás</a>' : '') +
    '<div class="profile-contact-links">' + (website ? '<a href="' + html(website) + '" target="_blank" rel="noopener noreferrer">A szolgáltató weboldala</a>' : '') + (phone ? (phoneHref ? '<a href="tel:' + html(phoneHref) + '">' + html(phone) + '</a>' : '<p>' + html(phone) + '</p>') : '') + (source ? '<a href="' + html(source) + '" target="_blank" rel="noopener noreferrer">Nyilvános forrás és elérhetőség</a>' : '') + '</div>' +
    (start ? '<div class="profile-event"><strong>Meghirdetett időpont</strong><p>' + html(start) + (end ? '<br>' + html(end) : '') + '</p></div>' : '') + '</aside></div>' +
    contactMarkup + '</main>';
}

module.exports = { listingCards, renderProfile };
