"""Use BaT's editorial vehicle photos, then the auction's main gallery."""
import json
from html.parser import HTMLParser
from urllib.parse import urlsplit, urlunsplit
from photo_selection import category, select_photos

SELECTION_VERSION = 1


def image_url(url):
    if not isinstance(url, str):
        return ""
    parts = urlsplit(url)
    if (parts.scheme != "https" or parts.netloc != "bringatrailer.com"
            or not parts.path.startswith("/wp-content/uploads/")
            or not parts.path.lower().endswith((".jpg", ".jpeg", ".png", ".webp"))):
        return ""
    return urlunsplit(parts._replace(query="w=1200", fragment=""))


class Gallery(HTMLParser):
    def __init__(self):
        super().__init__()
        self.depth = 0
        self.editorial_depth = 0
        self.photos = []
        self.preferred = []
        self.pending = ""
        self.paragraph = None
        self.paragraph_image = ""

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag == "div":
            if attrs.get("id") == "bat_listing_page_photo_gallery":
                self.depth = 1
            elif self.depth:
                self.depth += 1
            if "post-excerpt" in attrs.get("class", "").split():
                self.editorial_depth = 1
            elif self.editorial_depth:
                self.editorial_depth += 1
        if self.editorial_depth:
            if tag == "p":
                self.paragraph = []
                self.paragraph_image = ""
            if tag == "img" and self.paragraph is not None:
                # Editorial ads/logos also occur in the excerpt; never select them.
                alt = attrs.get("alt", "").lower()
                src = attrs.get("src", "")
                if not any(word in (alt + " " + src).lower() for word in
                           ("recommends", "widget", "logo", "advert", "carfax", "autocheck")):
                    self.paragraph_image = image_url(src)
        if not self.depth or "data-gallery-items" not in attrs:
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
            url = image_url(item["large"].get("url"))
            if url and url not in self.photos:
                self.photos.append(url)

    def handle_data(self, text):
        if self.editorial_depth and self.paragraph is not None:
            self.paragraph.append(text)

    def handle_endtag(self, tag):
        if tag == "p" and self.editorial_depth and self.paragraph is not None:
            text = " ".join(self.paragraph)
            if self.paragraph_image:
                self.pending = self.paragraph_image
            elif text.strip() and self.pending:
                if category(text):
                    self.preferred.append((self.pending, text))
                self.pending = ""
            self.paragraph = None
        if tag == "div":
            if self.depth:
                self.depth -= 1
            if self.editorial_depth:
                self.editorial_depth -= 1
                if not self.editorial_depth:
                    self.pending = ""


def gallery_urls(page):
    parser = Gallery()
    parser.feed(page)
    return select_photos(parser.photos, parser.preferred)
