# Offline Hungarian location data

The article recommendation feature uses two checked-in data snapshots. Runtime
lookups run locally and need no API key, external IP lookup, or network request.
Only canonical settlement IDs are used for saved reader preferences; neither
these files nor the locality helper persist reader IPs or exact coordinates.

## Attribution and licensing

| Dataset | Source | License |
| --- | --- | --- |
| Hungarian settlement centroids and Budapest district anchors | [GeoNames](https://www.geonames.org/), [Hungarian postal codes](https://download.geonames.org/export/zip/HU.zip), [Hungarian gazetteer](https://download.geonames.org/export/dump/HU.zip) | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/); [postal README](https://download.geonames.org/export/zip/readme.txt), [gazetteer README](https://download.geonames.org/export/dump/readme.txt) |
| Hungarian IP ranges and approximate source city labels | [DB-IP IP to City Lite](https://db-ip.com/db/download/ip-to-city-lite), November 2026 | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/); [publisher licensing terms](https://db-ip.com/db/lite.php) |

The public location UI must include links crediting **GeoNames** and
**IP Geolocation by DB-IP**. DB-IP specifically requires its link on pages that
display or use results from its database. The existing source licenses and
credits also apply when these derived snapshots are redistributed.

## Settlement snapshot

`hungary-locations.json` contains 3,155 settlement records derived from the 3,571
GeoNames Hungarian postal rows downloaded on 2026-11-27. Each `cities` row is
`[id, name, county, latitude, longitude]`, using approximate WGS84 centroids.
County labels are retained from the source. The `source` metadata records the
original URLs, license, download date, hashes, and transformations.

For places with several postal codes, the highest source accuracy is used and
duplicate coordinates are removed. If several equally accurate points remain,
their mean is used. These are settlement approximations, not street addresses.
The normalizer accepts accents, accentless names, postal prefixes, and valid
Budapest district labels. The ambiguous accentless names `komlo` and `komoro`
are deliberately not resolved without a canonical selection: Komló/Kömlő and
Komoró/Kömörő are separate settlements. Their stable IDs include a source postal
code suffix.

The 24 additional Budapest district anchors come from GeoNames gazetteer
populated-place records. They let coordinates in outer Budapest districts
coarsen to the canonical Budapest record instead of the centre of a neighbouring
municipality. All matching anchors still return the same city centroid.

`nearestCity` finds the nearest settlement or district anchor within its supplied
distance cap, defaulting to 35 km. It is not a municipal or national boundary
test. Near borders, a nearest Hungarian settlement may be outside the reader's
actual municipality or country. The reader can select the correct city. The
IP snapshot separately filters source records to country `HU`.

## IP snapshot

`hungary-ip-locations.json` is derived directly from the official
[November 2026 CSV](https://download.db-ip.com/free/dbip-city-lite-2026-11.csv.gz).
The source SHA-256 is
`f796ba4f3e999259080cc90fb695633bc22c524b1e72e804c96029a79dc1f637`.
Its [documented CSV schema](https://db-ip.com/db/format/ip-to-city-lite/csv.html)
contains the inclusive range bounds, country, city, and approximate coordinates.

Only Hungarian rows are retained. Known city names and explicit parenthesized
neighbourhoods map to a canonical GeoNames city. Source coordinates must be
within 35 km of that city; unknown or contradictory records are omitted rather
than assigned to an arbitrary neighbouring city. The November source contains
21,292 Hungarian ranges, of which 21,160 are retained. The exclusions are
documented in the JSON metadata. Adjacent ranges are merged only when there is
no gap and their canonical city is identical.

The resulting file contains 10,794 IPv4 and 7,474 IPv6 ranges:

- `ipv4`: `[inclusiveStartNumber, inclusiveEndNumber, cityId]`.
- `ipv6`: `[inclusiveStartHex32, inclusiveEndHex32, cityId]`; hex strings are
  fixed-width, lowercase, and contain no separators.

Both lists are numerically sorted and nonoverlapping. Coordinates are obtained
from the settlement snapshot after lookup; source IP coordinates are not copied
into the runtime snapshot. DB-IP Lite is an approximate and reduced-coverage
dataset. VPNs, mobile networks, provider routing, and database age can make an IP
estimate inaccurate; a reader's explicit city choice must take precedence.

## Refreshing the snapshots

The refresh scripts use the Python 3.11+ standard library. They are maintenance
tools, not part of the Node.js request path. Refresh DB-IP regularly as its
publisher releases monthly data; refresh settlement data when needed.

```sh
python3 scripts/refresh-hungary-locations.py --cache-dir /tmp/mentalhu-geo
python3 scripts/refresh-hungary-ip-locations.py --month 2026-11
node --test scripts/test-hungary-locations.cjs scripts/test-reader-location.cjs
```

Choose the released month for `--month`. To obtain new GeoNames data, remove or
use a new cache directory before running its script. To reproduce the checked-in
snapshots, use the original ZIP/GZIP downloads with their recorded hashes and
pass `--retrieved-at 2026-11-27`; the IP refresh accepts an existing compressed
source with `--input /path/to/dbip-city-lite-2026-11.csv.gz`.

Always refresh settlement data first and IP data second. The IP metadata includes
the hash of the city snapshot it was generated against. Review the source dates,
exclusion counts, and tests before committing generated files. These are static
snapshots: installing the application does not silently download newer data.
