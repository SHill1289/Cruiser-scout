"""Read only the auction's main gallery, excluding comments and related cars."""
import json
from html.parser import HTMLParser
from urllib.parse import urlsplit, urlunsplit


class Gallery(HTMLParser):
    def __init__(self):
        super().__init__()
        self.depth = 0
        self.photos = []

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag == "div":
            if attrs.get("id") == "bat_listing_page_photo_gallery":
                self.depth = 1
            elif self.depth:
                self.depth += 1
        if not self.depth or "data-gallery-items" not in attrs or len(self.photos) >= 8:
            return
        try:
            items = json.loads(attrs["data-gallery-items"])
        except (ValueError, TypeError):
            return
        if not isinstance(items, list):
            return
        for item in items:
            if not isinstance(item, dict) or not isinstance(item.get("large"), dict):
                continue
            url = item["large"].get("url")
            if not isinstance(url, str):
                continue
            parts = urlsplit(url)
            if (parts.scheme != "https" or parts.netloc != "bringatrailer.com"
                    or not parts.path.startswith("/wp-content/uploads/")
                    or not parts.path.lower().endswith((".jpg", ".jpeg", ".png", ".webp"))):
                continue
            url = urlunsplit(parts._replace(query="w=1200", fragment=""))
            if url not in self.photos:
                self.photos.append(url)
            if len(self.photos) >= 8:
                break

    def handle_endtag(self, tag):
        if tag == "div" and self.depth:
            self.depth -= 1


def gallery_urls(page):
    parser = Gallery()
    parser.feed(page)
    return parser.photos[:8]
