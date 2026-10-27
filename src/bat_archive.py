"""Read public BaT archive records and explicit listing location metadata."""
import html
import json
import re
from datetime import datetime, timedelta, timezone
from urllib.parse import urlsplit, urlencode

STATE_CODES = dict(item.split(":") for item in (
"Alabama:AL|Alaska:AK|Arizona:AZ|Arkansas:AR|California:CA|Colorado:CO|Connecticut:CT|Delaware:DE|District of Columbia:DC|Florida:FL|Georgia:GA|Hawaii:HI|Idaho:ID|Illinois:IL|Indiana:IN|Iowa:IA|Kansas:KS|Kentucky:KY|Louisiana:LA|Maine:ME|Maryland:MD|Massachusetts:MA|Michigan:MI|Minnesota:MN|Mississippi:MS|Missouri:MO|Montana:MT|Nebraska:NE|Nevada:NV|New Hampshire:NH|New Jersey:NJ|New Mexico:NM|New York:NY|North Carolina:NC|North Dakota:ND|Ohio:OH|Oklahoma:OK|Oregon:OR|Pennsylvania:PA|Rhode Island:RI|South Carolina:SC|South Dakota:SD|Tennessee:TN|Texas:TX|Utah:UT|Vermont:VT|Virginia:VA|Washington:WA|West Virginia:WV|Wisconsin:WI|Wyoming:WY").split("|"))

def location(page):
    match = re.search(r'<strong[^>]*>Location</strong>\s*:\s*<a\b[^>]*>(.*?)</a>', page, re.S | re.I)
    if not match:
        return {}
    label = html.unescape(re.sub("<[^>]+>", "", match[1])).strip()
    parts = label.split(", ", 1)
    if len(parts) != 2:
        return {"city": label}
    city, region = parts
    postal = re.search(r"\b(\d{5})(?:-\d{4})?\b", region)
    region = re.sub(r"\s+\d{5}(?:-\d{4})?\b.*", "", region).strip()
    region = re.sub(r",?\s*(?:United States|USA)$", "", region).strip(", ")
    state = next((code for name, code in STATE_CODES.items() if region.casefold() in (name.casefold(), code.casefold())), region)
    return {"city": city, "state": state, "postal_code": postal[1] if postal else ""}

def archive_results(page, years, now, fetch=None):
    match = re.search(r"var\s+auctionsCompletedInitialData\s*=\s*", page)
    if not match:
        raise ValueError("BaT structured archive results unavailable")
    data, _ = json.JSONDecoder().raw_decode(page[match.end():])
    stats = data.get("stats")
    # BaT may defer chart data to the same public request used by its page UI.
    if stats is False and fetch is not None:
        base = data.get("base_filter", {})
        ids = base.get("keyword_pages", [])
        if (base.get("items_type") != "model" or not isinstance(ids, list)
                or len(ids) != 1 or type(ids[0]) is not int or ids[0] <= 0):
            raise ValueError("BaT archive model filter unavailable")
        query = urlencode({"page": 1, "per_page": 24, "get_items": 0, "get_stats": 1,
                           "base_filter[keyword_pages][]": ids[0],
                           "base_filter[items_type]": "model", "sort": "td"})
        payload = json.loads(fetch("https://bringatrailer.com/wp-json/bringatrailer/1.0/data/listings-filter?" + query))
        stats = payload.get("stats")
    if not isinstance(stats, dict) or not isinstance(stats.get("sold"), list) or not isinstance(stats.get("unsold"), list):
        raise ValueError("BaT archive result format changed")
    cutoff = datetime.fromisoformat(now) - timedelta(days=731)
    result = {}
    for outcome in ("sold", "unsold"):
        for item in stats[outcome]:
            title = html.unescape(item.get("title", ""))
            identity = re.search(r"\b(20\d{2})\s+(Lexus LX\s?(?:470|570)|Toyota Land Cruiser)\b", title, re.I)
            if not identity:
                continue
            model = "Land Cruiser" if identity[2].lower().startswith("toyota") else "LX570" if "570" in identity[2] else "LX470"
            if int(identity[1]) not in years.get(model, ()):
                continue
            url = item.get("url", "")
            parsed = urlsplit(url)
            if parsed.scheme != "https" or parsed.netloc != "bringatrailer.com" or not re.fullmatch(r"/listing/[^/]+/", parsed.path) or parsed.query or parsed.fragment:
                continue
            stamp = datetime.fromtimestamp(item["timestamp"], timezone.utc)
            if stamp < cutoff or stamp > datetime.fromisoformat(now):
                continue
            result[url] = {"model": model, "year": int(identity[1]), "outcome": outcome,
                           "result_at": stamp.isoformat(), "amount": item.get("amount")}
    return result
