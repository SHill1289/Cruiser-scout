# Collection watchdog

Runs in GitHub Actions after each production collector finishes and daily at 14:47 UTC (9:47 AM Eastern standard time / 10:47 AM daylight time). No AI model, API subscription, new secret, or local computer is required.

Checks inventory and source timestamps plus the sanitized public auction email feed. Manual-only sources are excluded from failure checks. Existing source search retries and quota-limited gallery backfills continue in the normal collector.

If the inventory snapshot is over nine hours old, the watchdog may dispatch one recovery collection. It refuses when a collection is queued/running, a collection started within an hour, a manual/recovery dispatch occurred within 24 hours, or run history is unavailable. Source warnings alone do not trigger another complete collection. Google login/trigger failures and source access blocks are reported, not bypassed.

The sanitized report is committed to `data/collection_watchdog.json`. The inventory publisher runs after the watchdog, even if that job fails, so a monitor failure cannot prevent publication of otherwise valid collected data. The publisher merges the report into the public source-health list without changing the inventory timestamp or stored listings. Collection health displays the report. The daily run also provides another publishing opportunity after a transient Pages failure. A failed monitor is visible in Actions; an older report retains its timestamp.

No monitoring report causes a Vercel app deployment. GitHub's normal Actions and Pages limits apply. This is rule-based recovery: collector format changes still require a code repair. The previous ChatGPT maintenance task is paused.
