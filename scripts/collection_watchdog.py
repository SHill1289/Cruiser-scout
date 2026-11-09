"""Bounded, non-AI collection monitoring. Uses only the workflow's GitHub token."""
import json
import os
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

REPO = 'SHill1289/Cruiser-scout'
INACTIVE = {'manual_only', 'disabled', 'paused', 'not_applicable'}


def age(value, now):
    try:
        stamp = datetime.fromisoformat(value.replace('Z', '+00:00'))
        if stamp.tzinfo is None:
            return float('inf')
        elapsed = (now - stamp).total_seconds()
        return elapsed if elapsed >= -300 else float('inf')
    except (ValueError, TypeError, AttributeError):
        return float('inf')


def assess(inventory, email, runs, now):
    issues = []
    stale = age(inventory.get('generated_at'), now) > 9 * 3600
    if stale:
        issues.append('Inventory snapshot is missing or more than 9 hours old.')
    if not inventory.get('listings'):
        issues.append('Inventory has no listing records; existing published data must be preserved.')
    for job in inventory.get('source_health', []):
        if job.get('status') in INACTIVE:
            continue
        source = job.get('source', 'Unknown')
        limit = 30 if source == 'autodev' else 9
        if job.get('status') in {'error', 'partial', 'warning'}:
            issues.append(f'{source}: {job["status"]}; see its source report. Existing retry/quota rules remain in effect.')
        elif age(job.get('checked_at'), now) > limit * 3600:
            issues.append(f'{source}: source report is overdue or has no valid timestamp.')
    if email is None or age(email.get('checked_at'), now) > 20 * 60:
        issues.append('Auction email feed is unavailable or overdue (20 minutes). Check the Google importer; no inbox access attempted.')
    elif email.get('partial'):
        issues.append('Auction email importer reports a partial check.')
    # Fail closed when run history is unavailable. Never overlap an active run,
    # duplicate a recent run, or spend API allowance retrying a source warning.
    recover = False
    reason = 'No extra collection needed; normal scheduled retries and backfills continue.'
    if stale:
        if runs is None:
            reason = 'Recovery deferred: GitHub run history unavailable.'
        elif any(r.get('status') != 'completed' for r in runs):
            reason = 'Recovery deferred: a collection is already queued or running.'
        elif any(age(r.get('created_at'), now) < 3600 for r in runs):
            reason = 'Recovery deferred: a collection was attempted within the last hour.'
        elif any(r.get('event') == 'workflow_dispatch' and age(r.get('created_at'), now) < 86400 for r in runs):
            reason = 'Recovery deferred: a manual or recovery collection was requested within 24 hours.'
        else:
            recover = True
            reason = 'Stale inventory is eligible for one recovery collection.'
    return issues, recover, reason


def request_json(url, token=None, payload=None):
    headers = {'User-Agent': 'Cruiser-Scout-collection-watchdog', 'Accept': 'application/json'}
    if token:
        headers['Authorization'] = 'Bearer ' + token
    body = None if payload is None else json.dumps(payload).encode()
    if body:
        headers['Content-Type'] = 'application/json'
    with urllib.request.urlopen(urllib.request.Request(url, data=body, headers=headers), timeout=25) as response:
        data = response.read(20_000_001)
        if len(data) > 20_000_000:
            raise ValueError('Response exceeds monitor size limit')
        return json.loads(data) if data else None


def main(root):
    now = datetime.now(timezone.utc)
    problems = []
    try:
        inventory = json.loads((root / 'web/inventory.json').read_text(encoding='utf-8'))
    except (OSError, ValueError):
        inventory = {}
    try:
        email = request_json('https://cruiser-scout.vercel.app/api/email-alerts')
    except Exception:
        email = None
    api = f'https://api.github.com/repos/{REPO}/actions/workflows/lx470_search.yml'
    token = os.environ['GH_TOKEN']
    try:
        runs = request_json(api + '/runs?branch=main&per_page=100', token)['workflow_runs']
        runs = [r for r in runs if r.get('event') != 'pull_request']
    except Exception:
        runs = None
        problems.append('Could not read collection run history; automatic dispatch disabled for this check.')
    issues, recover, action = assess(inventory, email, runs, now)
    problems.extend(issues)
    try:
        published = request_json('https://shill1289.github.io/Cruiser-scout/inventory.json')
        if not published.get('listings') or age(published.get('generated_at'), now) > 12 * 3600:
            problems.append('Public inventory feed is empty or over 12 hours old. Publishing runs again after this check.')
    except Exception:
        problems.append('Public inventory feed could not be checked. Publishing runs again after this check.')
    if recover:
        try:
            request_json(api + '/dispatches', token, {'ref': 'main'})
            action = 'Requested one recovery collection. Completion will be checked after that run; daily retry cap applies.'
        except Exception:
            action = 'Recovery request failed; no repeated dispatch attempted.'
            problems.append(action)
    # Only sanitized operational messages are published, never responses/tokens.
    report = {'source': 'Collection watchdog', 'status': 'warning' if problems else 'ok',
              'checked_at': now.isoformat(), 'detail': action + ' ' + (' '.join(problems) if problems else 'Inventory and email freshness checks passed.')}
    (root / 'data').mkdir(exist_ok=True)
    (root / 'data/collection_watchdog.json').write_text(json.dumps(report, indent=2) + '\n', encoding='utf-8')
    summary = '### Collection watchdog\n\n' + report['detail'] + '\n'
    if os.environ.get('GITHUB_STEP_SUMMARY'):
        with open(os.environ['GITHUB_STEP_SUMMARY'], 'a', encoding='utf-8') as output:
            output.write(summary)
    print(summary)


if __name__ == '__main__':
    main(Path(__file__).resolve().parents[1])
