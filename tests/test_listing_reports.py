import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'src'))
from listing_reports import enqueue, process_requests, report_id, recheck_listing

class Reports(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup);self.root=Path(self.tmp.name)
        self.now='2026-11-13T12:00:00+00:00';self.key='cargurus:123'
    def report(self):
        return json.loads((self.root/'data/recheck_requests'/(report_id(self.key,'wrong_photo')+'.json')).read_text())
    def test_queue_dedupes_and_validates(self):
        self.assertEqual(enqueue(self.root,'cars.com:abc-123','missing_information',self.now)['status'],'queued')
        a=enqueue(self.root,self.key,'wrong_photo',self.now)
        self.assertEqual(enqueue(self.root,self.key,'wrong_photo','2026-11-14T12:00:00+00:00'),a)
        for key,reason in [('../outside','wrong_photo'),(self.key,'delete')]:
            with self.assertRaises(ValueError):enqueue(self.root,key,reason,self.now)
    def test_retry_is_bounded_and_preserves_inventory(self):
        enqueue(self.root,self.key,'wrong_photo',self.now)
        state={'listings':{self.key:{'status':'active','photo_urls':['original']}}}
        def fail(*args):raise ValueError('blocked')
        for day in [13,14,15]:process_requests(self.root,state,f'2026-11-{day}T12:00:00+00:00',fail)
        self.assertEqual(self.report()['status'],'needs_review');self.assertEqual(self.report()['attempts'],3)
        self.assertEqual(state['listings'][self.key]['photo_urls'],['original'])
        process_requests(self.root,state,'2026-11-16T12:00:00+00:00',fail)
        self.assertEqual(self.report()['attempts'],3)
    def test_limit_and_deferred_completion(self):
        for i in range(7):enqueue(self.root,f'cargurus:{i}','already_sold',self.now)
        state={'listings':{f'cargurus:{i}':{} for i in range(7)}};writes=[]
        process_requests(self.root,state,self.now,lambda *a:{'status':'needs_review','detail':'No confirmation'},writer=lambda p,r:writes.append((p,r)))
        self.assertEqual(len(writes),5)
        self.assertTrue(all(json.loads(p.read_text())['status']=='queued' for p,_ in writes))
    def test_report_does_not_mark_active_listing_sold(self):
        row={'source':'cargurus','status':'active','last_seen':self.now}
        result=recheck_listing({},row,'already_sold',None,self.now,[])
        self.assertEqual(result['status'],'needs_review');self.assertEqual(row['status'],'active')
    def test_wrong_photo_requires_identity_and_preserves_existing_on_failure(self):
        row={'source':'cargurus','source_listing_id':'123','listing_key':self.key,'vin':'JTJHT00W564000001','photo_urls':['original'],'photo_url':'original'}
        class Fetch:
            def get(self,url):return 'Unrelated listing'
        with self.assertRaises(ValueError):recheck_listing({},row,'wrong_photo',Fetch(),self.now,[])
        self.assertEqual(row['photo_urls'],['original'])
    def test_new_source_gallery_is_applied_without_claiming_visual_verification(self):
        row={'source':'cargurus','source_listing_id':'123','listing_key':self.key,'vin':'JTJHT00W564000001','photo_urls':['original'],'photo_url':'original'}
        class Fetch:
            def get(self,url):return row['vin']
        def gallery(trial,fetcher):trial.update(photo_url='replacement',photo_urls=['replacement']);return ''
        with patch('finder.add_listing_photo',gallery):result=recheck_listing({},row,'wrong_photo',Fetch(),self.now,[])
        self.assertEqual(row['photo_urls'],['replacement']);self.assertEqual(result['status'],'updated');self.assertIn('not automatically confirmed',result['detail'])
if __name__=='__main__':unittest.main()
