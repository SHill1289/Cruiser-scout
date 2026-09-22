"""Fetch the Census reference archives once for local use and GitHub Actions."""
from pathlib import Path
from urllib.request import urlopen

ROOT = Path(__file__).resolve().parents[1]
DEST = ROOT / "sources" / "gazetteer"
FILES = {
    "places.zip": "https://www2.census.gov/geo/docs/maps-data/data/gazetteer/2026_Gazetteer/2026_Gaz_place_national.zip",
    "zcta.zip": "https://www2.census.gov/geo/docs/maps-data/data/gazetteer/2026_Gazetteer/2026_Gaz_zcta_national.zip",
    "states-kml.zip": "https://www2.census.gov/geo/tiger/GENZ2025/kml/cb_2025_us_state_20m.zip",
}


def main():
    DEST.mkdir(parents=True, exist_ok=True)
    for filename, url in FILES.items():
        target = DEST / filename
        if target.exists() and target.stat().st_size:
            continue
        with urlopen(url, timeout=40) as response:
            content = response.read()
        if not content.startswith(b"PK"):
            raise ValueError(f"Census reference {filename} was not a ZIP archive")
        target.write_bytes(content)
        print(f"Downloaded {filename}: {len(content)} bytes")


if __name__ == "__main__":
    main()
