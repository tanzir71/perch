# Integrating Perch

To integrate Perch into this site, read `INTEGRATION.md` and follow it from top to bottom.

Hard rules:

- Never add cookies, `localStorage`, `sessionStorage`, or any other client identity. The tracker stores nothing in the browser.
- Never put personal information in event `props` or `name`.
- Never insert the Perch tracker more than once. Load it from the Worker (`https://<worker-host>/perch.js`) so the endpoint is inferred.
- Never commit the Worker `SALT`.
- Keep one stable `PROJECT_ID` per site.
- Keep `/collect` and `/perch.js` public with narrowly scoped Cloudflare Access Bypass applications.
- Protect `/` and `/api/*` with Cloudflare Access for the owner.
- Reuse one Worker, one D1 database, and one Worker-served dashboard for all projects.
- Instrument existing CTA markup; do not restructure the page just for analytics.
- Register every project before sending events: once one project exists, the Worker rejects unknown project IDs.
- Single-page apps: call `perch.track("pageview")` after each route change; never send pageviews from a loop or a timer.
