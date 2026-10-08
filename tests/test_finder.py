import copy
import json
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src'))
import finder

NOW = '2026-10-08T18:00:00+00:00'

def fixture(page=1):
    return json.loads((Path(__file__).parent / 'fixtures' / f'truecar-page-{page}.json').read_text())

def html(state):
    return '<script id="__NEXT_DATA__" type="application/json">' + json.dumps({'props': {'pageProps': {'__APOLLO_STATE__': state}}}) + '</script>'

def candidate():
    rows, _, _ = finder.parse_truecar(html(fixture()), NOW)
    return copy.deepcopy(next(row for row in rows if finder.qualified_listings([row])))

class RaptorFinderTests(unittest.TestCase):
    def test_real_source_pages_and_strict_matches(self):
        rows = []
        for page in [1, 2, 3]:
            batch, _, total = finder.parse_truecar(html(fixture(page)), NOW, (page - 1) * 30)
            self.assertEqual(total, 63)
            rows.extend(batch)
        matches = finder.qualified_listings(rows)
        self.assertGreater(len(matches), 0)
        self.assertTrue(all(row['make'] == 'Ford' and row['model'] == 'F-150' and row['asking_price'] < 30000 and row['accident_history'] == 'No reported accidents' for row in matches))
        self.assertTrue(any(row['year'] <= 2014 for row in matches))
        self.assertTrue(any(row['year'] >= 2017 for row in matches))

    def test_exact_price_boundary_and_unknowns(self):
        row = candidate()
        for price in [30000, 30001, None, float('inf'), float('nan'), 0]:
            row['asking_price'] = price
            self.assertEqual(finder.qualified_listings([row]), [])
        row['asking_price'] = 29999.99
        self.assertEqual(len(finder.qualified_listings([row])), 1)

    def test_accident_and_title_unknowns_excluded(self):
        row = candidate()
        for history in ['', 'History unavailable', '1 reported accident', 'Seller discloses prior accident']:
            row['accident_history'] = history
            self.assertEqual(finder.qualified_listings([row]), [])
        row = candidate()
        row['title_status'] = 'unknown'
        self.assertEqual(finder.qualified_listings([row]), [])

    def test_conflicts_block_all_vin_matched_sources_and_prior_reports(self):
        clean = candidate()
        conflict = {**clean, 'source': 'manual-dealer', 'listing_key': 'manual:1', 'accident_history': '1 reported accident'}
        self.assertEqual(finder.qualified_listings([clean, conflict]), [])
        self.assertEqual(finder.qualified_listings([clean], [conflict]), [])

    def test_non_raptor_trim_and_wrong_models_rejected(self):
        row = candidate()
        for change in [{'trim': 'XLT'}, {'make': 'Toyota'}, {'model': 'Bronco'}, {'year': 2015}, {'trim': ''}]:
            with self.assertRaises(ValueError):
                finder.normalize({**row, **change})

    def test_source_scope_and_pagination_are_verified(self):
        state = fixture()
        oldkey = next(iter(state['ROOT_QUERY']))
        args = json.loads(oldkey[len('marketplaceListingSearch('):-1])
        args['filters']['makeModelTrim'][0]['trimSlugs'] = ['xlt']
        state['ROOT_QUERY']['marketplaceListingSearch(' + json.dumps(args) + ')'] = state['ROOT_QUERY'].pop(oldkey)
        with self.assertRaises(ValueError):
            finder.parse_truecar(html(state), NOW)
        with self.assertRaises(ValueError):
            finder.parse_truecar(html(fixture(2)), NOW, 0)

    def test_missing_not_sold_and_partial_preserves_inventory(self):
        state = {'listings': {}, 'history': []}
        row = candidate()
        finder.update(state, [row], NOW)
        for _ in range(4):
            finder.update(state, [], NOW, scopes=[])
        self.assertEqual(next(iter(state['listings'].values()))['status'], 'active')
        for _ in range(3):
            finder.update(state, [], NOW, scopes=[(row['source'], row['year'])])
        self.assertEqual(next(iter(state['listings'].values()))['status'], 'removed')

    def test_vin_matching_checks_year(self):
        row = candidate()
        self.assertTrue(row['vehicle_key'].startswith('vin:'))
        row['year'] = 2021
        updated = finder.normalize(row)
        self.assertTrue(updated['vehicle_key'].startswith('listing:'))
        self.assertIn('vin_model_or_year_conflict', updated['quality_flags'])

if __name__ == '__main__':
    unittest.main()
