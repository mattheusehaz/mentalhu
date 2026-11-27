# Szolgáltatói mini-CRM

## Belépés és jogosultság

A saját fiókban elindított szolgáltatói profilhoz azonnal elérhető az **Ügyfeleim és megkereséseim** felület: `/fiokom/ugyfelek`. A használatához megerősített e-mail-cím, érvényes olvasói munkamenet és az ugyanazon fiókhoz tartozó szolgáltatói képesség szükséges. A kézzel vezetett kapcsolatokhoz nem kell kitöltött, jóváhagyott vagy közzétett adatlap.

Minden kapcsolat és naplóbejegyzés egyetlen fiókhoz tartozik. A szerver a munkamenetből veszi a fiókazonosítót; a kliens nem adhat meg másik tulajdonost. A puszta CMS-adminsüti nem ad hozzáférést, az admin fióklistája nem mutatja a CRM személyes adatait. A privát oldal és az API nem cache-elhető és nem indexelhető.

## Kapcsolatok és idővonal

- Kézi felvétel: név, opcionális e-mail-cím és telefonszám, forrás, megjegyzés.
- Állapotok: **Új érdeklődő**, **Kapcsolatfelvétel**, **Egyeztetett időpont**, **Folyamatban**, **Lezárva**, **Nem aktuális**.
- Következő lépés és utánkövetési időpont; az elvégzett lépés az idővonalra kerül.
- Külön naplózható megjegyzés, telefonhívás, e-mail vagy találkozó. Az e-mail típusú naplóbejegyzés egy megtörtént esemény feljegyzése, nem levélküldési művelet.
- A létrehozás, az állapot- és adatmódosítás, valamint az utánkövetés teljesítése automatikusan bekerül az előzmények közé.
- Keresés név, e-mail vagy telefonszám alapján; állapot-, forrás- és határidőszűrés, lapozás.
- Az áttekintő a kapcsolatokat és a következő teendőket összesíti. Az egyes kapcsolatok idővonala mutatja a szolgáltató elvégzett lépéseit és a folyamat kimenetelét.

A szerkesztés verziószámmal védett. Ha két ablakból módosítják ugyanazt a kapcsolatot, a régi verzió nem írhatja felül észrevétlenül az újabb adatokat; a szerver 409-es választ ad és frissítést kér.

## Beérkező megkeresések

A felület megnyitásakor, majd frissítéskor a böngésző hitelesített, CSRF-védett szinkronizálást indít. A szerver kizárólag a `provider_listing_owners` táblával kifejezetten a fiókhoz kapcsolt adatlap megkereséseit emeli át. Név vagy azonos e-mail-cím alapján nem ad hozzáférést más katalógusbejegyzéshez. Az átvétel az eredeti megkeresés címzettjét is összeveti a megerősített fiók e-mail-címével; más korábbi tulajdonosnak küldött megkeresés nem vehető át. Saját adatlap hiányában a kézi CRM működik, a beérkező lista üres.

A szinkronizálás idempotens: egy kapcsolatfelvételi kérésből legfeljebb egy CRM-bejegyzés lesz. Egyszerre legfeljebb 200 új kérés kerül feldolgozásra; a válasz jelzi, ha maradt további elem. A megkeresés rögzítése nem függ a kapcsolati értesítő e-mail sikeres kézbesítésétől.

## Személyes adatok és megőrzés

A nevet, e-mail-címet, telefonszámot, forrásmegnevezést, megjegyzést, következő lépést és a napló tartalmát a meglévő kapcsolati titkosítás védi. A keresés fiókonként külön, titkosítva tárolt véletlen kulccsal képzett keresőtokeneken fut; a CRM-tábla nem tárol kereshető egyszerű szöveges nevet vagy e-mail-címet. A titkosítás a tartós `CONTACT_DATA_KEY` kulcsot, ennek hiányában a meglévő `CMS_JWT_SECRET` származtatását használja. A kulcsot működés közben nem szabad új véletlen értékre cserélni.

A beérkező kérésből készült másolat az eredeti megkeresés lejárati idejét örökli. Nem hosszabbítja meg az eredeti megőrzési időt. A forrás törlése, visszavonása, lejárata vagy az adatlap tulajdonosi kapcsolatának megszűnése után a személyes CRM-másolat és annak naplója törlődik. A háttértakarítás óránként fut; az olvasó műveletek is ellenőrzik a lejáratot. A kézzel létrehozott kapcsolatok a szolgáltató törlési műveletéig maradnak meg.

A törlés eltávolítja a titkosított személyes tartalmat, keresőtokeneket, határidőt és kapcsolati naplót. Az átvett megkeresés átlátszatlan forrásazonosítója megmarad, hogy a következő szinkronizálás ne hozza létre ismét a már törölt kapcsolatot. A fiók végleges adatbázisos törlése a hozzá kapcsolt CRM-adatokat is törli. A CRM-be történő felvétel nem jelent hírlevél-feliratkozást és nem indít levelet.

## API és üzemeltetés

Minden alábbi végpont megerősített és aktív szolgáltatói fiókot igényel. Író művelethez ugyanarról az originről érkező kérés és a fiók/CRM áttekintő válaszából kapott `X-Account-CSRF` fejléc szükséges.

| Végpont | Funkció |
| --- | --- |
| `GET /api/provider/crm` | Áttekintő, következő teendők, saját adatlap, CSRF-token. |
| `POST /api/provider/crm/sync` | Kifejezetten saját adatlaphoz beérkezett megkeresések átvétele. |
| `GET /api/provider/crm/contacts` | Keresett, szűrt és lapozott kapcsolatok. |
| `POST /api/provider/crm/contacts` | Kézi kapcsolat létrehozása. |
| `GET /api/provider/crm/contacts/:id` | Saját kapcsolat részletei és idővonala. |
| `PUT /api/provider/crm/contacts/:id` | Verzióval ellenőrzött módosítás. |
| `DELETE /api/provider/crm/contacts/:id` | Személyes tartalom és idővonal törlése. |
| `GET /api/provider/crm/contacts/:id/events` | A saját kapcsolat lapozott idővonala. |
| `POST /api/provider/crm/contacts/:id/events` | Megtörtént egyeztetés vagy feljegyzés rögzítése. |
| `POST /api/provider/crm/contacts/:id/followup/complete` | Következő lépés teljesítése és naplózása. |

Az alkalmazás a meglévő migrációs zárolással és sémaverzió-naplóval futtatja a `023_provider_crm.sql` migrációt a fiók-, tulajdonosi és kapcsolati sémák után. Külön külső CRM-fiók, szolgáltatás vagy ütemező nem szükséges.

## Ellenőrzés

```bash
node --test scripts/test-provider-crm.cjs
node scripts/test-provider-crm-db.cjs
node scripts/test-provider-crm-concurrency-db.cjs
node scripts/test-provider-crm-browser.cjs
```

Az adatbázisos és böngészős tesztek csak eldobható, loopback PostgreSQL `TEST_DATABASE_URL` címet fogadnak el. Saját véletlen nevű sémával ellenőrzik a fiókok közti elszigetelést, a titkosított tartalmat, a megkeresés-importot, a verzióütközést, az utánkövetést, a törlést és az adatmegőrzést. A tesztek nem küldenek valódi e-mailt.
