#!/usr/bin/env python3
"""Build a compact offline HU-only IP -> canonical city database from DB-IP.

python3 scripts/refresh-hungary-ip-locations.py --month 2026-11
Uses only the Python 3 standard library. A cached source may be supplied using
--input /path/dbip-city-lite-YYYY-MM.csv.gz to reproduce a reviewed snapshot.
No visitor IP is sent anywhere; this is an explicit maintenance-time download.
"""

import argparse
import collections
import csv
import datetime
import gzip
import hashlib
import ipaddress
import json
import math
import pathlib
import re
import unicodedata
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parents[1]


def fold(value):
    return "".join(c for c in unicodedata.normalize("NFD", value.lower())
                   if unicodedata.category(c) != "Mn")


def distance_km(point, city):
    lat1, lon1, lat2, lon2 = map(math.radians, [*point, city[3], city[4]])
    h = math.sin((lat2-lat1)/2)**2 + math.cos(lat1)*math.cos(lat2)*math.sin((lon2-lon1)/2)**2
    return 6371.0088 * 2 * math.asin(math.sqrt(min(1, max(0, h))))


def city_resolver(dataset):
    exact = {row[1].lower(): row for row in dataset["cities"]}
    folded = collections.defaultdict(list)
    for row in dataset["cities"]:
        folded[fold(row[1])].append(row)
    ids = {row[0]: row for row in dataset["cities"]}
    aliases = {fold(name): ids[key] for name, key in dataset.get("aliases", [])}

    def resolve(name):
        # DB-IP parenthesized neighbourhoods explicitly belong to the named
        # city; confirm the coordinate is nearby before accepting this result.
        base = re.sub(r"\s+\([^()]+\)$", "", name).strip().lower()
        if base in exact:
            return exact[base]
        key = fold(base)
        if key in aliases:
            return aliases[key]
        matches = folded.get(key, [])
        return matches[0] if len(matches) == 1 else None
    return resolve


def merge_ranges(rows):
    rows.sort(key=lambda row: row[0])
    merged = []
    for start, end, city in rows:
        if merged and start <= merged[-1][1]:
            raise ValueError("Overlapping ranges in source database")
        if merged and start == merged[-1][1] + 1 and city == merged[-1][2]:
            merged[-1][1] = end
        else:
            merged.append([start, end, city])
    return merged


def build(input_path, source_url, month, retrieved_at):
    cities_path = ROOT / "content/hungary-locations.json"
    cities_bytes = cities_path.read_bytes()
    resolve_city = city_resolver(json.loads(cities_bytes))
    ranges = {4: [], 6: []}
    source_rows = hu_rows = excluded_coordinates = 0
    excluded_names = collections.Counter()
    with gzip.open(input_path, "rt", encoding="utf-8", newline="") as source:
        for row in csv.reader(source):
            source_rows += 1
            if len(row) != 8:
                raise ValueError(f"Unexpected DB-IP CSV schema at row {source_rows}")
            if row[3] != "HU":
                continue
            hu_rows += 1
            city = resolve_city(row[5])
            if city is None:
                excluded_names[row[5]] += 1
                continue
            latitude, longitude = float(row[6]), float(row[7])
            if not math.isfinite(latitude) or not math.isfinite(longitude) or distance_km((latitude, longitude), city) > 35:
                excluded_coordinates += 1
                continue
            start, end = ipaddress.ip_address(row[0]), ipaddress.ip_address(row[1])
            if start.version != end.version or int(start) > int(end):
                raise ValueError("Invalid source address range")
            ranges[start.version].append([int(start), int(end), city[0]])
    included_ranges = sum(len(rows) for rows in ranges.values())
    v4, v6 = merge_ranges(ranges[4]), merge_ranges(ranges[6])
    if hu_rows < 5000 or included_ranges < hu_rows * 0.95:
        raise ValueError("Unexpectedly low HU coverage; review the source before replacing the snapshot")
    with input_path.open("rb") as stream:
        source_hash = hashlib.file_digest(stream, "sha256").hexdigest()
    return {
        "schemaVersion": 1,
        "source": {
            "name": "DB-IP IP to City Lite",
            "url": source_url,
            "license": "CC-BY-4.0",
            "licenseUrl": "https://creativecommons.org/licenses/by/4.0/",
            "attributionUrl": "https://db-ip.com/",
            "release": month,
            "retrievedAt": retrieved_at,
            "sha256": source_hash,
            "citiesSha256": hashlib.sha256(cities_bytes).hexdigest(),
            "sourceRanges": source_rows,
            "hungaryRanges": hu_rows,
            "includedRangesBeforeMerging": included_ranges,
            "excludedUnknownCities": dict(sorted(excluded_names.items())),
            "excludedCoordinateMismatch": excluded_coordinates,
            "changes": "HU ranges only; city names mapped to GeoNames centroids; unresolved or contradictory locations omitted; adjacent ranges for the same city merged."
        },
        "rangeColumns": ["inclusiveStart", "inclusiveEnd", "cityId"],
        "ipv4": v4,
        "ipv6": [[f"{start:032x}", f"{end:032x}", city] for start, end, city in v6]
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--month", default=datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m"))
    parser.add_argument("--input", type=pathlib.Path)
    parser.add_argument("--retrieved-at", default=datetime.datetime.now(datetime.timezone.utc).date().isoformat())
    args = parser.parse_args()
    if not re.fullmatch(r"\d{4}-(?:0[1-9]|1[0-2])", args.month):
        parser.error("--month must be YYYY-MM")
    source_url = f"https://download.db-ip.com/free/dbip-city-lite-{args.month}.csv.gz"
    input_path = args.input or pathlib.Path(f"/tmp/dbip-city-lite-{args.month}.csv.gz")
    if not input_path.exists():
        request = urllib.request.Request(source_url, headers={"User-Agent": "MENTAL.hu offline dataset refresh (CC-BY-4.0 attribution)"})
        temporary = input_path.with_suffix(input_path.suffix + ".partial")
        with urllib.request.urlopen(request, timeout=45) as response, temporary.open("wb") as output:
            while chunk := response.read(1024 * 1024):
                output.write(chunk)
        temporary.replace(input_path)
    data = build(input_path, source_url, args.month, args.retrieved_at)
    output_path = ROOT / "content/hungary-ip-locations.json"
    text = json.dumps(data, ensure_ascii=False, separators=(",", ":")).replace('],[', '],\n[')
    output_path.write_text(text + "\n", encoding="utf-8")
    print(f"Wrote {len(data['ipv4'])} IPv4 and {len(data['ipv6'])} IPv6 ranges; {output_path.stat().st_size} bytes")
    print(json.dumps(data["source"], ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
