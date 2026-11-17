import sys
import unittest
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'src'))
from auction_fees import buyer_total
from finder import deal_rating


class AuctionFeeTests(unittest.TestCase):
    def test_buyer_totals_and_historical_cap(self):
        for bid,total in [(1000,1250),(20000,21000),(34250,35962.5),(200000,207500)]:
            self.assertEqual(buyer_total(dict(source='Bring a Trailer',sale_price=bid)),total)
        self.assertEqual(buyer_total(dict(source='bringatrailer',sale_price=120000,sold_at='2024-01-29')),125000)
        self.assertEqual(buyer_total(dict(source='bringatrailer',sale_price=120000,sold_at='2024-01-30')),126000)

    def test_no_fee_for_unsold_other_sources_or_already_included(self):
        for change in [dict(outcome='unsold'),dict(source='cargurus'),dict(status='active'),dict(currency='CAD'),dict(auction_fee_included=True),dict(price_review={'sale_price':'Review'})]:
            self.assertEqual(buyer_total(dict(source='bringatrailer',sale_price=30000)|change),30000)

    def test_collector_rating_uses_buyer_totals_without_changing_source_sales(self):
        sales=[dict(source='Bring a Trailer',sale_price=p,model='LX470',mileage=120000) for p in (20000,30000,40000)]
        row=dict(status='active',category='retail',asking_price=30000,model='LX470',mileage=120000)
        self.assertEqual(deal_rating(row,sales)['deal_median_price'],31500)
        self.assertEqual(sales[1]['sale_price'],30000)


if __name__=='__main__':unittest.main()
