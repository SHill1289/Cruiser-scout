import importlib.util
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

spec = importlib.util.spec_from_file_location('watchdog', Path(__file__).resolve().parents[1] / 'scripts/collection_watchdog.py')
watchdog = importlib.util.module_from_spec(spec)
spec.loader.exec_module(watchdog)


class WatchdogTests(unittest.TestCase):
    def setUp(self):
        self.now = datetime(2026, 11, 9, 15, tzinfo=timezone.utc)
        self.inventory = {'generated_at': self.ago(1), 'listings': [{}], 'source_health': []}
        self.email = {'checked_at': self.ago(0.1), 'partial': False}

    def ago(self, hours):
        return (self.now - timedelta(hours=hours)).isoformat()

    def assess(self, runs=()):
        return watchdog.assess(self.inventory, self.email, runs, self.now)

    def test_healthy_and_disabled_do_not_dispatch(self):
        self.inventory['source_health'] = [{'source': 'cars.com', 'status': 'manual_only'}]
        self.assertEqual(self.assess()[0], [])
        self.assertFalse(self.assess()[1])

    def test_source_errors_reported_but_do_not_repeat_full_collection(self):
        self.inventory['source_health'] = [{'source': 'autodev', 'status': 'error', 'detail': 'quota'}]
        self.assertIn('autodev', self.assess()[0][0])
        self.assertFalse(self.assess()[1])

    def test_stale_inventory_recovers_only_when_eligible(self):
        self.inventory['generated_at'] = self.ago(12)
        self.assertTrue(self.assess()[1])
        for runs in [None,
                     [{'status': 'in_progress', 'created_at': self.ago(2)}],
                     [{'status': 'completed', 'created_at': self.ago(.5)}],
                     [{'status': 'completed', 'event': 'workflow_dispatch', 'created_at': self.ago(23)}]]:
            self.assertFalse(self.assess(runs)[1])
        self.assertTrue(self.assess([{'status': 'completed', 'event': 'workflow_dispatch', 'created_at': self.ago(25)}])[1])

    def test_email_failure_does_not_dispatch_collector(self):
        for email in [None, {'checked_at': self.ago(1)}, {'checked_at': self.ago(0), 'partial': True}]:
            self.email = email
            self.assertTrue(self.assess()[0])
            self.assertFalse(self.assess()[1])

    def test_invalid_timestamps_and_daily_source(self):
        for value in [None, 'invalid', '2026-11-09T10:00:00', self.ago(-1)]:
            self.assertEqual(watchdog.age(value, self.now), float('inf'))
        self.inventory['source_health'] = [{'source': 'autodev', 'status': 'ok', 'checked_at': self.ago(24)}]
        self.assertFalse(self.assess()[0])


if __name__ == '__main__':
    unittest.main()
