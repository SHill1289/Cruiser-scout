"""Bounded Auto.dev free-tier collection. Credentials never enter URLs or exports."""
import json
import re
import time
import urllib.error
import urllib.parse
import urllib.request

BASE = 'https://api.auto.dev/listings'
QUERIES = (
    ('LX470', 'Lexus', 'LX,LX 470,LX470', '2006-2007'),
    ('Land Cruiser', 'Toyota', 'Land Cruiser', '2006-2007'),
    ('LX570', 'Lexus', 'LX,LX 570,LX570', '2011-2016'),
)


def parse_listing(item, expected_model):
    v, retail = item.get('vehicle') or {}, item.get('retailListing') or {}
    year = int(v.get('year') or 0)
    make = 'Toyota' if expected_model == 'Land Cruiser' else 'Lexus'
    models = {'LX470': {'lx', 'lx470'}, 'LX570': {'lx', 'lx570'}, 'Land Cruiser': {'landcruiser'}}
    if (v.get('make', '').lower() != make.lower()
            or re.sub(r'[^a-z0-9]', '', v.get('model', '').lower()) not in models[expected_model]
            or year not in (range(2011, 2017) if expected_model == 'LX570' else (2006, 2007))):
        raise ValueError('API returned an out-of-scope vehicle')
    vin = str(v.get('vin') or item.get('vin') or '').upper()
    if not re.fullmatch(r'[A-HJ-NPR-Z0-9]{17}', vin):
        raise ValueError('API listing has no usable VIN')
    url = retail.get('vdp') or ''
    if urllib.parse.urlsplit(url).scheme != 'https' or not urllib.parse.urlsplit(url).hostname:
        raise ValueError('API listing has no HTTPS source listing URL')
    if item.get('removedAt'):
        raise ValueError('API returned an inactive listing')
    photo = retail.get('primaryImage') or ''
    if urllib.parse.urlsplit(photo).scheme != 'https':
        photo = ''
    history = item.get('history') or {}
    accident_count = history.get('accidentCount')
    owners = history.get('ownerCount')
    accidents = ('No reported accidents' if type(accident_count) is int and accident_count == 0 else
                 f'{accident_count} reported accidents' if type(accident_count) is int and accident_count > 0 else
                 'History unavailable')
    # The listings API does not document a clean-title assertion. Never infer it
    # from a dealer advertisement, a Carfax link, or absent history fields.
    return dict(source='autodev', source_listing_id=vin, listing_url=url, vin=vin,
        year=year, make=make, model=expected_model, status='active', category='retail',
        asking_price=retail.get('price'), mileage=retail.get('miles'), currency='USD',
        city=retail.get('city', ''), state=retail.get('state', ''), postal_code=retail.get('zip', ''),
        seller=retail.get('dealer', ''), seller_type='dealer', photo_url=photo,
        exterior_color=v.get('exteriorColor', ''), interior_color=v.get('interiorColor', ''),
        title_status='unknown', accident_history=accidents, owners=str(owners) if type(owners) is int and owners > 0 else 'Unknown',
        owners_source='Auto.dev reported history' if type(owners) is int and owners > 0 else '',
        notes='Auto.dev dealer inventory. Title history is not established by this feed. Available owner and accident counts are provider-reported.')


class Client:
    def __init__(self, api_key):
        self.api_key = api_key

    def get(self, url):
        p = urllib.parse.urlsplit(url)
        if p.scheme != 'https' or p.netloc != 'api.auto.dev' or p.path != '/listings':
            raise ValueError('Unexpected API pagination destination')
        request = urllib.request.Request(url, headers={'Authorization': 'Bearer ' + self.api_key, 'Accept': 'application/json'})
        # Do not forward the credential to a redirected host.
        class NoRedirect(urllib.request.HTTPRedirectHandler):
            def redirect_request(self, *args, **kwargs):
                return None
        try:
            with urllib.request.build_opener(NoRedirect()).open(request, timeout=30) as response:
                raw = response.read(8_000_001)
                if len(raw) > 8_000_000:
                    raise ValueError('API response exceeds 8 MB')
                return json.loads(raw)
        except urllib.error.HTTPError as e:
            raise ValueError(f'Auto.dev HTTP {e.code}; collection stopped') from None


def collect(client, state, now):
    """At most 28 calls per UTC day and 900/month; no absence-based removals.

    State is saved by the existing collector even after a partial API response.
    Reserve a request before sending it, including failures, to bound usage.
    """
    usage = state.setdefault('autodev_usage', {})
    if usage.get('month') != now[:7]:
        usage.clear()
        usage.update(month=now[:7], calls=0)
    if usage.get('day') == now[:10]:
        return [], {'status': usage.get('status', 'warning'), 'detail': 'Daily API collection already attempted. ' + usage.get('detail', ''), 'checked_at': usage.get('checked_at', now)}
    usage.update(day=now[:10], checked_at=now)
    rows, errors, calls, skipped = [], [], 0, 0
    for model, make, model_names, years in QUERIES:
        url = BASE + '?' + urllib.parse.urlencode({'vehicle.make': make, 'vehicle.model': model_names,
            'vehicle.year': years, 'retailListing.used': 'true', 'limit': 20, 'includes': 'total'})
        seen = set()
        while url:
            if calls >= 28 or usage['calls'] >= 900:
                errors.append('Free-tier request budget reached; remaining pages deferred')
                break
            if url in seen:
                errors.append('API repeated a pagination URL')
                break
            seen.add(url)
            calls += 1
            usage['calls'] += 1
            try:
                payload = client.get(url)
                if not isinstance(payload.get('data'), list):
                    raise ValueError('API response has no listings array')
                for item in payload['data']:
                    try:
                        rows.append(parse_listing(item, model))
                    except (ValueError, TypeError, AttributeError):
                        skipped += 1
                link = (payload.get('links') or {}).get('next')
                url = urllib.parse.urljoin(BASE, link) if link else ''
                if url:
                    time.sleep(0.25)
            except Exception as e:
                # Do not expose response bodies, headers or credentials.
                errors.append(str(e) if isinstance(e, ValueError) else type(e).__name__)
                url = ''
    detail = f'{len(rows)} dealer observations; {calls} API calls today, {usage["calls"]}/900 monthly budget. Title history requires independent evidence.'
    if skipped:
        detail += f' {skipped} incomplete or out-of-scope records excluded.'
    if errors:
        detail += ' ' + '; '.join(dict.fromkeys(errors))
    usage.update(status='partial' if errors else 'warning' if skipped else 'ok', detail=detail)
    return rows, {'status': usage['status'], 'detail': detail, 'checked_at': now}
