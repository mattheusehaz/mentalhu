# MENTÁL.hu

Magazin, szakemberkereső és szolgáltatói katalógus. A publikus oldal és az adminisztráció ugyanabban a Node.js / Express alkalmazásban fut; a cikkek és katalógusadatok PostgreSQL-adatbázisból érkeznek.

## Futtatás

Node.js 20 és PostgreSQL szükséges. A környezeti változókat a futtatókörnyezetben kell megadni, a titkos értékeket nem szabad a repositoryba menteni.

```bash
npm ci
npm start
```

Az alkalmazás alapértelmezésben a 8080-as portot használja. Fejlesztés közben az `npm run dev` figyeli a változásokat.

Fontos beállítások: `DATABASE_URL`, `CMS_JWT_SECRET`, `CMS_ADMIN_EMAIL`, valamint `CMS_ADMIN_PASSWORD_HASH`. A portot a `PORT`, az éles környezetet a `NODE_ENV=production` állítja be. A kapcsolatfelvétel és levélküldés saját beállításait a meglévő adminfelület kezeli.

## Arculat és oldalak

A `folio-20261123` arculat közös elemei a `lib/site-shell.cjs`, `mental.css` és `mental.js` fájlokban vannak. A betűkészleteket és a márkajelzést az alkalmazás helyben szolgálja ki; a fontok licence az `assets/fonts` mappában található.

- Főoldal: `index.html`, a szerver cseréli ki a cikk-, kategóriaszám- és katalógusösszesítő blokkokat. A menü után közvetlenül a témasor következik.
- Cikkarchívum és cikkolvasó: `lib/article-views.cjs`, `editorial.css`.
- Cikkek melletti, település és téma szerinti szakemberajánló: `lib/related-providers.cjs`, `lib/reader-location.cjs`, `related-providers.js/css`; működés és frissítés: [docs/GEO_RECOMMENDATIONS.md](docs/GEO_RECOMMENDATIONS.md).
- Katalógus, keresési találatok és profilok: `lib/public-catalog.cjs`, `lib/directory-views.cjs`, `catalog-design.css`.
- Kapcsolatfelvétel: `lib/contact-inquiries.cjs`, `contact.css`.
- Adminfelület: `admin/`, a közös arculati kiegészítés `admin/brand.css`.

A könyvjelzők az adott böngésző helyi tárhelyében maradnak. A cikkkereső a meglévő publikus API-t használja. A cikkek és a szolgáltatói adatlapok továbbra is szerveroldalon jelennek meg, a natív keresés JavaScript nélkül is használható.

## Ellenőrzés és élesítés

```bash
npm run build
node --test scripts/test-home-editorial.cjs
node scripts/validate-editorial.cjs
node --test scripts/test-editorial-import.cjs
```

A GitHub Actions adatbázissal és izolált böngészővel futtatja a katalógus-, kapcsolatfelvételi és cikkteszteket. A teljes integrációs tesztekhez külön tesztadatbázis szükséges.

Az éles mental.hu a DigitalOcean App Platformon futó Node.js alkalmazás. A `main` ág változásait az ott beállított automatikus telepítés veszi át. Az aktuális arculati verzió a `/frontend-version.json` címen, az alkalmazás készenléte a `/health/ready` végponton ellenőrizhető. A működő adatbázist és a telepítési környezeti változókat az arculati frissítés nem helyettesíti.
