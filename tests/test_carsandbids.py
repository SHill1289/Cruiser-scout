import json
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src'))
from carsandbids import identity, canonical_url, parse_snapshot, Collector
from finder import normalize, clean_title_candidate

NOW = '2026-10-23T20:00:00+00:00'


class CarsAndBidsTests(unittest.TestCase):
    def setUp(self):
        self.sample = json.loads((Path(__file__).parent / 'fixtures/carsandbids-sold.json').read_text())

    def test_real_sale_keeps_bid_separate_and_deduplicates_by_vin(self):
        row = normalize(parse_snapshot(self.sample, NOW))
        self.assertEqual(row['sold_price'], 10500)
        self.assertEqual(row['mileage'], 231700)
        self.assertEqual(row['vehicle_key'], 'vin:JTJHT00W364008364')
        self.assertEqual(row['source_listing_id'], 'rjBVzZqx')
        self.assertIsNone(row['asking_price'])
        self.assertIsNone(row['current_bid'])
        self.assertTrue(clean_title_candidate(row))

    def test_active_and_unsold_are_not_sales(self):
        self.sample.update(bidbar='Time Left\n3 Days\nBid\n$8,500', ended=False)
        row = parse_snapshot(self.sample, NOW)
        self.assertEqual((row['status'], row['current_bid'], row['sold_price']), ('active', 8500, None))
        self.sample.update(bidbar='Bid to $8,500', ended=True)
        row = parse_snapshot(self.sample, NOW)
        self.assertEqual((row['status'], row['sold_price']), ('ended', None))

    def test_fail_closed_for_unknown_status_and_title(self):
        self.sample['facts']['Title Status'] = 'Rebuilt (NY)'
        self.assertFalse(clean_title_candidate(parse_snapshot(self.sample, NOW)))
        self.sample.update(bidbar='Loading...', ended=False)
        with self.assertRaises(ValueError):
            parse_snapshot(self.sample, NOW)

    def test_scope_and_url_validation(self):
        self.assertIsNone(identity('2004 Lexus LX 470'))
        self.assertIsNone(identity('2017 Lexus LX 570'))
        self.assertEqual(identity('2007 Toyota Land Cruiser'), (2007, 'Toyota', 'Land Cruiser'))
        with self.assertRaises(ValueError):
            canonical_url('https://example.com/auctions/123/test')
        self.sample['facts']['Location'] = 'Toronto, Ontario, CA'
        with self.assertRaises(ValueError):
            parse_snapshot(self.sample, NOW)

    def test_search_failures_still_recheck_known_active_listing(self):
        collector = Collector.__new__(Collector)
        self.sample.update(bidbar='Time Left\n1 Day\nBid\n$8,500', ended=False)
        old = normalize(parse_snapshot(self.sample, NOW))
        def page(url, script):
            if '/search/' in url:
                raise TimeoutError()
            return self.sample
        collector.page = page
        rows, errors = collector.collect([old], NOW)
        self.assertEqual(len(rows), 1)
        self.assertEqual(len(errors), 2)
        self.assertEqual(rows[0]['status'], 'active')

    def test_blocked_detail_does_not_fabricate_empty_observation(self):
        collector = Collector.__new__(Collector)
        def page(url, script):
            if '/search/' in url:
                return {'active': [{'title': self.sample['title'], 'url': self.sample['url']}], 'recent': []}
            raise TimeoutError()
        collector.page = page
        rows, errors = collector.collect([], NOW)
        self.assertEqual(rows, [])
        self.assertEqual(len(errors), 1)


if __name__ == '__main__':
    unittest.main()
