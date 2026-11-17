"""Derived BaT buyer costs; source sale prices remain the recorded winning bids."""
import math
import re
from decimal import Decimal, ROUND_HALF_UP


def buyer_total(row):
    price = row.get('sale_price')
    if isinstance(price, bool) or not isinstance(price, (int, float)) or not math.isfinite(price) or price <= 0:
        return price
    if re.sub('[^a-z]', '', str(row.get('source', '')).lower()) != 'bringatrailer' or row.get('outcome') == 'unsold' or row.get('status') not in (None, '', 'sold') or row.get('auction_fee_included') or row.get('price_review', {}).get('sale_price'):
        return price
    if row.get('currency') and row['currency'].upper() not in ('USD', 'US$', '$'):
        return price
    date = str(row.get('sold_at') or row.get('auction_result_at') or '')[:10]
    cap = 5000 if re.fullmatch(r'\d{4}-\d{2}-\d{2}', date) and date <= '2024-01-29' else 7500
    bid = Decimal(str(price)).quantize(Decimal('.01'), rounding=ROUND_HALF_UP)
    fee = min(Decimal(cap), max(Decimal(250), (bid * Decimal('.05')).quantize(Decimal('.01'), rounding=ROUND_HALF_UP)))
    return float(bid + fee)
