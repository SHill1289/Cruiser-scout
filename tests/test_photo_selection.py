import sys
import unittest
from pathlib import Path
from unittest.mock import patch
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
from photo_selection import select_photos
from bat_photos import gallery_urls
from finder import backfill_listing_photos
from test_bat_photos import page, BASE


class PhotoSelectionTests(unittest.TestCase):
    def test_unlabeled_gallery_spans_available_views(self):
        urls = [BASE + str(i) + ".jpg" for i in range(40)]
        selected = select_photos(urls)
        self.assertEqual(len(selected), 8)
        self.assertEqual(selected[0], urls[0])
        self.assertIn(urls[-1], selected)
        self.assertGreater(len([u for u in selected if urls.index(u) >= 20]), 2)

    def test_editorial_views_prioritized_and_ads_comments_excluded(self):
        views = [("outside", "The exterior is finished in black."),
                 ("cabin", "The cabin has leather seating surfaces."),
                 ("dash", "The odometer indicates 140k miles."),
                 ("engine", "The V8 was factory rated at 275 horsepower."),
                 ("under", "Power is sent to all four wheels through a transmission.")]
        excerpt = '<div class="post-excerpt"><p>An introductory overview of the entire truck.</p>'
        for name, description in views:
            excerpt += f'<p><img src="{BASE}{name}.jpg?w=620"></p><p>{description}</p>'
        excerpt += f'<p><img src="{BASE}ad.jpg" alt="BaT recommends tires"></p><p>The exterior is great.</p></div>'
        excerpt += f'<div id="comments"><p><img src="{BASE}other-car.jpg"></p><p>The cabin.</p></div>'
        selected = gallery_urls(excerpt + page([BASE+str(i)+".jpg" for i in range(60)]))
        self.assertEqual(len(selected), 8)
        for name, _ in views:
            self.assertIn(BASE+name+".jpg?w=1200", selected)
        self.assertFalse(any("ad.jpg" in u or "other-car" in u for u in selected))

    def test_full_old_gallery_is_upgraded_once(self):
        row = {"source": "bringatrailer", "source_listing_id": "test", "status": "sold",
               "title_status": "unknown", "listing_url": "https://bringatrailer.com/listing/test/",
               "photo_url": BASE+"old.jpg", "photo_urls": [BASE+str(i)+".jpg" for i in range(8)]}
        state = {"listings": {"test": row}}
        class Fetcher:
            calls = 0
            def get(self, url):
                self.calls += 1
                return page([BASE+str(i)+".jpg" for i in range(40)])
        f = Fetcher()
        backfill_listing_photos(state, f)
        self.assertEqual(row["photo_selection_version"], 1)
        self.assertIn(BASE+"39.jpg?w=1200", row["photo_urls"])
        backfill_listing_photos(state, f)
        self.assertEqual(f.calls, 1)

    def test_failed_upgrade_preserves_gallery_and_retries_later(self):
        old = [BASE+str(i)+".jpg" for i in range(8)]
        row = {"source": "bringatrailer", "source_listing_id": "test", "status": "sold",
               "title_status": "unknown", "listing_url": "https://bringatrailer.com/listing/test/",
               "photo_url": old[0], "photo_urls": old[:]}
        state = {"listings": {"test": row}}
        class Fetcher:
            calls = 0
            def get(self, url):
                self.calls += 1
                raise ValueError("unavailable")
        f = Fetcher()
        with patch("finder.utcnow", return_value="2026-10-30T12:00:00+00:00"):
            self.assertEqual(len(backfill_listing_photos(state, f)), 1)
            backfill_listing_photos(state, f)
        self.assertEqual(f.calls, 1)
        self.assertEqual(row["photo_urls"], old)
        self.assertNotIn("photo_selection_version", row)
        with patch("finder.utcnow", return_value="2026-10-31T13:00:00+00:00"):
            backfill_listing_photos(state, f)
        self.assertEqual(f.calls, 2)
