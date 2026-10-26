"""Prevent repeated manual collections without a database or paid service."""
import json
import os
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

def allowed(event, runs, current_id, now):
    if event != "workflow_dispatch":
        return True
    for run in runs:
        if run.get("event") != "workflow_dispatch" or int(run["id"]) >= int(current_id):
            continue
        created = datetime.fromisoformat(run["created_at"].replace("Z", "+00:00"))
        if (now - created).total_seconds() < 3600:
            return False
    return True

if __name__ == "__main__":
    event = os.environ["GITHUB_EVENT_NAME"]
    runs = []
    if event == "workflow_dispatch":
        request = urllib.request.Request(
            "https://api.github.com/repos/SHill1289/Cruiser-scout/actions/workflows/lx470_search.yml/runs?branch=main&event=workflow_dispatch&per_page=30",
            headers={"Authorization": "Bearer " + os.environ["GH_TOKEN"], "Accept": "application/vnd.github+json"})
        with urllib.request.urlopen(request, timeout=20) as response:
            runs = json.load(response)["workflow_runs"]
    proceed = allowed(event, runs, os.environ["GITHUB_RUN_ID"], datetime.now(timezone.utc))
    with Path(os.environ["GITHUB_OUTPUT"]).open("a", encoding="utf-8") as output:
        output.write("allowed=" + str(proceed).lower() + "\n")
    if not proceed:
        with Path(os.environ["GITHUB_STEP_SUMMARY"]).open("a", encoding="utf-8") as output:
            output.write("Manual refresh skipped: another manual request was made in the last hour. No inventory API allowance was used.\n")
