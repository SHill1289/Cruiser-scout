
import json
import sys
import unittest
from pathlib import Path
from unittest.mock import patch
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
from bat_archive import archive_results, location
from finder import collect_bat_archive, normalize
NOW="2026-10-26T16:00:00+00:00"
YEARS={"LX470":(2006,2007),"LX570":tuple(range(2011,2017)),"Land Cruiser":(2006,2007)}
def page(items, unsold=()):
    return "<script>var auctionsCompletedInitialData = "+json.dumps({"items":items[:24],"stats":{"sold":items,"unsold":list(unsold)}})+";</script>"
def item(i=1, **changes):
    return {"title":"2006 Lexus LX470","timestamp":1788883200,"url":f"https://bringatrailer.com/listing/2006-lexus-lx470-{i}/","amount":17750,**changes}
class ArchiveTests(unittest.TestCase):
    def test_full_chart_history_not_first_page(self):
        self.assertEqual(len(archive_results(page([item(i) for i in range(60)]),YEARS,NOW)),60)
    def test_title_controls_identity_even_wrong_url_slug(self):
        rows=archive_results(page([item(url="https://bringatrailer.com/listing/2006-lexus-gx470-43/"),item(2,title="2005 Lexus LX470"),item(3,timestamp=1500000000),item(4,url="https://evil.example/listing/x/")],[item(5)]),YEARS,NOW)
        self.assertEqual(len(rows),2)
        self.assertEqual(rows["https://bringatrailer.com/listing/2006-lexus-gx470-43/"]["model"],"LX470")
        self.assertEqual(rows[item(5)["url"]]["outcome"],"unsold")
    def test_missing_chart_is_failure_not_empty_inventory(self):
        with self.assertRaises(ValueError):archive_results("<html></html>",YEARS,NOW)
    def test_explicit_location_beats_registration_narrative(self):
        result=location('Previously registered in Texas. <strong>Location</strong>: <a href="#">Miami, Florida 33157</a>')
        self.assertEqual(result,{"city":"Miami","state":"FL","postal_code":"33157"})
        self.assertEqual(location("Currently registered in Florida"),{})
        self.assertEqual(location('<strong>Location</strong>: <a>St. John&amp;#39;s, Newfoundland, Canada</a>')["state"],"Newfoundland, Canada")
    def test_hydrates_once_and_retries_failed_detail(self):
        url=item()["url"]
        row=normalize({"source":"bringatrailer","source_listing_id":"1","year":2006,"model":"LX470","listing_url":url,"status":"sold","sold_price":17750,"bat_details_version":2})
        class Fetcher:
            def get(self,url): return "detail"
        state={"listings":{}}
        with patch("finder.parse_bat",return_value=row),patch("finder.parse_historical_sale",return_value={"listing_url":url,"sold_at":"2026-09-08"}):
            batch,_,errors,_=collect_bat_archive(state,Fetcher(),page([item()]),"LX470",NOW)
        self.assertEqual(errors,[]);self.assertEqual(len(batch),1)
        state["listings"]={batch[0]["listing_key"]:batch[0]}
        with patch.object(Fetcher,"get",side_effect=AssertionError("should not refetch")):
            self.assertEqual(collect_bat_archive(state,Fetcher(),page([item()]),"LX470",NOW)[0],[])
if __name__=="__main__": unittest.main()
