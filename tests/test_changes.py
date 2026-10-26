import sys,unittest
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'src'))
from finder import change_metadata
class ChangeMetadataTests(unittest.TestCase):
    def test_discovery_uses_earliest_known_vin_even_if_old_listing_is_removed(self):
        row=dict(listing_key='new',vehicle_key='vin:1',listing_url='url',first_seen='2026-10-25T00:00:00+00:00')
        state={'updated_at':'2026-10-26T00:00:00+00:00','listings':{'new':row,'old':dict(row,listing_key='old',status='removed',first_seen='2026-09-01T00:00:00+00:00')}}
        self.assertEqual(change_metadata(state,row)['vehicle_first_seen'],'2026-09-01T00:00:00+00:00')
    def test_return_requires_matching_record_and_recent_explicit_event(self):
        row=dict(listing_key='a',vehicle_key='vin:1',listing_url='url',first_seen='2026-09-01T00:00:00+00:00')
        event=dict(row,event='reappeared',observed_at='2026-10-25T00:00:00+00:00')
        state={'updated_at':'2026-10-26T00:00:00+00:00','listings':{'a':row},'history':[event,dict(event,listing_url='other'),dict(event,event='updated'),dict(event,observed_at='2026-01-01T00:00:00+00:00')]}
        self.assertEqual(change_metadata(state,row)['reappeared_at'],[event['observed_at']])
