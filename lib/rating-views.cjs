'use strict';
const {html}=require('./site-shell.cjs');

// Public/cacheable markup intentionally contains no scores or rating counts.
function renderRatingPanel({slug}={}) {
  if(typeof slug!=='string'||!/^[a-zA-Z0-9_-]+$/.test(slug))return '';
  const next='/szolgaltato/'+slug+'#ertekelesek';
  return '<section id="ertekelesek" class="service-ratings" data-service-ratings data-listing-slug="'+html(slug)+'" aria-labelledby="serviceRatingsTitle">'+
    '<header class="service-ratings-heading"><p class="eyebrow">OLVASÓI TAPASZTALATOK</p><h2 id="serviceRatingsTitle">Értékelések</h2></header>'+
    '<div data-ratings-guest class="service-ratings-gate"><div><h3>Lépj be az értékelésekhez.</h3><p>Az olvasói értékeléseket bejelentkezés után nézheted meg. Saját fiókoddal te is értékelheted a szolgáltatót.</p></div><div class="service-ratings-gate-actions"><a class="button button-green" href="/belepes?next='+encodeURIComponent(next)+'">Belépés</a><a class="service-ratings-link" href="/regisztracio?next='+encodeURIComponent(next)+'">Regisztráció</a></div></div>'+
    '<div data-ratings-content hidden></div><p class="service-ratings-message" data-ratings-message role="status" aria-live="polite"></p><button type="button" data-ratings-retry class="service-ratings-secondary" hidden>Újrapróbálás</button>'+
    '<noscript><p>Az értékelések megtekintéséhez engedélyezd a JavaScriptet, és jelentkezz be.</p></noscript></section>';
}
module.exports={renderRatingPanel};
