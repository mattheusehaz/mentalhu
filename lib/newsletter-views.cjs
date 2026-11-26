'use strict';

const {siteShell, html} = require('./site-shell.cjs');
const RELEASE = 'newsletter-20261126';

function topicOptions(topics = []) {
  return topics.map(topic => '<label class="newsletter-topic"><input type="checkbox" name="topics" value="' + html(topic.key) + '"><span>' + html(topic.label) + '</span></label>').join('');
}

function newsletterForm({topics = [], preferences = false} = {}) {
  return '<form class="newsletter-form" data-newsletter-form data-newsletter-mode="' + (preferences ? 'preferences' : 'subscribe') + '" method="post" action="/api/newsletter/' + (preferences ? 'preferences' : 'subscribe') + '">' +
    '<div class="newsletter-fields"><label>Név<input name="name" type="text" required minlength="2" maxlength="120" autocomplete="name" placeholder="Ahogy megszólíthatunk"></label>' +
    (preferences ? '<div class="newsletter-email"><span>E-mail-cím</span><strong data-newsletter-email></strong></div>' : '<label>E-mail-cím<input name="email" type="email" required maxlength="254" autocomplete="email" placeholder="pelda@email.hu"></label>') + '</div>' +
    '<fieldset class="newsletter-interests"><legend>Milyen témák érdekelnek?</legend><p class="newsletter-hint">Többet is választhatsz, és később bármikor módosíthatod.</p><div class="newsletter-topics" data-newsletter-topics>' + (topics.length ? topicOptions(topics) : '<p class="newsletter-loading" role="status">A témák betöltése…</p>') + '</div><button type="button" class="newsletter-retry" data-newsletter-retry hidden>Témák újratöltése</button></fieldset>' +
    (preferences ? '' : '<label class="newsletter-trap" aria-hidden="true">Ezt a mezőt hagyd üresen<input name="website" tabindex="-1" autocomplete="off"></label><label class="newsletter-consent"><input type="checkbox" name="consent" required><span>Kifejezetten hozzájárulok, hogy a Proptech Digital Investment Zrt. a nevem, az e-mail-címem és a választott témáim alapján személyre szabott MENTÁL.hu-hírlevelet küldjön. Tudomásul veszem, hogy a témaválasztás egészséggel kapcsolatos érdeklődésre is utalhat; hozzájárulásomat bármikor visszavonhatom. <a href="/hirlevel-adatkezeles" target="_blank" rel="noopener">Adatkezelési tájékoztató</a></span></label>') +
    '<div class="newsletter-submit"><button class="button button-green" type="submit">' + (preferences ? 'Választásaim mentése' : 'Feliratkozom') + ' <span aria-hidden="true">→</span></button><p>' + (preferences ? 'A következő válogatást már ezekből a témákból állítjuk össze.' : 'E-mailben kérünk megerősítést.<br>Bármikor leiratkozhatsz.') + '</p></div><p class="newsletter-message" data-newsletter-message role="status" aria-live="polite" tabindex="-1"></p><noscript><p>A hírlevél beállításaihoz engedélyezd a JavaScriptet a böngésződben.</p></noscript></form>';
}

function renderNewsletterPage({mode = 'subscribe', topics = [], token = ''} = {}) {
  const modes = {
    subscribe: ['A te heti olvasnivalód.', 'Válaszd ki, mi foglalkoztat. Péntek reggel elküldjük az elmúlt hét új cikkeiből a saját válogatásodat.'],
    confirm: ['Még egy kattintás.', 'Erősítsd meg, hogy te kérted a MENTÁL.hu hírlevelét. Ezután péntekenként a választott témáidból küldünk olvasnivalót.'],
    preferences: ['Ami most érdekel.', 'Itt módosíthatod a nevedet és a választott témáidat. A változás a következő hírlevélre érvényes.'],
    unsubscribe: ['Leiratkozás a hírlevélről.', 'Az alábbi gombbal leállíthatod a MENTÁL.hu heti hírlevelét. Később bármikor újra feliratkozhatsz.']
  };
  if (!Object.hasOwn(modes, mode)) mode = 'subscribe';
  const [heading, intro] = modes[mode];
  let content;
  if (mode === 'subscribe') content = newsletterForm({topics});
  else if (mode === 'preferences') content = '<div data-newsletter-preferences-loading role="status">A beállításaid betöltése…</div><div data-newsletter-preferences-content hidden>' + newsletterForm({topics, preferences:true}) + '<p class="newsletter-leave"><a data-newsletter-unsubscribe-link href="/hirlevel/leiratkozas">Leiratkozom a hírlevélről</a></p></div><p class="newsletter-message" data-newsletter-page-message role="status" aria-live="polite"></p>';
  else content = '<div class="newsletter-token-action"><button type="button" class="button button-green" data-newsletter-' + (mode === 'confirm' ? 'confirm' : 'unsubscribe') + '>' + (mode === 'confirm' ? 'Megerősítem a feliratkozást' : 'Leiratkozom') + '</button><p class="newsletter-message" data-newsletter-message role="status" aria-live="polite" tabindex="-1"></p><p data-newsletter-followup hidden></p></div>';
  const body = '<main id="tartalom" class="shell newsletter-page" data-newsletter-page data-mode="' + mode + '"' + (token ? ' data-token="' + html(token) + '"' : '') + '><a class="newsletter-back" href="/">← Vissza a magazinba</a><div class="newsletter-page-grid"><header class="newsletter-intro"><p class="newsletter-kicker">MENTÁL.hu · Hírlevél</p><h1>' + heading + '</h1><p class="newsletter-lead">' + intro + '</p>' + (mode === 'subscribe' ? '<div class="newsletter-cadence"><span class="newsletter-cadence-day">Péntek</span><span>8:00 · magyar idő szerint</span></div><p class="newsletter-small">Csak akkor küldünk levelet, ha az adott héten jelent meg új cikk a választott témáidban.</p>' : '') + '</header><section class="newsletter-sheet" aria-label="Hírlevél ' + (mode === 'preferences' ? 'beállítások' : 'űrlap') + '">' + content + '</section></div></main>';
  return siteShell(heading + ' – Hírlevél', body, {description:'Heti válogatás a MENTÁL.hu friss cikkeiből, a téged érdeklő témákban. Péntekenként, magyar idő szerint reggel 8-kor.',canonical:mode === 'subscribe' ? '/hirlevel' : '/hirlevel/' + ({confirm:'megerosites',preferences:'beallitasok',unsubscribe:'leiratkozas'}[mode]),styles:['/newsletter.css?v=' + RELEASE],scripts:['/newsletter.js?v=' + RELEASE],bodyClass:'newsletter-body',...(mode === 'subscribe' ? {} : {robots:'noindex,nofollow'})});
}

function renderNewsletterPrivacy({provider} = {}) {
  const mailProvider = ({resend:'Resend',brevo:'Brevo',smtp:'az adminisztrátor által beállított SMTP-szolgáltató'})[provider] || 'az adminisztrátor által beállított levélküldő szolgáltató';
  const body = '<main id="tartalom" class="shell newsletter-privacy"><a class="newsletter-back" href="/hirlevel">← Hírlevél</a><p class="newsletter-kicker">MENTÁL.hu</p><h1>A hírlevél adatkezelése</h1>' +
    '<p>A feliratkozás célja, hogy heti egy levélben elküldjük a választott témáidhoz kapcsolódó friss cikkeket. A feliratkozás önkéntes, és e-mailes megerősítést kérünk hozzá.</p>' +
    '<h2>Ki kezeli az adatokat?</h2><p><strong>Proptech Digital Investment Zártkörűen Működő Részvénytársaság</strong><br>1162 Budapest, Ferenc utca 2.<br>Adatkezeléssel kapcsolatos megkeresések: <a href="mailto:info@proptechdigital.com">info@proptechdigital.com</a>. A részletes cégadatok az <a href="/impresszum">impresszumban</a> találhatók.</p>' +
    '<h2>Milyen adatokat és milyen célból használunk?</h2><p>A nevedet a megszólításhoz, az e-mail-címedet a kézbesítéshez, a kiválasztott témákat a cikkek összeválogatásához használjuk. Tároljuk a feliratkozás, a hozzájárulás és a megerősítés időpontját, az elfogadott tájékoztató változatát, valamint a feliratkozás állapotát. A küldési naplóban a kiválasztott cikkeket, a küldés időpontját és technikai eredményét rögzítjük.</p>' +
    '<p>A témaválasztás egészséggel kapcsolatos érdeklődésre is utalhat. A választásaidat kizárólag a hírlevél cikkeinek kiválasztására használjuk, diagnózist nem állítunk fel belőlük.</p>' +
    '<h2>Mi az adatkezelés jogalapja?</h2><p>Az adatkezelés alapja az önkéntes, kifejezett hozzájárulásod az általános adatvédelmi rendelet (GDPR) 6. cikk (1) bekezdés a) pontja szerint. Amennyiben a témaválasztás egészségre vonatkozó személyes adatnak minősül, az ilyen adat kezelésének alapja a GDPR 9. cikk (2) bekezdés a) pontja szerinti kifejezett hozzájárulás. A hozzájárulást nem kötjük a magazin olvasásához. Bármikor visszavonhatod; ez a visszavonás előtti adatkezelés jogszerűségét nem érinti.</p>' +
    '<h2>Hogyan érkezik a hírlevél?</h2><p>A hírlevél pénteken, magyar idő szerint reggel 8 órától indul. Az előző heti időszakban megjelent, a témáidhoz illeszkedő cikkekből válogatunk. Ha nincs ilyen új cikk, nem küldünk üres levelet.</p>' +
    '<h2>Kik vesznek részt a technikai működtetésben?</h2><p>A honlap és az adatbázis tárhelyét a DigitalOcean biztosítja. A levelek továbbításában közreműködik: <strong>' + html(mailProvider) + '</strong>. A levélküldő a kézbesítéshez megkapja az e-mail-címet és a levél tartalmát. Az igénybe vett szolgáltatóra és az alkalmazott adatátadási garanciákra vonatkozó további információt az adatkezelő fenti elérhetőségén kérhetsz.</p>' +
    '<h2>Módosítás, megőrzés és leiratkozás</h2><p>Minden hírlevélben találsz hivatkozást a témáid módosításához és a leiratkozáshoz. A nevet, az e-mail-címet és a választott témákat az aktív feliratkozás kezeléséhez használjuk. A hét napon belül meg nem erősített új feliratkozást töröljük.</p>' +
    '<p>A kézbesítéshez előkészített levél tartalmát titkosítva tároljuk. A levélküldő által átvett üzenet helyi tartalmát az átadás után töröljük. Ha az átadás nem sikerül vagy nem ellenőrizhető, a heti levél helyi tartalmát legfeljebb 24 óráig, a megerősítő levélét legfeljebb hét napig őrizzük. A küldések technikai naplóját 90 nap után töröljük.</p>' +
    '<p>Leiratkozáskor leállítjuk a további heti hírleveleket, töröljük a nevet és a témaválasztást, valamint érvénytelenítjük a függőben lévő megerősítéseket és a beállítási hivatkozásokat. A leiratkozás tényét, az ehhez szükséges e-mail-címet és a hozzájárulás igazolását megőrizzük, hogy egy korábbi feliratkozás alapján ne induljon újra a küldés. Személyes adataid törlését az adatkezelő e-mail-címén kérheted.</p>' +
    '<p>A megerősítő és beállítási hivatkozásokat ne oszd meg másokkal: ezekkel kezelhető a feliratkozásod.</p>' +
    '<h2>Milyen jogaid vannak?</h2><p>Kérhetsz tájékoztatást és hozzáférést a személyes adataidhoz, javítást, törlést, az adatkezelés korlátozását, valamint az alkalmazandó feltételek mellett adathordozhatóságot. A hozzájárulásodat bármikor visszavonhatod a leiratkozási hivatkozással vagy a <a href="mailto:info@proptechdigital.com">info@proptechdigital.com</a> címre küldött kéréssel. Panasszal fordulhatsz a <a href="https://www.naih.hu/" target="_blank" rel="noopener">Nemzeti Adatvédelmi és Információszabadság Hatósághoz</a>, illetve bírósági jogorvoslatot kérhetsz.</p>' +
    '<p class="newsletter-small">Tájékoztató frissítve: 2026. november 26.</p></main>';
  return siteShell('A hírlevél adatkezelése',body,{canonical:'/hirlevel-adatkezeles',description:'A MENTÁL.hu hírlevél-feliratkozás adatkezelési tájékoztatója.',styles:['/newsletter.css?v=' + RELEASE]});
}

module.exports = {renderNewsletterPage,renderNewsletterPrivacy,newsletterForm,topicOptions};
