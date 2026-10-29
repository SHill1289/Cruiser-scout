import html
import json
import sys
import unittest
from pathlib import Path
from unittest.mock import patch
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
from bat_photos import gallery_urls
from finder import backfill_listing_photos, parse_bat

BASE = "https://bringatrailer.com/wp-content/uploads/2026/10/"
def block(urls):
    return '<div data-gallery-items="' + html.escape(json.dumps([
        {"large": {"url": url}, "small": {"url": BASE + "thumb.jpg"}} for url in urls
    ])) + '"></div>'

def page(urls):
    return '<div id="bat_listing_page_photo_gallery"><h2><div>Photos</div></h2>' + block(urls) + '</div>'


class BatPhotoTests(unittest.TestCase):
    def test_main_gallery_only_and_deduplication(self):
        content = block([BASE + "unrelated.jpg"]) + page([
            BASE + "a.jpg?w=155&h=105", BASE + "a.jpg", BASE + "b.jpg",
            "https://example.com/wrong.jpg", "http://bringatrailer.com/wp-content/uploads/no.jpg"
        ]) + block([BASE + "comment.jpg"])
        self.assertEqual(gallery_urls(content), [BASE + "a.jpg?w=1200", BASE + "b.jpg?w=1200"])

    def test_bounded_gallery_and_malformed_data(self):
        self.assertEqual(len(gallery_urls(page([BASE + str(i) + ".jpg" for i in range(100)]))), 8)
        self.assertEqual(gallery_urls('<div id="bat_listing_page_photo_gallery"><div data-gallery-items="bad"></div></div>'), [])

    def test_cover_only_sold_unknown_title_is_backfilled_and_then_skipped(self):
        row = {"source": "bringatrailer", "source_listing_id": "test", "status": "sold", "title_status": "unknown",
               "listing_url": "https://bringatrailer.com/listing/test/", "photo_url": BASE+"cover.jpg",
               "photo_urls": [BASE+"cover.jpg"]}
        state = {"listings": {"test": row}}
        class Fetcher:
            calls = 0
            def get(self, url):
                self.calls += 1
                return page([BASE+"a.jpg", BASE+"b.jpg"])
        fetcher = Fetcher()
        self.assertEqual(backfill_listing_photos(state, fetcher), [])
        self.assertEqual(len(row["photo_urls"]), 2)
        backfill_listing_photos(state, fetcher)
        self.assertEqual(fetcher.calls, 1)

    def test_failed_gallery_retains_cover_and_retries_next_day(self):
        row = {"source": "bringatrailer", "source_listing_id": "test", "status": "active", "title_status": "clean title",
               "listing_url": "https://bringatrailer.com/listing/test/", "photo_url": BASE+"cover.jpg",
               "photo_urls": [BASE+"cover.jpg"]}
        state = {"listings": {"test": row}}
        class Fetcher:
            calls = 0
            def get(self, url):
                self.calls += 1
                raise ValueError("temporarily unavailable")
        fetcher = Fetcher()
        with patch("finder.utcnow", return_value="2026-10-29T12:00:00+00:00"):
            self.assertEqual(len(backfill_listing_photos(state, fetcher)), 1)
            backfill_listing_photos(state, fetcher)
        self.assertEqual(fetcher.calls, 1)
        self.assertEqual(row["photo_urls"], [BASE+"cover.jpg"])
        with patch("finder.utcnow", return_value="2026-10-30T13:00:00+00:00"):
            backfill_listing_photos(state, fetcher)
        self.assertEqual(fetcher.calls, 2)

    def test_new_auction_parsing_collects_gallery(self):
        content = '<h1>2006 Lexus LX470</h1><div class="listing-intro"><div class="post-excerpt">A clean title.</div>Sold for $20,000</div>'
        row = parse_bat(content + page([BASE+"a.jpg", BASE+"b.jpg"]),
                        "https://bringatrailer.com/listing/2006-lexus-lx470-test/",
                        "2026-10-29T12:00:00+00:00")
        self.assertEqual(len(row["photo_urls"]), 2)

if __name__ == "__main__":
    unittest.main()
