# Manual refresh setup

The website calls `/api/refresh`; collection still runs in GitHub Actions.
No database or paid service is required.

Production Vercel secrets:
- `GITHUB_REFRESH_TOKEN`: fine-grained token, only SHill1289/Cruiser-scout, Actions read/write (plus automatic Metadata read). Rotate before its expiry.
- `REFRESH_OWNER_KEY`: randomly generated access code with at least 32 characters. Never put it in the repository.

Redeploy after changing secrets. Open Refresh inventory, enter the owner code, and select Start refresh. The code is exchanged for a seven-day Secure, HttpOnly, SameSite=Strict signed cookie. Lock owner controls clears the current browser's cookie; rotating the owner key invalidates all sessions.

The endpoint rejects unauthenticated and cross-origin writes. Requests are pinned to main and lx470_search.yml. Active runs block dispatch; recent manual runs enforce a one-hour cooldown. The workflow also serializes runs and checks GitHub history before collecting, protecting against simultaneous requests. Auto.dev's existing daily and monthly gates remain in force.

Progress is checked only while the dialog is open, every 30 seconds. Collection completion and a newer published inventory are separate: Load updated inventory appears after the snapshot changes. Partial collections preserve previously verified listings. Errors link to the GitHub run.

The coverage notice's close button remembers only the dismissed inventory timestamp in local storage. A newer partial snapshot shows a new notice; Sources and Coverage remains available.
