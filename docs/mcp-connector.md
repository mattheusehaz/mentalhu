# MENTÁL.hu – Cikkfeltöltés MCP

A csatoló közvetlenül a MENTÁL.hu PostgreSQL-alapú CMS-ébe ment. Egy cikk vagy média feltöltéséhez nem kell GitHub-commit vagy új weboldal-telepítés.

## Kapcsolódás a ChatGPT-ben

- Név: **MENTÁL.hu – Cikkfeltöltés**
- MCP URL: **https://mental.hu/mcp**
- Kapcsolat: nyilvános HTTPS, **Streamable HTTP**
- Hitelesítés: **OAuth**, dinamikus kliensregisztráció (DCR), S256 PKCE
- Kézzel megadandó client ID / client secret: **nincs**; a ChatGPT regisztrálja a klienst.

A ChatGPT [Plugins](https://chatgpt.com/plugins) oldalán a **+ → Add custom MCP server** felületen add meg a nevet, az URL-t és az OAuth-hitelesítést. A létrehozás után a MENTÁL.hu engedélyezési oldala nyílik meg. Itt a meglévő CMS-admin e-mail-címmel és jelszóval lehet belépni, vagy a már bejelentkezett admin munkamenet használható. A **Kapcsolat engedélyezése** gomb ad hozzáférést a felsorolt műveletekhez. Ez a kapcsolat engedélyezése; önmagában egyetlen cikket sem publikál.

Az első csatlakoztatás és az admin jóváhagyás felhasználói művelet. A szerver telepítése nem teszi automatikusan elérhetővé az eszközöket egy már futó ChatGPT-beszélgetésben. Telepítés/engedélyezés után a csatolót ki kell választani; változó eszközlista esetén **Refresh**, majd új beszélgetés szükséges lehet. A fiók és a munkaterület szabályai korlátozhatják saját MCP-szerver hozzáadását.

Hivatalos útmutató: https://developers.openai.com/plugins/deploy/connect-chatgpt

## Műveletek

| MCP-eszköz | Művelet |
| --- | --- |
| `mental_get_site_info` | Kapcsolat, verzió, feltöltési határok, munkafolyamat |
| `mental_list_articles` | Cikkek és piszkozatok keresése, lapozható listája |
| `mental_get_article` | Teljes mentett cikk, pontos revízió és publikálási állapot |
| `mental_get_topics` | Témák és a hozzájuk tartozó publikált cikkszámok |
| `mental_upload_image` | Jóváhagyott JPEG, PNG, WebP vagy AVIF feltöltése |
| `mental_upload_video` | Jóváhagyott eredeti MP4 feltöltése |
| `mental_save_draft` | Jóváhagyott tartalom mentése privát piszkozatként |
| `mental_update_article` | Jóváhagyott módosítás előkészítése privát változatként |
| `mental_publish_article` | A külön jóváhagyott, pontos változat publikálása |
| `mental_set_featured` | Kiemelés beállítása vagy megszüntetése |

## Szerkesztési folyamat

1. Keresd meg a cikket a duplikáció elkerülésére. Új cikkhez adj tartós `external_id` azonosítót; újrapróbáláskor ugyanazt használd.
2. Csak a tulajdonos által jóváhagyott képet vagy videót töltsd fel. A válasz helyi `/media/<id>` hivatkozást és beilleszthető HTML-t ad.
3. Mentsd a jóváhagyott szöveget és a médiát piszkozatként. A `hero_image_id` mező a borítóképet jelöli. A `content_html` helyi képet/videót is tartalmazhat. Válassz konkrét témát, például „Alvás”, és a kutatási cikkekhez add meg az ellenőrzött forrásokat.
4. A `mental_get_article` eszközzel olvasd vissza a teljes mentett cikket, a médiaadatokat és a `revision` értékét. A `preview_url` csak bejelentkezett CMS-adminnak érhető el.
5. Kérd a tulajdonos külön, kifejezett publikálási jóváhagyását **erre a változatra**. A mentés vagy feltöltés engedélyezése nem publikálási jóváhagyás.
6. Hívd a `mental_publish_article` eszközt a visszaolvasott `expected_revision` és `confirm_publish:true` értékkel. Ha időközben módosult a cikk, előbb újra olvasd és hagyasd jóvá.
7. Ellenőrizd a visszaadott nyilvános URL-t és a `/api/public/articles` listát.

A már publikált cikk módosítása külön piszkozatba kerül; a nyilvános szöveg csak az új változat jóváhagyott publikálásakor változik. Az eredeti megjelenési dátum megmarad. A revízió a szöveg, források és média lenyomatát is tartalmazza. A CMS-ben közben történt módosítás ütközést okoz: a `mental_get_article` `view:"live"` opciójával olvasható a jelenlegi élő változat, és csak ennek új jóváhagyása után készíthető friss piszkozat.

Az újrapróbálás nem hoz létre még egy cikket; a publikálás idempotens. Külső azonosító, slug, DOI vagy PMID ütközésnél a művelet megáll. A törölt cikket egy régi kérés újraküldése nem hozza vissza. Piszkozat kiemelése nem publikálja azt.

## Média

- Képek: legfeljebb **12 MiB**, tényleges fájlformátum és méret ellenőrzésével.
- Videó: legfeljebb **100 MiB MP4**, eredeti bájtokkal, átkódolás nélkül.
- ChatGPT-csatolmány: `file` objektum `download_url`, `file_id`, opcionális `mime_type`, `file_name` mezőkkel. A leíró az `openai/fileParams` szerződést követi.
- Alternatíva: HTTPS `source_url`; képnél legfeljebb **1 MiB** dekódolt `base64`.
- Egy kérésben egy bemeneti forrás adható meg. A JSON mérethatár 2 MiB; a nagyobb média a letöltési URL-en érkezik.
- A fájlok tartós PostgreSQL-tárolást, SHA-256 deduplikációt és auditnaplót kapnak. Ideiglenes aláírt letöltési URL nem kerül az adatbázisba vagy naplóba.
- Az új média csak publikált cikk hivatkozásakor lesz nyilvános; admin előnézetben előbb is elérhető. A korábbi CMS-média elérhetősége megmarad.
- A videók GET/HEAD és HTTP byte-range kéréssel olvashatók. A kiszolgálás 4 MiB-os adatbázisrészleteket használ.

## Üzemeltetés és hitelesítés

A szerver az alkalmazás meglévő adminazonosítását használja (`CMS_ADMIN_EMAIL`, `CMS_ADMIN_PASSWORD_HASH` vagy `CMS_ADMIN_PASSWORD`, és CMS JWT-munkamenet). Új statikus MCP-jelszó vagy a régi `MENTAL_EDITORIAL_API_TOKEN` másolása nem szükséges. A `MENTAL_PUBLIC_URL` alapértéke `https://mental.hu`; élesben a kanonikus HTTPS-origin legyen.

- OAuth metadata: `/.well-known/oauth-authorization-server`
- Protected resource metadata: `/.well-known/oauth-protected-resource/mcp`
- Kliensregisztráció: `/mcp/oauth/register`
- Engedélyezés: `/mcp/oauth/authorize`
- Token és frissítés: `/mcp/oauth/token`
- Visszavonás: `/mcp/oauth/revoke`
- Jogosultságok: `mental:read`, `mental:write`, `mental:publish`

Az engedélyezési kód egyszer használható, az access token egy óráig, az engedély legfeljebb 30 napig érvényes. A refresh token minden használatkor cserélődik; a korábbi token ismételt felhasználása visszavonja az engedélyt. A titkos értékekből csak hash kerül az adatbázisba. A belépéshez pontos ChatGPT callback, PKCE, Origin- és CSRF-ellenőrzés tartozik. A mentés, publikálás, feltöltés és OAuth-engedélyezés a meglévő `cms_audit_log` naplóba kerül.

A 012–014 migráció automatikusan lefut az alkalmazás indulásakor. A régi jóváhagyott cikkcsomagok importálója és REST-publikáló API-ja tovább használható; a változatlan jóváhagyási hash-eket az MCP nem írja át.

## Ellenőrzés

```sh
node --test scripts/test-mcp-oauth.cjs scripts/test-mcp-media.cjs scripts/test-mcp-articles.cjs scripts/test-mcp-server.cjs
```

Adatbázis nélkül a tiszta egységtesztek és a valódi MCP SDK-klienssel végzett sématesztek futnak. A PostgreSQL-integrációs tesztek csak loopback címen elérhető, a nevében `test` szót tartalmazó eldobható adatbázison hajlandók adatot írni. A CI előbb futtatja az alkalmazás migrációit, majd a teljes OAuth → MCP → feltöltés → piszkozat → visszaolvasás → publikálás → nyilvános oldal ellenőrzési folyamatot és a meglévő katalógus-/böngészőteszteket. Valós szolgáltatóknak üzenetet nem küldenek és az éles CMS-be tesztcikket nem írnak.
