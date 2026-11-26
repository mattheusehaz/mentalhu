# Személyre szabott heti MENTÁL.hu-hírlevél

## Olvasói felület

A főoldal hírlevélblokkjában és a `/hirlevel` oldalon név, e-mail-cím és egy vagy több érdeklődési téma adható meg. A **Minden téma** választás az összes megjelent cikket bevonja. A témák a magazin szerkesztőségi kategóriáival egyeznek; a szolgáltatói katalógus kategóriáit nem keverjük közéjük.

A feliratkozó külön hozzájárulást ad, majd a címére érkező megerősítő levél hivatkozását megnyitva, a megerősítés gombbal aktiválja a feliratkozást. A levélbiztonsági ellenőrzőprogramok linkmegnyitása önmagában nem aktivál feliratkozást és nem iratkoztat le.

Meglévő e-mail-cím újbóli megadása nem írja át az aktív feliratkozás nevét és témáit. Ehhez is a postaláda tulajdonosának megerősítése szükséges. A nevet és a témákat a heti levélben található **Témáim módosítása** hivatkozással lehet megváltoztatni, külön felhasználói fiók nélkül.

## Heti összeállítás és küldés

- Időpont: **péntek 08:00, Europe/Budapest**. A nyári és téli időszámítás változását a helyi naptári idő követi.
- Időablak: az előző péntek 08:00-tól az aktuális péntek 08:00-ig. A kezdő időpont beleértendő, a záró nem. Csak publikált cikk kerülhet a levélbe.
- A cikkeket minden címzetthez a megerősített témái alapján választjuk ki, megjelenés szerinti csökkenő sorrendben. Egy levél legfeljebb 12 friss cikket mutat be; további olvasnivalókhoz a magazinba vezető hivatkozás tartozik.
- Új, megfelelő cikk nélkül az adott címzettnek nem készül üres hírlevél.
- A heti kiadás és a címzettenkénti küldés adatbázisban egyedi. Több alkalmazáspéldány vagy újraindulás nem készít ugyanarra a kiadásra második levelet.
- A telepítés az első következő pénteki időpontot állítja be, nem indít visszamenőleges tömeges küldést. Egy pénteki üzemzavar után a legutóbbi kiadás legfeljebb 24 órán belül pótolható.
- A végleges átadás előtt a rendszer ismét ellenőrzi a feliratkozás, a témák és a cikkek állapotát. A leiratkozás a még várakozó heti leveleket is leállítja.

A HTML-levél a jelenlegi MENTÁL.hu-logót, színeket, cikkképeket, címeket, rövid ajánlókat és cikkhivatkozásokat tartalmazza. Minden küldéshez egyszerű szöveges változat is készül. A képek és hivatkozások a `MENTAL_PUBLIC_URL` (alapértelmezés: `https://mental.hu`) saját címét használják.

## Adminisztráció

Belépés után az **Admin → Hírlevél** menüpont vagy közvetlenül a `/admin/?view=newsletter` cím nyitja meg a kezelőt.

Itt látható az automatikus küldés állapota, a következő időpont, a levélküldés konfiguráltsága és a feliratkozók száma. A feliratkozók név és e-mail-cím szerint kereshetők, állapot szerint szűrhetők és leiratkoztathatók. A korábbi feliratkozási adatok megmaradnak, de témaválasztás és címmegerősítés nélkül nem kerülnek az új heti küldésbe.

A **Levél előnézete** a kiválasztott témák és az elmúlt hét tényleges cikkei alapján jeleníti meg a sablont. A **Tesztlevél küldése** csak a felületen jelzett tesztcímre, a `den@proptechdigital.com` címre küld, nem iratkoztat fel senkit és nem indít olvasói kampányt. Az automatikus heti küldés ugyanitt szüneteltethető és visszakapcsolható.

A heti kiadásoknál címzettenként ellenőrizhető az eredmény:

| Állapot | Jelentés |
| --- | --- |
| Küldésre vár | A levél az adatbázisban várakozik. |
| Levélküldés beállítására vár | A meglévő küldési konfiguráció hiányzik vagy nem használható. |
| A levélküldő átvette | A szolgáltató elfogadta az üzenetet. Ez nem olvasási vagy postaládába érkezési visszaigazolás. |
| Sikertelen | Biztosan sikertelen átadás. A napló hibakódot tartalmaz. |
| Ellenőrzést igényel | Nem állapítható meg biztosan az átadás eredménye. A rendszer nem küldi újra automatikusan. |
| Kihagyva | Nincs megfelelő cikk, vagy a feliratkozás/kiadás már nem küldhető. |

A meglévő CSV-export megmarad. Az exportált cellák képletbeillesztés elleni védelmet kapnak.

## Beállítások és telepítés

A rendszer a már meglévő SMTP-, Resend- vagy Brevo-beállításokat használja. A beállítások a `/admin/kapcsolatfelvetelek.html` oldalon kezelhetők. A szolgáltató által megkövetelt domainhitelesítés és küldési jogosultság továbbra is szükséges. A levélküldés konfigurációját nem kell a hírlevélnél újra megadni.

A `server.js` indításkor lefuttatja a `020_newsletter.sql` migrációt. A migráció a korábbi feliratkozókat és leiratkozási hivatkozásokat megőrzi, az e-mail-címek kis-/nagybetűs változatait közös címzetthez rendeli. Ha valamelyik változat korábban leiratkozott, ezt az állapotot tiszteletben tartja.

A küldési munkafolyamat a meglévő Node webszolgáltatásban fut. Nincs szükség külön ChatGPT-feladatra vagy külső cronra. A háttérfeladat csak sikeres adatbázis-inicializálás után dolgozik. A szolgáltatásnak folyamatosan futnia kell; 24 órán túli kieséskor a régi kiadás már nem indul el.

A megerősítő és levéltartalmak titkosításához a meglévő `CONTACT_DATA_KEY`, ennek hiányában `CMS_JWT_SECRET` szolgál. Ezeknek az értékeknek állandónak kell maradniuk. Nincs új kötelező környezeti változó és nincs új éles csomagfüggőség.

## Leiratkozás és adatok

A levélben leiratkozási hivatkozás, valamint szabványos `List-Unsubscribe` és `List-Unsubscribe-Post` fejléc található. Az egykattintásos levelezőoldali művelet célhoz kötött, véletlen tokennel védett POST-kérés; nem igényel bejelentkezést. A szolgáltató DKIM-beállítása határozza meg, hogy a fogadó levelező megjeleníti-e a saját leiratkozás gombját.

Leiratkozáskor a rendszer törli a nevet és a témaválasztást, érvényteleníti a függő megerősítő és beállítási linkeket, és leállítja a várakozó heti küldést. A minimális leiratkozási nyilvántartás és a hozzájárulás igazolása megmarad. Új feliratkozás csak új megerősítéssel aktiválható.

A meg nem erősített új jelentkezés a megerősítő hivatkozás hétnapos érvényességének lejárta után törlődik; egy későbbi, még érvényes megerősítő kérés ezt az időt meghosszabbítja. Az átadott levél titkosított helyi tartalma az átadás után törlődik; a nem átadott tartalom a határideje után, a küldési napló 90 nap után törlődik. A részletes nyilvános tájékoztató a `/hirlevel-adatkezeles` oldalon olvasható.

## Ellenőrzés

A GitHub Actions ellenőrzi a pénteki időpontot és az óraátállítást, a témaszűrést, a levélsablont, a feliratkozás/megerősítés/leiratkozás teljes útját, az adatbázisban történő egyedi küldést és a böngészős űrlapokat. A tesztek csak eldobható helyi PostgreSQL-adatbázist és tesztlevél-átadót használnak; valódi címzettnek nem küldenek üzenetet.

### Műszaki források

- [RFC 8058 – One-Click Unsubscribe](https://www.rfc-editor.org/info/rfc8058/): fejlécek és a levélből indított leiratkozási POST-kérés.
- [Resend – Idempotency Keys](https://resend.com/docs/dashboard/emails/idempotency-keys): azonos kérésazonosítók szolgáltatói kezelése. A helyi adatbázis egyedisége a szolgáltató 24 órás megőrzésétől függetlenül is szükséges.
- [GDPR, 6., 7., 9. és 13. cikk](https://eur-lex.europa.eu/eli/reg/2016/679/oj/eng/): hozzájárulás és a feliratkozási adatkezelés ismertetése.
