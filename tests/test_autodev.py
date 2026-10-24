import copy
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src'))
from autodev import Client, collect, parse_listing
from finder import normalize, clean_title_candidate, inventory_candidate, deal_rating, expire_unrefreshed_observations

NOW = '2026-10-23T20:00:00+00:00'


class AutoDevTests(unittest.TestCase):
    def setUp(self):
        # Synthetic response using the provider's documented nested response.
        self.item = {'vehicle': {'vin': 'JTJHT00W364008364', 'year': 2006, 'make': 'Lexus', 'model': 'LX'},
                     'retailListing': {'vdp': 'https://dealer.example/vehicle/123', 'price': 12000,
                                       'miles': 231700, 'dealer': 'Example dealer', 'city': 'Raleigh',
                                       'state': 'NC', 'zip': '27601'}}

    def test_listing_does_not_invent_clean_history(self):
        row = normalize(parse_listing(self.item, 'LX470'))
        self.assertEqual(row['asking_price'], 12000)
        self.assertEqual(row['mileage'], 231700)
        self.assertEqual(row['title_status'], 'unknown')
        self.assertFalse(clean_title_candidate(row))

    def test_visible_unknown_title_is_not_clean_and_has_no_deal_rating(self):
        row = normalize(parse_listing(self.item, 'LX470'))
        self.assertTrue(inventory_candidate(row))
        self.assertFalse(clean_title_candidate(row))
        self.assertEqual(deal_rating(row, []), {})
        row['title_status'] = 'salvage'
        self.assertFalse(inventory_candidate(row))
        row['title_status'] = 'unknown'
        row['quality_flags'] = 'vin_model_or_year_conflict'
        self.assertFalse(inventory_candidate(row))

    def test_history_counts_do_not_establish_clean_title(self):
        self.item['history'] = {'ownerCount': 3, 'accidentCount': 0}
        row = parse_listing(self.item, 'LX470')
        self.assertEqual(row['owners'], '3')
        self.assertEqual(row['accident_history'], 'No reported accidents')
        self.assertEqual(row['title_status'], 'unknown')

    def test_stale_api_observation_expires_without_claiming_sold(self):
        row = normalize(parse_listing(self.item, 'LX470'))
        row['last_seen'] = '2026-10-01T00:00:00+00:00'
        state = {'listings': {row['listing_key']: row}, 'history': []}
        expire_unrefreshed_observations(state, NOW, [])
        self.assertEqual(row['status'], 'unknown')

    def test_wrong_model_year_removed_and_unsafe_urls_rejected(self):
        for change in ('year', 'url', 'removed'):
            item = copy.deepcopy(self.item)
            if change == 'year': item['vehicle']['year'] = 2004
            if change == 'url': item['retailListing']['vdp'] = 'javascript:alert(1)'
            if change == 'removed': item['removedAt'] = '2026-10-22'
            with self.assertRaises(ValueError): parse_listing(item, 'LX470')

    def test_credentials_cannot_follow_other_hosts(self):
        with self.assertRaises(ValueError):
            Client('secret').get('https://evil.example/listings')

    def test_daily_gate_preserves_observation_time(self):
        class Fake:
            def get(self, url): return {'data': []}
        state = {}
        collect(Fake(), state, NOW)
        rows, result = collect(Fake(), state, '2026-10-23T23:00:00+00:00')
        self.assertEqual(state['autodev_usage']['calls'], 3)
        self.assertEqual(result['checked_at'], NOW)
        self.assertEqual(rows, [])

    @patch('autodev.time.sleep')
    def test_daily_and_monthly_caps_include_failed_calls(self, _):
        class Endless:
            count = 0
            def get(self, url):
                self.count += 1
                return {'data': [], 'links': {'next': f'/listings?page={self.count + 1}'}}
        state = {}
        collect(Endless(), state, NOW)
        self.assertEqual(state['autodev_usage']['calls'], 28)
        state = {'autodev_usage': {'month': '2026-10', 'calls': 899}}
        class Fails:
            def get(self, url): raise ValueError('Auto.dev HTTP 429; collection stopped')
        rows, result = collect(Fails(), state, NOW)
        self.assertEqual(state['autodev_usage']['calls'], 900)
        self.assertEqual(rows, [])
        self.assertEqual(result['status'], 'partial')

    def test_rejected_record_warns_without_failing_complete_collection(self):
        class Skipped:
            def get(self, url): return {'data': [{'vehicle': {}}]}
        rows, result = collect(Skipped(), {}, NOW)
        self.assertEqual(rows, [])
        self.assertEqual(result['status'], 'warning')
        self.assertIn('3 incomplete or out-of-scope records excluded', result['detail'])

    def test_live_runner_reads_api_secret_and_preserves_unknown_title(self):
        import json, tempfile
        import finder
        row = parse_listing(self.item, 'LX470')
        with tempfile.TemporaryDirectory(dir=Path(__file__).resolve().parents[1]) as directory:
            root = Path(directory)
            (root / 'sources').mkdir()
            (root / 'sources/config.json').write_text(json.dumps({'sources': [{'id':'autodev', 'type':'autodev', 'enabled': True}]}))
            with patch.dict('os.environ', {'AUTODEV_API_KEY':'test-key'}), \
                 patch('finder.BrowserPhotoFetcher') as browser, \
                 patch('finder.backfill_listing_photos', return_value=[]), \
                 patch('autodev.Client') as client, \
                 patch('autodev.collect', return_value=([row], {'status':'ok', 'detail':'test'})), \
                 patch('finder.save') as save:
                browser.return_value.galleries = {}
                browser.return_value.errors = {}
                self.assertEqual(finder.run(root, live=True), 0)
                client.assert_called_once_with('test-key')
                saved = save.call_args.args[1]['listings']
                self.assertEqual(next(iter(saved.values()))['title_status'], 'unknown')

    def test_failed_response_does_not_claim_success(self):
        class Bad:
            def get(self, url): return {'error': 'unavailable'}
        rows, result = collect(Bad(), {}, NOW)
        self.assertEqual(rows, [])
        self.assertEqual(result['status'], 'partial')


if __name__ == '__main__':
    unittest.main()

