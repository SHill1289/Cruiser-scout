"""Read public, rendered Cars & Bids pages using ordinary headless Chrome.

No authentication, proxy rotation, challenge solving, or private endpoints.
Search snapshots never establish removal; individual auction results do.
"""
import re
import time
import urllib.parse
import urllib.request
import urllib.robotparser

SEARCH_SCRIPT = r"""
const articles = [...document.querySelectorAll('article')];
const live = articles.find(e => /Auctions \(\d+\)/.test(e.querySelector('h2')?.textContent || ''));
if (!live) return null;
const count = Number(live.querySelector('h2').textContent.match(/\((\d+)\)/)[1]);
const links = root => [...root.querySelectorAll('.auction-title a[href*="/auctions/"]')]
    .map(e => ({title:e.textContent.trim(), url:e.href.split('?')[0]}));
const active = links(live);
if (active.length !== count) return null;
const recent = articles.find(e => /Results \(\d+\)/.test(e.querySelector('h2')?.textContent || ''));
return {active, recent:recent ? links(recent) : []};
"""

DETAIL_SCRIPT = r"""
const title = document.querySelector('h1')?.textContent.trim();
const facts = Object.fromEntries([...document.querySelectorAll('.cnb-details-quick-facts dt')]
  .map(e => [e.textContent.trim(), e.nextElementSibling.textContent.trim()]));
const bar = document.querySelector('.auction-bidbar');
if (!title || !facts.VIN || !bar) return null;
return {url:location.href.split('?')[0], title, facts, bidbar:bar.innerText,
  ended:!!bar.querySelector('.ended'),
  stats:Object.fromEntries([...document.querySelectorAll('ul.stats .th')]
    .map(e => [e.textContent.trim(), e.nextElementSibling.textContent.trim()])),
  photos:[...document.querySelectorAll('img[data-section]')].slice(0,8).map(e => e.src)};
"""


def identity(title):
    match = re.fullmatch(r'(20\d{2}) (Lexus LX ?(470|570)|Toyota Land Cruiser)', title.strip(), re.I)
    if not match:
        return None
    year = int(match[1])
    model = 'LX' + match[3] if match[3] else 'Land Cruiser'
    years = range(2011, 2017) if model == 'LX570' else (2006, 2007)
    return (year, 'Toyota' if model == 'Land Cruiser' else 'Lexus', model) if year in years else None


def canonical_url(url):
    p = urllib.parse.urlsplit(url)
    if p.scheme != 'https' or p.netloc != 'carsandbids.com' or not re.fullmatch(r'/auctions/[A-Za-z0-9]+/[a-z0-9-]+/?', p.path):
        raise ValueError('Invalid Cars & Bids auction URL')
    return 'https://carsandbids.com' + p.path.rstrip('/')


def parse_snapshot(snapshot, now):
    vehicle = identity(snapshot.get('title', ''))
    if not vehicle:
        raise ValueError('Unsupported Cars & Bids vehicle')
    url = canonical_url(snapshot['url'])
    facts, bar = snapshot['facts'], snapshot['bidbar']
    if not facts.get('VIN') or 'Title Status' not in facts:
        raise ValueError('Auction facts are incomplete')
    sold = re.search(r'\bSold for\s*\$([\d,]+)', bar)
    bid = re.search(r'\b(?:Bid|High Bid|Current Bid)\s*\$([\d,]+)', bar)
    if sold:
        status = 'sold'
    elif snapshot.get('ended'):
        status = 'ended'
    elif re.search(r'\bTime Left\b', bar):
        status = 'active'
    else:
        raise ValueError('Auction status is not explicit')
    mileage = facts.get('Mileage', '')
    if not re.fullmatch(r'[\d,]+', mileage):
        raise ValueError('Mileage is unavailable or not stated in miles')
    location = re.fullmatch(r'(.+), ([A-Z]{2}) (\d{5})', facts.get('Location', ''))
    if not location:
        raise ValueError('Auction location is not a US city/state/ZIP')
    year, make, model = vehicle
    row = dict(source='carsandbids', source_listing_id=url.split('/')[4], listing_url=url,
        year=year, make=make, model=model, vin=facts['VIN'], status=status, category='auction',
        mileage=int(mileage.replace(',', '')), mileage_is_approximate=False,
        current_bid=int(bid[1].replace(',', '')) if bid and status == 'active' else None,
        sold_price=int(sold[1].replace(',', '')) if sold else None,
        bid_observed_at=now if status == 'active' else '',
        title_status='clean title' if re.fullmatch(r'Clean(?: \([A-Z]{2}\))?', facts['Title Status']) else 'unknown',
        exterior_color=facts.get('Exterior Color', ''), interior_color=facts.get('Interior Color', ''),
        seller=facts.get('Seller', ''), seller_type='dealer' if facts.get('Seller Type') == 'Dealer' else 'unknown',
        city=location[1], state=location[2], postal_code=location[3], currency='USD',
        photo_urls=snapshot.get('photos', []), accident_history='History unavailable', owners='Unknown',
        notes='Cars & Bids auction observation. Bid and sale price exclude buyer fees. Title status is source-reported.')
    return row


class Collector:
    def __init__(self):
        self.driver = None
        self.last = 0
        self.robots = urllib.robotparser.RobotFileParser()
        with urllib.request.urlopen('https://carsandbids.com/robots.txt', timeout=30) as r:
            self.robots.parse(r.read().decode().splitlines())

    def page(self, url, script):
        from selenium import webdriver
        from selenium.webdriver.support.ui import WebDriverWait
        if urllib.parse.urlsplit(url).netloc != 'carsandbids.com' or not self.robots.can_fetch('CruiserScout', url):
            raise ValueError('Cars & Bids URL is not permitted')
        if self.driver is None:
            options = webdriver.ChromeOptions()
            for arg in ('--headless=new', '--no-sandbox', '--disable-dev-shm-usage', '--window-size=1280,900'):
                options.add_argument(arg)
            self.driver = webdriver.Chrome(options=options)
            self.driver.set_page_load_timeout(35)
        time.sleep(max(0, 3 - (time.monotonic() - self.last)))
        self.driver.get(url)
        self.last = time.monotonic()
        return WebDriverWait(self.driver, 25).until(lambda d: d.execute_script(script))

    def collect(self, existing, now):
        urls, rows, errors = set(), [], []
        for url in ('https://carsandbids.com/search/lexus/lx', 'https://carsandbids.com/search/toyota/land-cruiser'):
            try:
                page = self.page(url, SEARCH_SCRIPT)
                urls.update(canonical_url(item['url']) for item in page['active'] + page['recent'] if identity(item['title']))
            except Exception as e:
                errors.append(f'Search unavailable: {url}: {type(e).__name__}')
        urls.update(canonical_url(r['listing_url']) for r in existing if r['source'] == 'carsandbids' and r['status'] in ('active', 'unknown'))
        if len(urls) > 60:
            errors.append('More than 60 auction pages; remaining pages deferred')
        # Recheck existing active auctions before discovering recent ended results.
        active = {r['listing_url'] for r in existing if r['source'] == 'carsandbids' and r['status'] in ('active', 'unknown')}
        for url in sorted(urls, key=lambda u: (u not in active, u))[:60]:
            try:
                snapshot = self.page(url, DETAIL_SCRIPT)
                rows.append(parse_snapshot(snapshot, now))
            except Exception as e:
                errors.append(f'Auction unavailable: {url}: {type(e).__name__}')
        return rows, errors

    def close(self):
        if self.driver:
            self.driver.quit()
