"""LX470 Finder: standard-library collectors and an auditable listing database."""
from __future__ import annotations

import argparse
import csv
import hashlib
import html
import io
import json
import os
import re
import shutil
import sys
import time
import zipfile
import urllib.error
import urllib.parse
import urllib.request
import urllib.robotparser
from datetime import datetime, timedelta, timezone
from html.parser import HTMLParser
from pathlib import Path
from statistics import median

ROOT = Path(__file__).resolve().parents[1]
UA = "LX470Finder/1.0 (+https://github.com/SHill1289/lx470-finder)"
KSL_UA = "Mozilla/5.0 (compatible; CruiserScout/1.0; +https://github.com/SHill1289/Cruiser-scout)"
FIELDS = ["listing_key", "vehicle_key", "vin", "year", "make", "model", "source", "source_listing_id",
          "listing_url", "status", "category", "asking_price", "base_price", "current_bid",
          "sold_price", "currency", "mileage", "mileage_is_approximate", "city", "state", "postal_code",
          "seller", "seller_type", "photo_url", "photo_urls", "exterior_color", "interior_color", "title_status",
          "reported_extras",
          "accident_history", "owners", "owners_source", "owners_verified_at", "owner_evidence_url",
          "service_records", "rust_notes", "source_days_on_market", "listed_at", "listed_at_is_estimated",
          "timing_belt_status", "timing_belt_evidence", "ahc_status", "ahc_evidence",
          "rust_status", "rust_evidence", "navigation_status", "navigation_evidence",
          "service_records_status", "service_records_evidence",
          "modifications_status", "modifications_evidence",
          "auction_ends_at", "bid_observed_at", "first_seen", "last_seen", "last_checked", "missing_checks",
          "quality_flags", "notes"]
MODEL_YEARS = {"LX470": (2006, 2007), "Land Cruiser": (2006, 2007), "LX570": tuple(range(2011, 2017))}
VIN_PREFIXES = {"LX470": ("JTJHT00W",), "Land Cruiser": ("JTEHT05J",), "LX570": ("JTJHY7AX",)}
YEAR_CODES = {year: code for year, code in zip(range(2010, 2017), "ABCDEFG")}
STATUSES = {"active", "sold", "ended", "removed", "unknown"}
CARGURUS_CLEAN_CRITERIA = {
    "hideLemon": True,
    "hideFrameDamaged": True,
    "hideSalvage": True,
    "hideTheft": True,
}


def utcnow():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True).encode()).hexdigest()


def number(value):
    if value in (None, ""):
        return None
    value = str(value).replace(",", "").replace("$", "").strip()
    n = float(value)
    if n < 0 or not n < float("inf"):
        raise ValueError("Expected a finite nonnegative number")
    return int(n) if n.is_integer() else n


def valid_vin(vin):
    if not re.fullmatch(r"[A-HJ-NPR-Z0-9]{17}", vin):
        return False
    letters = dict(zip("ABCDEFGHJKLMNPRSTUVWXYZ", [1,2,3,4,5,6,7,8,1,2,3,4,5,7,9,2,3,4,5,6,7,8,9]))
    total = sum((int(c) if c.isdigit() else letters[c]) * w
                for c, w in zip(vin, [8,7,6,5,4,3,2,10,0,9,8,7,6,5,4,3,2]))
    return vin[8] == ("X" if total % 11 == 10 else str(total % 11))


DISTINCT_EXTRAS = {
    "DVD Entertainment System": "Rear-seat DVD",
    "Rear Seat Entertainment": "Rear-seat DVD",
    "Night View": "Night View",
    "Night Vision": "Night View",
    "CarPlay": "CarPlay",
    "Apple CarPlay": "CarPlay",
    "Remote Start": "Remote start",
}


def listing_extras(features):
    """Keep only source-reported extras that distinguish these model years."""
    if not isinstance(features, list):
        return ""
    labels = set()
    for item in features:
        name = item.get("name") if isinstance(item, dict) else item
        if isinstance(name, str) and name in DISTINCT_EXTRAS:
            labels.add(DISTINCT_EXTRAS[name])
    return ";".join(sorted(labels))


def safe_photo_urls(urls):
    if not isinstance(urls, list):
        raise ValueError("photo_urls must be a list")
    result = []
    for url in urls:
        if not isinstance(url, str):
            raise ValueError("photo_urls must contain HTTPS URLs")
        parts = urllib.parse.urlsplit(url)
        if parts.scheme != "https" or not parts.hostname:
            raise ValueError("photo_urls must contain HTTPS URLs")
        if url not in result:
            result.append(url)
        if len(result) == 8:
            break
    return result


def gallery_image_urls(raw):
    """Keep vehicle CDN URLs and request usable sizes of gallery thumbnails."""
    photos = []
    for photo in raw:
        parts = urllib.parse.urlsplit(photo)
        if parts.scheme != "https" or not parts.hostname:
            continue
        if parts.hostname == "static.cargurus.com" and parts.path.startswith("/images/forsale/"):
            photo = photo.replace("-296x222.", "-1024x768.")
        elif parts.hostname == "listings-prod.tcimg.net" and "/listings/" in parts.path:
            query = urllib.parse.parse_qs(parts.query)
            query.update({"h": ["675"], "w": ["1200"]})
            photo = urllib.parse.urlunsplit(parts._replace(query=urllib.parse.urlencode(query, doseq=True)))
        else:
            continue
        if photo not in photos:
            photos.append(photo)
        if len(photos) == 8:
            break
    return photos


def gallery_urls_in_page(page, source, lead_url="", vin=""):
    """Extract source-hosted vehicle images from a listing's public HTML."""
    page = html.unescape(page.replace("\\/", "/"))
    if source == "cargurus":
        matches = re.findall(r'https://static\.cargurus\.com/images/forsale/[^"\'<>\s\\]+', page, re.I)
        lead_parts = urllib.parse.urlsplit(lead_url)
        if lead_parts.hostname == "static.cargurus.com":
            directory = lead_url.rsplit("/", 1)[0] + "/"
            matches = [url for url in matches if url.startswith(directory)]
    elif source == "truecar":
        matches = re.findall(r'https://listings-prod\.tcimg\.net/listings/[^"\'<>\s\\]+', page, re.I)
        if vin:
            matches = [url for url in matches if f"/{vin}/" in url]
    else:
        return []
    matches = [url.rstrip("),.;") for url in matches]
    return gallery_image_urls([lead_url, *matches])


def normalize(raw):
    row = {k: raw.get(k, "") for k in FIELDS}
    row["year"] = int(raw["year"])
    make = re.sub(r"[^a-z0-9]", "", str(raw.get("make") or "Lexus").lower())
    model = re.sub(r"[^a-z0-9]", "", str(raw.get("model") or "LX470").lower())
    identities = {("lexus", "lx470"): ("Lexus", "LX470"),
                  ("lexus", "lx570"): ("Lexus", "LX570"),
                  ("toyota", "landcruiser"): ("Toyota", "Land Cruiser")}
    if (make, model) not in identities:
        raise ValueError("Unsupported make/model")
    row["make"], row["model"] = identities[make, model]
    if row["year"] not in MODEL_YEARS[row["model"]]:
        raise ValueError("Year is outside the supported range for " + row["model"])
    if not row["source"] or not row["source_listing_id"]:
        raise ValueError("Source and stable source listing ID are required")
    row["source_listing_id"] = str(row["source_listing_id"])
    postal_code = str(row.get("postal_code") or "").strip()
    row["postal_code"] = postal_code if re.fullmatch(r"\d{5}", postal_code) else ""
    parts = urllib.parse.urlsplit(row["listing_url"])
    if parts.scheme != "https" or not parts.hostname:
        raise ValueError("An HTTPS listing URL is required")
    if row["photo_url"]:
        photo_parts = urllib.parse.urlsplit(str(row["photo_url"]))
        if photo_parts.scheme != "https" or not photo_parts.hostname:
            raise ValueError("photo_url must be a complete HTTPS URL")
    row["photo_urls"] = safe_photo_urls(row["photo_urls"] or [])
    if row["photo_url"] and row["photo_url"] not in row["photo_urls"]:
        row["photo_urls"] = [row["photo_url"], *row["photo_urls"]][:8]
    if not row["photo_url"] and row["photo_urls"]:
        row["photo_url"] = row["photo_urls"][0]
    row["listing_key"] = row["source"] + ":" + row["source_listing_id"]
    row["vin"] = str(row["vin"]).upper().strip()
    flags = set(filter(None, str(row["quality_flags"]).split(";")))
    vin_ok = valid_vin(row["vin"])
    if row["vin"] and not vin_ok:
        flags.add("invalid_vin")
    if vin_ok and (not row["vin"].startswith(VIN_PREFIXES[row["model"]]) or row["vin"][9] != YEAR_CODES.get(row["year"], str(row["year"])[-1])):
        flags.add("vin_model_or_year_conflict")
        vin_ok = False
    if not row["vin"]:
        flags.add("missing_vin")
    row["vehicle_key"] = "vin:" + row["vin"] if vin_ok else "listing:" + row["listing_key"]
    row["status"] = row["status"] or "unknown"
    if row["status"] not in STATUSES:
        raise ValueError("Unsupported status")
    row["category"] = row["category"] or "retail"
    if row["category"] not in {"retail", "auction", "salvage"}:
        raise ValueError("Unsupported category")
    row["title_status"] = row["title_status"] or "unknown"
    for topic in CONDITION_TOPICS:
        status_key, evidence_key = f"{topic}_status", f"{topic}_evidence"
        if not row[status_key] or not row[evidence_key]:
            row[status_key] = ""
            row[evidence_key] = ""
    row["currency"] = row["currency"] or "USD"
    for key in ("asking_price", "base_price", "current_bid", "sold_price", "mileage"):
        row[key] = number(row[key])
    if row["listed_at"]:
        try:
            datetime.fromisoformat(str(row["listed_at"]).replace("Z", "+00:00"))
        except ValueError as error:
            raise ValueError("listed_at must be an ISO 8601 date or timestamp") from error
    if row["listed_at_is_estimated"] not in ("", True, False):
        raise ValueError("listed_at_is_estimated must be true or false")
    row["listed_at_is_estimated"] = bool(row["listed_at_is_estimated"])
    row["quality_flags"] = ";".join(sorted(flags))
    return row


def inferred_listed_at(row, observed_at):
    """Estimate the source listing date from its reported days on market."""
    days = row.get("source_days_on_market")
    if days in (None, ""):
        return ""
    try:
        days = int(days)
        observed = datetime.fromisoformat(str(observed_at).replace("Z", "+00:00"))
    except (TypeError, ValueError):
        return ""
    if days < 0:
        return ""
    return (observed.date() - timedelta(days=days)).isoformat()


def backfill_listing_dates(state):
    """Add stable source listing dates to databases created before this field existed."""
    records = list(state.get("listings", {}).values()) + list(state.get("history", []))
    for row in records:
        if row.get("listed_at"):
            continue
        observed_at = row.get("first_seen") or row.get("observed_at")
        inferred = inferred_listed_at(row, observed_at) if observed_at else ""
        row["listed_at"] = inferred
        row["listed_at_is_estimated"] = bool(inferred)


def accident_category(value):
    """Only explicit source evidence may classify a listing as accident-reported."""
    label = str(value or "").strip().lower()
    if label == "no reported accidents":
        return "none"
    if (re.search(r"\b\d+ reported accidents?\b", label)
            or "seller discloses prior accident" in label
            or label == "accident reported"):
        return "reported"
    return "unavailable"


def correct_ambiguous_accident_history(state):
    """Remove an old CarGurus inference from retained listings and history."""
    for row in list(state.get("listings", {}).values()) + list(state.get("history", [])):
        if row.get("accident_history") in {"Accident reported or history unavailable", "Unknown", ""}:
            row["accident_history"] = "History unavailable"


class Fetcher:
    def __init__(self):
        self.robots = {}
        self.last = {}
        self.pages = {}

    def request(self, url):
        agent = KSL_UA if urllib.parse.urlsplit(url).hostname == "cars.ksl.com" else UA
        req = urllib.request.Request(url, headers={"User-Agent": agent, "Accept": "text/html"})
        with urllib.request.urlopen(req, timeout=30) as response:
            data = response.read(8_000_001)
            if len(data) > 8_000_000:
                raise ValueError("Page exceeds 8 MB limit")
            return data.decode("utf-8", errors="replace")

    def get(self, url):
        if url in self.pages:
            return self.pages[url]
        parts = urllib.parse.urlsplit(url)
        host = parts.netloc
        if parts.scheme != "https" or host not in {"www.cargurus.com", "bringatrailer.com", "www.truecar.com", "cars.ksl.com"}:
            raise ValueError("Collector host is not allowlisted")
        if host not in self.robots:
            parser = urllib.robotparser.RobotFileParser()
            parser.parse(self.request(f"https://{host}/robots.txt").splitlines())
            self.robots[host] = parser
        parser = self.robots[host]
        if not parser.can_fetch(UA, url):
            raise ValueError("Disallowed by robots.txt")
        delay = max(8 if host == "cars.ksl.com" else 2, parser.crawl_delay(UA) or 0)
        time.sleep(max(0, delay - (time.monotonic() - self.last.get(host, 0))))
        try:
            page = self.request(url)
            self.pages[url] = page
            return page
        finally:
            self.last[host] = time.monotonic()


class BrowserPhotoFetcher:
    """Read a small set of source-hosted photos from public listing galleries."""
    def __init__(self):
        self.driver = None
        self.galleries = {}
        self.descriptions = {}
        self.errors = {}
        self.last = 0

    def gallery(self, url):
        if url in self.galleries:
            return self.galleries[url]
        self.galleries[url] = []
        try:
            from selenium import webdriver
            from selenium.webdriver.chrome.service import Service
            from selenium.webdriver.support.ui import WebDriverWait
            if self.driver is None:
                options = webdriver.ChromeOptions()
                for argument in ("--headless=new", "--no-sandbox", "--disable-dev-shm-usage",
                                 "--disable-gpu", "--window-size=1280,900"):
                    options.add_argument(argument)
                chrome = next((path for name in ("google-chrome", "google-chrome-stable",
                                                  "chromium", "chromium-browser")
                               if (path := shutil.which(name))), None)
                if chrome:
                    options.binary_location = chrome
                driver = shutil.which("chromedriver")
                service = Service(executable_path=driver) if driver else Service()
                self.driver = webdriver.Chrome(service=service, options=options)
                self.driver.set_page_load_timeout(30)
            time.sleep(max(0, 2 - (time.monotonic() - self.last)))
            self.driver.get(url)
            self.last = time.monotonic()
            gallery_script = """
                const pick = image => [image.getAttribute('src'), image.currentSrc, image.getAttribute('data-src')]
                    .find(url => url && url.startsWith('https://')) || '';
                if (location.hostname.endsWith('cargurus.com')) {
                    const main = document.querySelector('#PreviewGalleryMainImage img');
                    const lead = main && pick(main);
                    if (!lead) return null;
                    const directory = lead.slice(0, lead.lastIndexOf('/') + 1);
                    const images = [...document.images].map(pick).filter(url => url.startsWith(directory));
                    return [lead, ...images];
                }
                if (location.hostname.endsWith('truecar.com')) {
                    const vin = location.pathname.split('/').filter(Boolean).pop();
                    const images = [...document.images].map(pick)
                        .filter(url => url.includes('/listings/') && url.includes('/' + vin + '/'));
                    return images.length ? images : null;
                }
                return null;
            """
            raw = WebDriverWait(self.driver, 10).until(lambda driver: driver.execute_script(gallery_script))
            if urllib.parse.urlsplit(url).hostname == "www.cargurus.com":
                description_script = """
                    const section = document.querySelector('[data-testid="dealer-section"]');
                    const heading = [...(section?.querySelectorAll('h3') || [])]
                        .find(node => node.textContent.trim() === "Dealer's description");
                    return heading?.nextElementSibling?.innerText || '';
                """
                self.descriptions[url] = self.driver.execute_script(description_script) or ""
            # Galleries often render the first thumbnail before the rest. Give
            # lazy thumbnails a moment to appear before saving this listing.
            for _ in range(6):
                time.sleep(0.5)
                later = self.driver.execute_script(gallery_script) or []
                if len(later) > len(raw):
                    raw = later
                if len(raw) >= 9:
                    break
            self.galleries[url] = gallery_image_urls(raw)
        except Exception as error:
            if self.driver is not None and urllib.parse.urlsplit(url).hostname == "www.cargurus.com":
                try:
                    self.descriptions[url] = self.driver.execute_script("""
                        const section = document.querySelector('[data-testid="dealer-section"]');
                        const heading = [...(section?.querySelectorAll('h3') || [])]
                            .find(node => node.textContent.trim() === "Dealer's description");
                        return heading?.nextElementSibling?.innerText || '';
                    """) or ""
                except Exception:
                    pass
            self.errors[url] = f"{type(error).__name__}: {error}".replace("\n", " ")[:500]
        return self.galleries[url]

    def photo(self, url):
        return next(iter(self.gallery(url)), "")

    def description(self, url):
        self.gallery(url)
        return self.descriptions.get(url, "")

    def error(self, url):
        return self.errors.get(url, "gallery photos unavailable")

    def close(self):
        if self.driver is not None:
            self.driver.quit()
            self.driver = None


def cargurus_search(page, year, extra_criteria=None):
    marker = re.search(r"window\.__remixContext\s*=\s*", page)
    if not marker:
        raise ValueError("CarGurus data missing; page may be blocked or its format changed")
    context, _ = json.JSONDecoder().raw_decode(page[marker.end():])
    searches = [v["search"] for v in context["state"]["loaderData"].values()
                if isinstance(v, dict) and "search" in v and isinstance(v["search"], dict)]
    if len(searches) != 1:
        raise ValueError("Expected one CarGurus search result")
    search = searches[0]
    criteria = search["appliedFilterCriteria"]
    if criteria.get("distance", 0) < 50000 or criteria.get("startYear") != year or criteria.get("endYear") != year:
        raise ValueError("Source did not apply nationwide/year filters")
    required = {**CARGURUS_CLEAN_CRITERIA, **(extra_criteria or {})}
    if any(criteria.get(key) != value for key, value in required.items()):
        raise ValueError("Source did not apply required clean-history filters")
    return search


def cargurus_listing_ids(page, year, extra_criteria):
    search = cargurus_search(page, year, extra_criteria)
    ids = {str(tile["data"]["id"]) for tile in search["tiles"]
           if tile.get("type", "").startswith("LISTING_USED")}
    complete = search.get("pageCount") == 1 and len(ids) == search.get("totalListings")
    if not complete:
        raise ValueError("Supplemental CarGurus history search was incomplete")
    return ids


def cargurus_photo(value):
    """Find the largest vehicle photo embedded in a CarGurus result tile."""
    candidates = []

    picture = value.get("pictureData", {}) if isinstance(value, dict) else {}
    direct = picture.get("url", "") if isinstance(picture, dict) else ""
    if direct.startswith("//"):
        direct = "https:" + direct
    elif direct.startswith("http://"):
        direct = "https://" + direct.removeprefix("http://")
    direct_parts = urllib.parse.urlsplit(direct)
    if direct_parts.scheme == "https" and direct_parts.hostname:
        return direct

    def visit(item):
        if isinstance(item, dict):
            for nested in item.values():
                visit(nested)
        elif isinstance(item, list):
            for nested in item:
                visit(nested)
        elif isinstance(item, str) and item.startswith("https://"):
            parts = urllib.parse.urlsplit(item)
            if (parts.hostname or "").endswith("cargurus.com") and "/images/forsale/" in parts.path:
                size = re.search(r"-(\d+)x(\d+)\.(?:jpe?g|webp|png)$", parts.path, re.I)
                area = int(size[1]) * int(size[2]) if size else 0
                candidates.append((area, item))

    visit(value)
    return max(candidates, default=(0, ""))[1]


def parse_cargurus(page, year, no_accident_ids=None, model="LX470"):
    search = cargurus_search(page, year)
    no_accident_ids = no_accident_ids or set()
    rows = {}
    for tile in search["tiles"]:
        if not tile.get("type", "").startswith("LISTING_USED"):
            continue
        d = tile["data"]
        ontology = d.get("ontologyData", {})
        identity_ok = (ontology.get("makeName") == "Toyota" and ontology.get("modelName") == "Land Cruiser"
                       if model == "Land Cruiser" else
                       ontology.get("makeName") == "Lexus" and ontology.get("modelName") == "LX" and ontology.get("trimName", "").startswith("570" if model == "LX570" else "470"))
        if int(ontology.get("carYear", 0)) != year or not identity_ok:
            continue
        seller, price = d.get("sellerData", {}), d.get("priceData", {})
        mileage = d.get("mileageData") or {}
        if mileage.get("value") not in (None, "") and mileage.get("unit") != "MILES":
            raise ValueError(f"Unexpected mileage units for CarGurus listing {d['id']}: {mileage.get('unit')!r}")
        listing_id = str(d["id"])
        rows[listing_id] = normalize({
            "source": "cargurus", "source_listing_id": d["id"], "year": year,
            "make": "Toyota" if model == "Land Cruiser" else "Lexus", "model": model,
            "vin": d.get("vin", ""), "status": "active", "category": "retail",
            "listing_url": f'https://www.cargurus.com/details/{d["id"]}',
            "asking_price": price.get("pricePlusFees", price.get("totalPrice", price.get("current"))),
            "base_price": price.get("basePrice", price.get("current")),
            "mileage": mileage.get("value"),
            "city": seller.get("city", ""), "state": seller.get("region", ""),
            "seller": seller.get("serviceProviderName", ""),
            "seller_type": "dealer" if seller.get("serviceProviderId") else "unknown",
            "photo_url": cargurus_photo(d),
            "exterior_color": d.get("exteriorColorData", {}).get("name", ""),
            "interior_color": d.get("interiorColorData", {}).get("localized", ""),
            "reported_extras": listing_extras(d.get("vehicleFeatures", [])),
            "title_status": "clean-title candidate",
            "accident_history": "No reported accidents" if listing_id in no_accident_ids else "History unavailable",
            "owners": "Unverified",
            "source_days_on_market": d.get("daysOnMarket", ""),
            "notes": "CarGurus clean-history filters exclude reported salvage, lemon, frame-damage and theft history. Absence from the separate no-accident results does not prove an accident. This is a clean-title candidate, not a legal title guarantee; verify through NMVTIS/CARFAX and the physical title. Asking price includes listed fees when supplied; taxes/shipping may be extra.",
        })
    complete = search.get("pageCount") == 1 and len(rows) == search.get("totalListings")
    if not rows and search.get("totalListings") != 0:
        raise ValueError("No valid listings parsed from nonempty results")
    return list(rows.values()), complete, search.get("totalListings")


def parse_truecar(page, now, model="LX470", page_offset=0, paginated=False):
    """Parse nationwide clean-title listings for the requested model from TrueCar's public search page."""
    expected = [{"makeSlug": "toyota", "modelSlug": "land-cruiser"}] if model == "Land Cruiser" else [{"makeSlug": "lexus", "modelSlug": "lx", "trimSlugs": ["lx-570" if model == "LX570" else "lx-470"]}]
    match = re.search(r'<script id="__NEXT_DATA__" type="application/json">(.*?)</script>', page, re.S)
    if not match:
        raise ValueError("TrueCar structured data missing; page may be blocked or its format changed")
    payload = json.loads(html.unescape(match[1]))
    state = payload.get("props", {}).get("pageProps", {}).get("__APOLLO_STATE__", {})
    root = state.get("ROOT_QUERY", {})
    searches = [(key, value) for key, value in root.items()
                if key.startswith("marketplaceListingSearch(")
                and isinstance(value, dict) and "totalCount" in value]
    if len(searches) != 1:
        raise ValueError("Expected one TrueCar marketplace search result")
    search_key, search = searches[0]
    try:
        search_args = json.loads(search_key[len("marketplaceListingSearch("):-1])
        filters = search_args["filters"]
        scope_ok = (
            search_args.get("offset") == page_offset and filters.get("condition") == "USED" and
            filters.get("makeModelTrim") == expected and
            # TrueCar omits withinRadius for unrestricted nationwide searches.
            ("withinRadius" not in filters or
             filters.get("withinRadius", {}).get("distance") == 5000) and
            filters.get("year") == {"min": min(MODEL_YEARS[model]), "max": max(MODEL_YEARS[model])} and
            set(filters) <= {"condition", "fallbackStrategy", "makeModelTrim", "withinRadius", "year"}
        )
    except (ValueError, KeyError, TypeError, AttributeError) as error:
        raise ValueError("TrueCar search filters could not be read") from error
    if not scope_ok:
        detail = json.dumps(filters, sort_keys=True, separators=(",", ":"))[:350]
        raise ValueError("TrueCar did not apply required nationwide year/model filters: " + detail)
    edges = search.get("edges", [])
    total = search.get("totalCount")
    complete = not search.get("pageInfo", {}).get("hasNextPage") and total == len(edges)
    rows = []
    parsed_edges = 0
    for edge in edges:
        ref = edge.get("node", {}).get("__ref", "")
        listing = state.get(ref, {})
        vehicle = listing.get("vehicle", {})
        style = vehicle.get("style", {}) or {}
        year = vehicle.get("year")
        vin = str(vehicle.get("vin", "")).upper()
        identity_ok = (vehicle.get("make", {}).get("name") == "Toyota" and vehicle.get("model", {}).get("name") == "Land Cruiser"
                       if model == "Land Cruiser" else
                       vehicle.get("make", {}).get("name") == "Lexus" and style.get("trimName") == ("LX 570" if model == "LX570" else "LX 470"))
        if year not in MODEL_YEARS[model] or not identity_ok:
            continue
        parsed_edges += 1
        history = listing.get("conditionHistory", {}) or {}
        if history.get("isCleanTitle") is not True:
            continue
        details = vehicle.get("details", {}) or {}
        dealer_ref = listing.get("dealership", {}).get("__ref", "")
        dealer = state.get(dealer_ref, {})
        location = dealer.get("location", {}).get("geolocation", {}) or {}
        gallery = next((value for key, value in listing.items() if key.startswith("galleryImages(")), {}) or {}
        photos = [item.get("node", {}).get("url", "") for item in gallery.get("edges", [])]
        photos = [url for url in photos if url.startswith("https://")][:8]
        photo = next(iter(photos), "")
        accident_count = history.get("accidentCount")
        accidents = ("No reported accidents" if accident_count == 0 else
                     f"{accident_count} reported accident{'s' if accident_count != 1 else ''}" if isinstance(accident_count, int) else
                     "History unavailable")
        owner_count = history.get("ownerCount")
        listing_url = f"https://www.truecar.com/used-cars-for-sale/listing/{vin}/"
        rows.append(normalize({
            "source": "truecar", "source_listing_id": vin, "year": year, "vin": vin,
            "make": "Toyota" if model == "Land Cruiser" else "Lexus", "model": model,
            "listing_url": listing_url, "status": "active", "category": "retail",
            "asking_price": listing.get("pricing", {}).get("listPrice"),
            "mileage": vehicle.get("mileage", details.get("mileage")),
            "city": location.get("city", details.get("dealerCity", "")),
            "state": location.get("state", details.get("dealerState", "")),
            "postal_code": location.get("postalCode", ""),
            "seller": dealer.get("name", ""), "seller_type": "dealer",
            "photo_url": photo, "photo_urls": photos,
            "exterior_color": details.get("exteriorColorName", vehicle.get("exteriorColor", "")),
            "interior_color": details.get("interiorColorName", vehicle.get("interiorColor", "")),
            "reported_extras": listing_extras(vehicle.get("keyFeatures") or details.get("keyFeatures", [])),
            "title_status": "clean title", "accident_history": accidents,
            "owners": str(owner_count) if isinstance(owner_count, int) else "Unknown",
            "owners_source": "TrueCar / Experian AutoCheck" if isinstance(owner_count, int) else "",
            "owner_evidence_url": listing_url if isinstance(owner_count, int) else "",
            "owners_verified_at": now[:10] if isinstance(owner_count, int) else "",
            "listed_at": details.get("listedAt", ""), "listed_at_is_estimated": False,
            "notes": "TrueCar reports clean-title, owner and accident data from Experian AutoCheck. Verify the physical title and a current history report before purchase.",
        }))
    if paginated:
        complete = parsed_edges == len(edges)
    elif parsed_edges != len(edges):
        complete = False
    return rows, complete, total


def ksl_listing_urls(page, make):
    """Find only matching cards in KSL's public search HTML."""
    if 'data-item-id=' not in page or 'KSL Cars' not in page:
        raise ValueError("KSL search cards missing; page may be blocked or its format changed")
    pattern = r'aria-label="(\d{4}) (Lexus LX|Toyota Land Cruiser)[^\"]*" data-item-id="(\d+)"'
    urls = set()
    for year_text, label, listing_id in re.findall(pattern, page):
        year = int(year_text)
        if ((make == "Lexus" and label == "Lexus LX" and
             year in MODEL_YEARS["LX470"] + MODEL_YEARS["LX570"]) or
            (make == "Toyota" and label == "Toyota Land Cruiser" and
             year in MODEL_YEARS["Land Cruiser"])):
            urls.add(f"https://cars.ksl.com/listing/{listing_id}")
    return sorted(urls)


def parse_ksl(page, url):
    """Use KSL's per-listing title field and structured data; no inferred clean titles."""
    listing_id = re.fullmatch(r"https://cars\.ksl\.com/listing/(\d+)", url)
    if not listing_id:
        raise ValueError("Unexpected KSL listing URL")
    title = re.search(r'>Title</p></div><div[^>]*>([^<]+)</div>', page)
    if not title:
        raise ValueError("KSL title field missing")
    if html.unescape(title[1]).strip().lower() != "clean title":
        return None
    car = None
    for raw in re.findall(r'<script type="application/ld\+json">(.*?)</script>', page, re.S):
        data = json.loads(html.unescape(raw))
        if isinstance(data, dict) and data.get("@type") == "Car":
            car = data
            break
    if not car or car.get("url") != url:
        raise ValueError("KSL vehicle structured data missing or mismatched")
    vin = str(car.get("vehicleIdentificationNumber") or "").upper()
    year = int(car.get("modelDate") or 0)
    brand = (car.get("brand") or {}).get("name")
    if brand == "Toyota" and vin.startswith(VIN_PREFIXES["Land Cruiser"]):
        model = "Land Cruiser"
    elif brand == "Lexus" and vin.startswith(VIN_PREFIXES["LX470"]):
        model = "LX470"
    elif brand == "Lexus" and vin.startswith(VIN_PREFIXES["LX570"]):
        model = "LX570"
    else:
        raise ValueError("KSL VIN does not identify a supported vehicle")
    if year not in MODEL_YEARS[model] or not valid_vin(vin):
        raise ValueError("KSL VIN or model year is invalid")
    offers = car.get("offers") or {}
    if offers.get("availability") != "https://schema.org/InStock":
        return None
    seller = offers.get("seller") or {}
    location = re.search(r'<title>\d{4} [^<]+ in ([^,<]+), ([A-Z]{2}) \| KSL Cars</title>', page)
    image = car.get("image") or {}
    photo = image.get("url", "") if isinstance(image, dict) else ""
    return normalize({
        "source": "ksl", "source_listing_id": listing_id[1],
        "year": year, "make": brand, "model": model, "vin": vin,
        "listing_url": url, "status": "active", "category": "retail",
        "asking_price": offers.get("price"),
        "mileage": (car.get("mileageFromOdometer") or {}).get("value"),
        "city": location[1] if location else "", "state": location[2] if location else "",
        "postal_code": (seller.get("address") or {}).get("postalCode", ""),
        "seller": seller.get("name", ""),
        "seller_type": "dealer" if seller.get("@type") == "Organization" else "private",
        "photo_url": photo,
        "exterior_color": car.get("color", ""),
        "interior_color": car.get("vehicleInteriorColor", ""),
        "title_status": "clean title", "accident_history": "History unavailable",
        "owners": "Unknown",
        "notes": "KSL Cars advertises this vehicle with a Clean Title. This is a marketplace claim, not a DMV verification; confirm through NMVTIS/CARFAX and the physical title before purchase.",
    })


def collect_ksl(fetcher, url, make):
    urls = ksl_listing_urls(fetcher.get(url), make)
    rows, errors = [], []
    for listing_url in urls:
        try:
            row = parse_ksl(fetcher.get(listing_url), listing_url)
            if row:
                rows.append(row)
        except Exception as error:
            errors.append(f"{listing_url}: {error}")
    return rows, len(urls), errors


def search_page_url(url, page):
    parts = urllib.parse.urlsplit(url)
    query = urllib.parse.parse_qs(parts.query)
    query["page"] = [str(page)]
    return urllib.parse.urlunsplit(parts._replace(query=urllib.parse.urlencode(query, doseq=True)))


def collect_cargurus(fetcher, url, year, model, no_accident_ids=None, extra_criteria=None):
    """Collect all advertised pages; inconsistent totals never become absence evidence."""
    rows, total, pages = {}, None, None
    complete = True
    next_url = url
    for page_number in range(1, 21):
        page = fetcher.get(next_url)
        search = cargurus_search(page, year, extra_criteria)
        if page_number == 1:
            total, pages = search.get("totalListings"), search.get("pageCount")
            if total == 0:
                batch, _, _ = parse_cargurus(page, year, no_accident_ids, model)
                return batch, not batch, 0
            if not isinstance(pages, int) or not 0 <= pages <= 20 or (pages == 0 and total != 0):
                raise ValueError("CarGurus page count is unavailable or exceeds collection limit")
        if search.get("totalListings") != total or search.get("pageCount") != pages:
            complete = False
        if search.get("pageNumber", 1) != page_number:
            raise ValueError("CarGurus returned the wrong result page")
        batch, _, _ = parse_cargurus(page, year, no_accident_ids, model)
        rows.update((row["source_listing_id"], row) for row in batch)
        if page_number >= max(1, pages):
            break
        parts = urllib.parse.urlsplit(search_page_url(url, page_number + 1))
        query = urllib.parse.parse_qs(parts.query)
        for key in ("pageReceipt", "pageAlignment", "seenSponsored", "seenStandard"):
            if search.get(key):
                query[key] = [search[key]]
        next_url = urllib.parse.urlunsplit(parts._replace(query=urllib.parse.urlencode(query, doseq=True)))
    return list(rows.values()), complete and len(rows) == total, total


def retry_search(fetcher, collect, source_id):
    """Retry one incomplete/failed search with uncached pages, without treating it as absence."""
    partial = None
    for attempt in range(2):
        try:
            result = collect()
            if result[1]:
                return result, attempt
            if partial is None or len(result[0]) > len(partial[0]):
                partial = result
        except Exception:
            if attempt:
                if partial is not None:
                    return partial, attempt
                raise
        if attempt == 0:
            print(f"Retrying {source_id} search with fresh pages", file=sys.stderr)
            if hasattr(fetcher, "pages"):
                fetcher.pages.clear()
    return partial, 1


def collect_cargurus_with_history(fetcher, source):
    """Optional accident-history enrichment must not prevent inventory collection."""
    model = source.get("model", "LX470")
    ids, history_retries, warning = set(), 0, ""
    try:
        (history_rows, complete, _), history_retries = retry_search(fetcher,
            lambda: collect_cargurus(fetcher, source["no_accidents_url"], source["year"], model,
                                     extra_criteria={"maxAccidents": 0}), source["id"] + " history")
        if complete:
            ids = {row["source_listing_id"] for row in history_rows}
        else:
            warning = " Supplemental accident-history search incomplete; accident history unavailable."
    except Exception as exc:
        warning = f" Supplemental accident-history search unavailable ({type(exc).__name__}); accident history unavailable."
    result, search_retries = retry_search(fetcher,
        lambda: collect_cargurus(fetcher, source["url"], source["year"], model, ids), source["id"])
    return result, bool(history_retries or search_retries), warning


def truecar_search_metadata(page):
    match = re.search(r'<script id="__NEXT_DATA__" type="application/json">(.*?)</script>', page, re.S)
    if not match:
        raise ValueError("TrueCar structured data missing")
    state = json.loads(html.unescape(match[1]))["props"]["pageProps"]["__APOLLO_STATE__"]
    searches = [(key, value) for key, value in state["ROOT_QUERY"].items()
                if key.startswith("marketplaceListingSearch(") and isinstance(value, dict) and "totalCount" in value]
    if len(searches) != 1:
        raise ValueError("Expected one TrueCar marketplace search result")
    key, search = searches[0]
    return json.loads(key[len("marketplaceListingSearch("):-1]), search


def collect_truecar(fetcher, url, now, model):
    rows, seen, total, size = {}, set(), None, None
    complete = True
    for page_number in range(1, 21):
        page = fetcher.get(url if page_number == 1 else search_page_url(url, page_number))
        args, search = truecar_search_metadata(page)
        if page_number == 1:
            total, size = search.get("totalCount"), args.get("first")
            if not isinstance(size, int) or size <= 0 or not isinstance(total, int) or total < 0:
                raise ValueError("TrueCar pagination metadata is invalid")
        batch, parsed, _ = parse_truecar(page, now, model, (page_number - 1) * size, paginated=True)
        complete = complete and parsed and search.get("totalCount") == total and args.get("first") == size
        refs = [edge.get("node", {}).get("__ref") for edge in search.get("edges", [])]
        if any(not ref or ref in seen for ref in refs) or len(set(refs)) != len(refs):
            complete = False
        seen.update(refs)
        rows.update((row["source_listing_id"], row) for row in batch)
        if not search.get("pageInfo", {}).get("hasNextPage"):
            return list(rows.values()), complete and len(seen) == total, total
    return list(rows.values()), False, total


def plain(page):
    page = re.sub(r"<(script|style)\b[^>]*>.*?</\1>", "", page, flags=re.S | re.I)
    return re.sub(r"\s+", " ", html.unescape(re.sub(r"<[^>]+>", " ", page))).strip()


CONDITION_TOPICS = ("timing_belt", "ahc", "rust", "navigation", "service_records", "modifications")


class ListingParagraphs(HTMLParser):
    """Read only the auction narrative, excluding comments and surrounding page copy."""

    def __init__(self, class_name):
        super().__init__(convert_charrefs=True)
        self.class_name = class_name
        self.depth = 0
        self.paragraph_depth = 0
        self.current = []
        self.paragraphs = []

    def handle_starttag(self, tag, attrs):
        classes = dict(attrs).get("class", "").split()
        if not self.depth and self.class_name in classes:
            self.depth = 1
            return
        if self.depth:
            if tag not in {"area", "br", "hr", "img", "input", "meta", "source", "wbr"}:
                self.depth += 1
            if tag == "p":
                self.paragraph_depth = self.depth
                self.current = []

    def handle_startendtag(self, tag, attrs):
        # Auction photo tags are often XHTML-style <img /> elements.
        # They must not close the narrative container's depth.
        self.handle_starttag(tag, attrs)
        if tag not in {"area", "br", "hr", "img", "input", "meta", "source", "wbr"}:
            self.handle_endtag(tag)

    def handle_endtag(self, tag):
        if not self.depth:
            return
        if tag == "p" and self.paragraph_depth:
            paragraph = re.sub(r"\s+", " ", " ".join(self.current)).strip()
            if paragraph:
                self.paragraphs.append(paragraph)
            self.paragraph_depth = 0
            self.current = []
        self.depth -= 1

    def handle_data(self, data):
        if self.paragraph_depth:
            self.current.append(data)


def condition_claims(paragraphs):
    """Extract explicit listing claims; an absent or standard feature stays unknown."""
    claims = {}
    patterns = {
        "timing_belt": [
            (r"\b(?:timing belt|timing-belt)\b.{0,55}\b(?:due|overdue|needs|required)\b", "Service due per listing"),
            (r"\b(?:timing belt|timing-belt)\b.{0,65}\b(?:replaced|changed|serviced|service was performed)\b|\b(?:replaced|changed|serviced)\b.{0,65}\b(?:timing belt|timing-belt)\b", "Service reported"),
        ],
        "ahc": [
            (r"\b(?:AHC|active height control|adjustable height control)\b.{0,50}\b(?:not working|inoperative|failed|leak(?:ing|s)?)\b", "Issue reported"),
            (r"\b(?:AHC|active height control|adjustable height control)\b.{0,50}\b(?:works|working|functions|operates)\b|\b(?:works|working|functions|operates)\b.{0,50}\bAHC\b", "Working per listing"),
            (r"\b(?:AHC|active height control|adjustable height control)\b.{0,50}\b(?:deleted|removed|converted)\b", "Removed or converted"),
        ],
        "rust": [
            (r"\b(?:no (?:concerning |significant |visible )?rust|rust[- ]free|no corrosion|clean undercarriage)\b", "No rust reported by listing"),
            (r"\b(?:rust|corrosion)\b.{0,45}\b(?:visible|present|reported|on the underside|on the frame)\b|\b(?:visible|present)\b.{0,45}\b(?:rust|corrosion)\b", "Rust reported"),
        ],
        "navigation": [
            (r"\b(?:navigation|nav system)\b.{0,45}\b(?:not working|inoperative|broken|failed)\b", "Issue reported"),
            (r"\b(?:navigation|nav system)\b.{0,45}\b(?:works|working|functions|operates)\b", "Working per listing"),
            (r"\b(?:equipped with|features|factory options include|optioned with)\b.{0,90}\b(?:navigation|nav system)\b", "Advertised; operation unknown"),
        ],
        "service_records": [
            (r"\b(?:no service records|no maintenance records|records (?:are )?unavailable)\b", "No records reported"),
            (r"\b(?:service records|maintenance records|service receipts|maintenance receipts|documented maintenance)\b", "Records mentioned"),
        ],
        "modifications": [
            (r"\b(?:unmodified|no modifications|stock condition)\b", "Unmodified per listing"),
            (r"\b(?:aftermarket|modified|modifications|lift kit|lifted suspension|AHC delete|AHC conversion)\b", "Modification reported"),
        ],
    }
    for paragraph in paragraphs:
        for sentence in re.split(r"(?<=[.!?])\s+", paragraph):
            sentence = sentence.strip()
            for topic in CONDITION_TOPICS:
                if topic in claims:
                    continue
                for pattern, status in patterns[topic]:
                    match = re.search(pattern, sentence, re.I)
                    if match:
                        start = max(0, match.start() - 55)
                        end = min(len(sentence), match.end() + 55)
                        evidence = sentence[start:end].strip()
                        claims[f"{topic}_status"] = status
                        claims[f"{topic}_evidence"] = ("…" if start else "") + evidence + ("…" if end < len(sentence) else "")
                        break
    return claims


def cargurus_condition_claims(page):
    # Only the seller's description; CarGurus' generic equipment panel is not evidence.
    section = re.search(r"<h3\b[^>]*>Dealer(?:&#x27;|&#39;|['’])s description</h3>\s*<div\b[^>]*>(.*?)</div>", page, re.I | re.S)
    return condition_claims([plain(section[1])]) if section else {}


def parse_listing_photo(page):
    """Return a public lead-image URL from standard social metadata."""
    for tag in re.findall(r"<meta\b[^>]*>", page, re.I):
        if not re.search(r'''(?:property|name)\s*=\s*["'](?:og:image|twitter:image(?::src)?)["']''', tag, re.I):
            continue
        content = re.search(r'''content\s*=\s*["']([^"']+)["']''', tag, re.I)
        if not content:
            continue
        url = html.unescape(content[1]).replace("\\/", "/")
        parts = urllib.parse.urlsplit(url)
        if parts.scheme == "https" and parts.hostname:
            return url
    # CarGurus preloads the lead image instead of consistently emitting og:image
    # to non-browser clients. Limit the fallback to its public vehicle-photo CDN.
    cargurus = re.search(r'''https://static\.cargurus\.com/images/forsale/[^"'<>\s]+''', page.replace("\\/", "/"), re.I)
    if cargurus:
        return html.unescape(cargurus[0]).replace("\\/", "/")
    return ""


def listing_detail_url(row):
    if row.get("source") == "cargurus" and row.get("source_listing_id"):
        return f'https://www.cargurus.com/details/{row["source_listing_id"]}'
    return row.get("listing_url", "")


def add_listing_photo(row, fetcher, browser_fetcher=None):
    """Add a source gallery where available, preserving a usable lead-photo fallback."""
    url = listing_detail_url(row)
    if not url:
        return "listing URL unavailable"
    page = ""
    plain_error = ""
    try:
        page = fetcher.get(url)
    except Exception as error:
        plain_error = str(error)
    if page and row.get("source") == "cargurus":
        row.update(cargurus_condition_claims(page))
    if row.get("source") == "cargurus" and browser_fetcher is not None and not row.get("photo_url"):
        description = browser_fetcher.description(url)
        if description:
            row.update(condition_claims([description]))
    if len(row.get("photo_urls") or []) > 1:
        return ""
    if page and row.get("source") in {"cargurus", "truecar"}:
        photos = gallery_urls_in_page(page, row["source"], row.get("photo_url", ""), row.get("vin", ""))
        print("Listing HTML gallery:", row["source"], row["source_listing_id"], len(photos))
        if len(photos) > 1:
            row["photo_urls"] = photos
            row["photo_url"] = photos[0]
            return ""
    if row.get("photo_url"):
        row["photo_urls"] = [row["photo_url"]]
        return ""
    photo = parse_listing_photo(page) if page else ""
    if not photo and row.get("source") == "cargurus" and browser_fetcher is not None:
        photo = browser_fetcher.photo(url)
    if not photo:
        if browser_fetcher is not None and row.get("source") == "cargurus":
            return browser_fetcher.error(url)
        return plain_error or "lead photo metadata unavailable"
    row["photo_url"] = photo
    row["photo_urls"] = [photo]
    return ""


def backfill_listing_photos(state, fetcher, browser_fetcher=None):
    """Fetch photos for existing public rows, including completed auctions."""
    errors = []
    for row in state.get("listings", {}).values():
        if (row.get("source") not in {"cargurus", "truecar", "bringatrailer"}
                or row.get("status") not in {"active", "sold", "ended"}
                or not clean_title_candidate(row)):
            continue
        if len(row.get("photo_urls") or []) > 1 or (row.get("source") == "bringatrailer" and row.get("photo_url")):
            continue
        error = add_listing_photo(row, fetcher, browser_fetcher)
        if error:
            errors.append(f'{row.get("listing_key", "listing")}: {error}')
    return errors


def parse_bat(page, url, now):
    title_match = re.search(r'<h1\b[^>]*>(.*?)</h1>', page, re.S)
    title = plain(title_match[1]) if title_match else ""
    match = re.search(r"\b(2006|2007|201[1-6]) (Lexus LX\s?(?:470|570)|Toyota Land Cruiser)\b", title, re.I)
    if not match:
        raise ValueError("Not a supported LX470, LX570 or Land Cruiser auction")
    # Limit extraction to the listing summary, never site strings or user comments.
    intro = re.search(r'<div class="listing-intro[\s\S]*', page)
    if not intro:
        raise ValueError("Auction summary missing")
    summary_html = intro[0].split('class="listing-actions-stats"')[0]
    text = plain(summary_html)
    details = re.search(r'<strong>Listing Details</strong>\s*<ul>(.*?)</ul>', page, re.S)
    details_text = plain(details[1]) if details else text
    detail_items = [plain(item) for item in re.findall(r'<li\b[^>]*>(.*?)</li>', details[1], re.S)] if details else []
    excerpt = re.search(r'<div class="post-excerpt"[^>]*>(.*?)</div>', page, re.S)
    excerpt_text = plain(excerpt[1]) if excerpt else ""
    narrative = ListingParagraphs("post-excerpt")
    narrative.feed(page)
    vin = re.search(r"Chassis:\s*([A-HJ-NPR-Z0-9]{17})", details_text)
    miles = re.search(r"\b([\d,.]+)(k)? Miles\b", details_text, re.I)
    current = re.search(r"Current Bid:\s*(?:USD\s*)?\$([\d,]+)", text)
    ended_bid = re.search(r"Bid to\s*(?:USD\s*)?\$([\d,]+)", text, re.I)
    sold = re.search(r"Sold for\s*(?:USD\s*)?\$([\d,]+)", text)
    end = re.search(r'data-until="(\d+)"', summary_html)
    ends_at = datetime.fromtimestamp(int(end[1]), timezone.utc).isoformat() if end else ""
    if sold:
        status = "sold"
    elif current and ends_at:
        status = "active" if datetime.fromisoformat(ends_at) > datetime.fromisoformat(now) else "ended"
    elif re.search(r"Bid to\s*(?:USD\s*)?\$|Reserve not met|Auction ended", text, re.I):
        status = "ended"
    else:
        status = "unknown"
    exterior_item = next((item for item in detail_items if item.endswith(" Paint")), "")
    interior_item = next((item for item in detail_items if item.endswith(" Upholstery")), "")
    clean_title = re.search(r"\bclean(?: [A-Za-z]+){0,3} title\b", excerpt_text, re.I)
    accident_free = re.search(r"\baccident-free (?:Carfax|AutoCheck)(?: report)?\b", excerpt_text, re.I)
    disclosed_accident = re.search(r"\b(?:seller[^.]{0,100})?(?:involved in|has|had) an accident\b", excerpt_text, re.I)
    if accident_free and disclosed_accident:
        accidents = "No accident on history report; seller discloses prior accident"
    elif accident_free:
        accidents = "No reported accidents"
    elif disclosed_accident:
        accidents = "Seller discloses prior accident"
    else:
        accidents = "History unavailable"
    row = {"source": "bringatrailer", "source_listing_id": url.rstrip('/').split('/')[-1],
           "year": int(match[1]), "make": "Toyota" if match[2].lower().startswith("toyota") else "Lexus",
           "model": "Land Cruiser" if match[2].lower().startswith("toyota") else "LX570" if "570" in match[2] else "LX470", "listing_url": url, "vin": vin[1] if vin else "",
           "category": "auction", "status": status,
           "current_bid": (current or ended_bid)[1] if (current or ended_bid) and not sold else None,
           "sold_price": sold[1] if sold else None, "auction_ends_at": ends_at,
           "bid_observed_at": now if (current or ended_bid) and not sold else "",
           "mileage": number(miles[1]) * (1000 if miles[2] else 1) if miles else None,
           "mileage_is_approximate": bool(miles and miles[2]),
           "seller_type": "private" if "Private Party or Dealer : Private Party" in text else "unknown",
           "exterior_color": exterior_item.removesuffix(" Paint"),
           "interior_color": interior_item.removesuffix(" Upholstery"),
           "photo_url": parse_listing_photo(page),
           "title_status": "clean title" if clean_title else "unknown",
           "accident_history": accidents,
           "owners": "Unknown",
           "notes": "Auction bid excludes buyer fees. Rounded mileage is approximate. Clean-title eligibility requires explicit listing text and still needs verification against the physical title and NMVTIS/CARFAX."}
    row.update(condition_claims(narrative.paragraphs))
    return normalize(row)


def bat_sale_date(page):
    """Extract the completed-auction date as YYYY-MM-DD."""
    decoded = html.unescape(page)
    month = r"(?:January|February|March|April|May|June|July|August|September|October|November|December)"
    full_date = rf"({month}\s+\d{{1,2}},\s+20\d{{2}})"
    # Auction pages often mention older service dates before the result. Only
    # accept a long-form date when it is attached to the completed-sale text.
    for pattern in (
        rf"This\s+Listing\s+Sold[\s\S]{{0,240}}?\b{full_date}\b",
        rf"\bSold\s+for[\s\S]{{0,160}}?\bon\s+{full_date}\b",
        rf"<title[^>]*>[\s\S]{{0,300}}?\b(?:sold|auction result)[\s\S]{{0,180}}?\b{full_date}\b",
    ):
        match = re.search(pattern, decoded, re.I)
        if match:
            return datetime.strptime(match[1].title(), "%B %d, %Y").date().isoformat()
    match = re.search(r"Sold for[^<]{0,80}\bon\s+(\d{1,2})/(\d{1,2})/(\d{2,4})", decoded, re.I)
    if match:
        year = int(match[3]) + (2000 if len(match[3]) == 2 else 0)
        return f"{year:04d}-{int(match[1]):02d}-{int(match[2]):02d}"
    return ""


def parse_historical_sale(page, url, now):
    """Return the small, auditable record used for market-price statistics."""
    row = parse_bat(page, url, now)
    sold_at = bat_sale_date(page)
    if row["status"] != "sold" or row["sold_price"] is None:
        raise ValueError("Auction did not record a completed sale")
    if row["mileage"] is None:
        raise ValueError("Completed sale did not expose mileage")
    if not sold_at:
        raise ValueError("Completed sale date unavailable")
    return {
        "source": "Bring a Trailer", "source_listing_id": row["source_listing_id"],
        "listing_url": url, "year": row["year"], "make": row["make"], "model": row["model"], "sold_at": sold_at,
        "sale_price": row["sold_price"], "mileage": row["mileage"],
        "mileage_is_approximate": row["mileage_is_approximate"],
    }


def bat_listing_urls(page):
    """Discover 2006-2007 listing links in the public BaT model archive."""
    paths = re.findall(r'''href=["'](?:https://bringatrailer\.com)?(/listing/(?:200[67]-(?:lexus-lx-?470|toyota-land-cruiser)|201[1-6]-lexus-lx-?570)[^"'?#]*/)["']''', page, re.I)
    absolute = re.findall(r'''https://bringatrailer\.com/listing/(?:200[67]-(?:lexus-lx-?470|toyota-land-cruiser)|201[1-6]-lexus-lx-?570)[^\s"'<>?#]*/''', page, re.I)
    return {"https://bringatrailer.com" + path for path in paths} | set(absolute)


def collect_historical_sales(root, state, fetcher, archive_page, now):
    """Backfill the two-year seed once, then add newly discovered completed sales."""
    seed = json.loads((root / "sources/historical_sales.json").read_text(encoding="utf-8"))
    existing = {row["listing_url"]: row for row in state.setdefault("historical_sales", [])}
    candidates = set(seed.get("listing_urls", [])) | bat_listing_urls(archive_page)
    errors = []
    for url in sorted(candidates - existing.keys()):
        try:
            sale = parse_historical_sale(fetcher.get(url), url, now)
            existing[url] = sale
        except Exception as error:
            errors.append(f"{url}: {error}")
    state["historical_sales"] = sorted(existing.values(), key=lambda row: (row["sold_at"], row["listing_url"]), reverse=True)
    return len(candidates), errors


def clean_title_candidate(row):
    return row.get("title_status") in {"clean-title candidate", "clean title"}


def inventory_candidate(row):
    """Include labeled Auto.dev unknown-title observations, never branded titles."""
    return clean_title_candidate(row) or (row.get("source") == "autodev"
        and row.get("title_status") == "unknown" and valid_vin(row.get("vin", ""))
        and "vin_model_or_year_conflict" not in row.get("quality_flags", ""))


def deal_rating(row, sales, minimum_comparables=3):
    """Compare a retail asking price with the median sale in its mileage band."""
    if (row.get("source") == "autodev" and not clean_title_candidate(row)
            or row.get("status") != "active" or row.get("category") != "retail"
            or not isinstance(row.get("asking_price"), (int, float))
            or not isinstance(row.get("mileage"), (int, float))):
        return {}
    miles = row["mileage"]
    if miles < 100_000:
        label, includes = "Under 100k", lambda value: value < 100_000
    elif miles < 150_000:
        label, includes = "100k-150k", lambda value: 100_000 <= value < 150_000
    elif miles < 250_000:
        label, includes = "150k-250k", lambda value: 150_000 <= value < 250_000
    else:
        label, includes = "250k+", lambda value: value >= 250_000
    prices = [sale.get("sale_price") for sale in sales
              if sale.get("model", "LX470") == row.get("model", "LX470")
              and isinstance(sale.get("mileage"), (int, float)) and includes(sale["mileage"])
              and isinstance(sale.get("sale_price"), (int, float))]
    if len(prices) < minimum_comparables:
        return {}
    baseline = median(prices)
    difference = round(((row["asking_price"] - baseline) / baseline) * 100)
    quality = "great" if difference <= -15 else "fair" if difference <= 15 else "bad"
    return {
        "deal_quality": quality,
        "deal_percent_vs_median": difference,
        "deal_comparable_count": len(prices),
        "deal_median_price": baseline,
        "deal_mileage_band": label,
    }


def remove_unverified_cargurus_owner_inferences(state):
    """Discard owner counts inferred from a search filter instead of listing evidence."""
    for row in list(state.get("listings", {}).values()) + list(state.get("history", [])):
        if row.get("source") == "cargurus":
            row["owners"] = "Unverified"
            row["owners_source"] = ""
            row["owners_verified_at"] = ""
            row["owner_evidence_url"] = ""


def apply_vehicle_history_overrides(root, state):
    """Apply human-verified history facts that search-result feeds do not expose."""
    path = root / "overrides/vehicle_history.json"
    if not path.exists():
        return
    overrides = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(overrides, dict):
        raise ValueError("Vehicle-history overrides must be an object keyed by VIN")
    for vin, evidence in overrides.items():
        vin = str(vin).upper().strip()
        owners = evidence.get("owners")
        verified_at = str(evidence.get("verified_at", ""))
        source = str(evidence.get("source", ""))
        evidence_url = str(evidence.get("evidence_url", ""))
        parts = urllib.parse.urlsplit(evidence_url)
        if not valid_vin(vin) or not isinstance(owners, int) or not 1 <= owners <= 20:
            raise ValueError(f"Invalid owner-count override for {vin}")
        if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", verified_at) or not source:
            raise ValueError(f"Owner-count override for {vin} needs source and YYYY-MM-DD verified_at")
        if parts.scheme != "https" or not parts.hostname:
            raise ValueError(f"Owner-count override for {vin} needs an HTTPS evidence URL")
        for row in state.get("listings", {}).values():
            if row.get("vin") == vin:
                row["owners"] = str(owners)
                row["owners_source"] = source
                row["owners_verified_at"] = verified_at
                row["owner_evidence_url"] = evidence_url


def update(state, rows, now, scopes=()):
    listings = state.setdefault("listings", {})
    history = state.setdefault("history", [])
    seen = set()
    changes = []
    for raw in rows:
        row = normalize(raw)
        key = row["listing_key"]
        if key in seen:
            continue
        seen.add(key)
        previous = listings.get(key)
        row["first_seen"] = previous["first_seen"] if previous else now
        if not row["photo_url"] and previous and previous.get("photo_url"):
            row["photo_url"] = previous["photo_url"]
        if previous and len(previous.get("photo_urls") or []) > len(row.get("photo_urls") or []):
            row["photo_urls"] = previous["photo_urls"]
        if previous and previous.get("listing_url") == row["listing_url"]:
            for topic in CONDITION_TOPICS:
                if not row.get(f"{topic}_evidence") and previous.get(f"{topic}_evidence"):
                    row[f"{topic}_status"] = previous[f"{topic}_status"]
                    row[f"{topic}_evidence"] = previous[f"{topic}_evidence"]
        if not row["listed_at"]:
            if previous and previous.get("listed_at"):
                row["listed_at"] = previous["listed_at"]
                row["listed_at_is_estimated"] = bool(previous.get("listed_at_is_estimated"))
            else:
                row["listed_at"] = inferred_listed_at(row, now)
                row["listed_at_is_estimated"] = bool(row["listed_at"])
        row["last_seen"] = now
        row["last_checked"] = now
        row["missing_checks"] = 0
        if previous and previous["vehicle_key"] != row["vehicle_key"] and previous.get("vin"):
            row["quality_flags"] += ";listing_vin_changed"
        if previous and row["mileage"] is not None and previous.get("mileage") is not None and row["mileage"] < previous["mileage"]:
            row["quality_flags"] += ";mileage_decreased"
        if previous:
            persistent = set(previous.get("quality_flags", "").split(";")) & {"mileage_decreased", "listing_vin_changed"}
            row["quality_flags"] = ";".join(sorted(set(filter(None, row["quality_flags"].split(";"))) | persistent))
        compare_keys = [k for k in FIELDS if k not in {"first_seen", "last_seen", "last_checked", "missing_checks", "source_days_on_market", "listed_at", "listed_at_is_estimated", "bid_observed_at"}]
        changed = not previous or any(previous.get(k) != row.get(k) for k in compare_keys)
        listings[key] = row
        if changed:
            event = "new" if not previous else "reappeared" if previous["status"] in {"removed", "sold", "ended"} and row["status"] == "active" else "updated"
            observation = {"observed_at": now, "event": event, **row}
            history.append(observation)
            changes.append(observation)
    # Missing != sold. Only fully parsed nationwide snapshots count as absence evidence.
    for scope in scopes:
        source, year = scope[:2]
        model = scope[2] if len(scope) == 3 else "LX470"
        for key, row in listings.items():
            if key in seen or row["source"] != source or row["year"] != year or row.get("model", "LX470") != model or row["status"] != "active":
                continue
            row["last_checked"] = now
            row["missing_checks"] = int(row.get("missing_checks", 0)) + 1
            if row["missing_checks"] >= 3:
                row["status"] = "removed"
                event = {"observed_at": now, "event": "removed", **row}
                history.append(event)
                changes.append(event)
    state["updated_at"] = now
    return changes


def asking_price_history(state, row):
    """Return distinct, dated retail asking prices for this exact source listing."""
    if row.get("category") != "retail":
        return []
    matching = sorted((event for event in state.get("history", [])
                       if event.get("listing_key") == row.get("listing_key")
                       and event.get("listing_url") == row.get("listing_url")
                       and event.get("model", "LX470") == row.get("model", "LX470")
                       and event.get("year") == row.get("year")
                       and isinstance(event.get("asking_price"), (int, float))
                       and not isinstance(event.get("asking_price"), bool)
                       and event["asking_price"] > 0
                       and event.get("observed_at")),
                      key=lambda event: event["observed_at"])
    prices = []
    for event in matching:
        if not prices or prices[-1]["asking_price"] != event["asking_price"]:
            prices.append({"observed_at": event["observed_at"], "asking_price": event["asking_price"]})
    return prices


def expire_unrefreshed_observations(state, now, changes):
    """One-time regional/dealer observations cannot advertise a truck indefinitely."""
    cutoff = datetime.fromisoformat(now) - timedelta(days=7)
    for row in state.get("listings", {}).values():
        if row.get("source") not in {"ksl", "bypex", "autodev", "carsandbids"} or row.get("status") != "active":
            continue
        last_seen = row.get("last_seen")
        if last_seen and datetime.fromisoformat(last_seen) < cutoff:
            row["status"] = "unknown"
            event = {"observed_at": now, "event": "stale", **row}
            state.setdefault("history", []).append(event)
            changes.append(event)


def csv_text(rows, fields):
    buf = io.StringIO(newline="")
    writer = csv.DictWriter(buf, fields, extrasaction="ignore", lineterminator="\n")
    writer.writeheader()
    for row in rows:
        # Prevent formula execution when downloaded CSVs are opened in spreadsheets.
        writer.writerow({k: "'" + v if isinstance(v, str) and v.startswith(("=", "+", "-", "@")) else v for k, v in row.items() if k in fields})
    return buf.getvalue()


def master_rows(state):
    groups = {}
    for row in state["listings"].values():
        groups.setdefault(row["vehicle_key"], []).append(row)
    result = []
    for key, rows in sorted(groups.items()):
        active = [r for r in rows if r["status"] == "active"]
        chosen = max(active or rows, key=lambda r: (r["last_seen"], r["listing_key"]))
        flags = set(filter(None, ";".join(r["quality_flags"] for r in rows).split(";")))
        miles = [r["mileage"] for r in active if r["mileage"] is not None]
        if len(miles) > 1 and max(miles) - min(miles) > 1000:
            flags.add("cross_source_mileage_conflict")
        result.append({**chosen, "first_seen": min(r["first_seen"] for r in rows),
                       "quality_flags": ";".join(sorted(flags)), "listing_count": len(rows),
                       "sources": ";".join(sorted({r["source"] for r in rows})),
                       "listing_urls": ";".join(sorted({r["listing_url"] for r in rows}))})
    return result


def merge_public_listings(rows):
    """Index public listings by validated VIN without discarding source records."""
    groups = {}
    for row in rows:
        key = row.get("vehicle_key") or "listing:" + row["listing_key"]
        groups.setdefault(key, []).append(row)
    return [{"vehicle_key": key,
             "vin": listings[0].get("vin", "") if key.startswith("vin:") else "",
             "listing_keys": sorted(row["listing_key"] for row in listings),
             "listing_count": len(listings),
             "sources": sorted({row["source"] for row in listings})}
            for key, listings in sorted(groups.items())]


RUST_CHECK_STATES = {
    "MI": "Michigan", "NY": "New York", "OH": "Ohio", "WI": "Wisconsin",
    "PA": "Pennsylvania", "MN": "Minnesota", "MA": "Massachusetts",
    "CT": "Connecticut", "RI": "Rhode Island", "NH": "New Hampshire",
    "VT": "Vermont", "ME": "Maine", "IL": "Illinois", "IN": "Indiana",
    "IA": "Iowa",
}


def rust_check_state(value):
    location = str(value or "").strip().upper()
    if location in RUST_CHECK_STATES:
        return location
    return next((code for code, name in RUST_CHECK_STATES.items() if name.upper() == location), "")


def rust_location_evidence(row, state):
    """Report observed marketplace locations, not registration history or rust condition."""
    vehicle_key = row.get("vehicle_key", "")
    listing_key = row.get("listing_key", "")

    def same_truck(other):
        # Only validated VINs may link different marketplace listings.
        return (other.get("vehicle_key") == vehicle_key if vehicle_key.startswith("vin:")
                else other.get("listing_key") == listing_key)

    matches = [other for other in state.get("listings", {}).values() if same_truck(other)]
    active_states = {code for other in matches if other.get("status") == "active"
                     if (code := rust_check_state(other.get("state")))}
    current = rust_check_state(row.get("state")) if row.get("status") == "active" else ""
    also = sorted(active_states - {current}) if row.get("status") == "active" else []
    previous = {code for other in matches if other.get("status") != "active"
                if (code := rust_check_state(other.get("state")))}
    previous.update(code for observation in state.get("history", [])
                    if same_truck(observation) and observation.get("event") != "removed"
                    if (code := rust_check_state(observation.get("state"))))
    previous -= active_states
    return {"current_state": current, "also_listed_states": also,
            "previously_listed_states": sorted(previous)}


def cache_public_photos(root, rows, opener=urllib.request.urlopen):
    """Serve TrueCar gallery photos locally when its CDN blocks embedded images."""
    folder = root / "web/photos"
    folder.mkdir(parents=True, exist_ok=True)
    for row in rows:
        if row.get("source") != "truecar":
            continue
        urls = [row.get("photo_url", ""), *(row.get("photo_urls") or [])]
        saved, seen_paths = [], set()
        for url in urls:
            parts = urllib.parse.urlsplit(url)
            if (parts.scheme != "https" or parts.hostname != "listings-prod.tcimg.net"
                    or not parts.path.endswith(".jpg") or parts.path in seen_paths):
                continue
            seen_paths.add(parts.path)
            filename = hashlib.sha256(parts.path.encode()).hexdigest()[:20] + ".jpg"
            target = folder / filename
            if not target.exists():
                image_url = urllib.parse.urlunsplit(parts._replace(query="h=675&w=1200"))
                request = urllib.request.Request(image_url, headers={"User-Agent": UA, "Accept": "image/jpeg"})
                try:
                    with opener(request, timeout=20) as response:
                        image = response.read(2_000_001)
                    if len(image) > 2_000_000 or not image.startswith(b"\xff\xd8\xff"):
                        continue
                    target.write_bytes(image)
                except Exception as error:
                    print("Photo cache unavailable:", row.get("source_listing_id"), type(error).__name__)
                    continue
            saved.append("photos/" + filename)
            if len(saved) == 8:
                break
        if saved:
            row["photo_url"] = saved[0]
            row["photo_urls"] = saved


def load_location_points():
    """Read Census representative points; no live geocoding or map account needed."""
    with zipfile.ZipFile(ROOT / "sources" / "gazetteer" / "places.zip") as archive:
        filename = next(name for name in archive.namelist() if name.endswith(".txt"))
        rows = csv.DictReader(io.TextIOWrapper(archive.open(filename), encoding="utf-8"), delimiter="|")
        places = {}
        for row in rows:
            name = re.sub(r" (city|town|village|CDP|borough|municipality|balance|urban county)$", "", row["NAME"], flags=re.I)
            key = (row["USPS"], name.casefold())
            if key not in places or row["FUNCSTAT"] == "A":
                places[key] = [float(row["INTPTLAT"]), float(row["INTPTLONG"])]
    zips = json.loads((ROOT / "web" / "zip-centroids.json").read_text(encoding="utf-8"))
    return places, zips


def listing_coordinates(row, places, zips):
    """Prefer a dealer ZIP area; otherwise use the advertised city reference point."""
    postal_code = str(row.get("postal_code") or "")
    point = zips.get(postal_code) if re.fullmatch(r"\d{5}", postal_code) else None
    precision = "ZIP area" if point else ""
    if not point:
        point = places.get((str(row.get("state") or "").upper(), str(row.get("city") or "").casefold()))
        precision = "city area" if point else ""
    return {"latitude": point[0] if point else None,
            "longitude": point[1] if point else None,
            "location_precision": precision}


def save(root, state, health, changes, cache_photos=False):
    data = root / "data"
    data.mkdir(parents=True, exist_ok=True)
    web = root / "web"
    web.mkdir(parents=True, exist_ok=True)
    rows = sorted(state["listings"].values(), key=lambda r: r["listing_key"])
    active = [r for r in rows if r["status"] == "active" and inventory_candidate(r)]
    excluded = [r for r in rows if r["status"] == "active" and not inventory_candidate(r)]
    outputs = {"listings.csv": rows, "active_listings.csv": active,
               "excluded_listings.csv": excluded,
               "retail_listings.csv": [r for r in active if r["category"] == "retail"],
               "auction_salvage_listings.csv": [r for r in active if r["category"] != "retail"],
               "sold_listings.csv": [r for r in rows if r["status"] == "sold"]}
    for filename, items in outputs.items():
        (data / filename).write_text(csv_text(items, FIELDS), encoding="utf-8")
    sale_fields = ["source", "source_listing_id", "listing_url", "year", "make", "model", "sold_at", "sale_price", "mileage", "mileage_is_approximate"]
    historical_sales = state.get("historical_sales", [])
    (data / "historical_sales.csv").write_text(csv_text(historical_sales, sale_fields), encoding="utf-8")
    (data / "historical_sales.json").write_text(json.dumps(historical_sales, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    eligible_keys = {r["vehicle_key"] for r in active}
    master = [r for r in master_rows(state) if r["vehicle_key"] in eligible_keys]
    (data / "lx470_master.csv").write_text(csv_text(master, FIELDS + ["listing_count", "sources", "listing_urls"]), encoding="utf-8")
    (data / "listing_history.csv").write_text(csv_text(state["history"], ["observed_at", "event"] + FIELDS), encoding="utf-8")
    for filename, obj in [("database.json", state), ("source_health.json", health), ("latest_changes.json", changes)]:
        temp = data / (filename + ".tmp")
        temp.write_text(json.dumps(obj, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
        temp.replace(data / filename)
    public_fields = [
        "listing_key", "vehicle_key", "vin", "year", "make", "model", "source", "listing_url", "status", "category",
        "asking_price", "base_price", "current_bid", "sold_price", "currency", "mileage",
        "mileage_is_approximate", "city", "state", "postal_code", "latitude", "longitude", "location_precision",
        "seller", "seller_type", "photo_url", "photo_urls",
        "exterior_color", "interior_color", "reported_extras", "title_status", "accident_history", "accident_category",
        "owners", "owners_source", "owners_verified_at", "owner_evidence_url",
        "timing_belt_status", "timing_belt_evidence", "ahc_status", "ahc_evidence",
        "rust_status", "rust_evidence", "navigation_status", "navigation_evidence",
        "service_records_status", "service_records_evidence",
        "modifications_status", "modifications_evidence",
        "auction_ends_at", "bid_observed_at", "listed_at", "listed_at_is_estimated", "first_seen", "last_seen", "last_checked", "missing_checks", "quality_flags",
        "deal_quality", "deal_percent_vs_median", "deal_comparable_count", "deal_median_price", "deal_mileage_band",
        "rust_location", "price_history",
    ]
    public_rows = [r for r in rows if inventory_candidate(r) and r["status"] in {"active", "sold", "ended"}]
    cutoff = (datetime.fromisoformat(state["updated_at"]) - timedelta(days=731)).date().isoformat()
    public_sales = [row for row in historical_sales if row.get("sold_at", "") >= cutoff]
    public_rows = [{**row, **deal_rating(row, public_sales),
                    "accident_category": accident_category(row.get("accident_history")),
                    "rust_location": rust_location_evidence(row, state),
                    "price_history": asking_price_history(state, row)} for row in public_rows]
    places, zips = load_location_points()
    public_rows = [{**row, **listing_coordinates(row, places, zips)} for row in public_rows]
    if cache_photos:
        cache_public_photos(root, public_rows)
    public_vehicles = merge_public_listings(public_rows)
    public_inventory = {
        "generated_at": state["updated_at"],
        "disclaimer": "Inventory includes screened candidates and Auto.dev listings labeled Title unverified. Verify title and independent history before purchase.",
        "summary": {
            "vehicles": len(master),
            "visible_vehicles": len(public_vehicles),
            "active_listings": len(active),
            "retail": sum(r["category"] == "retail" for r in active),
            "auctions": sum(r["category"] != "retail" for r in active),
            "sold": sum(r["status"] == "sold" for r in public_rows),
            "ended_auctions": sum(r["status"] == "ended" and r["category"] == "auction" for r in public_rows),
        },
        "source_health": health,
        "market_history": {
            "source": "Bring a Trailer completed auctions",
            "window_months": 24,
            "sales": public_sales,
        },
        "listings": [{key: row.get(key) for key in public_fields} for row in public_rows],
        "vehicles": public_vehicles,
    }
    temp = web / "inventory.json.tmp"
    temp.write_text(json.dumps(public_inventory, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    temp.replace(web / "inventory.json")
    report = ["# LX470, LX570 and Land Cruiser inventory", "", f"Last run: {state['updated_at']}", "",
              f"**{len(master)} distinct vehicles Â· {len(outputs['active_listings.csv'])} active listings Â· {len(changes)} changes this run**", "",
              "Only clean-title candidates appear below. CarGurus candidates have no reported salvage, lemon, frame-damage or theft history; this is not an official title guarantee. Verify NMVTIS/CARFAX and the physical title before purchase. Active means seen advertised at last_seen, not seller-confirmed availability.", "",
              "## Source health", "", "| Source | Result | Detail |", "|---|---|---|"]
    escape = lambda v: html.escape(str(v or "")).replace("|", "&#124;").replace("\n", " ")
    for source in health:
        report.append(f"| {escape(source['source'])} | {escape(source['status'])} | {escape(source.get('detail', ''))} |")
    report += ["", "## Advertised retail listings", "", "| Year | Make | Model | Asking USD | Miles | Exterior | Interior | Owners | Accidents | Title screen | Location | Seller | VIN | Last seen | Listing |", "|---|---|---|---:|---:|---|---|---|---|---|---|---|---|---|---|"]
    for row in sorted(outputs["retail_listings.csv"], key=lambda r: r["asking_price"] if r["asking_price"] is not None else float('inf')):
        report.append("| " + " | ".join(escape(row[k]) for k in ["year", "make", "model", "asking_price", "mileage", "exterior_color", "interior_color", "owners", "accident_history", "title_status"]) + f" | {escape(row['city'])}, {escape(row['state'])} | {escape(row['seller'])} | {escape(row['vin'])} | {escape(row['last_seen'])} | [Open]({row['listing_url']}) |")
    report += ["", "## Auctions and salvage", "", "| Year | Make | Model | Status | Current bid USD | Sold price USD | Miles | Exterior | Interior | Owners | Accidents | Title | VIN | Listing |", "|---|---|---|---|---:|---:|---:|---|---|---|---|---|---|---|"]
    for row in outputs["auction_salvage_listings.csv"]:
        report.append("| " + " | ".join(escape(row[k]) for k in ["year", "make", "model", "status", "current_bid", "sold_price", "mileage", "exterior_color", "interior_color", "owners", "accident_history", "title_status", "vin"]) + f" | [Open]({row['listing_url']}) |")
    report += ["", f"{len(excluded)} active listings are retained for audit but excluded because clean-title eligibility was not established. See `data/excluded_listings.csv`."]
    (root / "INVENTORY.md").write_text("\n".join(report) + "\n", encoding="utf-8")


def run(root=ROOT, live=True):
    path = root / "data/database.json"
    state = json.loads(path.read_text(encoding="utf-8")) if path.exists() else {"version": 1, "listings": {}, "history": [], "imports": []}
    for row in list(state.get("listings", {}).values()) + state.get("history", []) + state.get("historical_sales", []):
        row.setdefault("make", "Lexus")
        row.setdefault("model", "LX470")
    backfill_listing_dates(state)
    correct_ambiguous_accident_history(state)
    remove_unverified_cargurus_owner_inferences(state)
    now, rows, scopes, health = utcnow(), [], [], []
    config = json.loads((root / "sources/config.json").read_text(encoding="utf-8"))
    fetcher = Fetcher()
    photo_browser = BrowserPhotoFetcher() if live else None
    photo_backfill_errors = backfill_listing_photos(state, fetcher, photo_browser) if live else []
    if live:
        for source in config["sources"]:
            if not source["enabled"]:
                health.append({"source": source["id"], "status": source.get("status", "manual_only"), "detail": source["reason"]})
                continue
            try:
                if source["type"] == "cargurus":
                    model = source.get("model", "LX470")
                    (batch, complete, total), retried, history_warning = collect_cargurus_with_history(fetcher, source)
                    photo_errors = [error for row in batch if (error := add_listing_photo(row, fetcher, photo_browser))]
                    rows.extend(batch)
                    if complete:
                        scopes.append(("cargurus", source["year"], source.get("model", "LX470")))
                    photo_note = f" First photo error: {photo_errors[0]}" if photo_errors else ""
                    retry_note = " Search recovered on retry." if retried else ""
                    health.append({"source": source["id"], "status": ("warning" if history_warning else "ok") if complete else "partial", "detail": f"{len(batch)} parsed of {total}; {len(batch)-len(photo_errors)} photos found; nationwide; {'all result pages checked' if complete else 'search incomplete after retry'}.{retry_note}{photo_note}{history_warning}"})
                elif source["type"] == "truecar":
                    (batch, complete, total), search_retries = retry_search(fetcher,
                        lambda: collect_truecar(fetcher, source["url"], now, source.get("model", "LX470")), source["id"])
                    photo_errors = [error for row in batch if (error := add_listing_photo(row, fetcher, photo_browser))]
                    rows.extend(batch)
                    if complete:
                        scopes.extend(("truecar", year, source.get("model", "LX470")) for year in MODEL_YEARS[source.get("model", "LX470")])
                    health.append({"source": source["id"], "status": "ok" if complete else "partial",
                                   "detail": f"{len(batch)} clean-title listings parsed of {total}; nationwide. {len(batch)-len(photo_errors)} galleries or lead photos found. {'Search recovered on retry. ' if search_retries and complete else 'Search incomplete after retry. ' if not complete else ''}Owner and accident counts are source-reported from Experian AutoCheck."})
                elif source["type"] == "autodev":
                    from autodev import Client, collect
                    key = os.environ.get("AUTODEV_API_KEY", "")
                    if not key:
                        health.append({"source": source["id"], "status": "setup_required", "detail": "Auto.dev API key is not configured; no automatic coverage yet."})
                        continue
                    batch, result = collect(Client(key), state, now)
                    for row in batch:
                        try:
                            rows.append(normalize(row))
                        except (ValueError, TypeError):
                            result["status"] = "partial"
                            result["detail"] += " One listing failed validation."
                    health.append({"source": source["id"], **result})
                elif source["type"] == "carsandbids":
                    from carsandbids import Collector
                    collector = Collector()
                    try:
                        batch, errors = collector.collect(list(state["listings"].values()), now)
                        rows.extend(normalize(row) for row in batch)
                    finally:
                        collector.close()
                    health.append({"source": source["id"], "status": "partial" if errors else "ok",
                                   "detail": f"{len(batch)} auction observations; {sum(r['status'] == 'active' for r in batch)} active matching auctions. Rendered model searches plus recent results; not a complete archive. Search absence never establishes removal. " + "; ".join(errors[:3])})
                elif source["type"] == "ksl":
                    batch, candidates, errors = collect_ksl(fetcher, source["url"], source["make"])
                    rows.extend(batch)
                    detail = (f"{len(batch)} clean-title listings from {candidates} matching search cards; "
                              "regional KSL coverage. Search-page snapshots do not establish removals.")
                    if errors:
                        detail += f" {len(errors)} listing pages unavailable; first error: {errors[0]}"
                    health.append({"source": source["id"], "status": "partial" if errors else "ok", "detail": detail})
                elif source["type"] == "bringatrailer":
                    page = fetcher.get(source["url"])
                    urls = bat_listing_urls(page)
                    urls.update(r["listing_url"] for r in state["listings"].values()
                                if r["source"] == "bringatrailer" and r.get("model", "LX470") == source.get("model", "LX470") and
                                (r["status"] in {"active", "unknown"} or
                                 (r["status"] in {"sold", "ended"} and
                                  not any(r.get(f"{topic}_evidence") for topic in CONDITION_TOPICS))))
                    if "listing" not in page or not re.search(r"Land Cruiser" if source.get("model") == "Land Cruiser" else r"LX\s?570" if source.get("model") == "LX570" else r"LX\s?470", page, re.I):
                        raise ValueError("Auction index format changed")
                    errors = []
                    for url in sorted(urls)[:30]:
                        try:
                            rows.append(parse_bat(fetcher.get(url), url, now))
                        except Exception as e:
                            errors.append(f"{url}: {e}")
                    health.append({"source": source["id"], "status": "partial" if errors or len(urls) > 30 else "ok", "detail": f"{min(len(urls),30)-len(errors)} auction pages parsed. Index coverage only; not a complete auction archive. " + "; ".join(errors)})
                    sale_candidates, sale_errors = collect_historical_sales(root, state, fetcher, page, now)
                    detail = f"{len(state['historical_sales'])} completed sales retained from {sale_candidates} discovered or seeded auctions."
                    if sale_errors:
                        detail += f" {len(sale_errors)} records unavailable; first error: {sale_errors[0]}"
                    health.append({"source": "historical sales" + (" - " + source["model"] if source.get("model") else ""), "status": "warning" if sale_errors else "ok", "detail": detail})
            except Exception as e:
                health.append({"source": source["id"], "status": "error", "detail": str(e)})
    # An edited import file is a new observation; unchanged files do not refresh last_seen.
    for file in sorted((root / "imports").glob("*.json")):
        payload = json.loads(file.read_text(encoding="utf-8-sig"))
        fingerprint = digest(payload)
        if fingerprint not in state["imports"]:
            batch = [normalize(row) for row in payload]
            rows.extend(batch)
            state["imports"].append(fingerprint)
    if photo_browser is not None:
        counts = {}
        for url, photos in photo_browser.galleries.items():
            host = urllib.parse.urlsplit(url).hostname or "unknown"
            counts.setdefault(host, []).append(len(photos))
        print("Photo gallery counts by source:", json.dumps(counts, sort_keys=True))
        errors = {}
        for url, error in photo_browser.errors.items():
            host = urllib.parse.urlsplit(url).hostname or "unknown"
            errors.setdefault(host, error)
        print("First photo gallery error by source:", json.dumps(errors, sort_keys=True))
        photo_browser.close()
    changes = update(state, rows, now, scopes)
    expire_unrefreshed_observations(state, now, changes)
    apply_vehicle_history_overrides(root, state)
    if live:
        health = [{**h, "checked_at": h.get("checked_at", now)} for h in health]
        if photo_backfill_errors:
            health.append({"source": "listing photos", "status": "warning", "detail": f"{len(photo_backfill_errors)} existing listing photos were unavailable; placeholders remain. First error: {photo_backfill_errors[0]}", "checked_at": now})
    elif (root / "data/source_health.json").exists():
        health = json.loads((root / "data/source_health.json").read_text(encoding="utf-8"))
    save(root, state, health, changes, cache_photos=live)
    print(json.dumps({"vehicles": len(master_rows(state)), "listings": len(state["listings"]), "changes": len(changes), "sources": health}, indent=2))
    return 1 if any(h["status"] in {"error", "partial"} for h in health) else 0


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--offline", action="store_true", help="Import local JSON and regenerate exports without network requests")
    args = parser.parse_args()
    sys.exit(run(live=not args.offline))

