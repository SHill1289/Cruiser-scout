import contextlib
import json
import sys
import shutil
import uuid
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src'))
from finder import (normalize, update, master_rows, parse_cargurus, parse_bat,
                    apply_vehicle_history_overrides, cargurus_listing_ids,
                    clean_title_candidate, csv_text, enrich_vehicle_history,
                    owner_count_from_history,
                    remove_unverified_cargurus_owner_inferences, run, valid_vin)

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

    def test_scope_filters_and_missing_vin(self):
        for field, value in [('year', 2005), ('make', 'Toyota'), ('model', 'LX570')]:
            with self.assertRaises(ValueError):
                normalize({**self.row, field: value})
        self.assertIn('missing_vin', normalize({**self.row, 'vin': ''})['quality_flags'])

    def test_duplicate_observations_do_not_duplicate_history(self):
        update(self.state, [self.row, self.row], NOW)
        update(self.state, [self.row], '2026-09-16T22:00:00+00:00')
        self.assertEqual(len(self.state['history']), 1)
        self.assertEqual(len(self.state['listings']), 1)

    def test_same_vin_across_sources_and_price_history(self):
        update(self.state, [self.row, {**self.row, 'source': 'another'}], NOW)
        self.assertEqual(len(master_rows(self.state)), 1)
        update(self.state, [{**self.row, 'asking_price': 21000}], '2026-09-16T22:00:00+00:00')
        self.assertEqual(self.state['history'][0]['asking_price'], 22000)
        self.assertEqual(self.state['history'][-1]['asking_price'], 21000)

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
                     'title_status': 'clean-title candidate'}
            unknown = {**self.row, 'source_listing_id': 'unknown',
                       'listing_url': 'https://example.com/car/2',
                       'title_status': 'unknown'}
            (root / 'imports/one.json').write_text(json.dumps([clean, unknown]))
            run(root, live=False)
            public = json.loads((root / 'web/inventory.json').read_text())
            self.assertEqual(public['summary']['active_listings'], 1)
            self.assertEqual([row['listing_key'] for row in public['listings']], ['test:clean'])
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

    def test_vehicle_history_owner_count_requires_coverage(self):
        result = {'metadata': {'vin': self.row['vin'], 'coverage': {'availableSections': ['ownership']}},
                  'report': {'ownership': [{'ownerNumber': 1}, {'ownerNumber': 3}]}}
        self.assertEqual(owner_count_from_history(result, self.row['vin']), 3)
        result['metadata']['coverage']['availableSections'] = []
        self.assertIsNone(owner_count_from_history(result, self.row['vin']))

    def test_cached_vehicle_history_is_applied_without_new_purchase(self):
        class FakeClient:
            def __init__(self):
                self.created = []

            def create_report(self, vin):
                self.created.append(vin)
                return {'id': str(uuid.uuid4()), 'vin': vin, 'status': 'queued', 'hasResult': False}

            def get_report(self, report_id):
                return {'status': 'completed', 'hasResult': True}

            def get_result(self, report_id):
                return {'metadata': {'vin': self_vin, 'provider': 'test-provider',
                                     'retrievedAt': '2026-09-16T12:00:00Z',
                                     'coverage': {'availableSections': ['ownership']}},
                        'report': {'ownership': [{'ownerNumber': 1}, {'ownerNumber': 3}]}}

        self_vin = self.row['vin']
        with temporary_workspace() as folder:
            root = Path(folder)
            (root / 'data').mkdir()
            report_id = str(uuid.uuid4())
            (root / 'data/vehicle_history_cache.json').write_text(json.dumps({
                'version': 1, 'reports': {self_vin: {'report_id': report_id, 'status': 'queued'}}
            }))
            state = {'listings': {'test:1': {**self.row, 'title_status': 'clean-title candidate'}},
                     'history': []}
            client = FakeClient()
            health = enrich_vehicle_history(root, state, client, 0, NOW)
            self.assertEqual(state['listings']['test:1']['owners'], '3')
            self.assertEqual(state['listings']['test:1']['owners_verified_at'], '2026-09-16')
            self.assertEqual(client.created, [])
            self.assertEqual(health['status'], 'ok')

    def test_vehicle_history_purchase_limit_is_enforced(self):
        class FakeClient:
            def __init__(self):
                self.created = []

            def create_report(self, vin):
                self.created.append(vin)
                return {'id': str(uuid.uuid4()), 'vin': vin, 'status': 'queued', 'hasResult': False}

        with temporary_workspace() as folder:
            root = Path(folder)
            second = {**self.row, 'source_listing_id': '2', 'listing_key': 'test:2',
                      'vin': 'JTJHT00W864019828', 'vehicle_key': 'vin:JTJHT00W864019828'}
            state = {'listings': {
                'test:1': {**self.row, 'title_status': 'clean-title candidate'},
                'test:2': {**second, 'title_status': 'clean-title candidate'},
            }, 'history': []}
            client = FakeClient()
            enrich_vehicle_history(root, state, client, 1, NOW)
            self.assertEqual(len(client.created), 1)


class ParserTests(unittest.TestCase):
    def clean_fixture(self):
        context = json.loads((Path(__file__).parent / 'fixtures/cargurus.json').read_text())
        criteria = context['state']['loaderData']['route']['search']['appliedFilterCriteria']
        criteria.update(hideLemon=True, hideFrameDamaged=True, hideSalvage=True, hideTheft=True)
        return context

    def test_live_structure_fixture(self):
        context = self.clean_fixture()
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
        self.assertTrue(clean_title_candidate(target))

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
        page = '<h1>2006 Lexus LX470</h1><div class="listing-intro"><span>Current Bid: USD $3,250</span><span data-until="1789585080"></span><li>Chassis: JTJHT00W964015853</li><li>209k Miles</li><b>Lot #263426</b><div class="listing-actions-stats">'
        row = parse_bat(page, 'https://bringatrailer.com/listing/2006-lexus-lx470-81/', NOW)
        self.assertEqual(row['status'], 'active')
        self.assertEqual(row['current_bid'], 3250)
        self.assertIsNone(row['asking_price'])
        self.assertEqual(row['mileage'], 209000)
        self.assertTrue(row['mileage_is_approximate'])
        row = parse_bat(page, row['listing_url'], '2026-09-20T22:00:00+00:00')
        self.assertEqual(row['status'], 'unknown')

    def test_unsold_auction_is_not_sold(self):
        page = '<h1>2007 Lexus LX470</h1><div class="listing-intro">Bid to USD $12,000 Reserve not met<div class="listing-actions-stats">'
        row = parse_bat(page, 'https://bringatrailer.com/listing/2007-lexus-lx470-example/', NOW)
        self.assertEqual(row['status'], 'ended')
        self.assertIsNone(row['sold_price'])

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

