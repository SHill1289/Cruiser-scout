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
        if p.scheme != 'https' or p.netloc != 'api.auto.dev' or not (p.path == '/listings' or re.fullmatch(r'/photos/[A-HJ-NPR-Z0-9]{17}', p.path)):
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
    usage.update(day=now[:10], checked_at=now, calls_today=0)
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
            usage['calls_today'] += 1
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


def enrich_photos(client, state, rows, now, priority_request=None):
    """Persist a fair retry queue without spending the inventory request reserve."""
    import calendar
    from datetime import datetime, timedelta
    usage = state.setdefault('autodev_usage', {})
    if usage.get('month') != now[:7] or usage.get('day') != now[:10]:
        return 0
    date = datetime.fromisoformat(now)
    if usage.get('photo_day') != now[:10]:
        usage.update(photo_day=now[:10], photo_calls_today=0, priority_photo_calls_today=0)
    request = priority_request or {}
    request_id = str(request.get('id') or '')[:100]
    requested = {vin for vin in request.get('vins', [])[:50]
                 if isinstance(vin, str) and re.fullmatch(r'[A-HJ-NPR-Z0-9]{17}', vin)} if request_id else set()
    processed = state.setdefault('photo_priority_requests', {}).setdefault(request_id, []) if request_id else []
    requested -= set(processed)
    attempts = state.setdefault('autodev_photo_attempts', {})
    # Migrate the original timestamp-only queue without discarding its history.
    for vin, record in list(attempts.items()):
        if isinstance(record, str):
            record = {'checked_at': record, 'attempts': 1, 'status': 'legacy'}
            attempts[vin] = record
        if record.get('status') in {'unavailable', 'legacy'} and record.get('checked_at'):
            retry_at = (datetime.fromisoformat(record['checked_at']) + timedelta(hours=24)).isoformat()
            record['retry_at'] = min(record.get('retry_at') or retry_at, retry_at)
    groups = {}
    for row in [*state.get('listings', {}).values(), *rows]:
        vin = row.get('vin', '')
        if (row.get('source') not in {'autodev', 'cargurus'} or row.get('status') != 'active'
                or 'vin_model_or_year_conflict' in (row.get('quality_flags') or '')
                or not re.fullmatch(r'[A-HJ-NPR-Z0-9]{17}', vin)):
            continue
        groups.setdefault(vin, []).append(row)
    # Conflicting identity evidence must never transfer photographs to another vehicle.
    groups = {vin: group for vin, group in groups.items()
              if len({(r.get('year'), r.get('model')) for r in group}) == 1}
    def assign(group, photos, source, source_url):
        for target in group:
            if len(target.get('photo_urls') or []) < len(photos):
                target.update(photo_urls=list(photos), photo_url=photos[0],
                              photo_source=source, photo_source_url=source_url)
    candidates = {}
    for vin, group in groups.items():
        donor = max(group, key=lambda r: len(r.get('photo_urls') or []))
        if len(donor.get('photo_urls') or []) > 1:
            assign(group, donor['photo_urls'], donor.get('photo_source') or donor['source'],
                   donor.get('photo_source_url') or donor.get('listing_url', ''))
        candidates[vin] = donor
    reserve = 28 * (calendar.monthrange(date.year, date.month)[1] - date.day)
    enriched = calls = 0
    stop_reason = ''
    def priority(pair):
        vin, _ = pair
        counts = [len(r.get('photo_urls') or ([r['photo_url']] if r.get('photo_url') else []))
                  for r in groups[vin] if r.get('source') == 'cargurus']
        tier = 0 if 0 in counts else 1 if 1 in counts else 2
        return vin not in requested, tier, attempts.get(vin, {}).get('checked_at', ''), vin
    for vin, row in sorted(candidates.items(), key=priority):
        record = attempts.get(vin, {})
        urgent = vin in requested
        if not urgent and (len(row.get('photo_urls') or []) > 1 or record.get('retry_at', '') > now):
            continue
        if state.get('autodev_photo_pause_until', '') > now:
            stop_reason = 'Provider retry pause'
            break
        if calls >= 50 or (not urgent and usage['photo_calls_today'] - usage.get('priority_photo_calls_today', 0) >= 100):
            stop_reason = 'Batch or daily photo allowance reached'
            break
        if usage.get('calls', 0) >= 900 - reserve:
            stop_reason = 'Remaining free requests reserved for inventory'
            break
        count = record.get('attempts', 0) + 1
        record = {'checked_at': now, 'attempts': count, 'status': 'unavailable',
                  'retry_at': (date + timedelta(hours=24)).isoformat()}
        attempts[vin] = record
        usage['calls'] += 1
        usage['photo_calls_today'] += 1
        if urgent:
            processed.append(vin)
            usage['priority_photo_calls_today'] = usage.get('priority_photo_calls_today', 0) + 1
        calls += 1
        try:
            payload = client.get('https://api.auto.dev/photos/' + vin)
            if not isinstance(payload, dict) or not isinstance(payload.get('data'), dict):
                raise ValueError('Invalid photo response')
            if payload.get('removedAt'):
                record.update(status='source_removed',
                              retry_at=(date + timedelta(days=min(30, 7 * 2 ** min(count - 1, 3)))).isoformat())
                continue
            photos = payload['data'].get('retail') or []
            if not isinstance(photos, list):
                raise ValueError('Invalid photo array')
            photos = list(dict.fromkeys(url for url in photos if isinstance(url, str)
                and urllib.parse.urlsplit(url).scheme == 'https'
                and urllib.parse.urlsplit(url).hostname in {'retail.photos.vin', 'api.auto.dev'}
                and not urllib.parse.urlsplit(url).query))[:8]
            if len(photos) > 1:
                assign(groups[vin], photos, 'autodev', 'https://docs.auto.dev/v2/products/vehicle-photos')
                record.update(status='complete', retry_at=(date + timedelta(days=30)).isoformat())
                enriched += 1
        except Exception as error:
            if 'HTTP 404' not in str(error):
                record.update(status='temporary_error',
                              retry_at=(date + timedelta(days=min(7, 2 ** min(count - 1, 3)))).isoformat())
                state['autodev_photo_pause_until'] = (date + timedelta(hours=6)).isoformat()
                stop_reason = 'Provider unavailable; retries scheduled'
                break
        time.sleep(0.25)
    pending = [vin for vin, row in candidates.items() if len(row.get('photo_urls') or []) < 2]
    waiting = sum(attempts.get(vin, {}).get('retry_at', '') > now for vin in pending)
    retry_dates = [attempts[vin]['retry_at'] for vin in pending if attempts.get(vin, {}).get('retry_at', '') > now]
    state['autodev_photo_progress'] = {
        'checked_at': now, 'complete': len(candidates) - len(pending), 'pending': len(pending),
        'waiting_retry': waiting, 'ready': len(pending) - waiting, 'added': enriched,
        'calls_this_run': calls, 'calls_today': usage['photo_calls_today'],
        'priority_calls_today': usage.get('priority_photo_calls_today', 0),
        'calls_this_month': usage.get('calls', 0), 'reason': stop_reason,
        'next_retry_at': min(retry_dates) if retry_dates else ''}
    return enriched
