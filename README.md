# Perch

Perch is a self-hostable, privacy-first analytics tool for landing pages and small site portfolios. One tiny cookieless script sends events to your own Cloudflare Worker and D1 database; the same Worker serves the tracker and a private dashboard for every registered project.

[Live site and demo dashboard](https://tanzir71.github.io/perch/) · [Integration guide](./INTEGRATION.md) · [Deploy to Cloudflare](https://deploy.workers.cloudflare.com/?url=https://github.com/tanzir71/perch)

## What you get

- **Portfolio first.** "All projects" ranks every site by visitors, compares each with the previous period, and flags sites that went quiet or never sent an event.
- **Traffic:** pageviews (every page, every load), anonymous daily visitors, 30-minute sessions, engaged visits, and pages per visit.
- **Acquisition:** channels (Direct, Search, AI assistants, Social, Email, Paid, Referral, Campaign), referring hosts, and UTM source, medium and campaign.
- **Attention:** scroll depth and visible time per page, plus top, entry and exit pages.
- **Goals:** conversion rate per CTA and per custom event, outbound links, and custom event properties.
- **Audience:** country, device, browser, operating system, and language.
- **Every row is a filter.** Click a referrer, page, country or CTA and the whole view scopes to it.
- **Install check:** a new project's dashboard shows a live checklist until its first events arrive, with a "send test event" button.
- **Optional Web Vitals** (LCP, INP, CLS at p75), realtime visitors, CSV export, and an unsampled JSON API.
- **A public demo** of the dashboard on GitHub Pages, running entirely on generated data.

The tracker is under 3 KB gzipped, stores nothing in the browser, and never throws.

## Start here

An LLM or developer integrating Perch should follow [INTEGRATION.md](./INTEGRATION.md) from top to bottom. It covers deployment, Cloudflare Access, project registration, the tracker tag, CTA instrumentation, and verification.

The shortest path, from a clone:

```bash
npm install
npx wrangler d1 create perch            # paste the database_id into wrangler.toml
npx wrangler secret put SALT            # a long random string; never commit it
npm run deploy                          # builds, applies migrations, deploys
```

Then add one tag to each site:

```html
<script src="https://perch.YOUR-ACCOUNT.workers.dev/perch.js" data-project-id="my-project" defer></script>
```

For local development, copy `.dev.vars.example` to `.dev.vars`, set a `SALT`, and run `npm run dev`.

## How it stays small

- **One Worker, one D1 database, one dashboard** for every project. No build step on your sites, no runtime dependencies.
- **Nightly rollups.** A Cron Trigger (`15 0 * * *`) summarises each finished UTC day into a small `daily` table. Long ranges read those summaries instead of scanning raw events, which keeps reads far inside the D1 free tier. Today is always read live. Run it on demand with `POST /api/maintenance`.
- **Optional retention.** Set `RETENTION_DAYS` in `wrangler.toml` to delete raw events older than that once they are rolled up. Daily summaries are kept. CSV export covers the raw events you keep.
- **Migrations, not hand-run SQL.** The schema lives in `migrations/` and `npm run deploy` applies anything new.

## Repository layout

```text
src/perch.js            tracker source (src/perch.min.js is generated and committed)
worker/worker.js        ingest, API, rollups, and the routes that serve the dashboard and tracker
stats/index.html        dashboard (inlined into the Worker by npm run build)
stats/demo-data.js      deterministic data for the public demo
site/                   marketing site for GitHub Pages
migrations/             D1 schema migrations
wrangler.toml           Worker config (D1 binding, cron, vars)
```

`npm run build` regenerates `src/perch.min.js`, `worker/tracker.generated.js`, `worker/dashboard.generated.js`, `dist/worker.js` and `dist/pages/`. Commit the generated files: the Pages workflow and `wrangler deploy` use them as they are.

## Marketing site and demo

The GitHub Pages workflow publishes `dist/pages/` on every push to `main`: the marketing site, the tracker, and a demo dashboard at `/dashboard/?demo`. It installs nothing.

One time only, set **Repository Settings → Pages → Build and deployment → Source** to **GitHub Actions**. Until then the workflow fails at "Configure Pages" and the site returns 404.

Before relying on the site's own analytics, replace the `YOUR-PERCH-WORKER` placeholder in `site/index.html` with your Worker host.

## API

The dashboard and API sit behind Cloudflare Access. `POST /collect` and `GET /perch.js` stay public.

```text
GET  /api/projects
GET  /api/overview?from=YYYY-MM-DD&to=YYYY-MM-DD&compare=1
GET  /api/rollup?projectId=site-slug&from=YYYY-MM-DD&to=YYYY-MM-DD&compare=1&filter=referrer:news.ycombinator.com
GET  /api/status?projectId=site-slug
GET  /api/export.csv?projectId=site-slug&from=YYYY-MM-DD&to=YYYY-MM-DD
POST /api/maintenance
```

`from` and `to` are inclusive UTC dates; without them the range is the last 30 days. `compare=1` adds the previous period of the same length. `filter=dim:value` may repeat (up to five); dimensions are `page`, `referrer`, `channel`, `source`, `medium`, `campaign`, `country`, `device`, `browser`, `os`, `lang`, `cta` and `event`.

`/api/rollup` returns:

```json
{
  "projectId": "site-slug",
  "range": { "from": "2026-10-19", "to": "2026-11-17" },
  "filters": [],
  "totals": {
    "pageviews": 940,
    "uniques": 610,
    "sessions": 690,
    "engagedRate": 0.57,
    "bounceRate": 0.43,
    "pagesPerSession": 1.4,
    "conversionRate": 0.087,
    "ctaClicks": 84,
    "avgScroll": 64,
    "avgTimeMs": 41000,
    "realtime": 12
  },
  "previous": { "range": {}, "totals": {}, "byDay": [] },
  "byDay": [{ "date": "2026-11-17", "pv": 42, "uv": 31 }],
  "byChannel": [], "byReferrer": [], "bySource": [], "byMedium": [], "byCampaign": [],
  "byPath": [], "entryPages": [], "exitPages": [],
  "byCta": [], "byEvent": [], "byEventProps": [], "topOutbound": [],
  "byCountry": [], "byDevice": [], "byBrowser": [], "byOS": [], "byLanguage": [],
  "vitals": { "LCP": null, "INP": null, "CLS": null }
}
```

Rates are decimal fractions. A session is **engaged** when it has more than one pageview, any CTA or custom event, or at least 10 seconds of visible time; `bounceRate` is the remainder. `realtime` counts distinct anonymous visitors in the last five minutes. Breakdown items contain `name`, `events` and `visitors`; pages add `scroll` and `timeMs`, goals add `conversionRate`. `previous` appears only with `compare=1`.

Perch does not sample: every number is a SQL query over every stored event or its exact daily summary.

## Privacy

Perch uses no cookies and no client storage, and stores no raw IP addresses. The Worker hashes the connection IP, user agent, UTC date and a secret salt, then discards the IP. That anonymous hash rotates daily, so it cannot follow a person across days or sites. Once a project is registered, events for unknown project IDs are rejected.

Policy text you may reuse:

> We use Perch, a cookieless analytics tool, to understand aggregate site traffic and improve this website. Perch does not store IP addresses or create cross-site profiles. Anonymous visitor identifiers rotate daily. We collect page paths, coarse country and device information, referring domains, campaign tags, and interactions such as button clicks. Do not submit personal information through analytics event properties.

## Development

```bash
npm install
npx playwright install chromium
npm run test:all
```

Tests use Node's built-in runner. Worker queries run against a real SQLite database through `node:sqlite` (Node 22.5+; skipped on older Node), browser tests use Playwright, and `test/worker.integration.mjs` runs the bundled Worker in Miniflare.

Perch is released under the [MIT License](./LICENSE).
