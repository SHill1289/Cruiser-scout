"""Bounded, deterministic owner report queue; no AI or paid calls."""
import hashlib
import json
import os
import re
from datetime import datetime, timedelta, timezone
from pathlib import Path

REASONS = {'wrong_photo', 'already_sold', 'missing_information'}

def report_id(key, reason):
    return hashlib.sha256(f'{key}:{reason}'.encode()).hexdigest()

def write(path, report):
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_suffix('.tmp')
    temp.write_text(json.dumps(report, indent=2) + '\n', encoding='utf-8')
    temp.replace(path)

def enqueue(root, key, reason, now):
    if not re.fullmatch(r'[a-zA-Z0-9:_.-]{1,200}', key or '') or reason not in REASONS:
        raise ValueError('Invalid listing report')
    path = root / 'data/recheck_requests' / (report_id(key, reason) + '.json')
    if path.exists():
        old = json.loads(path.read_text(encoding='utf-8'))
        if old['status'] in {'queued', 'retry_queued'} or datetime.fromisoformat(now)-datetime.fromisoformat(old['requested_at']) < timedelta(days=1):
            return old
    report = dict(listing_key=key, reason=reason, requested_at=now, status='queued', attempts=0,
                  detail='Queued for a scheduled inventory refresh; no listing facts changed.')
    write(path, report)
    return report

def process_requests(root, state, now, check, limit=5, writer=write):
    attempted = 0
    paths = sorted((root / 'data/recheck_requests').glob('*.json'))
    pending = [(path, json.loads(path.read_text(encoding='utf-8'))) for path in paths]
    for path, report in sorted(pending, key=lambda item: item[1]['requested_at']):
        if attempted >= limit: break
        if report['status'] not in {'queued', 'retry_queued'}: continue
        if report.get('retry_at', '') > now: continue
        attempted += 1
        report['attempts'] += 1
        report['checked_at'] = now
        row = state.get('listings', {}).get(report['listing_key'])
        try:
            if not row: raise ValueError('Listing is not yet in the collected database')
            result = check(row, report['reason'])
            report.update(result)
            report.pop('retry_at', None)
        except Exception:
            report['status'] = 'retry_queued' if report['attempts'] < 3 else 'needs_review'
            report['detail'] = ('Source unavailable or listing identity could not be verified. Existing data was preserved. '
                                + ('Retry after 24 hours.' if report['attempts'] < 3 else 'Three attempts completed; manual review is needed.'))
            report['retry_at'] = (datetime.fromisoformat(now)+timedelta(days=1)).isoformat()
        writer(path, report)
    return {'source':'Reported listing issues', 'status':'warning' if any(r['status']=='needs_review' for _,r in pending) else 'ok',
            'checked_at':now, 'detail':f'{attempted} reported issues rechecked this refresh; at most {limit} attempts per run. Reports never establish sale status by themselves.'}

if __name__ == '__main__':
    root = Path(__file__).resolve().parents[1]
    result = enqueue(root, os.environ.get('REPORT_LISTING_KEY',''), os.environ.get('REPORT_REASON',''), datetime.now(timezone.utc).isoformat())
    print(result['status'] + ': ' + result['detail'])

def recheck_listing(state, row, reason, fetcher, now, changes):
    """Read a fresh source page or current collection evidence; never trust the report as evidence."""
    import copy
    import urllib.parse
    from finder import (listing_detail_url, parse_bat, parse_ksl, normalize, update,
                        add_listing_photo, cargurus_condition_claims)
    source = row.get('source')
    if reason == 'already_sold' and row.get('last_seen') == now:
        if row.get('status') == 'sold':
            return {'status':'updated', 'detail':'The source confirms a completed sale. Inventory contains the source-reported sold status.'}
        if row.get('status') == 'active':
            return {'status':'needs_review', 'detail':'The source still advertises this vehicle in the latest collection. Seller confirmation is needed; the report did not change its status.'}
    allowed = {'bringatrailer':{'bringatrailer.com','www.bringatrailer.com'},
               'cargurus':{'cargurus.com','www.cargurus.com'},
               'truecar':{'truecar.com','www.truecar.com'},
               'ksl':{'cars.ksl.com'}}
    url = listing_detail_url(row)
    parsed = urllib.parse.urlsplit(url)
    if parsed.scheme != 'https' or parsed.hostname not in allowed.get(source,set()):
        return {'status':'needs_review', 'detail':'This source has no supported direct recheck. Normal collection continues; review the source listing. No data was changed.'}
    page = fetcher.get(url)
    before = copy.deepcopy(row)
    verified = bool(row.get('vin') and row['vin'].upper() in page.upper())
    if source in {'bringatrailer','ksl'}:
        fresh = normalize(parse_bat(page,url,now) if source=='bringatrailer' else parse_ksl(page,url))
        if fresh['listing_key'] != row['listing_key'] or row.get('vin') and fresh.get('vin') != row['vin']:
            raise ValueError('Listing identity mismatch')
        verified = True
        if reason != 'wrong_photo':
            changes.extend(update(state,[fresh],now))
            row = state['listings'][row['listing_key']]
    if not verified: raise ValueError('Listing identity unavailable')
    if reason == 'wrong_photo':
        trial = copy.deepcopy(row)
        trial.update(photo_url='',photo_urls=[],photo_selection_version='',photo_source=source,photo_source_url=url)
        error = add_listing_photo(trial,fetcher)
        if error or not trial.get('photo_urls'): raise ValueError('Photos unavailable')
        if trial['photo_urls'] == (row.get('photo_urls') or [row.get('photo_url')]):
            return {'status':'needs_review', 'detail':'The source returned the same photos. Automatic checks cannot establish whether they show the correct vehicle; manual review is needed.'}
        for field in ['photo_url','photo_urls','photo_selection_version','photo_source','photo_source_url']:
            row[field] = trial.get(field,'')
        return {'status':'updated', 'detail':'Gallery refreshed from the identity-matched source page. Please check the replacement photos; visual correctness is not automatically confirmed.'}
    if reason == 'missing_information' and source == 'cargurus':
        claims = cargurus_condition_claims(page)
        for key,value in claims.items():
            if value: row[key] = value
    if reason == 'already_sold':
        return {'status':'updated' if row.get('status')=='sold' else 'needs_review',
                'detail':'Source confirms a completed sale.' if row.get('status')=='sold' else 'Source checked, but a completed sale was not confirmed. Existing status rules remain in effect.'}
    different = any(row.get(k)!=before.get(k) for k in row if k not in {'last_seen','last_checked','missing_checks'})
    return {'status':'updated' if different else 'needs_review',
            'detail':'New source evidence was added. Review the listing details.' if different else 'Source checked; no additional supported information was found. Missing information does not mean the item is absent or work was not done.'}
