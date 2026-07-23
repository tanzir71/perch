# Perch

Perch is a self-hostable, privacy-first analytics tool for landing pages and small site portfolios. One tiny script sends cookieless events to your Cloudflare Worker and D1 database; the Worker itself serves a polished dashboard for every registered project.

## What you get

- Pageviews, anonymous daily unique visitors, 30-minute sessions, bounce rate, and pages per session
- CTA clicks, custom events, outbound links, referrers, and UTM campaigns
- Country-level geography, device, browser, operating system, and language
- Top and entry pages, live visitors, CTA conversion, CSV export, and an unsampled JSON API
- An “All projects” portfolio view plus a private Cloudflare Access sign-in
- A static marketing site and tiny CDN-ready tracker on GitHub Pages

## Start here

An LLM or developer integrating Perch should follow [INTEGRATION.md](./INTEGRATION.md) from top to bottom. It covers backend deployment, Cloudflare Access, project registration, tracker installation, CTA instrumentation, and verification.

For local development:

```bash
npm install
npm run test:all
```

`stats/index.html` is bundled into the Worker by `npm run build`. The deployable Worker is written to `dist/worker.js`; the tracker is minified to `src/perch.min.js`.

## Marketing site

The GitHub Pages workflow publishes `site/index.html` at the site root and `src/perch.min.js` beside it on every push to `main`. One time only, set **Repository Settings → Pages → Build and deployment → Source** to **GitHub Actions**. A normal push then makes both files live, usually within about a minute.

Before publishing, replace `YOUR-USER`, `YOUR-REPO`, and `YOUR-PERCH-WORKER` placeholders in `site/index.html`.

Zero-Actions fallback: rename or copy `site/` to `docs/`, place `src/perch.min.js` at `docs/perch.min.js`, and choose **Deploy from a branch → `main` → `/docs`** in Pages settings.

## API

The dashboard and API are intended to sit behind Cloudflare Access. Ingest at `POST /collect` remains public.

```text
GET /api/projects
GET /api/overview?from=YYYY-MM-DD&to=YYYY-MM-DD
GET /api/rollup?projectId=site-slug&from=YYYY-MM-DD&to=YYYY-MM-DD
GET /api/export.csv?projectId=site-slug&from=YYYY-MM-DD&to=YYYY-MM-DD
```

`/api/rollup` returns:

```json
{
  "projectId": "site-slug",
  "range": { "from": "2026-06-24", "to": "2026-07-23" },
  "totals": {
    "pageviews": 940,
    "uniques": 610,
    "sessions": 690,
    "bounceRate": 0.43,
    "pagesPerSession": 1.4,
    "realtime": 12,
    "conversionRate": 0.087
  },
  "byDay": [{ "date": "2026-07-23", "pv": 42, "uv": 31 }],
  "byCountry": [],
  "byPath": [],
  "byReferrer": [],
  "bySource": [],
  "byDevice": [],
  "byBrowser": [],
  "byOS": [],
  "byLanguage": [],
  "byCta": [],
  "topOutbound": [],
  "entryPages": []
}
```

Rates are decimal fractions. `realtime` is the distinct anonymous visitor count in the last five minutes. Sessions are 30-minute tumbling-window approximations. Breakdown items contain `name`, `events`, and—where applicable—`visitors`.

Rollups are full-data SQL queries over D1; Perch does not sample.

## Privacy

Perch uses no cookies and stores no raw IP addresses. The Worker hashes the connection IP, user agent, UTC date, and a secret salt, then immediately discards the IP. That anonymous hash rotates daily, so it cannot follow a person across days or sites.

Policy text you may reuse:

> We use Perch, a cookieless analytics tool, to understand aggregate site traffic and improve this website. Perch does not store IP addresses or create cross-site profiles. Anonymous visitor identifiers rotate daily. We collect page paths, coarse country and device information, referring domains, campaign tags, and interactions such as button clicks. Do not submit personal information through analytics event properties.

Perch is released under the [MIT License](./LICENSE).
