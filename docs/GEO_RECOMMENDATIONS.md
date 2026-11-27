# Település szerinti szakemberajánlás

A cikkek ajánlója az adott cikk témájához és korosztályához illő, publikált
szolgáltatók közül legfeljebb négyet mutat. Az olvasó települése alapján a sorrend:

1. Azonos településen működő szakemberek.
2. Legfeljebb 50 km-re található szakemberek.
3. Online elérhető szakemberek, ha marad hely.

A földrajzi csoporton belül megmarad a témaspecifikus prioritás; a közeli
csoportban ezt a távolság követi. Azonos feltételeknél a korábbi véletlenszerű
válogatás működik tovább. Távoli, kizárólag személyes szolgáltatás nem töltheti
fel a listát. Ismeretlen helyzetnél csak online találatok jelennek meg.

Az online pótlást külön „Online konzultáció” jelölés mutatja. A `kb. … km`
településközpontok közötti légvonalbeli becslés, nem a rendelőig vezető út hossza.
A Budapesthez tartozó érvényes kerületmegnevezések ugyanahhoz a városhoz tartoznak.
Az ismeretlen vagy kétértelmű katalógus-települések csak online elérhetőség esetén
kerülhetnek az online csoportba. A klinikai és korosztályi szűrések megmaradnak.

## Az olvasó helyének feloldása

A kézzel vagy a böngésző helymeghatározásával kiválasztott település megelőzi
az IP alapján becsült helyet. A „Település módosítása” kereső magyar településeket
kínál fel. A „Helyzetem használata” gomb explicit kattintás után hívja a böngésző
helymeghatározását; az oldal megnyitása nem kér helyhozzáférést. Az „Automatikus
hely” törli a választást és új IP-becslést használ.

A böngésző már elküldés előtt két tizedesre kerekíti a koordinátákat, és a szerver
is kerekít. A szerver a legközelebbi magyar települést keresi, majd csak annak
azonosítóját, nevét és a választás módját adja vissza. Nincs nyers koordinátát
vagy olvasói IP-címet tartalmazó adatbázisírás, URL, HTML-attribútum vagy napló.
A városhatár közelében a becslés a szomszédos településre eshet; a kézi választás
ilyenkor is elsőbbséget élvez. Külföldi vagy ismeretlen IP nem kap kitalált várost.

Az IP-becslés a szerveren tárolt magyarországi DB-IP Lite snapshotból történik.
Nincs IP-t továbbító külső geolokációs kérés, API-kulcs vagy új npm-függőség.
A mobilhálózat, VPN, szolgáltatói útvonal és az adatbázis kora miatt a becslés
pontatlan lehet; a felület ezért „Becsült hely” címkét és városváltást kínál.
Az adatok származása, licence és frissítése a
[GEO-DATA-SOURCES.md](../content/GEO-DATA-SOURCES.md) dokumentumban szerepel.

## Megjegyzett választás és gyorsítótár

A `mental_provider_location` süti 90 napig érvényes, `HttpOnly`, `SameSite=Lax`,
élesben `Secure`. Tartalma verzió, kanonikus településazonosító és
`manual`/`browser` forrás, például `1|budapest|manual`. Nem bejelentkezési süti.
A szerver minden beolvasáskor a helyi településlistához ellenőrzi. Így már az
első szerveroldali HTML a mentett városhoz igazodik.

A `mental-provider-location-v1` localStorage bejegyzés csak a kanonikus ID-t,
nevet és a választás módját tartalmazza. A helyi tárhely letiltása nem akadályozza
a keresőt. Az automatikus IP-becslés nem kerül mentett preferenciába.
A személyre szabott HTML és API-válasz `Cache-Control: private, no-store`,
`Vary: Cookie` fejléceket kap. Az alkalmazásban nincs közös olvasói helycache.

## Végpontok

| Metódus és útvonal | Működés |
| --- | --- |
| `GET /api/public/provider-locations?q=Budapest` | Legfeljebb 12 kanonikus település, csak ID, név, megye. |
| `POST /api/public/provider-location/resolve` | Kerekített `{latitude,longitude,accuracy}` → `{location}`; sikeres feloldáskor várossüti. |
| `POST /api/public/articles/:slug/providers` | `{}`: mentett város vagy IP; `{city,source?}`: választás; `{automatic:true}`: törlés és IP-becslés. |

A POST végpontok azonos origint és JSON törzset kérnek. A publikus hely alakja
`{id,name,source}` vagy `null`; a találatok `match_type` mezője `local`, `nearby`
vagy `online`, a `distance_km` csak a közeli csoportnál kitöltött egész szám.
Piszkozat és későbbre időzített cikk ajánlója nem érhető el ezen a végponton.
A szolgáltatói lekérdezés hibája üres ajánlót eredményez; a cikk olvasható marad.

## Tárhely és megbízható kliens-IP

A jelenlegi éles Node-belépési pont DigitalOcean App Platform mögött fut.
A `server.js` ebben az éles környezetben kifejezetten engedélyezi a platform által
beállított `DO-Connecting-IP` fejléc használatát. A külön felhasználható
`reader-location.cjs` modul alapértelmezésben nem bízik proxyfejlécekben.

Más tárhelyre költözésnél vagy közvetlenül elérhető Node-szervernél állítsd
`MENTAL_GEO_TRUST_DO_HEADER=0` értékre. Az `1` érték kizárólag akkor használható,
ha minden kérés a megbízható, a fejlécet felülíró DigitalOcean ingressen halad át.
Közvetlen módban a socket nyilvános IP-címe használható. Hiányzó vagy érvénytelen
platformfejléc esetén nincs automatikus hely; `X-Forwarded-For`, `X-Real-IP` és
`req.ip` nem helyettesíti azt. A privát, dokumentációs és többcímes értékek kiesnek.

Forrás: [DigitalOcean: client IP address](https://docs.digitalocean.com/support/where-can-i-find-the-client-ip-address-of-a-request-connecting-to-my-app/).
A platform dokumentációja szerint az `X-Forwarded-For` az ingress címét tartalmazza.

## Ellenőrzés

```sh
node --test scripts/test-hungary-locations.cjs scripts/test-reader-location.cjs scripts/test-reader-location-http.cjs scripts/test-related-providers-views.cjs
TEST_DATABASE_URL=… node --test scripts/test-related-providers.cjs scripts/test-related-providers-geo.cjs
TEST_DATABASE_URL=… node scripts/test-related-providers-browser.cjs
```

A böngészőteszt külön tesztsémát és Playwright Chromiumot használ; adatvédelmi,
SSR-, mobilos, jogosultságmegtagadási és hibakezelési eseteket is ellenőriz.
Az új funkció nem igényel migrációt vagy szolgáltatói adatmódosítást. A GitHub
Actions teljes regressziós sora a korábbi funkciókat is ellenőrzi élesítés előtt.
