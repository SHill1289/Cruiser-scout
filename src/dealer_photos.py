"""Free, bounded photo recovery from explicitly configured dealer inventory pages.
Only exact VIN evidence and vehicle-scoped galleries are accepted.
"""
from photo_selection import select_photos
import html
import json
import re
import time
import urllib.error
import urllib.parse
import urllib.request
import urllib.robotparser
from datetime import datetime, timedelta
from html.parser import HTMLParser

IMAGE_HOSTS = {'images.dealersync.com', 'cdn05.carsforsale.com', 'cdn.ebizautos.media', 'cdn-img.vincue.net', 'cdn.gma.to', 'vehicle-images.carscommerce.inc', 'static.cargurus.com'}
PLACEHOLDER = re.compile(r'nophoto|no-photo|comingsoon|coming-soon|placeholder|sports_car_front_view', re.I)


def usable(url):
    return isinstance(url, str) and not PLACEHOLDER.search(url)


class Page(HTMLParser):
    def __init__(self, text):
        super().__init__()
        self.tags = []
        self.feed(text)

    def handle_starttag(self, tag, attrs):
        self.tags.append((tag, dict(attrs)))


def objects(value):
    if isinstance(value, dict):
        yield value
        for child in value.values():
            yield from objects(child)
    elif isinstance(value, list):
        for child in value:
            yield from objects(child)


def structured(page):
    for raw in re.findall(r'<script[^>]*type=[\"\']application/ld\+json[\"\'][^>]*>(.*?)</script>', page, re.S | re.I):
        try:
            yield from objects(json.loads(raw))
        except (ValueError, TypeError):
            continue


def clean_images(urls, base):
    result, seen = [], set()
    for value in urls:
        if not isinstance(value, str) or not usable(value):
            continue
        url = urllib.parse.urljoin(base, html.unescape(value))
        p = urllib.parse.urlsplit(url)
        if p.scheme != 'https' or p.hostname not in IMAGE_HOSTS or p.username or p.password:
            continue
        if p.hostname == 'images.dealersync.com':
            query = urllib.parse.urlencode([(k, v) for k, v in urllib.parse.parse_qsl(p.query) if k not in {'width', 'height', 'format'}])
            url = urllib.parse.urlunsplit(p._replace(query=query))
        key = (p.hostname, p.path)
        if key not in seen:
            seen.add(key)
            result.append(url)
    return select_photos(result)


def gallery(page, url, vin):
    """Do not take recommendation images merely because the VIN appears somewhere."""
    tags = Page(page).tags
    for obj in structured(page):
        if str(obj.get('vehicleIdentificationNumber', '')).upper() == vin:
            images = obj.get('image') or []
            if isinstance(images, str): images = [images]
            if isinstance(images, list):
                found = clean_images([i.get('url', '') if isinstance(i, dict) else i for i in images], url)
                if len(found) > 1: return found
    # DealerSync: primary VIN metadata ties the OG image's vehicle folder to this VDP.
    primary_vins = {a.get('content', '').upper() for t, a in tags if t == 'meta' and
                    (a.get('itemprop') == 'vehicleIdentificationNumber' or a.get('property') == 'product:retailer_item_id')}
    if primary_vins == {vin}:
        lead = next((a.get('content', '') for t, a in tags if t == 'meta' and a.get('property') == 'og:image'), '')
        p = urllib.parse.urlsplit(urllib.parse.urljoin(url, lead))
        if p.hostname == 'images.dealersync.com' and re.fullmatch(r'/[0-9]+/Photos/[0-9]+/[^/]+', p.path):
            folder = p.path.rsplit('/', 1)[0] + '/'
            candidates = re.findall(r'(?:https?:)?//images\.dealersync\.com/[^\s\"\'<>]+', html.unescape(page))
            return clean_images([u for u in candidates if urllib.parse.urlsplit(urllib.parse.urljoin(url, u)).path.startswith(folder)], url)
    # CarsForSale classic VDP: exact VIN on a single-vehicle page, main carousel lazy images.
    if '/details/' in urllib.parse.urlsplit(url).path.lower() and vin in page.upper():
        vehicle_objects = [o for o in structured(page) if o.get('@type') in {'Vehicle', 'Car'}]
        if len(vehicle_objects) == 1 and set(re.findall(r'\b[A-HJ-NPR-Z0-9]{17}\b', page)) == {vin} and 'vdp-carousel-block' in page:
            candidates = [a['data-lazy'] for t, a in tags if t == 'img' and a.get('data-lazy') and
                          'cdn05.carsforsale.com/' in a['data-lazy']]
            return clean_images(candidates, url)
    return []


class DealerFetcher:
    def __init__(self, hosts, limit=24):
        self.hosts, self.limit = set(hosts), limit
        self.calls = 0
        self.pages, self.robots, self.last = {}, {}, {}

    def validate(self, url):
        p = urllib.parse.urlsplit(url)
        if p.scheme != 'https' or p.hostname not in self.hosts or p.username or p.password or p.port not in {None, 443}:
            raise ValueError('Unconfigured dealer destination')

    def request(self, url):
        self.validate(url)
        if self.calls >= self.limit: raise ValueError('Dealer request budget reached')
        self.calls += 1
        outer = self
        class Redirect(urllib.request.HTTPRedirectHandler):
            def redirect_request(self, req, fp, code, msg, headers, newurl):
                outer.validate(newurl)
                return super().redirect_request(req, fp, code, msg, headers, newurl)
        req = urllib.request.Request(url, headers={'User-Agent': 'CruiserScout/1.0', 'Accept': 'text/html'})
        with urllib.request.build_opener(Redirect()).open(req, timeout=20) as response:
            data = response.read(4_000_001)
        if len(data) > 4_000_000: raise ValueError('Dealer page too large')
        return data.decode('utf-8', errors='replace')

    def get(self, url):
        self.validate(url)
        if url in self.pages: return self.pages[url]
        host = urllib.parse.urlsplit(url).netloc
        if host not in self.robots:
            try: text = self.request('https://' + host + '/robots.txt')
            except urllib.error.HTTPError as e:
                if e.code != 404: raise
                text = ''
            parser = urllib.robotparser.RobotFileParser()
            parser.parse(text.splitlines())
            self.robots[host] = parser
        parser = self.robots[host]
        if not parser.can_fetch('CruiserScout/1.0', url): raise ValueError('Dealer robots disallow collection')
        time.sleep(max(0, max(2, parser.crawl_delay('CruiserScout/1.0') or 0) - (time.monotonic() - self.last.get(host, 0))))
        self.last[host] = time.monotonic()
        self.pages[url] = self.request(url)
        return self.pages[url]


def apply_verified(root, state, cache):
    """Retain browser-reviewed galleries only for the exact existing listing IDs.
    This is a bounded backlog repair, not a claim that background discovery works on blocked sites.
    """
    path = root / 'sources/verified_photo_galleries.json'
    if not path.exists(): return 0
    added = 0
    for seed in json.loads(path.read_text(encoding='utf-8'))[:50]:
        source = seed.get('source', 'dealer')
        if source not in {'dealer', 'cargurus'}: continue
        photos = clean_images(seed.get('photos', []), seed['source_url'])
        if len(photos) < 2: continue
        targets = [state.get('listings', {}).get(key) for key in seed.get('listing_keys', [])]
        targets = [r for r in targets if r and r.get('status') == 'active' and
                   r.get('vin') == seed['vin'] and r.get('year') == seed['year'] and
                   r.get('model') == seed['model'] and r.get('seller') == seed['seller'] and
                   (source != 'cargurus' or r.get('listing_url') == seed['source_url']) and
                   len(r.get('photo_urls') or []) < 2]
        if not targets: continue
        trial = {'source': source, 'photo_source': source, 'photo_url': photos[0], 'photo_urls': photos}
        cache(root, [trial])
        if len([u for u in trial['photo_urls'] if u.startswith('photos/')]) < 2: continue
        for row in targets:
            row.update(photo_url=photos[0], photo_urls=photos, photo_source=source, photo_source_url=seed['source_url'])
        added += 1
    return added


def enrich(root, state, now, cache, fetcher=None):
    # Dealer placeholders must not masquerade as real vehicle photographs.
    for row in state.get('listings', {}).values():
        row['photo_urls'] = [u for u in (row.get('photo_urls') or []) if usable(u)]
        if not usable(row.get('photo_url', '')):
            row['photo_url'] = next(iter(row['photo_urls']), '')
    config_path = root / 'sources/dealer_photos.json'
    if not config_path.exists(): return {'source': 'dealer photo backfill', 'status': 'ok', 'detail': 'No configured dealers.', 'checked_at': now}
    config = json.loads(config_path.read_text(encoding='utf-8'))
    hosts = {urllib.parse.urlsplit(url).hostname for c in config for url in [*c.get('pages', {}).values(), *c.get('indexes', [])]}
    fetcher = fetcher or DealerFetcher(hosts)
    attempts = state.setdefault('dealer_photo_attempts', {})
    date = datetime.fromisoformat(now)
    reviewed = apply_verified(root, state, cache)
    added = checked = 0
    rows = list(state.get('listings', {}).values())
    for c in config:
        targets = [r for r in rows if r.get('status') == 'active' and r.get('source') in {'cargurus', 'autodev'} and
                   r.get('seller', '').casefold() in {s.casefold() for s in c['sellers']} and
                   len([u for u in (r.get('photo_urls') or []) if usable(u)]) < 2]
        groups = {}
        for r in targets: groups.setdefault(r.get('vin', ''), []).append(r)
        for vin, group in groups.items():
            if not re.fullmatch(r'[A-HJ-NPR-Z0-9]{17}', vin): continue
            key = c['id'] + ':' + vin
            prior = attempts.get(key, {})
            if prior.get('retry_at') and datetime.fromisoformat(prior['retry_at']) > date: continue
            if checked >= 12: break
            checked += 1
            record = {'checked_at': now, 'retry_at': (date + timedelta(hours=24)).isoformat(), 'status': 'unavailable'}
            attempts[key] = record
            try:
                urls = [c.get('pages', {}).get(vin, '')]
                urls += [r.get('listing_url', '') for r in group if urllib.parse.urlsplit(r.get('listing_url', '')).hostname in hosts]
                urls = list(dict.fromkeys(u for u in urls if u))
                for index in c.get('indexes', []) if not urls else []:
                    page = fetcher.get(index)
                    for obj in structured(page):
                        if str(obj.get('vehicleIdentificationNumber', '')).upper() == vin and obj.get('url'):
                            candidate = urllib.parse.urljoin(index, obj['url'])
                            if urllib.parse.urlsplit(candidate).hostname == urllib.parse.urlsplit(index).hostname:
                                urls.append(candidate)
                    if not urls:
                        # Only bounded model detail links; each detail must independently prove its VIN.
                        for tag, attrs in Page(page).tags:
                            href = attrs.get('href', '')
                            if tag == 'a' and re.search(r'(?:/details/|/pre-owned-cars/detail/).*lexus.*lx', href, re.I):
                                candidate = urllib.parse.urljoin(index, href)
                                if urllib.parse.urlsplit(candidate).hostname == urllib.parse.urlsplit(index).hostname:
                                    urls.append(candidate)
                for url in list(dict.fromkeys(urls))[:3]:
                    photos = gallery(fetcher.get(url), url, vin)
                    if len(photos) < 2: continue
                    trial = {'source': 'dealer', 'photo_source': 'dealer', 'photo_url': photos[0], 'photo_urls': photos}
                    cache(root, [trial])
                    if len([u for u in trial['photo_urls'] if u.startswith('photos/')]) < 2:
                        record['status'] = 'download_unavailable'
                        continue
                    for target in group:
                        target.update(photo_url=photos[0], photo_urls=photos, photo_source='dealer', photo_source_url=url)
                    record.update(status='complete', photos=len(photos), source_url=url)
                    added += 1
                    break
                if not urls: record['status'] = 'detail_not_found'
            except Exception as error:
                record.update(status='retry_pending', detail=str(error)[:180])
    return {'source': 'dealer photo backfill', 'status': 'ok',
            'detail': f'{added} dealer galleries recovered; {reviewed} reviewed galleries restored; {checked} vehicles checked. Missing or inaccessible galleries retry after 24 hours.',
            'checked_at': now}
