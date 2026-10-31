import sys
import unittest
from pathlib import Path
from unittest.mock import patch
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src'))
from autodev import enrich_photos

NOW = '2026-10-31T18:00:00+00:00'
VIN = 'JTJHT00W364008364'
URLS = ['https://retail.photos.vin/image' + str(i) + '.jpg' for i in range(40)]


def fixture():
    row = dict(vin=VIN, source='cargurus', status='active', year=2006, model='LX470',
               photo_source='autodev', photo_url=URLS[0], photo_urls=URLS[:8])
    state = {'listings': {'cg': row},
             'autodev_usage': {'month': NOW[:7], 'day': NOW[:10], 'calls': 100}}
    return row, state


class Photos:
    def __init__(self, urls=URLS):
        self.urls = urls
        self.calls = []

    def get(self, url):
        self.calls.append(url)
        return {'data': {'retail': self.urls}}


@patch('autodev.time.sleep')
class UpgradeTests(unittest.TestCase):
    def test_equal_length_gallery_upgraded_once(self, _):
        row, state = fixture()
        client = Photos()
        self.assertEqual(enrich_photos(client, state, [], NOW, verify_gallery=lambda p: True), 1)
        self.assertEqual(len(row['photo_urls']), 8)
        self.assertIn(URLS[-1], row['photo_urls'])
        self.assertEqual(row['photo_urls'][0], URLS[0])
        enrich_photos(client, state, [], NOW, verify_gallery=lambda p: True)
        self.assertEqual(len(client.calls), 1)
        self.assertEqual(state['cargurus_photo_selection_progress']['pending'], 0)

    def test_failed_download_keeps_previous_gallery_and_cools_down(self, _):
        row, state = fixture()
        client = Photos()
        enrich_photos(client, state, [], NOW, verify_gallery=lambda p: False)
        self.assertEqual(row['photo_urls'], URLS[:8])
        enrich_photos(client, state, [], NOW, verify_gallery=lambda p: True)
        self.assertEqual(len(client.calls), 1)
        self.assertEqual(state['cargurus_photo_selection_progress']['pending'], 1)

    def test_shorter_source_keeps_previous_gallery(self, _):
        row, state = fixture()
        enrich_photos(Photos(URLS[:3]), state, [], NOW, verify_gallery=lambda p: True)
        self.assertEqual(row['photo_urls'], URLS[:8])
        self.assertEqual(state['cargurus_photo_selection'][VIN]['status'], 'source_limited')

    def test_missing_gallery_has_priority(self, _):
        row, state = fixture()
        missing = dict(row, vin='JTJHT00W664008364', photo_urls=[], photo_url='')
        state['listings']['missing'] = missing
        client = Photos()
        enrich_photos(client, state, [], NOW, verify_gallery=lambda p: True)
        self.assertTrue(client.calls[0].endswith(missing['vin']))

    def test_no_extra_calls_after_daily_or_monthly_budget(self, _):
        for usage in ({'photo_day': NOW[:10], 'photo_calls_today': 100}, {'calls': 900}):
            row, state = fixture()
            state['autodev_usage'].update(usage)
            client = Photos()
            enrich_photos(client, state, [], NOW, verify_gallery=lambda p: True)
            self.assertEqual(client.calls, [])
            self.assertEqual(row['photo_urls'], URLS[:8])

    def test_conflicting_identity_never_upgraded(self, _):
        row, state = fixture()
        state['listings']['conflict'] = dict(row, year=2007)
        client = Photos()
        enrich_photos(client, state, [], NOW, verify_gallery=lambda p: True)
        self.assertEqual(client.calls, [])
