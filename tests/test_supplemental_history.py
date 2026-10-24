import sys
import unittest
from pathlib import Path
from unittest.mock import patch
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src'))
import finder

class SupplementalHistoryTests(unittest.TestCase):
    source = dict(id='cargurus-lx570-2014', year=2014, model='LX570', url='inventory', no_accidents_url='history')

    def collect(self, history, inventory):
        calls = []
        def fake(fetcher, url, year, model, ids=None, **kwargs):
            calls.append((url, ids))
            result = history if url == 'history' else inventory
            if isinstance(result, Exception):
                raise result
            return result
        with patch.object(finder, 'collect_cargurus', side_effect=fake):
            result = finder.collect_cargurus_with_history(object(), self.source)
        return result, calls

    def test_failed_history_still_collects_inventory_without_accident_assertions(self):
        result, calls = self.collect(ValueError('unavailable'), ([{'source_listing_id':'1'}], True, 1))
        self.assertTrue(result[0][1])
        self.assertIn('unavailable', result[2])
        self.assertEqual(calls[-1], ('inventory', set()))

    def test_partial_history_is_not_used_as_evidence(self):
        result, calls = self.collect(([{'source_listing_id':'1'}], False, 2), ([], True, 0))
        self.assertIn('incomplete', result[2])
        self.assertEqual(calls[-1], ('inventory', set()))

    def test_complete_history_enriches_inventory(self):
        result, calls = self.collect(([{'source_listing_id':'1'}], True, 1), ([], True, 0))
        self.assertEqual(result[2], '')
        self.assertEqual(calls[-1], ('inventory', {'1'}))

    def test_incomplete_inventory_remains_incomplete(self):
        result, calls = self.collect(([], True, 0), ([], False, 5))
        self.assertFalse(result[0][1])

    def test_failed_inventory_still_raises(self):
        with self.assertRaises(ValueError):
            self.collect(([], True, 0), ValueError('inventory unavailable'))
