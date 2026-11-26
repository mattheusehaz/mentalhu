# Szolgáltatói fiókok és jelentkezések

A szolgáltatók e-mail-címmel és saját jelszóval lépnek be, a CMS-adminisztrátoroktól külön munkamenettel. A jelentkezés elfogadása, az e-mail-cím igazolása és az adatlap közzététele külön lépés. Egy korábbi katalógusrekord nem kerül automatikusan egy új fiókhoz név- vagy e-mail-egyezés alapján.

## Admin: beküldések és kuka

A meglévő `/admin/` felület **Beküldések** menüpontja az aktív jelentkezésekkel nyílik meg. Név, kapcsolattartó, e-mail-cím és település szerint kereshető, státusz szerint szűrhető és lapozható. A státuszok: **Új**, **Átnézve**, **Elfogadva**, **Elutasítva**.

- A **Kukába** gomb elrejti a jelentkezést az aktív listából. A sikerüzenet **Visszavonás** gombja azonnali visszaállítást ad.
- Jobb felül a **Kuka (N)** nyitja meg a törölt jelentkezéseket. A **Visszaállítás** megőrzi a korábbi státuszt és az összes beküldött adatot.
- Nincs végleges törlés vagy automatikus ürítés. A kuka visszafordítható rendezési művelet.
- A kukába helyezés visszavonja az adott jelentkezés még fel nem használt meghívóját és a még elküldésre váró leveleit. A már megkezdett hálózati küldés vagy átadott levél nem hívható vissza; a visszavont hivatkozás ezután nem aktiválhat fiókot.
- A visszaállítás nem küld újabb e-mailt. Elfogadott jelentkezésnél erre külön **Meghívó újraküldése** gomb szolgál.

A kuka nem törli és nem függeszti fel a már aktivált szolgáltatói fiókot. Erre a külön **Szolgáltatói fiókok** menüpont használható. Még nem aktivált fióknál a visszavont jelentkezés jóváhagyása megszűnik, ha más aktív, elfogadott jelentkezés nem alapozza meg. Így egy későbbi nyilvános regisztráció önmagában nem örökölhet egy visszavont elfogadást.

## Elfogadás és meghívás

### Új jelentkezések adminértesítése

Minden új, hozzájárulással rögzített katalógusjelentkezésről értesítés megy a **den@proptechdigital.com** címre. A címzettet a szerver határozza meg; a beküldő nem írhatja felül. A levél tartalmazza a jelentkező adatait, a kategóriák nevét, a bemutatkozást, a képesítéseket és az adott rekordot megnyitó `/admin/?submission=<id>` hivatkozást. A linkhez CMS-belépés szükséges, a jelentkező elérhetőségei nem kerülnek az URL-be.

A `019_submission_notifications.sql` trigger a jelentkezéssel egy tranzakcióban hozza létre a küldési feladatot, a főoldali és a szolgáltatói fiókból érkező beküldéseknél egyaránt. A migráció nem indít visszamenőleges küldést. Az eleve új rekord ismételt mentése és a kuka visszaállítása nem küld újabb levelet; egy átnézett vagy elutasított jelentkezés tényleges újrabeküldése igen. A még várakozó korábbi értesítést ilyenkor felváltja az új.

A háttérfeldolgozó tíz másodpercenként ellenőrzi a várólistát. A kapcsolatfelvételi űrlap engedélyezési kapcsolójától függetlenül használja a mentett levélküldőt. Párhuzamos alkalmazáspéldányok nem dolgozhatják fel egyszerre ugyanazt a feladatot. A biztos 429-es elutasítás legfeljebb három, azonos azonosítójú próbálkozást kap; a bizonytalan hálózati eredmény, az 5xx válasz vagy a megszakadt küldés külön ellenőrzést igényel, automatikusan nem ismétlődik. Az adminlistában külön **Adminértesítés** állapot jelzi az eredményt.

A Beküldések fejlécében látszik az értesítési cím, és **Tesztértesítés** küldhető kizárólag erre a címre. A teszt nem hoz létre jelentkezést, és nem tartalmaz valódi jelentkezői adatokat.

### Elfogadó levél a jelentkezőnek

Az **Elfogadva** gomb egyetlen adatbázis-tranzakcióban menti a státuszt, a fiókhoz kapcsolást, a jóváhagyást és a kimenő levél feladatát. Ha valamelyik mentés meghiúsul, egyik rész sem marad félkészen. Ugyanannak az elfogadásnak az ismétlése nem hoz létre ismétlődő levelet.

Ha a jelentkezőnek még nincs igazolt fiókja, a levél egyszer használható, 7 napig érvényes regisztrációs hivatkozást tartalmaz. A címzett a hivatkozáson állítja be saját jelszavát. Ha már van igazolt fiókja, elfogadási értesítést kap a `/fiokom` oldal hivatkozásával; a meglévő jelszavát a rendszer nem változtatja meg.

A korábban, e funkció bevezetése előtt elfogadott jelentkezésekhez nem indul tömeges vagy visszamenőleges levélküldés. Az admin ezeknél külön **Meghívó küldése** művelettel indíthatja a folyamatot. Az **Elutasítva** vagy **Átnézve** státuszra visszaállítás az előző, még fel nem használt meghívást visszavonja. Egy későbbi valódi újraelfogadás új meghívót készíthet.

Az explicit újraküldés érvényteleníti a korábbi, még fel nem használt meghívóhivatkozást. Folyamatban lévő küldésre nem indítható új küldés; a levélküldő által éppen átvett értesítés után egy perc várakozás szükséges. Egy bizonytalan eredményű korábbi küldés címzettje már megkaphatta a levelet, ezért újraküldés előtt ellenőrizhető a levélszolgáltató naplója.

## A levelek állapota

A fióklevelek tartós adatbázis-várólistába kerülnek. A háttérfeldolgozó a futó alkalmazásban működik; a böngészőoldalt nem kell nyitva tartani.

| Technikai állapot | Jelentés és teendő |
| --- | --- |
| `needs_mail` | A levél rögzítve van, a levélküldés beállítására vár. Még nincs elküldve. A működő beállítás után a még érvényes várakozó levelek automatikusan feldolgozhatók. |
| `queued` | Küldésre vár. A rendszer még nem igazolta a levélküldő átvételét. |
| `sending` | A küldés folyamatban van. Újraküldés ezalatt nem indítható. |
| `accepted` | Az SMTP-/API-szolgáltató átvette a levelet. Ez nem kézbesítési vagy olvasási visszaigazolás. |
| `failed` | A küldés ismert hibával meghiúsult. A levélküldési beállítás ellenőrzése után külön újraküldés szükséges. |
| `uncertain` | A hálózati küldés kimenetele nem állapítható meg biztosan. A rendszer nem ismétli meg automatikusan. |
| `cancelled` | A meghívót visszavonták, felhasználták, lecserélték, vagy a feladat/link lejárt. A régi hivatkozással nem lehet új fiókot aktiválni. |

A kimenő levelek szövege és címzettje titkosítva kerül a várólistába. Sikeres átadás és visszavonás után a titkosított levéltartalmat eltávolítjuk; a technikai küldési állapot megmarad. A fel nem használt, lejárt levelek nem indulnak el a levélküldő későbbi beállításakor. Ha a 7 napos meghívó lejárt, az admin új meghívót indíthat.

## Levélküldés beállítása

A fióklevelek a meglévő **Kapcsolatfelvételek** adminoldalon (`/admin/kapcsolatfelvetelek.html`) mentett levélküldési beállításokat használják. SMTP, Resend és Brevo támogatott. A kapcsolatfelvételi űrlap engedélyezése ettől független: a fióklevelek küldéséhez nem kell bekapcsolni a látogatói megkeresések fogadását.

1. Válaszd ki a levélküldőt, és add meg a ténylegesen használható feladói e-mail-címet.
2. SMTP esetén add meg a kiszolgálót, portot, felhasználónevet és jelszót. Resend/Brevo esetén az API-kulcs szükséges. A szolgáltatónál a feladói domain engedélyezése/hitelesítése önmagában nem helyettesíti az alkalmazás API-kulcsát.
3. Mentsd a beállítást. Az admin felület **Tesztlevél** gombja az aktuális adminisztrátor e-mail-címére indíthat ellenőrzést.

A telepítési környezetből alapértékként olvasható a `RESEND_API_KEY`, a `BREVO_API_KEY`, illetve az `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD`. A feladót a `CONTACT_FROM_EMAIL`, ennek hiányában a `MAIL_FROM` vagy `SMTP_FROM` adja. A már elmentett adminbeállítások felülírják ezeket az alapértékeket; szolgáltatóváltáskor az adminfelületen is a megfelelő beállítást kell menteni.

A szükséges állandó alkalmazásbeállítások:

| Változó | Szerep |
| --- | --- |
| `DATABASE_URL` | A meglévő PostgreSQL-adatbázis. |
| `CMS_JWT_SECRET` | A CMS titka és a tőle elkülönített szolgáltatói CSRF-/védelmi kulcs alapja. Tartós titok legyen. |
| `CONTACT_DATA_KEY` | Opcionális, tartós kulcs a titkosított beállításokhoz és levelekhez. Hiányában a meglévő `CMS_JWT_SECRET` alapján származik a titkosítási kulcs. |
| `MENTAL_PUBLIC_URL` | A levélhivatkozások kanonikus HTTPS-originje, élesben `https://mental.hu`. Nem tartalmazhat felhasználónevet, jelszót, útvonalat vagy query paramétert. |
| `NODE_ENV=production` | Éles környezetben biztonságos munkamenetsütik. |

Titkok nem kerülnek a repositoryba, adminlistákba vagy naplózott válaszokba. A titkosítási kulcs cseréje a régi titkosított beállítások és várólista tartalmának olvashatóságát érinti; a használt kulcsot nem szabad egyszerű új véletlen értékre cserélni.

## Nyilvános fiókkezelés

| Útvonal | Funkció |
| --- | --- |
| `/belepes` | Szolgáltatói belépés. A fejléc **Belépés** hivatkozása ide vezet. |
| `/regisztracio` | Regisztrációs hivatkozás kérése, valamint a meghívó megnyitása után fiókaktiválás. |
| `/elfelejtett-jelszo` | Jelszó-visszaállító levél kérése. |
| `/jelszo-visszaallitas` | Egyszer használható, 1 órás hivatkozás alapján új jelszó beállítása. |
| `/fiokom` | Saját szolgáltatói adatlap és fiók kezelése. |
| `/szolgaltatoi-adatkezeles` | A fiók adatkezelési tájékoztatója. |

A jelszó minimum 10 karakter, legfeljebb 72 UTF-8 bájt. A rendszer bcrypt-jelszókivonatot tárol; meglévő jelszót sem az admin, sem a levélküldő nem kap vissza. Jelszó-visszaállítás és jelszócsere után a korábbi munkamenetek megszűnnek. Új jelszó beállítása után ismét be kell lépni.

A nyilvános regisztráció és az elfelejtett jelszó válasza nem árulja el, hogy a megadott címhez tartozik-e már használható fiók. A levélkérések és belépési kísérletek korlátozottak. A regisztrációs/jelszó-visszaállító token a hivatkozás fragmentjében szerepel, nem a szervernek küldött URL query részében; pusztán a levélhivatkozás megnyitása nem használja fel.

Az adminbelépés és a szolgáltatói belépés elkülönül. A szolgáltatói cookie nem ad adminjogot, a CMS-cookie nem léptet be szolgáltatóként.

## Saját adatlap és kategóriák

Egy fiók egy saját adatlapot kezelhet, legfeljebb öt aktív kategóriával. A tulajdonosi kapcsolat külön táblában szerepel; az API mindig a bejelentkezett fiókhoz tartozó adatlapot keresi meg. A kliens nem adhat meg másik adatlapazonosítót, kiemelést, ellenőrzött jelzést vagy adminmezőt.

A szolgáltató piszkozatot menthet, majd a kitöltött adatlapot elbírálásra küldheti. Ekkor a profilhoz kapcsolódó jelentkezés megjelenik a Beküldések között. Az elfogadás után a szolgáltató maga kattint az **Adatlap közzététele** gombra. A közzétételhez név, legalább 20 karakteres rövid bemutatkozás, 50 karakteres részletes bemutatkozás, kategória és település vagy online elérhetőség szükséges.

A publikált adatlap mentett változtatásai rögtön megjelennek a katalógusban. Az **Adatlap elrejtése** megtartja az adatokat, de megszünteti a nyilvános megjelenést. A kategóriák darabszáma ugyanabból az adatbázisból számolódik, ezért közzétételkor és elrejtéskor követi a változást. A kapcsolati e-mail a fiók igazolt e-mail-címe, nem irányítható át más címzettre.

A főoldali jelentkezési űrlap szerveroldali mező- és kategóriaellenőrzést, kötelező hozzájárulást, CSRF-védelmet, rejtett spamcsapdát, IP-alapú sebességkorlátot és e-mailenként 15 perces ismétlésvédelmet használ. Az admin kukája a már beérkezett kéretlen jelentkezések kezelésére szolgál.

## Szolgáltatói fiókok az adminban

A **Szolgáltatói fiókok** menüpont név/e-mail szerinti keresést, lapozást, e-mail-ellenőrzési és jóváhagyási állapotot, valamint a kapcsolt adatlapot mutatja. Jelszavakat nem jelenít meg.

A **Felfüggesztés** megszünteti a fiók munkameneteit, visszavonja a még használható fiókhivatkozásokat, és leveszi a saját adatlapot a nyilvános katalógusból. Az **Újraengedélyezés** új belépést tesz lehetővé; régi munkamenetet nem éleszt fel, és adatlapot nem tesz automatikusan újra nyilvánossá.

## Adatbázis és ellenőrzés

A meglévő `directory_submissions` táblának a fiókmigráció előtt léteznie kell. Az új migrációk sorrendje:

1. `016_provider_accounts.sql`: fiókok, munkamenetek, tokenek, titkosított levél-várólista, események és korlátozások.
2. `017_submission_trash.sql`: a jelentkezések kukamezői és a fiókhoz kapcsolás.
3. `018_provider_listing_owners.sql`: a fiók és a saját katalógusadatlap közötti egyértelmű tulajdonosi kapcsolat.
4. `019_submission_notifications.sql`: új jelentkezések és újrabeküldések adminértesítése.

A jelentkezés módosításakor az alkalmazás előbb a kapcsolódó fiókot, majd a jelentkezést zárolja; ez megegyezik a fiókhoz tartozó adatlap mentésének zársorrendjével. Az admin író végpontjain a CMS-hitelesítés mellett ugyanarról az originről érkező kérés és a `/api/admin/directory/submissions/session` végpontról kapott `X-Provider-CSRF` fejléc szükséges. A fiók- és jelentkezési API-válaszok nem cache-elhetők.

Gyors, külső levélküldés nélküli ellenőrzés:

```bash
node --test scripts/test-provider-accounts.cjs scripts/test-provider-profiles.cjs scripts/test-provider-views.cjs scripts/test-submission-trash.cjs scripts/test-mail-transport.cjs
node --check lib/provider-accounts.cjs
node --check lib/directory-submissions.cjs
node --check admin/admin.js
```

Az integrációs tesztekhez a `TEST_DATABASE_URL` csak eldobható, loopback címen futó, nevében `test` adatbázisra mutathat:

```bash
node scripts/test-provider-accounts-db.cjs
node scripts/test-provider-profiles-db.cjs
node scripts/test-submission-trash-db.cjs
node scripts/test-provider-browser.cjs
```

A tesztek saját, véletlen nevű sémát hoznak létre, és csak azt takarítják el. A beküldésteszt a valódi 016 és 017 migrációt sorrendben, kétszer is alkalmazza. A böngészőteszt a főoldali jelentkezéstől a kukán, elfogadáson, fiókaktiváláson és közzétételen át a jelszó-visszaállításig ellenőrzi a folyamatot. A levélküldőt a tesztek helyettesítik vagy minden szolgáltatói hitelesítő adatát törlik a tesztfolyamat környezetéből; valódi szolgáltatóknak vagy jelentkezőknek nem küldenek levelet.
