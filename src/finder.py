"""LX470 Finder: standard-library collectors and an auditable listing database."""
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
import urllib.error
import urllib.parse
import urllib.request
import urllib.robotparser
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
UA = "LX470Finder/1.0 (+https://github.com/SHill1289/lx470-finder)"
FIELDS = ["listing_key", "vehicle_key", "vin", "year", "source", "source_listing_id",
          "listing_url", "status", "category", "asking_price", "base_price", "current_bid",
          "sold_price", "currency", "mileage", "mileage_is_approximate", "city", "state",
          "seller", "seller_type", "photo_url", "exterior_color", "interior_color", "title_status",
          "accident_history", "owners", "owners_source", "owners_verified_at", "owner_evidence_url",
          "service_records", "rust_notes", "source_days_on_market", "listed_at", "listed_at_is_estimated",
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


def normalize(raw):
    row = {k: raw.get(k, "") for k in FIELDS}
    row["year"] = int(raw["year"])
    if row["year"] not in (2006, 2007):
        raise ValueError("Only 2006Ã¢â‚¬â€œ2007 vehicles are accepted")
    if re.sub(r"[^a-z0-9]", "", str(raw.get("make", "Lexus")).lower()) != "lexus":
        raise ValueError("Wrong make")
    if re.sub(r"[^a-z0-9]", "", str(raw.get("model", "LX470")).lower()) != "lx470":
        raise ValueError("Wrong model")
    if not row["source"] or not row["source_listing_id"]:
        raise ValueError("Source and stable source listing ID are required")
    row["source_listing_id"] = str(row["source_listing_id"])
    parts = urllib.parse.urlsplit(row["listing_url"])
    if parts.scheme != "https" or not parts.hostname:
        raise ValueError("An HTTPS listing URL is required")
    if row["photo_url"]:
        photo_parts = urllib.parse.urlsplit(str(row["photo_url"]))
        if photo_parts.scheme != "https" or not photo_parts.hostname:
            raise ValueError("photo_url must be a complete HTTPS URL")
    row["listing_key"] = row["source"] + ":" + row["source_listing_id"]
    row["vin"] = str(row["vin"]).upper().strip()
    flags = set(filter(None, str(row["quality_flags"]).split(";")))
    vin_ok = valid_vin(row["vin"])
    if row["vin"] and not vin_ok:
        flags.add("invalid_vin")
    if vin_ok and (not row["vin"].startswith("JTJHT00W") or row["vin"][9] != str(row["year"])[-1]):
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
        if parts.scheme != "https" or host not in {"www.cargurus.com", "bringatrailer.com"}:
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
    """Render JavaScript listing pages only when plain HTML omits the lead photo."""
    def __init__(self):
        self.driver = None
        self.photos = {}
        self.errors = {}
        self.last = 0

    def photo(self, url):
        if url in self.photos:
            return self.photos[url]
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
            photo = WebDriverWait(self.driver, 10).until(lambda driver: driver.execute_script(
                "return document.querySelector('#PreviewGalleryMainImage img')?.currentSrc || "
                "document.querySelector('#PreviewGalleryMainImage img')?.src || "
                "document.querySelector('link[rel=preload][as=image]')?.href || "
                "document.querySelector('meta[property=\\\"og:image\\\"]')?.content || "
                "document.querySelector('meta[name=\\\"twitter:image\\\"]')?.content || ''"))
            parts = urllib.parse.urlsplit(photo)
            self.photos[url] = photo if parts.scheme == "https" and parts.hostname else ""
        except Exception as error:
            self.photos[url] = ""
            self.errors[url] = f"{type(error).__name__}: {error}".replace("\n", " ")[:500]
        return self.photos[url]

    def error(self, url):
        return self.errors.get(url, "lead photo metadata unavailable")

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


def parse_cargurus(page, year, no_accident_ids=None):
    search = cargurus_search(page, year)
    no_accident_ids = no_accident_ids or set()
    rows = {}
    for tile in search["tiles"]:
        if not tile.get("type", "").startswith("LISTING_USED"):
            continue
        d = tile["data"]
        ontology = d.get("ontologyData", {})
        if int(ontology.get("carYear", 0)) != year or ontology.get("makeName") != "Lexus" or ontology.get("modelName") != "LX" or not ontology.get("trimName", "").startswith("470"):
            continue
        seller, price = d.get("sellerData", {}), d.get("priceData", {})
        listing_id = str(d["id"])
        rows[listing_id] = normalize({
            "source": "cargurus", "source_listing_id": d["id"], "year": year,
            "vin": d.get("vin", ""), "status": "active", "category": "retail",
            "listing_url": f'https://www.cargurus.com/details/{d["id"]}',
            "asking_price": price.get("pricePlusFees", price.get("totalPrice", price.get("current"))),
            "base_price": price.get("basePrice", price.get("current")),
            "mileage": d.get("mileageData", {}).get("value"),
            "city": seller.get("city", ""), "state": seller.get("region", ""),
            "seller": seller.get("serviceProviderName", ""),
            "seller_type": "dealer" if seller.get("serviceProviderId") else "unknown",
            "photo_url": cargurus_photo(d),
            "exterior_color": d.get("exteriorColorData", {}).get("name", ""),
            "interior_color": d.get("interiorColorData", {}).get("localized", ""),
            "title_status": "clean-title candidate",
            "accident_history": "No reported accidents" if listing_id in no_accident_ids else "Accident reported or history unavailable",
            "owners": "Unverified",
            "source_days_on_market": d.get("daysOnMarket", ""),
            "notes": "CarGurus clean-history filters exclude reported salvage, lemon, frame-damage and theft history. This is a clean-title candidate, not a legal title guarantee; verify through NMVTIS/CARFAX and the physical title. Asking price includes listed fees when supplied; taxes/shipping may be extra.",
        })
        if d.get("mileageData", {}).get("unit") != "MILES":
            raise ValueError("Unexpected mileage units")
    complete = search.get("pageCount") == 1 and len(rows) == search.get("totalListings")
    if not rows and search.get("totalListings") != 0:
        raise ValueError("No valid listings parsed from nonempty results")
    return list(rows.values()), complete, search.get("totalListings")


def plain(page):
    page = re.sub(r"<(script|style)\b[^>]*>.*?</\1>", "", page, flags=re.S | re.I)
    return re.sub(r"\s+", " ", html.unescape(re.sub(r"<[^>]+>", " ", page))).strip()


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
    """Add a source-hosted lead photo without making image failure fatal."""
    if row.get("photo_url"):
        return ""
    url = listing_detail_url(row)
    if not url:
        return "listing URL unavailable"
    photo = ""
    plain_error = ""
    try:
        photo = parse_listing_photo(fetcher.get(url))
    except Exception as error:
        plain_error = str(error)
    if not photo and row.get("source") == "cargurus" and browser_fetcher is not None:
        photo = browser_fetcher.photo(url)
    if not photo:
        if browser_fetcher is not None and row.get("source") == "cargurus":
            return browser_fetcher.error(url)
        return plain_error or "lead photo metadata unavailable"
    row["photo_url"] = photo
    return ""


def backfill_listing_photos(state, fetcher, browser_fetcher=None):
    """Fetch photos for existing public rows, including completed auctions."""
    errors = []
    for row in state.get("listings", {}).values():
        if (row.get("photo_url") or row.get("source") not in {"cargurus", "bringatrailer"}
                or row.get("status") not in {"active", "sold", "ended"}
                or not clean_title_candidate(row)):
            continue
        error = add_listing_photo(row, fetcher, browser_fetcher)
        if error:
            errors.append(f'{row.get("listing_key", "listing")}: {error}')
    return errors


def parse_bat(page, url, now):
    title_match = re.search(r'<h1\b[^>]*>(.*?)</h1>', page, re.S)
    title = plain(title_match[1]) if title_match else ""
    match = re.search(r"\b(2006|2007) Lexus LX\s?470\b", title, re.I)
    if not match:
        raise ValueError("Not a 2006Ã¢â‚¬â€œ2007 LX470 auction")
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
        accidents = "Unknown"
    row = {"source": "bringatrailer", "source_listing_id": url.rstrip('/').split('/')[-1],
           "year": int(match[1]), "listing_url": url, "vin": vin[1] if vin else "",
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
    return normalize(row)


def clean_title_candidate(row):
    return row.get("title_status") in {"clean-title candidate", "clean title"}


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


def save(root, state, health, changes):
    data = root / "data"
    data.mkdir(parents=True, exist_ok=True)
    web = root / "web"
    web.mkdir(parents=True, exist_ok=True)
    rows = sorted(state["listings"].values(), key=lambda r: r["listing_key"])
    active = [r for r in rows if r["status"] == "active" and clean_title_candidate(r)]
    excluded = [r for r in rows if r["status"] == "active" and not clean_title_candidate(r)]
    outputs = {"listings.csv": rows, "active_listings.csv": active,
               "excluded_listings.csv": excluded,
               "retail_listings.csv": [r for r in active if r["category"] == "retail"],
               "auction_salvage_listings.csv": [r for r in active if r["category"] != "retail"],
               "sold_listings.csv": [r for r in rows if r["status"] == "sold"]}
    for filename, items in outputs.items():
        (data / filename).write_text(csv_text(items, FIELDS), encoding="utf-8")
    eligible_keys = {r["vehicle_key"] for r in active}
    master = [r for r in master_rows(state) if r["vehicle_key"] in eligible_keys]
    (data / "lx470_master.csv").write_text(csv_text(master, FIELDS + ["listing_count", "sources", "listing_urls"]), encoding="utf-8")
    (data / "listing_history.csv").write_text(csv_text(state["history"], ["observed_at", "event"] + FIELDS), encoding="utf-8")
    for filename, obj in [("database.json", state), ("source_health.json", health), ("latest_changes.json", changes)]:
        temp = data / (filename + ".tmp")
        temp.write_text(json.dumps(obj, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
        temp.replace(data / filename)
    public_fields = [
        "listing_key", "vin", "year", "source", "listing_url", "status", "category",
        "asking_price", "base_price", "current_bid", "sold_price", "currency", "mileage",
        "mileage_is_approximate", "city", "state", "seller", "seller_type", "photo_url",
        "exterior_color", "interior_color", "title_status", "accident_history",
        "owners", "owners_source", "owners_verified_at", "owner_evidence_url",
        "auction_ends_at", "bid_observed_at", "listed_at", "listed_at_is_estimated", "first_seen", "last_seen", "quality_flags",
    ]
    public_rows = [r for r in rows if clean_title_candidate(r) and r["status"] in {"active", "sold", "ended"}]
    public_inventory = {
        "generated_at": state["updated_at"],
        "disclaimer": "Marketplace screening identifies clean-title candidates, not a legal title guarantee. Verify NMVTIS/CARFAX and the physical title before purchase.",
        "summary": {
            "vehicles": len(master),
            "active_listings": len(active),
            "retail": sum(r["category"] == "retail" for r in active),
            "auctions": sum(r["category"] != "retail" for r in active),
            "sold": sum(r["status"] == "sold" for r in public_rows),
            "ended_auctions": sum(r["status"] == "ended" and r["category"] == "auction" for r in public_rows),
        },
        "source_health": health,
        "listings": [{key: row.get(key) for key in public_fields} for row in public_rows],
    }
    temp = web / "inventory.json.tmp"
    temp.write_text(json.dumps(public_inventory, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    temp.replace(web / "inventory.json")
    report = ["# LX470 inventory", "", f"Last run: {state['updated_at']}", "",
              f"**{len(master)} distinct vehicles Ã‚Â· {len(outputs['active_listings.csv'])} active listings Ã‚Â· {len(changes)} changes this run**", "",
              "Only clean-title candidates appear below. CarGurus candidates have no reported salvage, lemon, frame-damage or theft history; this is not an official title guarantee. Verify NMVTIS/CARFAX and the physical title before purchase. Active means seen advertised at last_seen, not seller-confirmed availability.", "",
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
    state = json.loads(path.read_text(encoding="utf-8")) if path.exists() else {"version": 1, "listings": {}, "history": [], "imports": []}
    backfill_listing_dates(state)
    remove_unverified_cargurus_owner_inferences(state)
    now, rows, scopes, health = utcnow(), [], [], []
    config = json.loads((root / "sources/config.json").read_text(encoding="utf-8"))
    fetcher = Fetcher()
    photo_browser = BrowserPhotoFetcher() if live else None
    photo_backfill_errors = backfill_listing_photos(state, fetcher, photo_browser) if live else []
    if live:
        for source in config["sources"]:
            if not source["enabled"]:
                health.append({"source": source["id"], "status": "manual_only", "detail": source["reason"]})
                continue
            try:
                if source["type"] == "cargurus":
                    no_accident_ids = cargurus_listing_ids(fetcher.get(source["no_accidents_url"]), source["year"], {"maxAccidents": 0})
                    batch, complete, total = parse_cargurus(fetcher.get(source["url"]), source["year"], no_accident_ids)
                    photo_errors = [error for row in batch if (error := add_listing_photo(row, fetcher, photo_browser))]
                    rows.extend(batch)
                    if complete:
                        scopes.append(("cargurus", source["year"]))
                    photo_note = f" First photo error: {photo_errors[0]}" if photo_errors else ""
                    health.append({"source": source["id"], "status": "ok" if complete else "partial", "detail": f"{len(batch)} parsed of {total}; {len(batch)-len(photo_errors)} photos found; nationwide. Additional pages are not crawled.{photo_note}"})
                elif source["type"] == "bringatrailer":
                    page = fetcher.get(source["url"])
                    urls = set(re.findall(r'https://bringatrailer.com/listing/200[67]-lexus-lx-?470[^\s"<>]*/', page))
                    urls.update(r["listing_url"] for r in state["listings"].values() if r["source"] == "bringatrailer" and r["status"] in {"active", "unknown"})
                    if "listing" not in page or not re.search(r"LX\s?470", page, re.I):
                        raise ValueError("Auction index format changed")
                    errors = []
                    for url in sorted(urls)[:30]:
                        try:
                            rows.append(parse_bat(fetcher.get(url), url, now))
                        except Exception as e:
                            errors.append(f"{url}: {e}")
                    health.append({"source": source["id"], "status": "partial" if errors or len(urls) > 30 else "ok", "detail": f"{min(len(urls),30)-len(errors)} auction pages parsed. Index coverage only; not a complete auction archive. " + "; ".join(errors)})
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
        photo_browser.close()
    changes = update(state, rows, now, scopes)
    apply_vehicle_history_overrides(root, state)
    if live:
        health = [{**h, "checked_at": now} for h in health]
        if photo_backfill_errors:
            health.append({"source": "listing photos", "status": "warning", "detail": f"{len(photo_backfill_errors)} existing listing photos were unavailable; placeholders remain. First error: {photo_backfill_errors[0]}", "checked_at": now})
    elif (root / "data/source_health.json").exists():
        health = json.loads((root / "data/source_health.json").read_text(encoding="utf-8"))
    save(root, state, health, changes)
    print(json.dumps({"vehicles": len(master_rows(state)), "listings": len(state["listings"]), "changes": len(changes), "sources": health}, indent=2))
    return 1 if any(h["status"] in {"error", "partial"} for h in health) else 0


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--offline", action="store_true", help="Import local JSON and regenerate exports without network requests")
    args = parser.parse_args()
    sys.exit(run(live=not args.offline))


