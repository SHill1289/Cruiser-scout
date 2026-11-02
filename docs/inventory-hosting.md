# Inventory hosting

The public application remains at https://cruiser-scout.vercel.app. GitHub Pages
serves the public inventory and referenced photos at
https://shill1289.github.io/Cruiser-scout/. Owner credentials and the refresh API
remain on Vercel; they are never part of the Pages artifact.

## Automatic updates

`LX470 database refresh` collects on its existing six-hour schedule (Auto.dev
retains its daily limit) or through the owner refresh button. After the workflow
finishes, `Publish inventory feed` checks out the latest main branch, validates
the inventory and all referenced photos, then publishes them to Pages. This also
runs after partial collections because those preserve valid previously collected
inventory. A failed publication leaves the previous Pages deployment live.

The separate workflow_run trigger is intentional: commits made by GITHUB_TOKEN
do not trigger another push workflow. Pull-request runs never publish. Publishing
is serialized and always reads main, so queued older runs cannot overwrite newer
inventory with their original commit. Workflow artifacts expire after one day.

`scripts/build_inventory_feed.cjs` rewrites cached photo paths to absolute Pages
URLs, including nested galleries. It publishes only inventory.json, referenced
photos, a small index and .nojekyll. Private collector state, source caches and
credentials are excluded. Missing photo files, unsafe paths, empty inventory or
an output over 500 MiB fail before publication. Review the Actions summary for
the measured output size; do not raise the budget without reviewing free limits.

## Vercel builds

`scripts/build_site.cjs` excludes inventory.json and photos from site-output.
The application has a 10 MiB build budget. `scripts/ignore_vercel_build.cjs`
compares against VERCEL_GIT_PREVIOUS_SHA to skip data-only changes without losing
pending code changes; missing Git history conservatively permits a build.
Raptor branch builds remain skipped. Vercel's one-day retention policy remains
a second safeguard for old application deployments.

Both initial inventory loading and owner refresh polling use inventory-source.js.
The /inventory.json and /photos/* Vercel paths redirect to Pages for old links.
The browser sends no owner cookies to Pages. GitHub's CDN can take several
minutes to expose a fresh publication; owner controls wait for generated_at to
advance before offering to reload.

## Verification and recovery

Run `node --test tests/*.test.cjs`, `node scripts/build_inventory_feed.cjs`, and
`node scripts/build_site.cjs`. Confirm Pages inventory.json returns HTTP 200 with
Access-Control-Allow-Origin, inspect a referenced photo, and check the live app's
inventory, full-screen gallery and owner controls.

If publishing fails, inspect Publish inventory feed in GitHub Actions and rerun
it after correcting the issue. Do not restore inventory and photos to every
Vercel deployment as a routine workaround. GitHub retains the source data and
photos, while Pages keeps serving the last successful publication.

