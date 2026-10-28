import copy
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src'))
from autodev import Client, collect, parse_listing, enrich_photos
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

    @patch('autodev.time.sleep')
    def test_gallery_uses_spare_budget_and_retries_only_after_cooldown(self, _):
        row = parse_listing(self.item, 'LX470')
        class Photos:
            def get(self, url):
                return {'data': {'retail': ['https://retail.photos.vin/a.jpg',
                    'https://retail.photos.vin/b.jpg', 'https://evil.example/a.jpg']}}
        state = {'autodev_usage': {'month': NOW[:7], 'day': NOW[:10], 'calls': 100, 'calls_today': 28}}
        self.assertEqual(enrich_photos(Photos(), state, [row], NOW), 1)
        self.assertEqual(len(row['photo_urls']), 2)
        self.assertEqual(state['autodev_usage']['calls'], 101)
        self.assertEqual(state['autodev_usage']['calls_today'], 28)
        self.assertEqual(enrich_photos(Photos(), state, [parse_listing(self.item, 'LX470')], NOW), 0)

    @patch('autodev.time.sleep')
    def test_removed_photo_sets_and_monthly_budget_are_respected(self, _):
        class Photos:
            def get(self, url):
                return {'removedAt': '2026-01-01', 'data': {'retail': ['https://retail.photos.vin/a.jpg']}}
        state = {'autodev_usage': {'month': NOW[:7], 'day': NOW[:10], 'calls': 100, 'calls_today': 10}}
        row = parse_listing(self.item, 'LX470')
        self.assertEqual(enrich_photos(Photos(), state, [row], NOW), 0)
        self.assertNotIn('photo_urls', row)
        self.assertEqual(state['autodev_usage']['calls'], 101)
        self.assertEqual(enrich_photos(Photos(), state, [row], NOW), 0)

    @patch('autodev.time.sleep')
    def test_photo_backfill_reserves_inventory_budget_and_caps_batches(self, _):
        class Empty:
            count = 0
            def get(self, url):
                self.count += 1
                return {'data': {'retail': []}}
        rows = [{'vin': 'JTJHT00W' + str(i).zfill(9), 'status': 'active', 'source': 'autodev'} for i in range(150)]
        client = Empty()
        state = {'autodev_usage': {'month': NOW[:7], 'day': NOW[:10], 'calls': 100}}
        enrich_photos(client, state, rows, NOW)
        self.assertEqual(client.count, 50)
        enrich_photos(client, state, rows, NOW)
        self.assertEqual(client.count, 100)
        enrich_photos(client, state, rows, NOW)
        self.assertEqual(client.count, 100)
        # October 23: reserve 8 remaining days at the maximum 28 inventory calls/day.
        state = {'autodev_usage': {'month': NOW[:7], 'day': NOW[:10], 'calls': 676}}
        enrich_photos(client, state, rows, NOW)
        self.assertEqual(client.count, 100)

    @patch('autodev.time.sleep')
    def test_retry_queue_preserves_success_and_tracks_transient_failures(self, _):
        row = parse_listing(self.item, 'LX470')
        row['photo_urls'] = ['https://api.auto.dev/photos/retail/a.jpg', 'https://api.auto.dev/photos/retail/b.jpg']
        state = {'listings': {'autodev:test': row}, 'autodev_usage': {'month': NOW[:7], 'day': NOW[:10], 'calls': 10}}
        class Fails:
            def get(self, url): raise ValueError('Auto.dev HTTP 503; collection stopped')
        fresh = parse_listing(self.item, 'LX470')
        self.assertEqual(enrich_photos(Fails(), state, [fresh], NOW), 0)
        self.assertEqual(fresh['photo_urls'], row['photo_urls'])
        self.assertEqual(state['autodev_usage']['calls'], 10)
        self.assertEqual(state['autodev_photo_progress']['complete'], 1)
        state['listings'] = {}
        fresh = parse_listing(self.item, 'LX470')
        enrich_photos(Fails(), state, [fresh], NOW)
        record = state['autodev_photo_attempts'][fresh['vin']]
        self.assertEqual(record['status'], 'temporary_error')
        self.assertTrue(record['retry_at'].startswith('2026-10-24'))
        self.assertEqual(state['autodev_photo_progress']['waiting_retry'], 1)
        enrich_photos(Fails(), state, [fresh], NOW)
        self.assertEqual(state['autodev_usage']['calls'], 11)

    @patch('autodev.time.sleep')
    def test_empty_gallery_retries_after_a_week_and_legacy_queue_migrates(self, _):
        row = parse_listing(self.item, 'LX470')
        state = {'autodev_usage': {'month': NOW[:7], 'day': NOW[:10], 'calls': 10},
                 'autodev_photo_attempts': {row['vin']: '2026-10-01T20:00:00+00:00'}}
        class Empty:
            def get(self, url): return {'data': {'retail': []}}
        enrich_photos(Empty(), state, [row], NOW)
        record = state['autodev_photo_attempts'][row['vin']]
        self.assertEqual(record['attempts'], 2)
        self.assertEqual(record['status'], 'unavailable')
        self.assertTrue(record['retry_at'].startswith('2026-11-06'))
        self.assertEqual(state['autodev_photo_progress']['ready'], 0)

    def test_failed_response_does_not_claim_success(self):
        class Bad:
            def get(self, url): return {'error': 'unavailable'}
        rows, result = collect(Bad(), {}, NOW)
        self.assertEqual(rows, [])
        self.assertEqual(result['status'], 'partial')


if __name__ == '__main__':
    unittest.main()

