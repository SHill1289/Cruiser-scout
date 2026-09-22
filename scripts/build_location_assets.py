"""Build the compact map and ZIP lookup from public US Census files.

Sources: 2026 Gazetteer ZCTAs and 2025 1:20m state KML.
The source archives live in sources/gazetteer/ for reproducible builds.
"""
import csv
import io
import json
import xml.etree.ElementTree as ET
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "sources" / "gazetteer"
WEB = ROOT / "web"


def project(lon, lat, state):
    if state == "AK":
        return 38 + (lon + 170) * 4.1, 445 + (72 - lat) * 5.3
    if state == "HI":
        return 222 + (lon + 161) * 11, 535 + (23 - lat) * 10
    return 38 + (lon + 125) * (924 / 59), 32 + (50 - lat) * (510 / 26)


def main():
    with zipfile.ZipFile(SOURCE / "zcta.zip") as archive:
        filename = next(name for name in archive.namelist() if name.endswith(".txt"))
        rows = csv.DictReader(io.TextIOWrapper(archive.open(filename), encoding="utf-8"), delimiter="|")
        zips = {row["GEOID"]: [round(float(row["INTPTLAT"]), 5), round(float(row["INTPTLONG"]), 5)]
                for row in rows}
    (WEB / "zip-centroids.json").write_text(json.dumps(zips, separators=(",", ":")), encoding="utf-8")

    with zipfile.ZipFile(SOURCE / "states-kml.zip") as archive:
        root = ET.fromstring(archive.read("cb_2025_us_state_20m.kml"))
    ns = {"k": "http://www.opengis.net/kml/2.2"}
    paths = []
    for placemark in root.findall(".//k:Placemark", ns):
        state = next((node.text for node in placemark.findall(".//k:SimpleData", ns)
                      if node.attrib.get("name") == "STUSPS"), None)
        if not state or state in {"PR", "GU", "VI", "AS", "MP"}:
            continue
        pieces = []
        for coords in placemark.findall(".//k:outerBoundaryIs/k:LinearRing/k:coordinates", ns):
            points = []
            for item in coords.text.split():
                lon, lat = map(float, item.split(",")[:2])
                x, y = project(lon, lat, state)
                points.append(f"{x:.1f},{y:.1f}")
            if points:
                pieces.append("M" + " L".join(points) + "Z")
        if pieces:
            paths.append(f'<path d="{" ".join(pieces)}"/>')
    svg = ('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 600" aria-hidden="true">'
           '<rect width="1000" height="600" fill="#111b17"/>'
           '<g fill="#23332a" stroke="#50614d" stroke-width="1.1" stroke-linejoin="round">'
           + "".join(paths) + '</g>'
           '<g fill="none" stroke="#50614d" stroke-dasharray="4 5" opacity=".7">'
           '<rect x="28" y="435" width="195" height="150"/>'
           '<rect x="220" y="515" width="135" height="70"/></g>'
           '<g fill="#91a496" font-family="system-ui,sans-serif" font-size="13" font-weight="700">'
           '<text x="40" y="454">AK</text><text x="230" y="534">HI</text></g></svg>')
    (WEB / "us-map.svg").write_text(svg, encoding="utf-8")
    print(f"Built {len(zips)} ZIP area reference points and {len(paths)} state shapes")


if __name__ == "__main__":
    main()
