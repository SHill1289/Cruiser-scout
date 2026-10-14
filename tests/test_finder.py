import copy
import contextlib
import io
import json
import sys
import shutil
import uuid
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src'))
from finder import (accident_category, add_listing_photo, cache_public_photos, correct_ambiguous_accident_history,
                    cargurus_condition_claims, condition_claims, collect_cargurus, collect_truecar,
                    gallery_image_urls, gallery_urls_in_page,
                    normalize, update, master_rows, merge_public_listings, parse_cargurus, parse_bat,
                    backfill_listing_dates,
                    apply_vehicle_history_overrides, bat_listing_urls, bat_sale_date,
                    cargurus_listing_ids, cargurus_photo, parse_historical_sale,
                    clean_title_candidate, csv_text, deal_rating, listing_extras,
                    parse_listing_photo, parse_truecar, remove_unverified_cargurus_owner_inferences,
                    run, rust_location_evidence, valid_vin, load_location_points, listing_coordinates)

NOW = '2026-09-15T22:00:00+00:00'


@contextlib.contextmanager
def temporary_workspace():
    # Default mkdir permissions also work with restricted Windows app tokens.
    base = Path(__file__).resolve().parent
    root = base / ('test-workspace-' + uuid.uuid4().hex)
    root.mkdir()
    try:
        yield root
    finally:
        assert root.resolve().is_relative_to(base)
        shutil.rmtree(root)


def listing(**changes):
    return normalize(dict(source='test', source_listing_id='1', year=2006,
                          vin='JTJHT00W464018109', listing_url='https://example.com/car/1',
                          status='active', asking_price=22000, mileage=186383, **changes))


class DatabaseTests(unittest.TestCase):
    def setUp(self):
        self.state = {'listings': {}, 'history': [], 'imports': []}
        self.row = listing()

    def test_vin_validation(self):
        self.assertTrue(valid_vin(self.row['vin']))
        self.assertFalse(valid_vin('JTJHT00W464018100'))
        bad = normalize({**self.row, 'vin': 'JTJHT00W464018100'})
        self.assertTrue(bad['vehicle_key'].startswith('listing:'))

    def test_lx570_years_and_vin(self):
        row = normalize({**self.row, 'model': 'LX570', 'year': 2016, 'vin': 'JTJHY7AX2G4189718'})
        self.assertEqual(row['vehicle_key'], 'vin:JTJHY7AX2G4189718')
        early = normalize({**row, 'year': 2011, 'vin': 'JTJHY7AXXB4080657'})
        self.assertNotIn('vin_model_or_year_conflict', early['quality_flags'])
        self.assertIn('vin_model_or_year_conflict', normalize({**row, 'year': 2015})['quality_flags'])
        for model, year in [('LX570', 2010), ('LX570', 2017), ('LX470', 2011), ('Land Cruiser', 2016)]:
            with self.subTest(model=model, year=year), self.assertRaises(ValueError):
                normalize({**self.row, 'model': model, 'make': 'Toyota' if model == 'Land Cruiser' else 'Lexus', 'year': year})

    def test_lx570_scope_does_not_remove_older_models(self):
        lc = {**self.row, 'source_listing_id': 'lc', 'make': 'Toyota', 'model': 'Land Cruiser', 'vin': 'JTEHT05J862085738'}
        lx = {**self.row, 'source_listing_id': '570', 'model': 'LX570', 'year': 2016, 'vin': 'JTJHY7AX2G4189718'}
        update(self.state, [self.row, lc, lx], NOW)
        for _ in range(3):
            update(self.state, [], NOW, [('test', 2016, 'LX570')])
        self.assertEqual(self.state['listings']['test:570']['status'], 'removed')
        self.assertEqual(self.state['listings']['test:lc']['missing_checks'], 0)
        self.assertEqual(self.state['listings']['test:1']['missing_checks'], 0)

    def test_land_cruiser_identity_and_vin(self):
        row = normalize({**self.row, 'make': 'Toyota', 'model': 'Land Cruiser', 'vin': 'JTEHT05J862085738'})
        self.assertEqual(row['model'], 'Land Cruiser')
        self.assertEqual(row['vehicle_key'], 'vin:JTEHT05J862085738')
        self.assertNotIn('vin_model_or_year_conflict', row['quality_flags'])
        wrong = normalize({**row, 'vin': self.row['vin']})
        self.assertIn('vin_model_or_year_conflict', wrong['quality_flags'])
        with self.assertRaises(ValueError):
            normalize({**row, 'model': '4Runner'})

    def test_model_scopes_do_not_remove_other_model(self):
        lc = {**self.row, 'make': 'Toyota', 'model': 'Land Cruiser',
              'vin': 'JTEHT05J862085738', 'source_listing_id': 'lc'}
        update(self.state, [self.row, lc], NOW)
        for _ in range(3):
            update(self.state, [], NOW, [('test', 2006, 'Land Cruiser')])
        self.assertEqual(self.state['listings']['test:lc']['status'], 'removed')
        self.assertEqual(self.state['listings']['test:1']['missing_checks'], 0)
        update(self.state, [], NOW, [('test', 2006, 'LX470')])
        self.assertEqual(self.state['listings']['test:1']['missing_checks'], 1)

    def test_deal_rating_keeps_models_separate(self):
        sales = [{'mileage': 180000, 'sale_price': 20000} for _ in range(3)]
        lc = {**self.row, 'model': 'Land Cruiser', 'mileage': 180000}
        self.assertEqual(deal_rating(lc, sales), {})
        sales += [{'model': 'Land Cruiser', 'mileage': 180000, 'sale_price': 30000} for _ in range(3)]
        self.assertEqual(deal_rating(lc, sales)['deal_median_price'], 30000)
        self.assertEqual(deal_rating({**self.row, 'mileage': 180000}, sales)['deal_median_price'], 20000)

    def test_listing_extras_excludes_standard_and_generic_features(self):
        features = ['Navigation System', 'Backup Camera', 'Leather Seats',
                    'DVD Entertainment System', 'CarPlay', 'Remote Start',
                    'Premium Package', 'DVD Entertainment System']
        self.assertEqual(listing_extras(features), 'CarPlay;Rear-seat DVD;Remote start')
        self.assertEqual(listing_extras([{'name': 'Night View'}, {'name': 'Moonroof'}]), 'Night View')
        self.assertEqual(listing_extras(None), '')

    def test_scope_filters_and_missing_vin(self):
        for field, value in [('year', 2005), ('make', 'Toyota'), ('model', 'LX570')]:
            with self.assertRaises(ValueError):
                normalize({**self.row, field: value})
        self.assertIn('missing_vin', normalize({**self.row, 'vin': ''})['quality_flags'])

    def test_accident_categories_require_explicit_evidence(self):
        self.assertEqual(accident_category('No reported accidents'), 'none')
        self.assertEqual(accident_category('1 reported accident'), 'reported')
        self.assertEqual(accident_category('Seller discloses prior accident'), 'reported')
        self.assertEqual(accident_category('No accident on history report; seller discloses prior accident'), 'reported')
        self.assertEqual(accident_category('Accident reported or history unavailable'), 'unavailable')
        self.assertEqual(accident_category('History unavailable'), 'unavailable')
        self.assertEqual(accident_category('Unknown'), 'unavailable')

    def test_old_ambiguous_accident_labels_are_corrected(self):
        old = {**self.row, 'accident_history': 'Accident reported or history unavailable'}
        state = {'listings': {'test:1': dict(old)}, 'history': [dict(old)]}
        correct_ambiguous_accident_history(state)
        self.assertEqual(state['listings']['test:1']['accident_history'], 'History unavailable')
        self.assertEqual(state['history'][0]['accident_history'], 'History unavailable')

    def test_duplicate_observations_do_not_duplicate_history(self):
        update(self.state, [self.row, self.row], NOW)
        update(self.state, [self.row], '2026-09-16T22:00:00+00:00')
        self.assertEqual(len(self.state['history']), 1)
        self.assertEqual(len(self.state['listings']), 1)

    def test_listing_and_finder_dates_are_kept_separate(self):
        row = {**self.row, 'source_days_on_market': 5}
        update(self.state, [row], NOW)
        saved = self.state['listings']['test:1']
        self.assertEqual(saved['listed_at'], '2026-09-10')
        self.assertTrue(saved['listed_at_is_estimated'])
        self.assertEqual(saved['first_seen'], NOW)
        update(self.state, [{**row, 'source_days_on_market': 6}], '2026-09-16T22:00:00+00:00')
        self.assertEqual(self.state['listings']['test:1']['listed_at'], '2026-09-10')

    def test_exact_listing_date_is_preserved(self):
        update(self.state, [{**self.row, 'listed_at': '2026-09-01', 'listed_at_is_estimated': False}], NOW)
        saved = self.state['listings']['test:1']
        self.assertEqual(saved['listed_at'], '2026-09-01')
        self.assertFalse(saved['listed_at_is_estimated'])

    def test_photo_is_preserved_when_a_refresh_has_no_image(self):
        update(self.state, [{**self.row, 'photo_url': 'https://images.example.com/lx470.jpg'}], NOW)
        update(self.state, [self.row], '2026-09-16T22:00:00+00:00')
        self.assertEqual(self.state['listings']['test:1']['photo_url'],
                         'https://images.example.com/lx470.jpg')

    def test_gallery_is_validated_and_preserved_across_refreshes(self):
        photos = ['https://images.example.com/one.jpg', 'https://images.example.com/two.jpg']
        with self.assertRaises(ValueError):
            normalize({**self.row, 'photo_urls': ['http://images.example.com/photo.jpg']})
        update(self.state, [{**self.row, 'photo_url': photos[0], 'photo_urls': photos + [photos[0]]}], NOW)
        update(self.state, [self.row], '2026-09-16T22:00:00+00:00')
        self.assertEqual(self.state['listings']['test:1']['photo_urls'], photos)

    def test_gallery_collection_from_listing_html(self):
        photos = ['https://static.cargurus.com/images/forsale/one-1024x768.jpeg',
                  'https://static.cargurus.com/images/forsale/two-1024x768.jpeg']
        class Fetcher:
            def get(self, url):
                return ''.join('<img src="' + photo + '">' for photo in photos)
        row = {**self.row, 'source': 'cargurus', 'source_listing_id': '1'}
        self.assertEqual(add_listing_photo(row, Fetcher()), '')
        self.assertEqual(row['photo_urls'], photos)
        self.assertEqual(row['photo_url'], photos[0])

    def test_condition_claims_require_explicit_listing_evidence(self):
        generic = condition_claims(['Standard AHC, navigation, and a reliable timing belt are included.'])
        self.assertFalse(generic)
        claims = condition_claims([
            'A timing belt service was performed in April 2022. Corrosion is visible on the underside.',
            'The seller notes AHC is not working and service records are included.',
            'Factory options include navigation. An aftermarket lift kit was installed.',
        ])
        self.assertEqual(claims['timing_belt_status'], 'Service reported')
        self.assertEqual(claims['rust_status'], 'Rust reported')
        self.assertEqual(claims['ahc_status'], 'Issue reported')
        self.assertEqual(claims['navigation_status'], 'Advertised; operation unknown')
        self.assertEqual(claims['service_records_status'], 'Records mentioned')
        self.assertEqual(claims['modifications_status'], 'Modification reported')
        self.assertEqual(condition_claims(['No rust visible.'])['rust_status'], 'No rust reported by listing')
        self.assertEqual(condition_claims(['The timing belt needs replacement.'])['timing_belt_status'], 'Service due per listing')

    def test_dealer_description_excludes_generic_equipment_and_persists(self):
        page = ('<h3>Dealer&#x27;s description</h3><div><p>Documented maintenance and no concerning rust.</p></div>'
                '<h3>Additional Information</h3><div>Navigation System AHC working</div>')
        claims = cargurus_condition_claims(page)
        self.assertEqual(claims['service_records_status'], 'Records mentioned')
        self.assertEqual(claims['rust_status'], 'No rust reported by listing')
        self.assertNotIn('navigation_status', claims)
        self.assertNotIn('ahc_status', claims)
        first = {**self.row, **claims}
        update(self.state, [first], NOW)
        update(self.state, [self.row], '2026-09-16T22:00:00+00:00')
        self.assertEqual(self.state['listings']['test:1']['rust_evidence'], claims['rust_evidence'])

    def test_browser_dealer_description_is_collected_with_existing_gallery(self):
        class Fetcher:
            def get(self, url):
                return '<html><body>Navigation System</body></html>'
        class Browser:
            def description(self, url):
                return 'The timing belt was replaced in 2021. AHC is working.'
        row = {**self.row, 'source': 'cargurus', 'source_listing_id': '1',
               'photo_url': '',
               'photo_urls': ['https://static.cargurus.com/images/forsale/one.jpg',
                              'https://static.cargurus.com/images/forsale/two.jpg']}
        self.assertEqual(add_listing_photo(row, Fetcher(), Browser()), '')
        self.assertEqual(len(row['photo_urls']), 2)
        self.assertEqual(row['timing_belt_status'], 'Service reported')
        self.assertEqual(row['ahc_status'], 'Working per listing')
        self.assertEqual(row['navigation_status'], '')

    def test_truecar_gallery_photos_are_served_locally(self):
        base = 'https://listings-prod.tcimg.net/listings/123/45/JTJHT00W074027827/'
        rows = [{'source': 'truecar', 'source_listing_id': 'JTJHT00W074027827',
                 'photo_url': base + '001.jpg',
                 'photo_urls': [base + '001.jpg?h=33', base + '002.jpg?h=33']}]
        with temporary_workspace() as root:
            cache_public_photos(root, rows, opener=lambda request, timeout: io.BytesIO(b'\xff\xd8\xfftest'))
            self.assertEqual(len(rows[0]['photo_urls']), 2)
            self.assertEqual(rows[0]['photo_url'], rows[0]['photo_urls'][0])
            self.assertTrue(all((root / 'web' / url).exists() for url in rows[0]['photo_urls']))

    def test_old_database_listing_date_is_backfilled(self):
        old = dict(self.row)
        old.update(first_seen=NOW, source_days_on_market=5)
        state = {'listings': {'test:1': old}, 'history': []}
        backfill_listing_dates(state)
        self.assertEqual(state['listings']['test:1']['listed_at'], '2026-09-10')
        self.assertTrue(state['listings']['test:1']['listed_at_is_estimated'])

    def test_same_vin_across_sources_and_price_history(self):
        update(self.state, [self.row, {**self.row, 'source': 'another'}], NOW)
        self.assertEqual(len(master_rows(self.state)), 1)
        update(self.state, [{**self.row, 'asking_price': 21000}], '2026-09-16T22:00:00+00:00')
        self.assertEqual(self.state['history'][0]['asking_price'], 22000)
        self.assertEqual(self.state['history'][-1]['asking_price'], 21000)

    def test_public_merge_requires_valid_vin_and_preserves_source_ids(self):
        same = normalize({**self.row, 'source': 'another', 'source_listing_id': '2',
                          'listing_url': 'https://example.com/car/2'})
        unknown_a = normalize({**self.row, 'vin': '', 'source_listing_id': '3',
                               'listing_url': 'https://example.com/car/3'})
        unknown_b = normalize({**self.row, 'vin': '', 'source_listing_id': '4',
                               'listing_url': 'https://example.com/car/4'})
        merged = merge_public_listings([self.row, same, unknown_a, unknown_b])
        self.assertEqual(len(merged), 3)
        pair = next(group for group in merged if group['listing_count'] == 2)
        self.assertEqual(pair['listing_keys'], ['another:2', 'test:1'])
        self.assertEqual(pair['sources'], ['another', 'test'])
        self.assertEqual(sum(group['listing_count'] for group in merged), 4)

    def test_rust_location_tracks_current_and_prior_vin_observations(self):
        update(self.state, [{**self.row, 'state': 'New York'}], NOW)
        update(self.state, [{**self.row, 'state': 'GA'}], '2026-09-16T22:00:00+00:00')
        current = self.state['listings']['test:1']
        self.assertEqual(rust_location_evidence(current, self.state), {
            'current_state': '', 'also_listed_states': [], 'previously_listed_states': ['NY']})
        other = {**self.row, 'source': 'other', 'listing_key': 'other:1', 'state': 'WI'}
        update(self.state, [other], '2026-09-17T22:00:00+00:00')
        self.assertEqual(rust_location_evidence(current, self.state)['also_listed_states'], ['WI'])
        self.assertEqual(rust_location_evidence(self.state['listings']['other:1'], self.state)['current_state'], 'WI')

    def test_rust_location_never_links_different_trucks_without_valid_vin(self):
        first = normalize({**self.row, 'vin': '', 'state': 'OH'})
        second = normalize({**self.row, 'vin': '', 'source': 'other',
                            'source_listing_id': '2', 'listing_url': 'https://example.com/car/2',
                            'state': 'GA'})
        update(self.state, [first, second], NOW)
        self.assertEqual(rust_location_evidence(self.state['listings']['other:2'], self.state), {
            'current_state': '', 'also_listed_states': [], 'previously_listed_states': []})

    def test_failures_and_partial_snapshots_never_remove(self):
        update(self.state, [self.row], NOW)
        for _ in range(5):
            update(self.state, [], NOW)
        self.assertEqual(self.state['listings']['test:1']['status'], 'active')

    def test_three_complete_absences_remove_then_reappear(self):
        update(self.state, [self.row], NOW)
        for n in range(3):
            update(self.state, [], f'2026-09-{16+n}T22:00:00+00:00', [('test', 2006)])
        self.assertEqual(self.state['listings']['test:1']['status'], 'removed')
        self.assertEqual(self.state['listings']['test:1']['last_seen'], NOW)
        update(self.state, [self.row], '2026-09-19T22:00:00+00:00')
        self.assertEqual(self.state['history'][-1]['event'], 'reappeared')
        self.assertEqual(self.state['listings']['test:1']['first_seen'], NOW)

    def test_year_scopes_do_not_interfere(self):
        update(self.state, [self.row], NOW)
        update(self.state, [], NOW, [('test', 2007)])
        self.assertEqual(self.state['listings']['test:1']['missing_checks'], 0)

    def test_mileage_conflicts_flagged(self):
        update(self.state, [self.row, {**self.row, 'source': 'other', 'mileage': 96000}], NOW)
        self.assertIn('cross_source_mileage_conflict', master_rows(self.state)[0]['quality_flags'])
        update(self.state, [{**self.row, 'mileage': 100000}], NOW)
        self.assertIn('mileage_decreased', self.state['history'][-1]['quality_flags'])

    def test_missing_vin_later_resolved(self):
        update(self.state, [{**self.row, 'vin': ''}], NOW)
        update(self.state, [self.row], NOW)
        self.assertEqual(len(master_rows(self.state)), 1)
        self.assertTrue(master_rows(self.state)[0]['vehicle_key'].startswith('vin:'))

    def test_csv_formula_safety(self):
        self.assertIn("'=HYPERLINK", csv_text([{'seller': '=HYPERLINK(1)'}], ['seller']))

    def test_deal_quality_uses_mileage_band_median(self):
        sales = [
            {'mileage': 160000, 'sale_price': 20000},
            {'mileage': 190000, 'sale_price': 22000},
            {'mileage': 240000, 'sale_price': 24000},
            {'mileage': 90000, 'sale_price': 40000},
        ]
        great = deal_rating({**self.row, 'asking_price': 18000, 'mileage': 180000}, sales)
        fair = deal_rating({**self.row, 'asking_price': 22000, 'mileage': 180000}, sales)
        bad = deal_rating({**self.row, 'asking_price': 26000, 'mileage': 180000}, sales)
        self.assertEqual(great['deal_quality'], 'great')
        self.assertEqual(fair['deal_quality'], 'fair')
        self.assertEqual(bad['deal_quality'], 'bad')
        self.assertEqual(fair['deal_median_price'], 22000)
        self.assertEqual(fair['deal_comparable_count'], 3)

    def test_deal_quality_requires_three_comparables(self):
        sales = [{'mileage': 160000, 'sale_price': 20000}, {'mileage': 190000, 'sale_price': 22000}]
        self.assertEqual(deal_rating(self.row, sales), {})
        self.assertEqual(deal_rating({**self.row, 'status': 'sold'}, sales * 2), {})

    def test_unchanged_import_does_not_refresh_last_seen(self):
        with temporary_workspace() as folder:
            root = Path(folder)
            (root / 'sources').mkdir()
            (root / 'imports').mkdir()
            (root / 'sources/config.json').write_text('{"sources": []}')
            (root / 'imports/one.json').write_text(json.dumps([self.row]))
            run(root, live=False)
            state = json.loads((root / 'data/database.json').read_text())
            state['listings']['test:1']['last_seen'] = NOW
            (root / 'data/database.json').write_text(json.dumps(state))
            run(root, live=False)
            saved = json.loads((root / 'data/database.json').read_text())
            self.assertEqual(saved['listings']['test:1']['last_seen'], NOW)
            self.assertEqual(len(saved['history']), 1)

    def test_web_inventory_contains_only_clean_title_candidates(self):
        with temporary_workspace() as folder:
            root = Path(folder)
            (root / 'sources').mkdir()
            (root / 'imports').mkdir()
            (root / 'sources/config.json').write_text('{"sources": []}')
            clean = {**self.row, 'source_listing_id': 'clean',
                     'reported_extras': 'Rear-seat DVD',
                     'timing_belt_status': 'Service reported', 'timing_belt_evidence': 'The timing belt was replaced.',
                     'title_status': 'clean-title candidate'}
            unknown = {**self.row, 'source_listing_id': 'unknown',
                       'listing_url': 'https://example.com/car/2',
                       'title_status': 'unknown'}
            sold = {**self.row, 'source_listing_id': 'sold',
                    'listing_url': 'https://example.com/car/3', 'status': 'sold',
                    'title_status': 'clean title', 'asking_price': None, 'sold_price': 18000}
            ended = {**self.row, 'source_listing_id': 'ended',
                     'listing_url': 'https://example.com/car/4', 'status': 'ended',
                     'category': 'auction', 'title_status': 'clean title',
                     'asking_price': None, 'current_bid': 12000,
                     'auction_ends_at': NOW, 'bid_observed_at': NOW}
            (root / 'imports/one.json').write_text(json.dumps([clean, unknown, sold, ended]))
            run(root, live=False)
            public = json.loads((root / 'web/inventory.json').read_text())
            self.assertEqual(public['summary']['active_listings'], 1)
            self.assertEqual(public['summary']['visible_vehicles'], 1)
            self.assertEqual(public['vehicles'][0]['listing_count'], 3)
            self.assertEqual({row['listing_key'] for row in public['listings']},
                             {'test:clean', 'test:sold', 'test:ended'})
            self.assertEqual(public['summary']['sold'], 1)
            self.assertEqual(public['summary']['ended_auctions'], 1)
            ended_public = next(row for row in public['listings'] if row['status'] == 'ended')
            self.assertEqual(ended_public['bid_observed_at'], NOW)
            self.assertIn('listed_at', public['listings'][0])
            self.assertIn('first_seen', public['listings'][0])
            self.assertEqual(next(row for row in public['listings'] if row['listing_key'] == 'test:clean')['reported_extras'], 'Rear-seat DVD')
            self.assertEqual(next(row for row in public['listings'] if row['listing_key'] == 'test:clean')['timing_belt_status'], 'Service reported')
            self.assertEqual(next(row for row in public['listings'] if row['listing_key'] == 'test:clean')['accident_category'], 'unavailable')
            self.assertNotIn('vin_specs', public['listings'][0])
            self.assertNotIn('notes', public['listings'][0])

    def test_verified_owner_override_applies_by_vin(self):
        with temporary_workspace() as folder:
            root = Path(folder)
            (root / 'overrides').mkdir()
            (root / 'overrides/vehicle_history.json').write_text(json.dumps({
                self.row['vin']: {
                    'owners': 3,
                    'source': 'CarGurus listing detail',
                    'verified_at': '2026-09-16',
                    'evidence_url': self.row['listing_url'],
                }
            }))
            state = {'listings': {'test:1': dict(self.row)}, 'history': []}
            apply_vehicle_history_overrides(root, state)
            saved = state['listings']['test:1']
            self.assertEqual(saved['owners'], '3')
            self.assertEqual(saved['owners_verified_at'], '2026-09-16')
            self.assertEqual(saved['owner_evidence_url'], self.row['listing_url'])

class ParserTests(unittest.TestCase):
    def clean_fixture(self):
        context = json.loads((Path(__file__).parent / 'fixtures/cargurus.json').read_text())
        criteria = context['state']['loaderData']['route']['search']['appliedFilterCriteria']
        criteria.update(hideLemon=True, hideFrameDamaged=True, hideSalvage=True, hideTheft=True)
        return context

    def test_live_structure_fixture(self):
        context = self.clean_fixture()
        context['state']['loaderData']['route']['search']['tiles'][0]['data']['vehicleFeatures'] = [
            'Navigation System', 'DVD Entertainment System', 'CarPlay']
        page = 'window.__remixContext = ' + json.dumps(context) + ';'
        rows, complete, total = parse_cargurus(page, 2006, {'458480534'})
        self.assertEqual(len(rows), 15)
        self.assertEqual(total, 15)
        self.assertTrue(complete)
        target = next(r for r in rows if r['vin'] == 'JTJHT00W464018109')
        self.assertEqual(target['asking_price'], 22777)
        self.assertEqual(target['base_price'], 21988)
        self.assertEqual(target['exterior_color'], 'Black Onyx')
        self.assertEqual(target['interior_color'], 'Gray')
        self.assertEqual(target['owners'], 'Unverified')
        self.assertEqual(target['accident_history'], 'No reported accidents')
        without_clear_history = next(r for r in rows if r['vin'] != target['vin'])
        self.assertEqual(without_clear_history['accident_history'], 'History unavailable')
        self.assertEqual(target['reported_extras'], 'CarPlay;Rear-seat DVD')
        self.assertTrue(clean_title_candidate(target))

    def lx570_cargurus_context(self):
        context = self.clean_fixture()
        search = context['state']['loaderData']['route']['search']
        search['appliedFilterCriteria'].update(startYear=2016, endYear=2016)
        search['tiles'] = search['tiles'][:3]
        for i, tile in enumerate(search['tiles']):
            tile['data']['ontologyData'].update(carYear='2016', trimName='570 4WD')
            tile['data']['vin'] = ''
        search.update(totalListings=3, pageCount=2, pageNumber=1, pageReceipt='receipt', pageAlignment='alignment')
        return context

    def test_cargurus_pagination_and_incomplete_snapshot(self):
        context = self.lx570_cargurus_context()
        search = context['state']['loaderData']['route']['search']
        second = copy.deepcopy(context)
        second['state']['loaderData']['route']['search'].update(tiles=search['tiles'][2:], pageNumber=2)
        search['tiles'] = search['tiles'][:2]
        calls = []
        class FakeFetcher:
            def get(self, url):
                calls.append(url)
                return 'window.__remixContext = ' + json.dumps(second if 'page=2' in url else context)
        rows, complete, total = collect_cargurus(FakeFetcher(), 'https://www.cargurus.com/test', 2016, 'LX570')
        self.assertTrue(complete)
        self.assertEqual(len(rows), total)
        self.assertTrue(all(row['model'] == 'LX570' for row in rows))
        self.assertIn('pageReceipt=receipt', calls[-1])
        second['state']['loaderData']['route']['search']['tiles'] = search['tiles']
        self.assertFalse(collect_cargurus(FakeFetcher(), 'https://www.cargurus.com/test', 2016, 'LX570')[1])
        second['state']['loaderData']['route']['search']['pageNumber'] = 1
        with self.assertRaisesRegex(ValueError, 'wrong result page'):
            collect_cargurus(FakeFetcher(), 'https://www.cargurus.com/test', 2016, 'LX570')

    def test_cargurus_empty_results_and_changing_totals(self):
        context = self.lx570_cargurus_context()
        search = context['state']['loaderData']['route']['search']
        search.update(totalListings=0, pageCount=0, tiles=[])
        class FakeFetcher:
            def get(self, url): return 'window.__remixContext = ' + json.dumps(context)
        self.assertEqual(collect_cargurus(FakeFetcher(), 'https://www.cargurus.com/test', 2016, 'LX570'), ([], True, 0))
        context = self.lx570_cargurus_context()
        second = copy.deepcopy(context)
        second['state']['loaderData']['route']['search'].update(pageNumber=2, totalListings=4)
        class ChangingFetcher:
            def get(self, url): return 'window.__remixContext = ' + json.dumps(second if 'page=2' in url else context)
        self.assertFalse(collect_cargurus(ChangingFetcher(), 'https://www.cargurus.com/test', 2016, 'LX570')[1])

    def truecar_lx570_page(self, offset, refs, total=3, has_next=False, clean=True):
        args = {'offset': offset, 'first': 2, 'filters': {'condition': 'USED',
            'year': {'min': 2011, 'max': 2016}, 'makeModelTrim': [{'makeSlug': 'lexus', 'modelSlug': 'lx', 'trimSlugs': ['lx-570']}]}}
        state = {'ROOT_QUERY': {'marketplaceListingSearch(' + json.dumps(args) + ')': {
            'totalCount': total, 'edges': [{'node': {'__ref': ref}} for ref in refs], 'pageInfo': {'hasNextPage': has_next}}}}
        for ref in refs:
            state[ref] = {'conditionHistory': {'isCleanTitle': clean}, 'vehicle': {
                'vin': ref, 'year': 2016, 'make': {'name': 'Lexus'}, 'style': {'trimName': 'LX 570'}}}
        return '<script id="__NEXT_DATA__" type="application/json">' + json.dumps(
            {'props': {'pageProps': {'__APOLLO_STATE__': state}}}) + '</script>'

    def test_truecar_lx570_pagination_and_clean_title_exclusions(self):
        first = self.truecar_lx570_page(0, ['a', 'b'], has_next=True)
        second = self.truecar_lx570_page(2, ['c'], clean=False)
        class FakeFetcher:
            def get(self, url): return second if 'page=2' in url else first
        rows, complete, total = collect_truecar(FakeFetcher(), 'https://www.truecar.com/test', NOW, 'LX570')
        self.assertTrue(complete)
        self.assertEqual(total, 3)
        self.assertEqual(len(rows), 2)
        self.assertTrue(all(row['model'] == 'LX570' for row in rows))
        second = self.truecar_lx570_page(2, ['a'])
        self.assertFalse(collect_truecar(FakeFetcher(), 'https://www.truecar.com/test', NOW, 'LX570')[1])
        second = self.truecar_lx570_page(0, ['c'])
        with self.assertRaises(ValueError):
            collect_truecar(FakeFetcher(), 'https://www.truecar.com/test', NOW, 'LX570')

    def test_lx570_auction_and_discovery(self):
        url = 'https://bringatrailer.com/listing/2011-lexus-lx570-1/'
        page = '<h1>2011 Lexus LX570</h1><div class="listing-intro">Bid to USD $25,000 Reserve not met<div class="listing-actions-stats">'
        row = parse_bat(page, url, NOW)
        self.assertEqual(row['model'], 'LX570')
        self.assertEqual(row['year'], 2011)
        self.assertEqual(bat_listing_urls('<a href="/listing/2011-lexus-lx570-1/">LX570</a>'
            '<a href="/listing/2017-lexus-lx570-1/">wrong year</a>'), {url})

    def test_cargurus_land_cruiser(self):
        context = self.clean_fixture()
        search = context['state']['loaderData']['route']['search']
        search['tiles'] = search['tiles'][:1]
        search['totalListings'] = 1
        data = search['tiles'][0]['data']
        data['ontologyData'].update(makeName='Toyota', modelName='Land Cruiser', trimName='4WD')
        data['vin'] = 'JTEHT05J862085738'
        page = 'window.__remixContext = ' + json.dumps(context)
        rows, complete, _ = parse_cargurus(page, 2006, model='Land Cruiser')
        self.assertTrue(complete)
        self.assertEqual(rows[0]['make'], 'Toyota')
        with self.assertRaises(ValueError):
            parse_cargurus(page, 2006)

    def test_land_cruiser_auction_and_archive(self):
        url = 'https://bringatrailer.com/listing/2006-toyota-land-cruiser-100/'
        page = ('<title>2006 Toyota Land Cruiser sold for $25,000 on May 13, 2026</title>'
                '<h1>2006 Toyota Land Cruiser UZJ100</h1><div class="listing-intro">Sold for USD $25,000'
                '<li>Chassis: JTEHT05J862085738</li><li>180k Miles</li><div class="listing-actions-stats">')
        row = parse_bat(page, url, NOW)
        self.assertEqual(row['model'], 'Land Cruiser')
        self.assertEqual(parse_historical_sale(page, url, NOW)['model'], 'Land Cruiser')
        self.assertEqual(bat_listing_urls('<a href="/listing/2006-toyota-land-cruiser-100/">LC</a>'
                         '<a href="/listing/2005-toyota-land-cruiser/">wrong year</a>'), {url})

    def test_cargurus_missing_mileage_keeps_complete_listing_batch(self):
        for mileage in (None, {}, {'value': None, 'unit': 'MILES'}, {'value': ''}):
            with self.subTest(mileage=mileage):
                context = self.clean_fixture()
                data = context['state']['loaderData']['route']['search']['tiles'][0]['data']
                data['mileageData'] = mileage
                rows, complete, total = parse_cargurus('window.__remixContext = ' + json.dumps(context), 2006)
                self.assertTrue(complete)
                self.assertEqual(len(rows), total)
                self.assertIsNone(rows[0]['mileage'])
        del data['mileageData']
        rows, complete, _ = parse_cargurus('window.__remixContext = ' + json.dumps(context), 2006)
        self.assertTrue(complete)
        self.assertIsNone(rows[0]['mileage'])

    def test_cargurus_populated_mileage_requires_miles(self):
        for unit in ('KILOMETERS', None):
            with self.subTest(unit=unit):
                context = self.clean_fixture()
                data = context['state']['loaderData']['route']['search']['tiles'][0]['data']
                data['mileageData'] = {'value': 100000, 'unit': unit}
                with self.assertRaisesRegex(ValueError, 'Unexpected mileage units.*458480534'):
                    parse_cargurus('window.__remixContext = ' + json.dumps(context), 2006)

    def test_truecar_clean_title_listing(self):
        vin = 'JTJHT00W074027827'
        listing_ref = 'ConsumerSummaryListing:test'
        dealer_ref = 'ListingDealership:test'
        search_key = ('marketplaceListingSearch({"filters":{"condition":"USED",'
                      '"makeModelTrim":[{"makeSlug":"lexus","modelSlug":"lx",'
                      '"trimSlugs":["lx-470"]}],"withinRadius":{"distance":5000,'
                      '"postalCode":"27106"},"year":{"max":2007,"min":2006}},'
                      '"first":30,"offset":0,"sort":"BEST_MATCH"})')
        state = {
            'ROOT_QUERY': {search_key: {'totalCount': 1, 'edges': [{'node': {'__ref': listing_ref}}],
                                       'pageInfo': {'hasNextPage': False}}},
            dealer_ref: {'name': 'Master Auto Group', 'location': {'geolocation': {'city': 'Raleigh', 'state': 'NC', 'postalCode': '27604'}}},
            listing_ref: {
                'pricing': {'listPrice': 21245}, 'dealership': {'__ref': dealer_ref},
                'galleryImages({"galleryImagesCount":2})': {'edges': [
                    {'node': {'url': 'https://images.example.com/lx.jpg'}},
                    {'node': {'url': 'https://images.example.com/rear.jpg'}}]},
                'conditionHistory': {'accidentCount': 1, 'ownerCount': 3, 'isCleanTitle': True},
                'vehicle': {'year': 2007, 'vin': vin, 'mileage': 198412,
                            'keyFeatures': ['Navigation', 'Night View'],
                            'make': {'name': 'Lexus'}, 'style': {'trimName': 'LX 470'},
                            'details': {'listedAt': '2026-09-16T00:45:00.000Z',
                                        'exteriorColorName': 'Crystal White', 'interiorColorName': 'Beige'}},
            },
        }
        page = '<script id="__NEXT_DATA__" type="application/json">' + json.dumps(
            {'props': {'pageProps': {'__APOLLO_STATE__': state}}}) + '</script>'
        rows, complete, total = parse_truecar(page, NOW)
        self.assertTrue(complete)
        self.assertEqual(total, 1)
        self.assertEqual(rows[0]['vin'], vin)
        self.assertEqual(rows[0]['postal_code'], '27604')
        self.assertEqual(rows[0]['owners'], '3')
        self.assertEqual(rows[0]['accident_history'], '1 reported accident')
        self.assertEqual(rows[0]['exterior_color'], 'Crystal White')
        self.assertEqual(rows[0]['listed_at'], '2026-09-16T00:45:00.000Z')

        self.assertEqual(rows[0]['reported_extras'], 'Night View')
        self.assertEqual(rows[0]['photo_urls'], ['https://images.example.com/lx.jpg',
                                                 'https://images.example.com/rear.jpg'])
        reordered = 'marketplaceListingSearch(' + json.dumps(
            json.loads(search_key[len('marketplaceListingSearch('):-1]), sort_keys=True) + ')'
        state['ROOT_QUERY'] = {reordered: state['ROOT_QUERY'][search_key]}
        page = '<script id="__NEXT_DATA__" type="application/json">' + json.dumps(
            {'props': {'pageProps': {'__APOLLO_STATE__': state}}}) + '</script>'
        self.assertTrue(parse_truecar(page, NOW)[1])
        broad = json.loads(reordered[len('marketplaceListingSearch('):-1])
        broad['filters']['withinRadius']['distance'] = 50
        state['ROOT_QUERY'] = {'marketplaceListingSearch(' + json.dumps(broad) + ')':
                               state['ROOT_QUERY'][reordered]}
        page = '<script id="__NEXT_DATA__" type="application/json">' + json.dumps(
            {'props': {'pageProps': {'__APOLLO_STATE__': state}}}) + '</script>'
        with self.assertRaises(ValueError):
            parse_truecar(page, NOW)

        nationwide = json.loads(reordered[len('marketplaceListingSearch('):-1])
        del nationwide['filters']['withinRadius']
        nationwide['filters']['fallbackStrategy'] = 'SIMPLE'
        result = state['ROOT_QUERY'][next(iter(state['ROOT_QUERY']))]
        def page_for(args, search_result=result):
            state['ROOT_QUERY'] = {'marketplaceListingSearch(' + json.dumps(args) + ')': search_result}
            return '<script id="__NEXT_DATA__" type="application/json">' + json.dumps(
                {'props': {'pageProps': {'__APOLLO_STATE__': state}}}) + '</script>'
        rows, complete, total = parse_truecar(page_for(nationwide), NOW)
        self.assertTrue(complete)
        self.assertEqual(rows[0]['vin'], vin)
        for extra in ({'withinRadius': None}, {'withinRadius': {}}, {'postalCode': '27106'},
                      {'year': {'min': 2005, 'max': 2007}}, {'makeModelTrim': []}):
            with self.subTest(extra=extra), self.assertRaises(ValueError):
                parse_truecar(page_for({**nationwide, 'filters': {**nationwide['filters'], **extra}}), NOW)
        self.assertFalse(parse_truecar(page_for(nationwide, {**result,
            'pageInfo': {'hasNextPage': True}}), NOW)[1])

    def test_truecar_land_cruiser(self):
        filters = {'condition': 'USED', 'makeModelTrim': [{'makeSlug': 'toyota', 'modelSlug': 'land-cruiser'}],
                   'year': {'min': 2006, 'max': 2007}}
        args = {'filters': filters, 'offset': 0, 'first': 30}
        state = {'ROOT_QUERY': {'marketplaceListingSearch(' + json.dumps(args) + ')': {
            'totalCount': 1, 'edges': [{'node': {'__ref': 'listing'}}], 'pageInfo': {'hasNextPage': False}}},
            'listing': {'conditionHistory': {'isCleanTitle': True}, 'vehicle': {
                'year': 2006, 'vin': 'JTEHT05J862085738', 'make': {'name': 'Toyota'},
                'model': {'name': 'Land Cruiser'}, 'mileage': 180000}}}
        page = '<script id="__NEXT_DATA__" type="application/json">' + json.dumps(
            {'props': {'pageProps': {'__APOLLO_STATE__': state}}}) + '</script>'
        rows, complete, total = parse_truecar(page, NOW, model='Land Cruiser')
        self.assertTrue(complete)
        self.assertEqual(total, 1)
        self.assertEqual(rows[0]['model'], 'Land Cruiser')
        with self.assertRaises(ValueError):
            parse_truecar(page, NOW)

    def test_location_points_prefer_dealer_zip_then_city_and_keep_unknown_unmapped(self):
        places, zips = load_location_points()
        city = listing_coordinates({'city': 'Marietta', 'state': 'GA'}, places, zips)
        self.assertEqual(city['location_precision'], 'city area')
        self.assertAlmostEqual(city['latitude'], 33.95356, places=4)
        zip_area = listing_coordinates({'city': 'Marietta', 'state': 'GA', 'postal_code': '27604'}, places, zips)
        self.assertEqual(zip_area['location_precision'], 'ZIP area')
        self.assertNotEqual(zip_area['latitude'], city['latitude'])
        self.assertIsNone(listing_coordinates({'city': 'Unknown Place', 'state': 'GA'}, places, zips)['latitude'])

    def test_social_photo_metadata(self):
        page = '<meta property="og:image" content="https://images.example.com/lx470.jpg?size=large&amp;crop=1">'
        self.assertEqual(parse_listing_photo(page),
                         'https://images.example.com/lx470.jpg?size=large&crop=1')
        preload = '<link rel="preload" as="image" href="https://static.cargurus.com/images/forsale/2026/08/lx470.jpeg">'
        self.assertEqual(parse_listing_photo(preload),
                         'https://static.cargurus.com/images/forsale/2026/08/lx470.jpeg')
        escaped = r'{"imageUrl":"https:\/\/static.cargurus.com\/images\/forsale\/lx470.jpg"}'
        self.assertEqual(parse_listing_photo(escaped),
                         'https://static.cargurus.com/images/forsale/lx470.jpg')

    def test_largest_cargurus_tile_photo(self):
        tile = {'logo': 'https://static.cargurus.com/images/dealer/logo.png',
                'pictures': ['https://static.cargurus.com/images/forsale/lx-64x48.jpeg',
                             {'url': 'https://static.cargurus.com/images/forsale/lx-1024x768.jpeg'}]}
        self.assertEqual(cargurus_photo(tile),
                         'https://static.cargurus.com/images/forsale/lx-1024x768.jpeg')
        self.assertEqual(cargurus_photo({'pictureData': {'url': '//images.example.com/lx.jpg'}}),
                         'https://images.example.com/lx.jpg')

    def test_gallery_thumbnails_use_larger_source_images(self):
        cargurus = 'https://static.cargurus.com/images/forsale/lx-296x222.jpeg'
        truecar = 'https://listings-prod.tcimg.net/listings/123/lx.jpg?auto=format&h=33&w=60'
        photos = gallery_image_urls([cargurus, cargurus, truecar,
                                    'https://static.cargurus.com/images/dealer/logo.png'])
        self.assertEqual(photos[0], cargurus.replace('-296x222.', '-1024x768.'))
        self.assertIn('h=675', photos[1])
        self.assertIn('w=1200', photos[1])
        self.assertEqual(len(photos), 2)

    def test_listing_html_gallery_excludes_other_vehicle_photos(self):
        lead = 'https://static.cargurus.com/images/forsale/2026/one-1024x768.jpeg'
        second = 'https://static.cargurus.com/images/forsale/2026/two-296x222.jpeg'
        unrelated = 'https://static.cargurus.com/images/forsale/2025/other-296x222.jpeg'
        page = '<img src="' + second + '"><img src="' + unrelated + '">'
        self.assertEqual(gallery_urls_in_page(page, 'cargurus', lead),
                         [lead, second.replace('-296x222.', '-1024x768.')])

    def test_partial_results_not_complete(self):
        context = self.clean_fixture()
        context['state']['loaderData']['route']['search']['pageCount'] = 2
        _, complete, _ = parse_cargurus('window.__remixContext = ' + json.dumps(context), 2006)
        self.assertFalse(complete)

    def test_unfiltered_results_are_rejected(self):
        context = json.loads((Path(__file__).parent / 'fixtures/cargurus.json').read_text())
        with self.assertRaises(ValueError):
            parse_cargurus('window.__remixContext = ' + json.dumps(context), 2006)

    def test_cargurus_owner_filter_inferences_are_removed(self):
        state = {'listings': {'cargurus:1': {**listing(), 'source': 'cargurus', 'owners': '1'}},
                 'history': [{**listing(), 'source': 'cargurus', 'owners': 'Multiple or unknown'}]}
        remove_unverified_cargurus_owner_inferences(state)
        self.assertEqual(state['listings']['cargurus:1']['owners'], 'Unverified')
        self.assertEqual(state['history'][0]['owners'], 'Unverified')

    def test_history_subset_must_be_complete_and_filtered(self):
        context = self.clean_fixture()
        search = context['state']['loaderData']['route']['search']
        search['appliedFilterCriteria']['hideMultipleOwners'] = True
        page = 'window.__remixContext = ' + json.dumps(context)
        self.assertEqual(len(cargurus_listing_ids(page, 2006, {'hideMultipleOwners': True})), 15)
        search['pageCount'] = 2
        with self.assertRaises(ValueError):
            cargurus_listing_ids('window.__remixContext = ' + json.dumps(context), 2006, {'hideMultipleOwners': True})

    def test_blocked_html_raises(self):
        with self.assertRaises(ValueError):
            parse_cargurus('<h1>Access denied</h1>', 2006)

    def test_auction_bid_is_not_asking_price(self):
        page = '<meta property="og:image" content="https://bringatrailer.com/lx470.jpg"><h1>2006 Lexus LX470</h1><div class="listing-intro"><span>Current Bid: USD $3,250</span><span data-until="1789585080"></span><li>Chassis: JTJHT00W964015853</li><li>209k Miles</li><b>Lot #263426</b><div class="listing-actions-stats">'
        row = parse_bat(page, 'https://bringatrailer.com/listing/2006-lexus-lx470-81/', NOW)
        self.assertEqual(row['status'], 'active')
        self.assertEqual(row['current_bid'], 3250)
        self.assertIsNone(row['asking_price'])
        self.assertEqual(row['mileage'], 209000)
        self.assertEqual(row['bid_observed_at'], NOW)
        self.assertTrue(row['mileage_is_approximate'])
        self.assertEqual(row['photo_url'], 'https://bringatrailer.com/lx470.jpg')
        row = parse_bat(page, row['listing_url'], '2026-09-20T22:00:00+00:00')
        self.assertEqual(row['status'], 'ended')

    def test_unsold_auction_is_not_sold(self):
        page = '<h1>2007 Lexus LX470</h1><div class="listing-intro">Bid to USD $12,000 Reserve not met<div class="listing-actions-stats">'
        row = parse_bat(page, 'https://bringatrailer.com/listing/2007-lexus-lx470-example/', NOW)
        self.assertEqual(row['status'], 'ended')
        self.assertIsNone(row['sold_price'])
        self.assertEqual(row['current_bid'], 12000)
        self.assertEqual(row['bid_observed_at'], NOW)

    def test_completed_sale_record_and_archive_links(self):
        page = ('<p>Service completed January 4, 2022</p>'
                '<title>2006 Lexus LX470 sold for $25,000 on May 13, 2026</title>'
                '<h1>2006 Lexus LX470</h1><div class="listing-intro">Sold for USD $25,000'
                '<div class="listing-actions-stats"></div><strong>Listing Details</strong><ul>'
                '<li>Chassis: JTJHT00W264012020</li><li>83k Miles</li></ul>')
        sale = parse_historical_sale(page, 'https://bringatrailer.com/listing/2006-lexus-lx470-38/', NOW)
        self.assertEqual(sale['sold_at'], '2026-05-13')
        self.assertEqual(sale['sale_price'], 25000)
        self.assertEqual(sale['mileage'], 83000)
        self.assertEqual(bat_sale_date('This Listing Sold May 13, 2026'), '2026-05-13')
        self.assertEqual(bat_sale_date('Service January 4, 2022. This Listing Sold for $25,000 on May 13, 2026'),
                         '2026-05-13')
        archive = '<a href="/listing/2007-lexus-lx470-57/">sold</a>'
        self.assertEqual(bat_listing_urls(archive),
                         {'https://bringatrailer.com/listing/2007-lexus-lx470-57/'})

    def test_bat_details_after_statistics(self):
        page = '<h1>2006 Lexus LX470</h1><div class="listing-intro">Current Bid: USD $3,250 <span data-until="1789585080"></span><div class="listing-actions-stats"></div><strong>Listing Details</strong><ul><li>Chassis: <a>JTJHT00W964015853</a></li><li>209k Miles</li><li>Black Onyx Paint</li><li>Ivory Leather Upholstery</li></ul><div class="post-excerpt"><p>Offered with an accident-free Carfax report and a clean New York title.</p></div>'
        row = parse_bat(page, 'https://bringatrailer.com/listing/2006-lexus-lx470-81/', NOW)
        self.assertEqual(row['vin'], 'JTJHT00W964015853')
        self.assertEqual(row['vehicle_key'], 'vin:JTJHT00W964015853')
        self.assertEqual(row['exterior_color'], 'Black Onyx')
        self.assertEqual(row['interior_color'], 'Ivory Leather')
        self.assertEqual(row['accident_history'], 'No reported accidents')
        self.assertEqual(row['title_status'], 'clean title')
        self.assertTrue(clean_title_candidate(row))

    def test_auction_condition_only_uses_listing_narrative(self):
        page = ('<h1>2006 Lexus LX470</h1><div class="listing-intro">Sold for USD $25,000'
                '<div class="listing-actions-stats"></div><div class="post-excerpt">'
                '<p>Factory AHC is standard equipment.</p><p><img src="photo.jpg" /></p>'
                '<p>A timing belt service was performed in April 2022.</p>'
                '<p>Corrosion is visible on the underside.</p></div>'
                '<div class="comments"><p>AHC works and navigation is broken.</p></div>')
        row = parse_bat(page, 'https://bringatrailer.com/listing/2006-lexus-lx470-81/', NOW)
        self.assertEqual(row['timing_belt_status'], 'Service reported')
        self.assertEqual(row['rust_status'], 'Rust reported')
        self.assertEqual(row['ahc_status'], '')
        self.assertEqual(row['navigation_status'], '')


if __name__ == '__main__':
    unittest.main()
