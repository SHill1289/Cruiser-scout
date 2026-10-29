import io,json,tempfile,unittest,sys
from pathlib import Path
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'src'))
from dealer_photos import gallery, DealerFetcher, enrich, apply_verified
VIN='JTJHT00W664011131'
URL='https://www.chapparoneautosales.com/details/used-2006-lexus-lx-470/123'
class DealerPhotosTests(unittest.TestCase):
 def test_exact_vin_structured_gallery_only(self):
  obj=[{'@type':'Vehicle','vehicleIdentificationNumber':'JTJHT00W664006477','image':['https://cdn05.carsforsale.com/wrong1.jpg','https://cdn05.carsforsale.com/wrong2.jpg']}, {'@type':'Vehicle','vehicleIdentificationNumber':VIN,'image':['https://cdn05.carsforsale.com/a.jpg','https://cdn05.carsforsale.com/b.jpg']}]
  page='<script type="application/ld+json">'+json.dumps(obj)+'</script>'
  self.assertEqual(gallery(page,URL,VIN),obj[1]['image'])
  self.assertEqual(gallery(page,URL,'JTJHY7AX8G4208160'),[])
 def test_dealersync_uses_primary_vehicle_folder_not_recommendations(self):
  page='<meta itemprop="vehicleIdentificationNumber" content="'+VIN+'"><meta property="og:image" content="//images.dealersync.com/1/Photos/2/a.jpg">'+' '.join(['<img src="//images.dealersync.com/1/Photos/2/a.jpg">','<img src="//images.dealersync.com/1/Photos/2/b.jpg">','<img src="//images.dealersync.com/1/Photos/3/wrong.jpg">'])
  self.assertEqual(len(gallery(page,URL,VIN)),2)
  self.assertEqual(gallery(page,URL,'JTJHT00W664006477'),[])
 def test_placeholder_is_not_gallery_and_http_destinations_rejected(self):
  page='<script type="application/ld+json">'+json.dumps({'vehicleIdentificationNumber':VIN,'image':['https://images.dealersync.com/1/Photos/comingsoon/a.jpg','https://cdn-img.vincue.net/NoPhoto/a.jpg','http://localhost/a.jpg']})+'</script>'
  self.assertEqual(gallery(page,URL,VIN),[])
  fetcher=DealerFetcher({'www.chapparoneautosales.com'})
  for url in ['http://www.chapparoneautosales.com/','https://127.0.0.1/','https://www.chapparoneautosales.com:999/','https://user:password@www.chapparoneautosales.com/']:
   with self.assertRaises(ValueError):fetcher.validate(url)
 def test_carsforsale_rejects_ambiguous_page_vins(self):
  page='<script type="application/ld+json">{"@type":"Vehicle"}</script><div class="vdp-carousel-block">'+VIN+'<img data-lazy="https://cdn05.carsforsale.com/a.jpg"><img data-lazy="https://cdn05.carsforsale.com/b.jpg"></div>'
  self.assertEqual(len(gallery(page,URL,VIN)),2)
  self.assertEqual(gallery(page+' JTJHT00W664006477',URL,VIN),[])
 def test_reviewed_gallery_requires_exact_listing_identity(self):
  with tempfile.TemporaryDirectory(dir=Path(__file__).resolve().parents[1]) as d:
   root=Path(d);(root/'sources').mkdir()
   seed={'vin':VIN,'year':2006,'model':'LX470','seller':'Cas','source':'cargurus','source_url':'https://www.cargurus.com/details/1','listing_keys':['c:1'],'photos':['https://static.cargurus.com/a.jpg','https://static.cargurus.com/b.jpg']}
   (root/'sources/verified_photo_galleries.json').write_text(json.dumps([seed]))
   row={'vin':VIN,'year':2006,'model':'LX470','seller':'Cas','status':'active','listing_url':seed['source_url'],'photo_urls':[]}
   def cache(root,rows):rows[0]['photo_urls']=['photos/a.jpg','photos/b.jpg']
   for field,value in [('vin','JTJHT00W664006477'),('year',2007),('model','LX570'),('seller','Different dealer'),('status','sold'),('listing_url','https://www.cargurus.com/details/2')]:
    bad={**row,field:value}
    self.assertEqual(apply_verified(root,{'listings':{'c:1':bad}},cache),0)
    self.assertEqual(bad['photo_urls'],[])
   self.assertEqual(apply_verified(root,{'listings':{'c:1':row}},cache),1)
   self.assertEqual(row['photo_source'],'cargurus')
   self.assertEqual(apply_verified(root,{'listings':{'c:1':row}},cache),0)
 def test_placeholder_cleanup_preserves_real_images(self):
  with tempfile.TemporaryDirectory(dir=Path(__file__).resolve().parents[1]) as d:
   row={'photo_url':'https://cdn-img.vincue.net/NoPhoto/a.jpg','photo_urls':['https://cdn-img.vincue.net/NoPhoto/a.jpg','https://cdn05.carsforsale.com/real.jpg']}
   enrich(Path(d),{'listings':{'x':row}},'2026-10-29T12:00:00+00:00',lambda *a:None)
   self.assertEqual(row['photo_urls'],['https://cdn05.carsforsale.com/real.jpg'])
   self.assertEqual(row['photo_url'],row['photo_urls'][0])
 def test_cache_failure_is_not_success_and_retry_is_daily(self):
  with tempfile.TemporaryDirectory(dir=Path(__file__).resolve().parents[1]) as d:
   root=Path(d);(root/'sources').mkdir();(root/'sources/dealer_photos.json').write_text(json.dumps([{'id':'cas','sellers':['Cas'],'pages':{VIN:URL}}]))
   row={'vin':VIN,'source':'cargurus','status':'active','seller':'Cas','photo_urls':[]}
   state={'listings':{'c:1':row}}
   class Fake:
    calls=0
    def get(self,url):
     self.calls+=1
     return '<script type="application/ld+json">'+json.dumps({'vehicleIdentificationNumber':VIN,'image':['https://cdn05.carsforsale.com/a.jpg','https://cdn05.carsforsale.com/b.jpg']})+'</script>'
   f=Fake();now='2026-10-29T12:00:00+00:00'
   enrich(root,state,now,lambda *args:None,f)
   self.assertEqual(state['dealer_photo_attempts']['cas:'+VIN]['status'],'download_unavailable')
   self.assertEqual(row['photo_urls'],[])
   enrich(root,state,now,lambda *args:None,f);self.assertEqual(f.calls,1)
   def cached(root,rows): rows[0]['photo_urls']=['photos/a.jpg','photos/b.jpg']
   enrich(root,state,'2026-10-30T12:00:00+00:00',cached,f)
   self.assertEqual(row['photo_source'],'dealer');self.assertEqual(row['photo_source_url'],URL)
   self.assertEqual(state['dealer_photo_attempts']['cas:'+VIN]['status'],'complete')
if __name__=='__main__':unittest.main()
