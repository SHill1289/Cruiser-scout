import contextlib
import json
import sys
import shutil
import uuid
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src'))
from finder import (accident_category, correct_ambiguous_accident_history,
                    normalize, update, master_rows, parse_cargurus, parse_bat,
                    backfill_listing_dates,
                    apply_vehicle_history_overrides, bat_listing_urls, bat_sale_date,
                    cargurus_listing_ids, cargurus_photo, parse_historical_sale,
                    clean_title_candidate, csv_text, deal_rating, listing_extras,
                    parse_listing_photo, parse_truecar, remove_unverified_cargurus_owner_inferences,
                    run, rust_location_evidence, valid_vin)

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
            self.assertEqual({row['listing_key'] for row in public['listings']},
                             {'test:clean', 'test:sold', 'test:ended'})
            self.assertEqual(public['summary']['sold'], 1)
            self.assertEqual(public['summary']['ended_auctions'], 1)
            ended_public = next(row for row in public['listings'] if row['status'] == 'ended')
            self.assertEqual(ended_public['bid_observed_at'], NOW)
            self.assertIn('listed_at', public['listings'][0])
            self.assertIn('first_seen', public['listings'][0])
            self.assertEqual(next(row for row in public['listings'] if row['listing_key'] == 'test:clean')['reported_extras'], 'Rear-seat DVD')
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
            dealer_ref: {'name': 'Master Auto Group', 'location': {'geolocation': {'city': 'Raleigh', 'state': 'NC'}}},
            listing_ref: {
                'pricing': {'listPrice': 21245}, 'dealership': {'__ref': dealer_ref},
                'galleryImages({"galleryImagesCount":1})': {'edges': [{'node': {'url': 'https://images.example.com/lx.jpg'}}]},
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
        self.assertEqual(rows[0]['owners'], '3')
        self.assertEqual(rows[0]['accident_history'], '1 reported accident')
        self.assertEqual(rows[0]['exterior_color'], 'Crystal White')
        self.assertEqual(rows[0]['listed_at'], '2026-09-16T00:45:00.000Z')
        self.assertEqual(rows[0]['reported_extras'], 'Night View')
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


if __name__ == '__main__':
    unittest.main()
