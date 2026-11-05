import sys,unittest,tempfile,json
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'src'))
from carsandbids_rss import parse_feed
from finder import normalize,inventory_candidate,save
NOW='2026-11-05T12:00:00+00:00'
def feed(description='',date='Tue, 03 Nov 2026 20:42:00 GMT',title='2007 Lexus LX 470',url='https://carsandbids.com/auctions/rjnQQnyx/2007-lexus-lx-470'):
    return f'<rss><channel><item><title>{title}</title><link>{url}</link><pubDate>{date}</pubDate><description><![CDATA[{description}]]></description></item></channel></rss>'
class RssTests(unittest.TestCase):
    def test_discovery_is_not_live_or_sold_and_not_vin_merged(self):
        r=normalize(parse_feed(feed('Timing belt replaced at 210,012 miles.'),NOW)[0])
        self.assertEqual(r['status'],'unknown');self.assertEqual(r['title_status'],'unknown')
        self.assertIsNone(r['mileage']);self.assertIsNone(r['sold_price']);self.assertIsNone(r['current_bid'])
        self.assertEqual(r['vehicle_key'],'listing:carsandbids:rjnQQnyx');self.assertTrue(inventory_candidate(r))
    def test_explicit_current_mileage_and_safe_photo(self):
        r=parse_feed(feed("<img src='https://media.carsandbids.com/photo.jpg'><img src='https://evil.test/pixel'>The odometer currently displays approximately 201,000 miles."),NOW)[0]
        self.assertEqual(r['mileage'],201000);self.assertEqual(r['photo_urls'],['https://media.carsandbids.com/photo.jpg'])
    def test_stale_future_out_of_scope_and_branded(self):
        self.assertEqual(parse_feed(feed(date='Wed, 01 Oct 2025 00:00:00 GMT'),NOW),[])
        self.assertEqual(parse_feed(feed(date='Fri, 06 Nov 2026 20:42:00 GMT'),NOW),[])
        self.assertEqual(parse_feed(feed(title='1999 Lexus LX 470'),NOW),[])
        self.assertFalse(inventory_candidate(normalize(parse_feed(feed('It has a rebuilt title.'),NOW)[0])))
    def test_invalid_feed_and_external_link_fail(self):
        with self.assertRaises(ValueError):parse_feed('<html/>',NOW)
        with self.assertRaises(ValueError):parse_feed(feed(url='https://evil.test/auctions/abc/test'),NOW)
    def test_public_discovery_never_counts_as_active_or_sale(self):
        r=normalize(parse_feed(feed(),NOW)[0]);r.update(first_seen=NOW,last_seen=NOW)
        state={'listings':{r['listing_key']:r},'history':[],'updated_at':NOW,'historical_sales':[]}
        with tempfile.TemporaryDirectory(dir=Path.cwd(), prefix=".tmp-rss-test-") as d:
            assert Path(d).resolve().parent == Path.cwd().resolve()
            save(Path(d),state,[],[],cache_photos=False)
            inventory=json.loads((Path(d)/'web/inventory.json').read_text(encoding='utf-8'))
            self.assertEqual(len(inventory['listings']),1)
            self.assertEqual(inventory['summary']['active_listings'],0)
            self.assertEqual(inventory['market_history']['results'],[])
            state['updated_at']='2026-11-20T12:00:00+00:00';save(Path(d),state,[],[],cache_photos=False)
            self.assertEqual(json.loads((Path(d)/'web/inventory.json').read_text(encoding='utf-8'))['listings'],[])
if __name__=='__main__':unittest.main()
