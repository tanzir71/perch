# Integrating Perch

To integrate Perch into this site, read `INTEGRATION.md` and follow it from top to bottom.

Hard rules:

- Never add cookies or persistent client identity. `sessionStorage` is only for per-tab pageview deduplication.
- Never put personal information in event `props` or `name`.
- Never insert the Perch tracker more than once.
- Never commit the Worker `SALT`.
- Keep one stable `PROJECT_ID` per site.
- Keep `/collect` public with a narrowly scoped Cloudflare Access Bypass application.
- Protect `/` and `/api/*` with Cloudflare Access for the owner.
- Reuse one Worker, one D1 database, and one Worker-served dashboard for all projects.
- Instrument existing CTA markup; do not restructure the page just for analytics.
