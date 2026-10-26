import sys
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from manual_refresh_gate import allowed

class ManualRefreshGateTests(unittest.TestCase):
    def test_duplicate_manual_is_skipped_but_schedule_runs(self):
        now = datetime.now(timezone.utc)
        runs = [{"id": 10, "event": "workflow_dispatch", "created_at": (now - timedelta(minutes=5)).isoformat()}]
        self.assertFalse(allowed("workflow_dispatch", runs, 11, now))
        self.assertTrue(allowed("schedule", runs, 11, now))
        self.assertTrue(allowed("workflow_dispatch", runs, 10, now))
        self.assertTrue(allowed("workflow_dispatch", runs, 11, now + timedelta(hours=2)))
