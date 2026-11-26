# Közvetlen szerkesztőségi CMS API

A MENTÁL.hu a már meglévő PostgreSQL `articles` táblába fogad közvetlen, tulajdonos által jóváhagyott cikkeket. Nem kell GitHub-commit vagy új deploy **egy-egy cikk közzétételéhez**, miután maga az API egyszer telepítésre került.

## Beüzemelés
- A DigitalOcean App Platform környezeti változói között állíts be egy véletlenszerű, legalább 32 karakteres `MENTAL_EDITORIAL_API_TOKEN` titkot (secret; soha ne commitold a repóba). Ha hiányzik, a végpontok minden kérést visszautasítanak.
- A csatolót a megbízható publikáló kliensben konfiguráld `Authorization: Bearer <token>` HTTP fejléc alatt HTTPS-en. A tokent csak a szerkesztői rendszer kapja; a kutatások és a nyilvános weboldalak soha.
- A kliensnek a chatben adott **valódi, konkrét** tulajdonosi jóváhagyásból kell előállítania a csomagot; a token birtoklása nem bizonyítja a jóváhagyást. A szerver a jóváhagyás metaadatait és a revíziót ellenőrzi, de a beszélgetés valós hitelességét önmagában nem tudja igazolni.

## API

`GET /api/editorial/articles?limit=20&offset=0`: hitelesített, nem publikus ellenőrző lista, a piszkozatokat is beleértve. `GET /api/editorial/articles/:external_id`: egy konkrét cikk állapota.

`POST /api/editorial/publish`: JSON body a `docs/editorial-publishing.md` szerinti `schema_version:1`, `article`, `approval` mezőkkel. Kizárólag előkészített, változatlan, kifejezetten jóváhagyott cikk fogadható el; a `validateApprovedPackage` a tartalmat és a SHA-256 lenyomatot ellenőrzi. Az első forrás DOI/PMID/URL alapján deduplikált. Sikernél HTTP 201, `url`, `revision_sha256`, `external_id`, `published_at`. Ütközésnél HTTP 409, hibás csomagnál 422, hitelesítés hiányában 401, adatbázishibánál 503/500.

A tranzakció és `article_import_ledger` megakadályozza, hogy a GitHub-importtal azonos jóváhagyott azonosító kétszer megjelenjen, illetve hogy utólag törölt cikk automatikusan visszakerüljön. A publikálási művelet auditnaplóba kerül. Nyilvános draft API és automatikus tartalommódosítás szándékosan nincs.

## Biztonsági és kiadási megjegyzések

Ez az interfész gép–gép REST API. A ChatGPT-kapcsolódáshoz külön OAuth-alapú MCP-csatoló tartozik a `https://mental.hu/mcp` címen; beállítása és szerkesztési folyamata a [csatoló dokumentációjában](mcp-connector.md) olvasható. A régi REST-tokent nem kell átmásolni a ChatGPT-be. **A GitHubra feltöltött kód önmagában még nem bizonyít telepítést vagy működő ChatGPT-csatlakozást.**

Minden publikálás után ellenőrizni kell a `/api/public/articles` végpontot és a visszakapott `/cikk/<slug>` oldalt. A szerverválasz vagy a sikeres HTTP 201 sem helyettesíti a nyilvános visszaellenőrzést.
