import json
import sys
import unittest
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src'))
import price_integrity as prices
from finder import deal_rating

NOW = '2026-11-16T12:00:00Z'


class PriceIntegrityTests(unittest.TestCase):
    def test_shared_browser_collector_cases(self):
        cases = json.loads((Path(__file__).parent / 'fixtures/price-integrity.json').read_text())
        for case in cases:
            with self.subTest(case['name']):
                self.assertEqual(bool(prices.reason(case['row'], case['field'], case['row'].get(case['field']), NOW)), case['flag'])

    def test_conflicts_and_raw_preservation(self):
        row = dict(status='active', category='retail', asking_price=35000, vehicle_key='vin:JTJHY7AX6G4215236', source='cargurus', last_seen=NOW)
        result = prices.listings([row, {**row, 'source':'autodev', 'asking_price':50000}], NOW)
        self.assertTrue(all(r['asking_price'] is None for r in result))
        self.assertEqual(row['asking_price'], 35000)
        self.assertEqual(result[0]['reported_prices']['asking_price'], 35000)
        self.assertEqual(prices.listings([row,{**row,'source':'autodev','asking_price':349}],NOW)[0]['asking_price'],35000)

    def test_ratings_exclude_suspicious_asks_and_sales(self):
        row = dict(status='active',category='retail',asking_price=349,mileage=120000,model='LX570')
        sales = [dict(sale_price=p,mileage=120000,model='LX570') for p in (349,35000,36000,37000)]
        self.assertEqual(deal_rating(row,sales),{})
        rating = deal_rating({**row,'asking_price':35000},sales)
        self.assertEqual(rating['deal_comparable_count'],3)
        self.assertEqual(rating['deal_median_price'],36000)


if __name__ == '__main__':
    unittest.main()
