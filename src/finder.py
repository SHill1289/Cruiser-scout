"""Raptor Finder: standard-library collectors and an auditable listing database."""
from __future__ import annotations

import argparse
import csv
import hashlib
import html
import io
import json
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
UA = "RaptorFinder/1.0"
YEARS = tuple(range(2010, 2015)) + tuple(range(2017, 2028))
VIN_YEARS = "ABCDEFGHJKLMNPRSTVWXY123456789"

FIELDS = ["make", "model", "trim", "listing_key", "vehicle_key", "vin", "year", "source", "source_listing_id",
          "listing_url", "status", "category", "asking_price", "base_price", "current_bid",
          "sold_price", "currency", "mileage", "mileage_is_approximate", "city", "state", "postal_code",
          "seller", "seller_type", "photo_url", "photo_urls", "exterior_color", "interior_color", "title_status",
          "reported_extras",
          "accident_history", "owners", "owners_source", "owners_verified_at", "owner_evidence_url",
          "service_records", "rust_notes", "source_days_on_market", "listed_at", "listed_at_is_estimated",
          "shocks_status", "shocks_evidence", "engine_status", "engine_evidence",
          "rust_status", "rust_evidence", "navigation_status", "navigation_evidence",
          "service_records_status", "service_records_evidence",
          "modifications_status", "modifications_evidence",
          "auction_ends_at", "bid_observed_at", "first_seen", "last_seen", "last_checked", "missing_checks",
          "quality_flags", "notes"]
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
    "Adaptive Cruise Control": "Adaptive cruise",
    "Remote Engine Start": "Remote start",
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
    if row["year"] not in YEARS:
        raise ValueError("Not an F-150 Raptor model year")
    if str(raw.get("make", "")).strip().lower() != "ford":
        raise ValueError("Wrong make")
    if re.sub(r"[^a-z0-9]", "", str(raw.get("model", "")).lower()) != "f150":
        raise ValueError("Wrong model")
    if str(raw.get("trim", "")).strip().lower() not in {"raptor", "svt raptor", "raptor r"}:
        raise ValueError("Explicit F-150 Raptor trim evidence is required")
    row.update(make="Ford", model="F-150", trim=str(raw["trim"]).strip())
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
    if vin_ok and (not row["vin"].startswith("1FT") or row["vin"][9] != VIN_YEARS[(row["year"] - 2010) % 30]):
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
        req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "text/html"})
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
        if parts.scheme != "https" or host not in {"www.cargurus.com", "bringatrailer.com", "www.truecar.com"}:
            raise ValueError("Collector host is not allowlisted")
        if host not in self.robots:
            parser = urllib.robotparser.RobotFileParser()
            parser.parse(self.request(f"https://{host}/robots.txt").splitlines())
            self.robots[host] = parser
        parser = self.robots[host]
        if not parser.can_fetch(UA, url):
            raise ValueError("Disallowed by robots.txt")
        delay = max(2, parser.crawl_delay(UA) or 0)
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


def parse_truecar(page, now, expected_offset=0):
    """Parse nationwide F-150 Raptor listings from TrueCar's public search page."""
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
            search_args.get("offset") == expected_offset
            and filters.get("condition") == "USED"
            and filters.get("makeModelTrim") == [{"makeSlug": "ford", "modelSlug": "f-150", "trimSlugs": ["raptor"]}]
            and filters.get("price") == {"max": 30000}
            and set(filters) <= {"condition", "fallbackStrategy", "makeModelTrim", "price"}
        )
    except (ValueError, KeyError, TypeError, AttributeError) as error:
        raise ValueError("TrueCar search filters could not be read") from error
    if not scope_ok:
        detail = json.dumps(filters, sort_keys=True, separators=(",", ":"))[:350]
        raise ValueError("TrueCar did not apply nationwide F-150 Raptor and price filters: " + detail)
    edges = search.get("edges", [])
    total = search.get("totalCount")
    complete = search.get("pageInfo", {}).get("hasNextPage") is False
    rows = []
    for edge in edges:
        ref = edge.get("node", {}).get("__ref", "")
        listing = state.get(ref, {})
        vehicle = listing.get("vehicle", {})
        style = vehicle.get("style", {}) or {}
        year = vehicle.get("year")
        vin = str(vehicle.get("vin", "")).upper()
        if year not in YEARS or vehicle.get("make", {}).get("name") != "Ford" or vehicle.get("model", {}).get("name") != "F-150" or style.get("trimName", "").lower() not in {"raptor", "svt raptor", "raptor r"}:
            continue
        history = listing.get("conditionHistory", {}) or {}
        details = vehicle.get("details", {}) or {}
        dealer_ref = listing.get("dealership", {}).get("__ref", "")
        dealer = state.get(dealer_ref, {})
        location = dealer.get("location", {}).get("geolocation", {}) or {}
        gallery = next((value for key, value in listing.items() if key.startswith("galleryImages(")), {}) or {}
        photos = [item.get("node", {}).get("url", "") for item in gallery.get("edges", [])]
        photos = [url for url in photos if url.startswith("https://")][:8]
        photo = next(iter(photos), "")
        accident_count = history.get("accidentCount")
        accidents = ("No reported accidents" if type(accident_count) is int and accident_count == 0 else
                     f"{accident_count} reported accident{'s' if accident_count != 1 else ''}" if isinstance(accident_count, int) else
                     "History unavailable")
        owner_count = history.get("ownerCount")
        listing_url = f"https://www.truecar.com/used-cars-for-sale/listing/{vin}/"
        rows.append(normalize({
            "source": "truecar", "source_listing_id": vin, "year": year, "vin": vin,
            "make": "Ford", "model": "F-150", "trim": style["trimName"],
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
            "title_status": "clean title" if history.get("isCleanTitle") is True else "unknown", "accident_history": accidents,
            "owners": str(owner_count) if (type(owner_count) is int and owner_count > 0) else "Unknown",
            "owners_source": "TrueCar / Experian AutoCheck" if (type(owner_count) is int and owner_count > 0) else "",
            "owner_evidence_url": listing_url if (type(owner_count) is int and owner_count > 0) else "",
            "owners_verified_at": now[:10] if (type(owner_count) is int and owner_count > 0) else "",
            "listed_at": details.get("listedAt", ""), "listed_at_is_estimated": False,
            "notes": "TrueCar reports clean-title, owner and accident data from Experian AutoCheck. Verify the physical title and a current history report before purchase.",
        }))
    if len(rows) != len(edges):
        complete = False
    return rows, complete, total


def plain(page):
    page = re.sub(r"<(script|style)\b[^>]*>.*?</\1>", "", page, flags=re.S | re.I)
    return re.sub(r"\s+", " ", html.unescape(re.sub(r"<[^>]+>", " ", page))).strip()


CONDITION_TOPICS = ("shocks", "engine", "rust", "navigation", "service_records", "modifications")


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
        "shocks": [
            (r"\b(?:shocks?|Fox suspension)\b.{0,65}\b(?:rebuilt|replaced|serviced)\b", "Service reported"),
            (r"\b(?:shocks?|Fox suspension)\b.{0,65}\b(?:leak|leaking|failed|worn)\b", "Issue reported"),
        ],
        "engine": [
            (r"\b(?:engine|cam phasers?)\b.{0,65}\b(?:replaced|repaired|serviced)\b", "Service reported"),
            (r"\b(?:engine|cam phasers?)\b.{0,65}\b(?:rattle|rattles|knock|failure|failed)\b", "Issue reported"),
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
            (r"\b(?:aftermarket|modified|modifications|lift kit|lifted suspension)\b", "Modification reported"),
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


def clean_title_candidate(row):
    return row.get("title_status") in {"clean-title candidate", "clean title"}


def qualified_listings(rows, history=()):
    # Keep conflicting accident evidence even when a later feed omits it.
    blocked = {row["vehicle_key"] for row in [*rows, *history]
               if accident_category(row.get("accident_history")) == "reported"}
    return [row for row in rows
            if row.get("status") == "active" and row.get("category") == "retail"
            and row.get("make") == "Ford" and row.get("model") == "F-150"
            and str(row.get("trim", "")).lower() in {"raptor", "svt raptor", "raptor r"}
            and clean_title_candidate(row)
            and accident_category(row.get("accident_history")) == "none"
            and row["vehicle_key"] not in blocked
            and isinstance(row.get("asking_price"), (int, float))
            and 0 < row["asking_price"] < 30000 and row.get("currency") == "USD"]


def deal_rating(row, sales, minimum_comparables=3):
    """Compare a retail asking price with the median sale in its mileage band."""
    if (row.get("status") != "active" or row.get("category") != "retail"
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
              if isinstance(sale.get("mileage"), (int, float)) and includes(sale["mileage"])
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
    for source, year in scopes:
        for key, row in listings.items():
            if key in seen or row["source"] != source or row["year"] != year or row["status"] != "active":
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
    qualified = qualified_listings(rows, state.get("history", []))
    active = qualified
    eligible_keys = {r["listing_key"] for r in active}
    excluded = [r for r in rows if r["status"] == "active" and r["listing_key"] not in eligible_keys]
    outputs = {"listings.csv": rows, "active_listings.csv": active,
               "excluded_listings.csv": excluded,
               "retail_listings.csv": [r for r in active if r["category"] == "retail"],
               "auction_salvage_listings.csv": [r for r in active if r["category"] != "retail"],
               "sold_listings.csv": [r for r in rows if r["status"] == "sold"]}
    for filename, items in outputs.items():
        (data / filename).write_text(csv_text(items, FIELDS), encoding="utf-8")
    sale_fields = ["source", "source_listing_id", "listing_url", "year", "sold_at", "sale_price", "mileage", "mileage_is_approximate"]
    historical_sales = state.get("historical_sales", [])
    (data / "historical_sales.csv").write_text(csv_text(historical_sales, sale_fields), encoding="utf-8")
    (data / "historical_sales.json").write_text(json.dumps(historical_sales, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    eligible_keys = {r["vehicle_key"] for r in active}
    master = [r for r in master_rows(state) if r["vehicle_key"] in eligible_keys]
    (data / "raptor_master.csv").write_text(csv_text(master, FIELDS + ["listing_count", "sources", "listing_urls"]), encoding="utf-8")
    (data / "listing_history.csv").write_text(csv_text(state["history"], ["observed_at", "event"] + FIELDS), encoding="utf-8")
    for filename, obj in [("database.json", state), ("source_health.json", health), ("latest_changes.json", changes)]:
        temp = data / (filename + ".tmp")
        temp.write_text(json.dumps(obj, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
        temp.replace(data / filename)
    public_fields = [
        "make", "model", "trim", "listing_key", "vehicle_key", "vin", "year", "source", "listing_url", "status", "category",
        "asking_price", "base_price", "current_bid", "sold_price", "currency", "mileage",
        "mileage_is_approximate", "city", "state", "postal_code", "latitude", "longitude", "location_precision",
        "seller", "seller_type", "photo_url", "photo_urls",
        "exterior_color", "interior_color", "reported_extras", "title_status", "accident_history", "accident_category",
        "owners", "owners_source", "owners_verified_at", "owner_evidence_url",
        "shocks_status", "shocks_evidence", "engine_status", "engine_evidence",
        "rust_status", "rust_evidence", "navigation_status", "navigation_evidence",
        "service_records_status", "service_records_evidence",
        "modifications_status", "modifications_evidence",
        "auction_ends_at", "bid_observed_at", "listed_at", "listed_at_is_estimated", "first_seen", "last_seen", "quality_flags",
        "deal_quality", "deal_percent_vs_median", "deal_comparable_count", "deal_median_price", "deal_mileage_band",
        "rust_location",
    ]
    public_rows = qualified
    cutoff = (datetime.fromisoformat(state["updated_at"]) - timedelta(days=731)).date().isoformat()
    public_sales = [row for row in historical_sales if row.get("sold_at", "") >= cutoff]
    public_rows = [{**row,
                    "accident_category": accident_category(row.get("accident_history")),
                    "rust_location": rust_location_evidence(row, state)} for row in public_rows]
    places, zips = load_location_points()
    public_rows = [{**row, **listing_coordinates(row, places, zips)} for row in public_rows]
    if cache_photos:
        cache_public_photos(root, public_rows)
    public_vehicles = merge_public_listings(public_rows)
    public_inventory = {
        "generated_at": state["updated_at"],
        "disclaimer": "F-150 Raptor listings with a known asking price below $30,000, clean-title evidence and no reported accidents. Unknown history and conflicting accident reports are excluded. Verify availability, fees, title and a current history report before purchase.",
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
    report = ["# Raptor inventory", "", f"Last run: {state['updated_at']}", "",
              f"**{len(master)} distinct vehicles Â· {len(outputs['active_listings.csv'])} active listings Â· {len(changes)} changes this run**", "",
              "Only active F-150 Raptors below $30,000 with clean-title evidence and no reported accidents appear below. Verify NMVTIS/CARFAX and the physical title before purchase. Active means seen advertised at last_seen, not seller-confirmed availability.", "",
              "## Source health", "", "| Source | Result | Detail |", "|---|---|---|"]
    escape = lambda v: html.escape(str(v or "")).replace("|", "&#124;").replace("\n", " ")
    for source in health:
        report.append(f"| {escape(source['source'])} | {escape(source['status'])} | {escape(source.get('detail', ''))} |")
    report += ["", "## Advertised retail listings", "", "| Year | Asking USD | Miles | Exterior | Interior | Owners | Accidents | Title screen | Location | Seller | VIN | Last seen | Listing |", "|---|---:|---:|---|---|---|---|---|---|---|---|---|---|"]
    for row in sorted(outputs["retail_listings.csv"], key=lambda r: r["asking_price"] if r["asking_price"] is not None else float('inf')):
        report.append("| " + " | ".join(escape(row[k]) for k in ["year", "asking_price", "mileage", "exterior_color", "interior_color", "owners", "accident_history", "title_status"]) + f" | {escape(row['city'])}, {escape(row['state'])} | {escape(row['seller'])} | {escape(row['vin'])} | {escape(row['last_seen'])} | [Open]({row['listing_url']}) |")
    report += ["", "## Auctions and salvage", "", "| Year | Status | Current bid USD | Sold price USD | Miles | Exterior | Interior | Owners | Accidents | Title | VIN | Listing |", "|---|---|---:|---:|---:|---|---|---|---|---|---|---|"]
    for row in outputs["auction_salvage_listings.csv"]:
        report.append("| " + " | ".join(escape(row[k]) for k in ["year", "status", "current_bid", "sold_price", "mileage", "exterior_color", "interior_color", "owners", "accident_history", "title_status", "vin"]) + f" | [Open]({row['listing_url']}) |")
    report += ["", f"{len(excluded)} active listings are retained for audit but excluded because clean-title eligibility was not established. See `data/excluded_listings.csv`."]
    (root / "INVENTORY.md").write_text("\n".join(report) + "\n", encoding="utf-8")


def run(root=ROOT, live=True):
    path = root / "data/database.json"
    state = json.loads(path.read_text()) if path.exists() else {"version": 1, "listings": {}, "history": [], "imports": []}
    now, rows, scopes, health = utcnow(), [], [], []
    if live:
        fetcher = Fetcher()
        source = json.loads((root / "sources/config.json").read_text())["sources"][0]
        try:
            total, seen, complete = None, set(), False
            for page_number in range(1, 11):
                url = source["url"] + (f"&page={page_number}" if page_number > 1 else "")
                batch, page_complete, page_total = parse_truecar(fetcher.get(url), now, (page_number - 1) * 30)
                if total is not None and page_total != total:
                    raise ValueError("Result count changed during pagination; preserving missing listings")
                total = page_total
                keys = {row["listing_key"] for row in batch}
                if keys and keys <= seen:
                    raise ValueError("Pagination repeated an entire page; preserving missing listings")
                seen.update(keys)
                rows.extend(batch)
                if page_complete:
                    complete = len(seen) == total
                    break
                if not batch:
                    break
            if complete:
                scopes = [("truecar", year) for year in YEARS]
            health.append({"source": "TrueCar", "status": "ok" if complete else "partial", "detail": f"{len(seen)} of {total} nationwide Raptor listings below the source's $30,000 maximum checked. Dashboard applies a strict below-$30,000 asking-price rule, clean title and zero reported accidents.", "checked_at": now})
        except Exception as error:
            health.append({"source": "TrueCar", "status": "error", "detail": str(error), "checked_at": now})
        health.extend({"source": item["id"], "status": "manual_only", "detail": item["reason"], "checked_at": now} for item in json.loads((root / "sources/config.json").read_text())["sources"][1:])
    for file in sorted((root / "imports").glob("*.json")):
        payload = json.loads(file.read_text(encoding="utf-8-sig"))
        fingerprint = digest(payload)
        if fingerprint not in state["imports"]:
            rows.extend(normalize(row) for row in payload)
            state["imports"].append(fingerprint)
    changes = update(state, rows, now, scopes)
    if not live and (root / "data/source_health.json").exists():
        health = json.loads((root / "data/source_health.json").read_text())
    save(root, state, health, changes, cache_photos=live)
    print(json.dumps({"observations": len(state["listings"]), "changes": len(changes), "sources": health}, indent=2))
    return 1 if any(item["status"] in {"error", "partial"} for item in health) else 0


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--offline", action="store_true", help="Import local JSON and regenerate exports without network requests")
    args = parser.parse_args()
    sys.exit(run(live=not args.offline))


