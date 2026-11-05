"""Official Cars & Bids RSS discovery; never infer live or sold status."""
import re
import urllib.request
import urllib.robotparser
import xml.etree.ElementTree as ET
from datetime import datetime, timedelta, timezone
from email.utils import parsedate_to_datetime
from html.parser import HTMLParser
from urllib.parse import urlsplit
from carsandbids import identity, canonical_url

URL = 'https://carsandbids.com/rss.xml'
class Description(HTMLParser):
    def __init__(self):
        super().__init__(); self.parts=[]; self.photos=[]
    def handle_data(self, value): self.parts.append(value)
    def handle_starttag(self, tag, attrs):
        values=dict(attrs)
        if tag=='img':
            url=values.get('src',''); p=urlsplit(url)
            if p.scheme=='https' and p.hostname=='media.carsandbids.com': self.photos.append(url)

def parse_feed(xml, now):
    root=ET.fromstring(xml)
    if root.tag!='rss' or root.find('channel') is None: raise ValueError('Expected RSS channel')
    observed=datetime.fromisoformat(now.replace('Z','+00:00'))
    rows={}
    for item in root.findall('./channel/item'):
        vehicle=identity(item.findtext('title',''))
        if not vehicle: continue
        url=canonical_url(item.findtext('link',''))
        published=parsedate_to_datetime(item.findtext('pubDate',''))
        if published.tzinfo is None: published=published.replace(tzinfo=timezone.utc)
        # A recent discovery is not proof the auction is still live.
        if not observed-timedelta(days=14)<=published<=observed+timedelta(hours=1): continue
        description=Description();description.feed(item.findtext('description',''))
        text=' '.join(description.parts)
        miles=re.search(r'odometer (?:currently )?(?:displays|shows|reads) (?:approximately |about )?([\d,]+) miles',text,re.I)
        year,make,model=vehicle
        row=dict(source='carsandbids',source_listing_id=url.split('/')[4],listing_url=url,
            year=year,make=make,model=model,status='unknown',category='auction',title_status='unknown',
            listed_at=published.isoformat(),photo_url=next(iter(description.photos),''),photo_urls=description.photos[:8],
            mileage=int(miles[1].replace(',','')) if miles else None,mileage_is_approximate=bool(miles),
            source_description=text.strip(),quality_flags='rss_discovery',notes='Official Cars & Bids RSS discovery. Auction status, title, VIN, location and current bid are unverified. The feed provides a lead photo, not a full gallery.',
            accident_history='History unavailable',owners='Unknown',_paragraphs=description.parts)
        colors=re.search(r'finished in ([^.\n]{1,40}?) with (?:a |an )?([^.\n]{1,30}?) interior\.',text,re.I)
        if colors: row.update(exterior_color=colors[1].strip(),interior_color=colors[2].strip())
        if re.search(r'\b(?:salvage|rebuilt|branded|flood) title\b', text, re.I): row['title_status']='branded title reported'
        rows[row['source_listing_id']]=row
    return list(rows.values())

def collect(now):
    def read(url, limit):
        req=urllib.request.Request(url,headers={'User-Agent':'CruiserScout'})
        with urllib.request.urlopen(req,timeout=25) as response:
            if urlsplit(response.url).hostname!='carsandbids.com': raise ValueError('Unexpected source redirect')
            data=response.read(limit+1)
        if len(data)>limit: raise ValueError('Source response too large')
        return data.decode('utf-8')
    robots=urllib.robotparser.RobotFileParser();robots.parse(read('https://carsandbids.com/robots.txt',1000000).splitlines())
    if not robots.can_fetch('CruiserScout',URL): raise ValueError('RSS collection disallowed')
    return parse_feed(read(URL,2000000),now)
