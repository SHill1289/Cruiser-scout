"""Non-destructive price review for exported inventory and ratings.

Raw observations stay in the database. Review means uncertain, not proven wrong.
Keep thresholds aligned with web/price-integrity.js and shared fixture tests.
"""
import math
import re
from datetime import datetime, timezone

FIELDS = ('asking_price', 'sold_price', 'current_bid', 'sale_price')


def timestamp(value):
    try:
        dt = datetime.fromisoformat(str(value).replace('Z', '+00:00'))
        return dt.replace(tzinfo=dt.tzinfo or timezone.utc).timestamp()
    except (ValueError, TypeError):
        return float('nan')


def reason(row, field, value, now=None):
    now = timestamp(now) if now is not None else datetime.now(timezone.utc).timestamp()
    if value is None or value == '':
        return ''
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or value <= 0:
        return 'Invalid or placeholder amount'
    if row.get('currency') and str(row['currency']).upper() not in ('USD', 'US$', '$'):
        return 'Non-USD amount; no currency conversion verified'
    bid = field == 'current_bid' or (field == 'sale_price' and row.get('outcome') == 'unsold')
    if not bid and value < 2500:
        return 'Unusually low full-vehicle price; may be a payment or deposit'
    if value > 250000:
        return 'Unusually high amount; verify the full-vehicle price'
    if not bid:
        for match in re.finditer(r'\$\s*([\d,]+(?:\.\d{1,2})?)\s*(?:/\s*(?:mo(?:nth)?|month)|per\s+month|a\s+month|monthly|down\b|deposit\b)', str(row.get('source_description') or ''), re.I):
            if float(match[1].replace(',', '')) == value:
                return 'Amount described as a payment or deposit'
    if field == 'current_bid' and row.get('status') not in ('ended', 'sold'):
        observed, end = timestamp(row.get('bid_observed_at')), timestamp(row.get('auction_ends_at'))
        if row.get('status') != 'active' or not math.isfinite(observed) or observed > now + 60 or now-observed > 86400 or not math.isfinite(end) or end <= now:
            return 'Auction bid is stale or its current status is unverified'
    return ''


def field_for(row):
    return 'sold_price' if row.get('status') == 'sold' else 'current_bid' if row.get('category') == 'auction' else 'asking_price'


def clean(row, now=None):
    result = {**row, 'price_review': dict(row.get('price_review') or {}), 'reported_prices': dict(row.get('reported_prices') or {})}
    for field in FIELDS:
        why = reason(row, field, row.get(field), now)
        if why:
            result['reported_prices'][field] = row[field]
            result['price_review'][field] = why
            result[field] = None
    if result['price_review'].get(field_for(row)):
        result = {key: value for key, value in result.items() if not key.startswith('deal_')}
    return result


def listings(rows, now):
    result = [clean(row, now) for row in rows]
    groups = {}
    for row in result:
        seen = timestamp(row.get('last_seen'))
        if row.get('status') != 'active' or row.get('category') != 'retail' or row.get('asking_price') is None or not re.fullmatch(r'vin:[A-HJ-NPR-Z0-9]{17}', row.get('vehicle_key') or '') or not math.isfinite(seen) or timestamp(now)-seen > 7*86400 or seen > timestamp(now)+60:
            continue
        groups.setdefault(row['vehicle_key'], []).append(row)
    conflicts = set()
    for group in groups.values():
        for i, a in enumerate(group):
            for b in group[i+1:]:
                low, high = sorted((a['asking_price'], b['asking_price']))
                if a.get('source') != b.get('source') and abs(timestamp(a['last_seen'])-timestamp(b['last_seen'])) <= 2*86400 and high-low >= 5000 and high/low > 1.35:
                    conflicts.update((id(a), id(b)))
    for row in result:
        if id(row) in conflicts:
            row['reported_prices']['asking_price'] = row['asking_price']
            row['asking_price'] = None
            row['price_review']['asking_price'] = 'Recent sources disagree substantially for this VIN'
            for key in list(row):
                if key.startswith('deal_'):
                    del row[key]
    return result
