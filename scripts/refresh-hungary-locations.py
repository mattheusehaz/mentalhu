#!/usr/bin/env python3
"""Refresh offline HU locality data; Python 3 standard library, no credentials.

python3 scripts/refresh-hungary-locations.py --cache-dir /tmp/mentalhu-geo
Delete cached ZIPs to obtain a new source snapshot. Run the locality tests after
refreshing, then review and commit the resulting JSON with its source hashes.
"""

import argparse
import collections
import csv
import datetime
import hashlib
import io
import json
import pathlib
import re
import unicodedata
import urllib.request
import zipfile

ROOT = pathlib.Path(__file__).resolve().parents[1]
POSTAL_URL = "https://download.geonames.org/export/zip/HU.zip"
GAZETTEER_URL = "https://download.geonames.org/export/dump/HU.zip"


def fold(value):
    return "".join(c for c in unicodedata.normalize("NFD", value.lower())
                   if unicodedata.category(c) != "Mn")


def download(url, path):
    if not path.exists():
        with urllib.request.urlopen(url, timeout=45) as response:
            data = response.read()
        path.write_bytes(data)
    return path.read_bytes()


def read_rows(data):
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        return list(csv.reader(io.StringIO(archive.read("HU.txt").decode("utf-8")), delimiter="\t"))


def build(postal_data, gazetteer_data, retrieved_at):
    rows = read_rows(postal_data)
    places = collections.defaultdict(list)
    for row in rows:
        if row[0] != "HU":
            raise ValueError("Non-Hungarian row in HU postal data")
        places[row[2]].append(row)
    folds = collections.Counter(fold(name) for name in places)
    cities = []
    for name, entries in places.items():
        best_accuracy = max(int(row[11]) for row in entries)
        best = [row for row in entries if int(row[11]) == best_accuracy]
        # Multiple codes usually share the same centroid. For the sole split
        # locality use the mean of distinct equally accurate points, not a
        # postal-code-weighted mean that would bias large postal districts.
        points = {(float(row[9]), float(row[10])) for row in best}
        latitude = round(sum(p[0] for p in points) / len(points), 5)
        longitude = round(sum(p[1] for p in points) / len(points), 5)
        if not 45.7 <= latitude <= 48.7 or not 16.0 <= longitude <= 23.0:
            raise ValueError(f"Coordinate outside Hungary bounds: {name}")
        key = re.sub(r"[^a-z0-9]+", "-", fold(name)).strip("-")
        if folds[fold(name)] > 1:
            key += "-" + min(row[1] for row in entries)
        county = collections.Counter(row[3] for row in entries).most_common(1)[0][0]
        cities.append([key, name, county, latitude, longitude])
    cities.sort(key=lambda row: row[0])
    if len(cities) < 3100 or len({row[0] for row in cities}) != len(cities):
        raise ValueError("Incomplete source or duplicate city IDs")

    anchors, aliases = [], [["Bp", "budapest"], ["Bp.", "budapest"]]
    for row in read_rows(gazetteer_data):
        if row[6] == "P" and row[7] == "PPLX" and ("Budapest" in row[1] or "budapest" in row[3].lower()):
            anchors.append(["budapest", float(row[4]), float(row[5])])
            aliases.append([row[1], "budapest"])
    anchors.sort()
    aliases.sort()
    if len(anchors) < 23:
        raise ValueError("Budapest district anchors missing from gazetteer")
    return {
        "schemaVersion": 1,
        "source": {
            "name": "GeoNames Hungarian postal codes and Budapest gazetteer districts",
            "url": "https://www.geonames.org/",
            "license": "CC-BY-4.0",
            "licenseUrl": "https://creativecommons.org/licenses/by/4.0/",
            "retrievedAt": retrieved_at,
            "postal": {"url": POSTAL_URL, "sha256": hashlib.sha256(postal_data).hexdigest(), "rows": len(rows)},
            "gazetteer": {"url": GAZETTEER_URL, "sha256": hashlib.sha256(gazetteer_data).hexdigest()},
            "changes": "Highest-accuracy city centroids; duplicate postal rows removed; ambiguous ASCII city IDs suffixed by postal code; Budapest districts collapsed to Budapest."
        },
        "cityColumns": ["id", "name", "county", "latitude", "longitude"],
        "cities": cities,
        "anchorColumns": ["cityId", "latitude", "longitude"],
        "anchors": anchors,
        "aliases": aliases,
    }


def write_compact_rows(path, dataset):
    # One city per line keeps reviews readable without a large expanded JSON.
    text = json.dumps(dataset, ensure_ascii=False, separators=(",", ":"))
    text = text.replace('],[' , '],\n[')
    path.write_text(text + "\n", encoding="utf-8")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cache-dir", type=pathlib.Path, default=pathlib.Path("/tmp/mentalhu-geo"))
    parser.add_argument("--retrieved-at", default=datetime.datetime.now(datetime.timezone.utc).date().isoformat())
    args = parser.parse_args()
    args.cache_dir.mkdir(parents=True, exist_ok=True)
    postal = download(POSTAL_URL, args.cache_dir / "HU.zip")
    gazetteer = download(GAZETTEER_URL, args.cache_dir / "HU-gazetteer.zip")
    dataset = build(postal, gazetteer, args.retrieved_at)
    output = ROOT / "content/hungary-locations.json"
    write_compact_rows(output, dataset)
    print(f"Wrote {len(dataset['cities'])} cities and {len(dataset['anchors'])} Budapest district anchors to {output}")


if __name__ == "__main__":
    main()
