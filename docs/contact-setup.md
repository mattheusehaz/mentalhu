# MENTÁL.hu kapcsolatfelvételek

Adminfelület: `/admin/kapcsolatfelvetelek.html`. A meglévő CMS adminbelépését használja.

## Első beállítás

1. Add meg az adatkezelő tényleges nevét, székhelyét és adatvédelmi kapcsolattartó e-mail-címét. Ellenőrizd a tájékoztatót, a tárhely- és levelező szolgáltató adatfeldolgozási/adattovábbítási feltételeit. Az alkalmazás nem állapítja meg helyetted a teljes jogi megfelelést.
2. Állítsd be a megőrzési időt (alapesetben 90 nap). A kapcsolatfelvételi felület csak külön engedélyezés után fogad adatokat; a szolgáltatói katalógus ettől függetlenül működik.
3. Válassz SMTP-t, Brevót vagy Resendet. SMTP esetén kiszolgáló, port (587, 465 vagy 2525), felhasználónév és jelszó kell. Resend/Brevo esetén API-kulcs kell. Mindegyikhez olyan feladó e-mail-címet adj meg, amelynek használatát a levelező szolgáltató engedélyezi; domainhitelesítésre is szükség lehet.
4. Küldj tesztlevelet a saját admin e-mail-címedre. A jelszót/API-kulcsot csak az adminoldalon vagy a megfelelő titkos környezeti változóban add meg, ne nyilvános dokumentumban, képernyőképen vagy chatben.

Az SMTP-kapcsolat titkosított és ellenőrzi a kiszolgáló tanúsítványát. A levélküldőnél ellenőrizni kell az alkalmazásból történő hozzáférés és a feladói domain feltételeit.

## Címzetti adatok

A megkeresés címzettje mindig a kiválasztott szolgáltató adatbázisban tárolt e-mail-címe. A látogató ezt nem írhatja felül. Csak kifejezetten nyilvános, az adott szolgáltatóhoz tartozó kapcsolatfelvételi címet töltöttünk be; más rekordoknál az adminisztrátornak kell a címet ellenőriznie és pótolnia. Nem készülnek kitalált `info@...` címek.

A „címzetti e-mail-címre vár” vagy „levélküldő beállítására vár” állapot azt jelenti, hogy a kérés mentve van, de nem továbbítottuk. A felület ezt a látogatónak is megmondja. A korábban várakozó kérés a beállítások javítása után az adminból külön küldésre jelölhető.

## Mit tárolunk

A megkeresés neve, e-mail-címe, önként megadott telefonszáma, kapcsolattartási preferenciája, címzettje és a hozzájárulás szövege AES-256-GCM titkosítással kerül az adatbázisba. Nem kérünk leletet, diagnózist, tesztválaszokat, gyermekadatot vagy szabad szöveges egészségügyi leírást. A beérkező megkeresések nem kerülnek hírlevél-listára.

Az admin külön naplót lát a létrehozásról, küldésről, újrapróbálásról és törlésről. Az alkalmazás általános naplóiba nem kerül a megkeresés tartalma. A lejárt kérések személyes adatait a futó alkalmazás rendszeresen eltávolítja; az admin a határidő előtt is törölheti őket.

## Titkosítási kulcs

A tartós kulcs a `CONTACT_DATA_KEY`, vagy ennek hiányában a meglévő tartós `CMS_JWT_SECRET` alapján származik. Nem jelenik meg az adminban. A használatban lévő kulcsot ne változtasd meg egyszerű új véletlen értékre: a korábban tárolt beállítások és megkeresések akkor nem lesznek visszafejthetők. Kulcscsere előtt szabályozott újratitkosítás és mentési terv szükséges. Új külön kulcsot még az első valódi megkeresés előtt célszerű kijelölni.

## A küldési állapot jelentése

Az „átvéve a levélküldőnél” csak azt jelenti, hogy a SMTP-/API-szolgáltató elfogadta a levelet. Nem bizonyítja a kézbesítést, elolvasást, a szolgáltató válaszát vagy az időpontfoglalást. Bizonytalan hálózati eredménynél a rendszer nem küld vakon újra; az adminnak meg kell erősítenie a duplikáció kockázatát.

## Ellenőrzések

Az integrációs teszt külön, eldobható PostgreSQL-adatbázist és tesztlevélküldőt használ. A böngészőteszt valós űrlapküldést és adminisztrációt tesztel ugyanebben az elkülönített környezetben, kikapcsolt külső levélküldéssel. Egyik teszt sem küld valódi megkeresést a katalógusban szereplő szolgáltatóknak.
