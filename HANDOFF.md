# Perch — Build Handoff for Codex

> **Perch** — a quiet vantage point over all your sites. A self-hostable, privacy-first web analytics tool: a landing page loads one `<script>` tag, a small Cloudflare backend collects events, and a single hosted stats page shows every project from one dropdown.

> **Agent:** You are *building the Perch project*. Build iteratively: implement one milestone, run its gate, fix until green, then advance.
>
> **Two audiences, two doc sets.** *You* (the builder) follow this `HANDOFF.md`. The finished project must itself ship an **`INTEGRATION.md`** written for a *different* LLM — the one that later drops Perch into a specific landing page, deploys the backend, and hands the site owner a **ready-to-open stats page URL**. That integration guide is a first-class deliverable (Milestone 7).

---

## 1. Goal

Ship a project that provides:

- **Traffic:** page views, unique visitors (cookieless), sessions, bounce rate, pages/session.
- **Engagement:** CTA clicks, custom events with properties, automatic outbound-link tracking.
- **Acquisition:** referrer host + UTM source/medium/campaign.
- **Audience:** country (server-side geo), device type, browser, OS, language.
- **Content:** top pages, entry pages.
- **Conversions:** per-project CTA conversion rate + a simple pageview→CTA goal.
- **Realtime:** "visitors now" (active in the last 5 minutes), per project and globally.
- **Multi-project by design:** one Perch backend serves many sites. The **Worker itself serves a single stats page** at its own URL — gated by Cloudflare Access (sign in once, no passphrase, no code) — listing every project in a **dropdown selector** as one access point for all a user's sites.
- **Global / portfolio view:** an "All projects" mode that ranks every project by traffic so the user can instantly see which site is attracting more, with per-project comparison.
- **Export & API:** CSV export and a documented JSON rollup endpoint — full data, no sampling.
- A **user-friendly, ready-to-go stats page** that the site owner just opens (no query-param fiddling, plain-language labels, clean empty states).
- An **`INTEGRATION.md`** that lets an LLM integrate Perch into any landing page, register the project, and deliver the live stats URL without human hand-holding.
- A **marketing landing page** for Perch itself, hosted on **GitHub Pages** and **auto-deployed on every push to `main`**, so the product site (and the CDN-hosted tracker file) is live the moment the owner pushes. It dogfoods Perch by tracking itself.

Runs **standalone on GitHub Pages** (tracker, stats page served by the Worker, and the marketing site are static) plus one **Cloudflare Worker + D1** backend. **Privacy-first:** no cookies, no stored IPs, no consent banner (country-level only, cookieless IDs).

Non-goals: session replay, per-user profiles, GPS/city-level location, ad attribution, real-time streaming.

---

## 2. Core concept: projects

A **project** is one tracked site/landing page, identified by a `projectId` slug (e.g. `my-portfolio`, `client-acme`). Perch is multi-tenant on day one:

- One Worker + one D1 database serve **all** of a user's projects.
- Every event row carries its `project_id`.
- A `projects` registry table holds a friendly display name per project.
- The stats page reads that registry to build a **project dropdown** — pick a project, see its numbers. Adding a new project later (re-run integration with a new `projectId`) makes it appear in the dropdown automatically; the same Worker, D1, and stats page are reused.

This "one backend, one stats page, many projects" model is the single access point the product is built around.

**Where the access point lives — and how it's gated.** The stats page is **not** hosted inside any tracked project. Instead the **Worker serves it directly**, so the Worker URL *is* the access point: open it in a browser and it returns the dashboard; the same origin answers the data API and receives beacons. One URL to bookmark, and no CORS for the dashboard because page and API share an origin. The Worker routes by path:

- `POST /collect` → **ingest beacon — PUBLIC** (anonymous visitors on the tracked sites must be able to send events).
- `GET /` → serve the dashboard HTML.
- `GET /api/*` → data (rollup, overview, projects, export).

**Gating = Cloudflare Access, not custom code.** The Worker has **no auth logic** and the dashboard has **no login form**. At deploy time, a **Cloudflare Access** (Zero Trust, free tier) self-hosted application protects the Worker's hostname on `/` and `/api/*` with a policy allowing the owner's email/SSO, plus a **Bypass** rule for `/collect` so beacons flow unauthenticated. Access enforces identity *at the edge* before any request reaches the Worker. For the owner this is zero-effort: visit the URL, sign in once with the identity they already have (Google, email OTP), done — nothing to configure in the page, no passphrase to invent or type. Setup is a few clicks (or API calls) performed by the integration step, documented in `INTEGRATION.md`.

---

## 3. Architecture

GitHub Pages is static-only — it can't receive a POST, store data, or read geography. One **Cloudflare Worker** backed by **D1** (Cloudflare's SQLite) closes that gap. Because setup is performed by an LLM (not a human clicking dashboards), we optimize the store for **capability and queryability** rather than fewest clicks — so D1's raw event table wins over key/value counters: every metric is a SQL query, new breakdowns need no schema change, and sessions/bounce are computable after the fact.

```
   many landing pages           Cloudflare Access (edge identity gate)   one Cloudflare Worker = access point
┌───────────────────────────┐    ┌───────────────────────────┐    ┌──────────────────────────────────┐
│ perch.js on project A ─────┼─POST /collect ─ (Bypass) ──────┼───▶│ POST /collect → ingest event      │   ┌─────┐
│ perch.js on project B ─────┼─beacon─────────────────────────┼───▶│ GET  /        → dashboard HTML     │D1 │ evt │
│ perch.js on project C ─────┼─beacon─────────────────────────┼───▶│ GET  /api/*   → rollup/overview/…  │──▶│ prj │
└───────────────────────────┘    │  /  and /api/*  require     │    │ • cf.country • UA • hash • INSERT │   └─────┘
  you, the owner ── open URL ─────┼─ owner email/SSO (once) ───┼───▶│ • SQL rollups (no auth code)      │
                                  └───────────────────────────┘    └──────────────────────────────────┘
```

The Worker URL is the one thing the owner bookmarks: `GET /` serves the dashboard, the same origin answers `/api/*` and `/collect` receives beacons — no separate host, no CORS for the dashboard. Cloudflare Access gates `/` and `/api/*` at the edge (owner signs in once with existing identity); `/collect` is bypassed so ingest stays public. The Worker itself carries no auth logic.

**Why Worker + D1:** geography is free and server-side (`request.cf.country`, no client geo API / ad-blocker failure mode); the dashboard is same-origin with the API so reads use a plain `fetch`; the tracker stays tiny because the Worker derives `country`, `device/browser/os`, and `visitorHash` (no client geo or crypto); the secret salt stays server-side; ingest is a pure `INSERT` and all analytics are read-time SQL (no counters, no dedupe bookkeeping, no write races — uniques/sessions/bounce fall out of `COUNT(DISTINCT …)`).

**Scale note:** D1's free tier is ample for personal/marketing traffic; if a project outgrows it, the same Worker interface can front a rollup table without touching the tracker or stats page.

---

## 4. Repository Layout (target)

```
perch/
├── HANDOFF.md                 # this file (builder-facing)
├── README.md                  # human overview (short)
├── INTEGRATION.md             # ⭐ LLM-facing integration + deploy guide (Milestone 7)
├── AGENTS.md                  # 1-screen pointer: "to integrate, read INTEGRATION.md" + guardrails
├── src/
│   ├── perch.js               # the tracker (ships to users' sites)
│   └── perch.min.js           # minified build
├── worker/
│   ├── worker.js              # Cloudflare Worker: ingest + data API + SERVES the dashboard (no auth code)
│   ├── wrangler.toml          # Worker config (D1 binding, name, compat date; SALT secret)
│   └── schema.sql             # D1 schema: events + projects, with indexes
├── stats/
│   └── index.html             # ⭐ the ready-to-go stats page SOURCE — inlined into worker.js at build (GET /)
├── site/
│   └── index.html             # ⭐ Perch marketing landing page (GitHub Pages, self-contained, dogfoods Perch)
├── .github/
│   └── workflows/
│       └── pages.yml          # deploy site/ (+ src/perch.min.js) to GitHub Pages on push to main
├── demo/
│   └── index.html             # sample landing page wired end-to-end for tests
├── examples/
│   └── before-after.md        # HTML snippets: a page before vs. after instrumentation
├── test/
│   ├── tracker.test.mjs
│   ├── worker.test.mjs
│   ├── worker.integration.mjs
│   ├── stats.test.mjs         # headless: dropdown populates, switching re-renders
│   ├── site.test.mjs          # headless: landing page renders; pages.yml valid
│   └── run.sh
└── package.json               # dev-only: node:test, wrangler/miniflare, jsdom, playwright, esbuild
```

---

## 5. Data Contract

### 5.1 What the tracker sends (client → Worker)

Flat JSON beacon. **No IP, no country, no hash, no device** — derived server-side.

| Field       | Type   | Example                     | Notes |
|-------------|--------|-----------------------------|-------|
| `type`      | string | `"pageview"`\|`"cta"`\|`"outbound"`\|`"custom"` | event kind |
| `name`      | string | `"signup-hero"`             | CTA id / outbound host / custom name; empty for pageview |
| `path`      | string | `"/pricing"`                | `location.pathname` |
| `ref`       | string | `"https://news.ycombinator.com/"` | `document.referrer` (Worker reduces to host) |
| `utm`       | object | `{source,medium,campaign}`  | parsed from `location.search`; omit if none |
| `props`     | object | `{plan:"pro"}`              | custom event properties (custom events only) |
| `screen`    | number | `1440`                      | viewport width (bucketed server-side) |
| `lang`      | string | `"en-US"`                   | `navigator.language` |
| `tz`        | string | `"Asia/Dhaka"`              | `Intl…timeZone` |
| `ts`        | string | ISO 8601                    | client timestamp |
| `projectId` | string | `"my-portfolio"`            | which project this event belongs to |

### 5.2 What the Worker derives (raw IP never persisted or returned)

- `country` — `request.cf?.country ?? "XX"`.
- `device`/`browser`/`os` — compact UA classifier (~40 lines, heuristic; document as coarse).
- `referrer_host` — host of `ref`, or `""`.
- `visitor_hash` — `SHA256(clientIP + "|" + userAgent + "|" + utcDate + "|" + SALT)` hex; IP from `CF-Connecting-IP`, rotates daily, discarded after hashing. `SALT` is a Worker secret.

### 5.3 D1 schema (`worker/schema.sql`)

```sql
CREATE TABLE IF NOT EXISTS projects (
  id         TEXT PRIMARY KEY,        -- slug == events.project_id
  name       TEXT NOT NULL,           -- friendly display name for the dropdown
  origin     TEXT,                    -- site origin (CORS + reference)
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id    TEXT NOT NULL,
  type          TEXT NOT NULL,        -- pageview | cta | outbound | custom
  name          TEXT,
  path          TEXT,
  referrer_host TEXT,
  utm_source    TEXT, utm_medium TEXT, utm_campaign TEXT,
  country       TEXT,                 -- ISO alpha-2, "XX" if unknown
  device        TEXT, browser TEXT, os TEXT,
  visitor_hash  TEXT NOT NULL,        -- cookieless, daily-rotating
  screen_bucket TEXT,                 -- mobile|tablet|desktop|wide
  lang          TEXT,
  props         TEXT,                 -- JSON string for custom props
  ts            TEXT NOT NULL         -- server UTC ISO
);
CREATE INDEX IF NOT EXISTS idx_events_project_ts      ON events(project_id, ts);
CREATE INDEX IF NOT EXISTS idx_events_project_visitor ON events(project_id, visitor_hash, ts);
```

Ingest is a single `INSERT`. Metrics are read-time queries: **uniques** = `COUNT(DISTINCT visitor_hash)`; **sessions** = `COUNT(DISTINCT visitor_hash || (unixepoch(ts)/1800))` (30-min tumbling window — document as an approximation); **bounce rate** = share of sessions with exactly one `pageview`; breakdowns = `GROUP BY country|path|referrer_host|utm_source|device|browser|os|name`.

**Privacy rules (must hold):** no cookies / no `localStorage` identity (`sessionStorage` only for per-tab pageview dedupe; the stats page may use `localStorage` only to remember the last-selected project + date range); raw IP hashed then discarded, never stored/logged/returned; `SALT` never in client code or responses; `props` never carry PII.

---

## 6. Feature Set (build exactly these)

1. **Pageviews** — auto on load; `perch.track("pageview")` for SPA route changes.
2. **Unique visitors** — cookieless daily hash.
3. **Sessions / bounce / pages-per-session** — read-time, 30-min window.
4. **CTA clicks** — any `[data-perch-cta="id"]`, capture-phase delegation.
5. **Custom events** — `window.perch.track("name", {props})`.
6. **Outbound links** — auto for `<a>` whose host ≠ current host (`name` = target host); opt-out with `data-perch-ignore`.
7. **Acquisition** — referrer host + UTM (auto-parsed).
8. **Audience** — country, device, browser, OS, language.
9. **Content** — top paths, entry pages.
10. **Multi-project stats page** — project dropdown, totals + time series + all breakdowns, date range, friendly UI.
11. **Global / portfolio view** — an "All projects" mode ranking projects by traffic (which site attracts more), with a comparison table + chart and per-project sparkline.
12. **Realtime** — "visitors now" (active in last 5 min), per project and in the global view.
13. **Conversions** — per-project CTA conversion rate (unique CTA clickers ÷ unique visitors) and a simple pageview→CTA goal; ties directly to the original CTA-tracking need.
14. **Export & API** — CSV export from the stats page and a documented JSON rollup endpoint (full data, no sampling).
15. **Core Web Vitals (optional module)** — LCP / INP / CLS via an opt-in `data-perf` flag; **off by default** to keep the tracker tiny.

---

## 7. Milestones (in order; each has a gate)

### M1 — Tracker (`src/perch.js`)
IIFE reading `data-*` config (`data-endpoint`, `data-project-id`, optional `data-respect-dnt`, `data-skip-bots`, `data-no-outbound`). Sends `pageview` once per tab (`sessionStorage` guard). Capture-phase delegation for CTAs (`closest('[data-perch-cta]')`) and outbound links. Parses UTM from `location.search`. Exposes `window.perch.track(typeOrName, props)`. Transport: `navigator.sendBeacon` (JSON) → `fetch({keepalive:true})` fallback. Never throws. No geo, no crypto.
**Gate M1:** `tracker.test.mjs` (jsdom, `sendBeacon` mocked): exactly one pageview/tab; one correct `cta` per CTA click; outbound `<a>`→`outbound` event with target host; internal links silent; UTM parsed; payloads carry no `ip`/`country`/`visitorHash`/`device`; thrown handlers never propagate; every payload includes `projectId`.

### M2 — Worker ingest + routing (`worker/worker.js`, `wrangler.toml`, `schema.sql`)
Module Worker with `DB` (D1) binding + one secret `SALT` (hashing). **No auth code — gating is Cloudflare Access at the edge (M7).** Route by path: `OPTIONS`→204+CORS; **`POST /collect` → ingest**; `GET /` and `GET /api/*` are stubbed here and filled in M3/M5. `POST /collect` ingest: validate `type`+`projectId`; derive `country`, `device/browser/os`, `referrer_host`, `visitor_hash`; `INSERT` one row; return `{ok:true}`+CORS; try/catch→`{ok:false,error}` at HTTP 200. Pure helpers (no D1): `hashVisitor`, `parseUA`, `refHost`, `bucketScreen`, `rowFromEvent`. Ship `schema.sql` (§5.3).
**Gate M2 (unit):** `worker.test.mjs`: `hashVisitor` deterministic + day-sensitive; `parseUA` classifies a representative UA table; `refHost`/`bucketScreen` correct; malformed body rejected; `POST /collect` inserts a well-formed row.

### M3 — Worker reads: data API (`GET /api/*`)
Access-gated at the edge (M7), so the Worker code itself needs no auth checks.
- `GET /api/rollup?projectId=&from=&to=` (default 30d) → `{ totals:{pageviews,uniques,sessions,bounceRate,pagesPerSession,realtime,conversionRate}, byDay:[{date,pv,uv}], byCountry, byPath, byReferrer, bySource, byDevice, byBrowser, byOS, byCta, topOutbound, entryPages }`. `realtime` = distinct `visitor_hash` in the last 5 min. `conversionRate` = distinct visitors with a `cta` event ÷ distinct visitors.
- `GET /api/projects` → `[{id,name,origin}]` from the `projects` table; **fallback** to `SELECT DISTINCT project_id` from events if the registry is empty, so the dropdown still works if registration was skipped.
- `GET /api/overview?from=&to=` → the **global/portfolio feed**: `[{projectId,name,pageviews,uniques,sessions,realtime,byDay:[{date,pv}]}]` for every project, sorted by pageviews desc. One query grouped by `project_id` (plus a small per-day query for sparklines). Powers the "All projects" view.
- `GET /api/export.csv?projectId=&from=&to=` → CSV of the matching event rows (or rollup) for export; correct `Content-Type` + `Content-Disposition`.
- Parameterized SQL builders, pure/testable where possible.
**Gate M3 (integration):** `worker.integration.mjs` (Miniflare/`unstable_dev`, real D1 — note Access is an edge layer not present locally, so tests hit the Worker directly): two pageviews via `POST /collect`, same visitor/day → `uniques==1`, `pageviews==2`; different hash → `uniques==2`; single-pageview session counts as a bounce; a visitor with a `cta` event yields `conversionRate>0`; a fresh event makes `realtime>=1`; two different `projectId`s stay isolated in per-project rollups but **both appear in `/api/overview` ranked by pageviews**; `/api/projects` returns both; `/api/export.csv` returns parseable CSV; assert `"XX"` when `request.cf` absent.

### M4 — Demo page (`demo/index.html`)
Loads `../src/perch.js` with placeholders; ≥2 CTAs, an outbound link, an internal link, a custom-event button.
**Gate M4:** headless (Playwright), network stubbed: one pageview on load; one `cta` per CTA; one `outbound`; `custom` on the button; internal link silent; no PII/derived fields in payloads.

### M5 — ⭐ Stats page (`stats/index.html`, served by the Worker at `GET /`) — the ready-to-go deliverable
Single self-contained file (inline CSS/JS; Chart.js via CDN allowed) that the build **inlines into `worker.js`** so the Worker returns it at `GET /`. The **Worker URL is the access point** — same-origin as the API, so it fetches `/api/*` with relative paths and **no CORS**. Design it as a **finished product for a non-technical site owner**, not a debug view:
- **No login UI, no config:** gating is Cloudflare Access at the edge (M7), so the page has **no passphrase prompt and no token handling** — by the time it loads, the owner is already authenticated. Because it's same-origin it needs no `WORKER_URL` constant either; it calls `/api/...` directly. (Accept an optional `?endpoint=` override for local dev only.) If an `/api/*` call ever returns 401/302 (session expired), show a friendly "Please sign in again" with a reload link.
- **On load:** `fetch("/api/projects")` → populate the **project selector**, whose first option is **"All projects" (global view)**, followed by each project's friendly name → auto-select the last-used choice (`localStorage`) or default to the global view.
- **Global / portfolio view ("All projects"):** the affordance for *which project attracts more*. Fetch `/api/overview`. Show a **ranked comparison** of projects by pageviews (sortable table: project, pageviews, unique visitors, sessions, live-now, per-project sparkline), plus a bar chart of the top projects and combined portfolio totals. Clicking a project row drills into its detail view.
- **Per-project detail view:** header with the Perch name + the project selector + a date-range selector (7/30/90d). A **"visitors now" realtime tile** and a **conversion-rate tile** alongside KPI tiles (pageviews, unique visitors, sessions, bounce rate, pages/session). A pv/uv time-series chart. Clean tables/bars for country, sources (referrer + UTM), device/browser/OS, top pages, entry pages, CTA leaderboard, outbound leaderboard.
- **Export:** an "Export CSV" button hitting `/api/export.csv?...` for the current view/range.
- **Friendly polish:** plain-language labels ("Unique visitors", not "uv"), country codes shown with flags/full names, thousands formatting, helpful empty states ("No data yet — events will appear here once your page gets traffic"), loading and error states, responsive on a phone.
- Remember last selection (global or a project) + date range in `localStorage` (the only allowed use).
**Gate M5:** `stats.test.mjs` headless against mocked `/api/projects`, `/api/overview`, and `/api/rollup` fixtures: the selector includes "All projects" + every project; the global view renders a ranked comparison and correctly identifies the highest-traffic project; clicking a project row drills into its detail; switching projects refetches/re-renders; realtime + conversion tiles render; Export targets `/api/export.csv`; a mocked 401 shows the "please sign in again" state; empty-state shows for a project with no data; no console errors.

### M6 — Build & polish
Minify `perch.js`→`perch.min.js` (target < 3 KB gzipped). Short human `README.md`. Privacy blurb the owner can paste into their policy.
**Gate M6:** bundle under budget; all prior gates green.

### M7 — ⭐ LLM Integration Guide (`INTEGRATION.md` + `AGENTS.md` + `examples/before-after.md`)
Write `INTEGRATION.md` **for an integrating LLM** — deterministic, copy-pasteable, self-verifying. Required sections, in order:

1. **What this is / what integration produces** — ends with a live, user-friendly stats page URL the owner can bookmark.
2. **Integration manifest to fill first:** `PROJECT_ID` (slug of the site), `PROJECT_NAME` (friendly), `WORKER_NAME`, `SALT` (generate a long random string), `ALLOW_ORIGIN` (site origin), `OWNER_EMAIL` (who may view the dashboard — used in the Cloudflare Access policy), and the target landing page's HTML path. Derived: `WORKER_URL` (from deploy) and the ingest endpoint `WORKER_URL + "/collect"`. **Reuse rule:** if the user already has a Perch backend, skip the deploy + Access steps and only register the new project + add the snippet — it will appear in the existing dropdown behind the same gate.
3. **Backend deploy — exact commands:**
   ```bash
   npx wrangler d1 create perch
   # paste the returned database_id into worker/wrangler.toml
   npx wrangler d1 execute perch --file=worker/schema.sql
   npx wrangler secret put SALT           # paste the generated salt
   npx wrangler deploy                     # prints https://<name>.workers.dev → WORKER_URL
   ```
   Include the dashboard-click alternative for non-CLI environments.
   **Recommended — first-party endpoint (ad-blocker resilience):** many blockers match `*.workers.dev`. If the site is on Cloudflare, add a Worker route on a **same-site subdomain** (e.g. `https://a.<sitedomain>`) and use that as `WORKER_URL`. First-party requests are far less likely to be blocked, closing the gap vs. tools that sell an "ad-blocker bypass" proxy.
   **Gate the dashboard with Cloudflare Access (Zero Trust, free) — the ONLY auth step, no code:** in the Zero Trust dashboard (or via API/Terraform), create a **self-hosted Access application** on `WORKER_URL`'s hostname with:
   - an **Allow policy** for `OWNER_EMAIL` (or a Google/email-OTP identity provider) covering paths `/` and `/api/*`, and
   - a **Bypass policy** for path `/collect` (Everyone) so beacons stay public.

   Result: the owner just visits `WORKER_URL`, signs in once with their existing identity, and sees the dashboard — nothing to install, no passphrase to set or type. Give exact click-path + the equivalent `cloudflared`/API snippet.
4. **Register the project** (so it shows in the dropdown with a friendly name):
   ```bash
   npx wrangler d1 execute perch --command \
     "INSERT OR REPLACE INTO projects (id,name,origin,created_at) VALUES ('$PROJECT_ID','$PROJECT_NAME','$ALLOW_ORIGIN',datetime('now'));"
   ```
5. **Add the tracker to the landing page** — exact `<script … data-endpoint="$WORKER_URL/collect" data-project-id defer>` snippet (note `data-endpoint` points at `/collect`), where it goes, and an **idempotency rule** (never insert twice; detect an existing `perch` script). Note the optional `data-perf` flag to enable Core Web Vitals (LCP/INP/CLS) collection for that page.
6. **Instrument CTAs — decision rules:** how to find primary CTAs in arbitrary markup (sign-up, buy, contact, download, subscribe, "get started", pricing…), a **naming convention** for `data-perch-cta` ids (`<intent>-<location>` kebab-case, e.g. `signup-hero`, `demo-nav`, `pricing-footer`), and before/after examples (link `examples/before-after.md`). Rule: instrument, don't restructure.
7. **Outbound & custom events** — outbound automatic; when/how to add `perch.track("newsletter_signup",{source:"footer"})`; the **no-PII guardrail** for `props`.
8. **UTM** — automatic; note the campaign-link format for the marketer.
9. **Hand over the stats page (ready to go):** there's nothing separate to deploy — the Worker already serves it at `GET /`. **Hand the owner `WORKER_URL`** as their one bookmark; opening it signs them in (via Access) and shows the project dropdown already populated. Adding future projects needs only steps 4–6; they appear in the same dropdown automatically, behind the same gate.
10. **Verification checklist to run and confirm green:**
    ```bash
    # ingest is public → works with no auth
    curl -s -X POST "$WORKER_URL/collect" -H 'content-type: application/json' \
      -d '{"type":"pageview","path":"/","projectId":"'"$PROJECT_ID"'","ts":"'"$(date -u +%FT%TZ)"'"}'
    npx wrangler d1 execute perch --command \
      "SELECT type,path,country FROM events WHERE project_id='$PROJECT_ID' ORDER BY id DESC LIMIT 1;"
    # dashboard/API are gated → unauthenticated curl should redirect to the Access login (302), NOT return data
    curl -s -o /dev/null -w '%{http_code}' "$WORKER_URL/api/projects"   # expect 302 (Access), not 200
    ```
    Confirm ingest inserted the row; confirm `/api/*` is gated (302 to Access); then open `WORKER_URL` in a browser, sign in, click a CTA on the page, and confirm the `cta` row and that the project is in the dropdown.
11. **Guardrails (hard rules):** never add cookies or client storage for identity; never put PII in `props`/`name`; never insert the snippet twice; never commit `SALT`; keep `PROJECT_ID` stable per site; always keep the `/collect` Bypass policy so ingest isn't accidentally gated; one backend + one Worker-served stats page serves all the user's projects — don't spin up duplicates.
12. **Troubleshooting table** — dashboard returns 200 to anonymous curl → Access app not covering `/` + `/api/*`; beacons 302/blocked → `/collect` Bypass missing; CORS → check `ALLOW_ORIGIN`; no rows → check `database_id`; project missing from dropdown → run step 4 (or it appears via the DISTINCT fallback once it has events); `country` always `XX` → local dev, expected; events missing in prod → ad blocker, use the first-party endpoint.

`AGENTS.md`: one screen — "To integrate Perch into this site, read `INTEGRATION.md` and follow it top to bottom," plus the step-11 guardrails.

**Gate M7:** `INTEGRATION.md` has every section with runnable commands and a filled example manifest; it includes the Cloudflare Access setup (Allow `/`+`/api/*` for the owner, Bypass `/collect`) and states the owner does nothing but sign in with existing identity; `examples/before-after.md` shows ≥3 real CTA instrumentations; a fresh reader can deploy, gate, register a project, and reach a working stats page using only these files. Dry-run the ingest + gating verification.

### M8 — ⭐ Marketing landing page + GitHub Pages auto-deploy (`site/index.html`, `.github/workflows/pages.yml`)

A single self-contained `site/index.html` (inline CSS/JS, no build step, no framework; optional inline SVG for a dashboard mock) — the public product page, modeled on how the privacy-analytics field presents itself (cookieless / no consent banner, one-line install, simple dashboard, GA-alternative framing, live demo, open-source/self-host) but leading with Perch's own differentiators. Required sections, in order:

1. **Hero** — the name **Perch**, tagline "A quiet vantage point over all your sites," a one-sentence subhead (privacy-first, cookieless, self-hostable analytics for landing pages), and two CTAs: primary "Get started" (→ repo / `INTEGRATION.md`), secondary "See the metrics" (→ anchor to the dashboard mock). Instrument both with `data-perch-cta` (`get-started-hero`, `demo-hero`).
2. **One-line install** — the copyable `<script … data-endpoint data-project-id defer>` snippet with a copy button; competitors put this front-and-center.
3. **Why Perch (value grid)** — lead with the differentiators the competitor scan surfaced: *no sampling / full data* (vs Cloudflare's 10%), *one dashboard for all your projects + a global "which site is winning" view*, *LLM-ready install*, *cookieless, no consent banner*, *< 3 KB script*, *own your data on Cloudflare's free tier*.
4. **Feature list** — mirror §6 (traffic, engagement/CTA & custom events, acquisition/UTM, audience, content, realtime, conversions, global view, export/API, optional Core Web Vitals).
5. **How it works** — three steps: add one script tag → events hit your own Cloudflare Worker → open your gated dashboard.
6. **Dashboard preview** — an inline CSS/SVG mock of the stats page (KPI tiles + a chart + the project dropdown) so visitors see the payoff without needing access.
7. **Comparison table** — Perch vs Google Analytics vs Cloudflare Web Analytics on: cookies/consent, sampling, data retention/ownership, multi-project view, self-host, price. (Every competitor ships a comparison; this is Perch's.)
8. **Privacy** — cookieless, no IP stored, no cross-site/cross-day tracking, GDPR/CCPA-friendly, no banner needed.
9. **Open-source / free** — link to the GitHub repo, `README.md`, and `INTEGRATION.md`; state the Cloudflare free-tier cost story.
10. **FAQ** — do I need a cookie banner? is it GDPR compliant? what does it cost? can I self-host? how accurate is it (no sampling)? how do I add another site?
11. **Footer** — repo link, docs link, license.
- **SEO/meta:** `<title>`, meta description, Open Graph + Twitter card tags, favicon, semantic landmarks, and reasonable Lighthouse hygiene (headings order, alt text, color contrast).
- **Dogfooding:** the page loads `perch.js` pointed at the owner's Worker under a `perch-site` project, and its CTAs carry `data-perch-cta` — so the landing page is both a live example and self-tracking. Use clearly-marked placeholders (`data-endpoint`, `data-project-id`) the owner fills once.

**GitHub Pages auto-deploy (`.github/workflows/pages.yml`):** a workflow triggered on `push` to `main` that publishes a Pages artifact containing `site/index.html` at the root **plus `src/perch.min.js`** (so the tracker is CDN-served from `https://<user>.github.io/<repo>/perch.min.js`). Use the official `actions/upload-pages-artifact` + `actions/deploy-pages` flow with the correct `pages: write`/`id-token: write` permissions and a `github-pages` environment. Include a one-time note that the repo's **Settings → Pages → Source** must be set to "GitHub Actions." Net effect: **push to `main` → site live in ~1 minute**, no manual deploy. Also document the zero-Actions fallback (Settings → Pages → deploy from `main` `/docs`, if they'd rather rename `site/`→`docs/`).

**Gate M8:** `site.test.mjs` (Playwright headless): the page renders hero + install snippet + value grid + comparison + FAQ; the install snippet is copyable and shown as text; CTAs carry `data-perch-cta`; the `perch.js` script tag is present with the placeholder `data-endpoint`/`data-project-id`; no console errors; no horizontal overflow at 375px width (mobile). Plus a static check that `pages.yml` is valid YAML, triggers on push to `main`, has `pages: write` + `id-token: write`, and uploads an artifact that includes `index.html` and `perch.min.js`.

---

## 8. The Build Loop
```
1. Implement the current milestone's files.
2. bash test/run.sh            # lint + units + integration + headless gates so far
3. Fix root causes (never weaken tests to pass).
4. Green → git commit -am "M<n>: <summary>".
5. Advance. Never start M(n+1) with M(n) red.
```
`run.sh`: `node --test test/*.test.mjs`, the Miniflare integration test, Playwright headless gates, minifier + size check; non-zero exit on any failure.

**Definition of done:** all gates green in a clean `run.sh`; the demo page against a deployed Worker writes rows to D1 via `POST /collect` and the Worker-served stats page shows every metric in §6; two projects stay isolated and both appear in the dropdown; the tracker is < 3 KB gzipped; no cookies; client payloads carry no `ip`/`country`/`visitorHash`/`device`; the Worker never stores or returns a raw IP; **the owner opens one URL (the Worker), signs in once via Cloudflare Access, picks a project from the dropdown, and sees friendly stats — zero configuration, no passphrase**; ingest stays public while `/` and `/api/*` are gated; the **marketing landing page renders and auto-deploys to GitHub Pages on push to `main`** (site + `perch.min.js` live within ~1 minute); and a competent LLM can integrate Perch into a new landing page using only `INTEGRATION.md`.

---

## 9. Tech Constraints
- **Tracker:** vanilla ES2019+, zero runtime deps, no framework, no geo call, no crypto.
- **Worker:** Cloudflare module syntax, one D1 binding (`DB`), one secret (`SALT`); free tier.
- **Stats page:** single HTML file; only Chart.js via CDN.
- **Dev/test only:** Node ≥ 20 (`node --test`), `wrangler`/Miniflare, jsdom, Playwright, esbuild/terser. Never shipped to clients.
- **Geo:** server-side `request.cf.country`, country-level only.

---

## 10. First Command for the Agent
Scaffold §4 and `package.json` (+`test/run.sh`), then build **M1** and run the loop until Gate M1 is green. Proceed milestone by milestone, committing after each green gate. The headline deliverables are the **ready-to-go stats page (M5)**, **`INTEGRATION.md` (M7)**, and the **auto-deploying marketing landing page (M8)** — give all three the same rigor as the code.

---

## 11. Competitive Positioning (why this feature set)

Perch is benchmarked against the privacy-first analytics field (Plausible, Umami, Fathom, GoatCounter, Simple Analytics, Cloudflare Web Analytics). The scan shaped §6.

**Where Perch is at parity or ahead:**
- **Cookieless, no-IP, daily-rotating hash** — matches GoatCounter/Fathom/Plausible privacy posture; no consent banner needed.
- **No sampling, retention = however long you keep D1** — beats **Cloudflare Web Analytics**, which samples 10% of traffic, caps reports at 15 rows, and retains only 30 days.
- **Global / portfolio view across many projects** — a genuine differentiator. Competitors are single-site-dashboard first; none foreground a ranked "which of my sites is winning" overview, which is exactly what an indie/agency owner of many landing pages wants.
- **LLM-driven, self-verifying integration** (`INTEGRATION.md`) — nobody ships this; it's Perch's install story.
- **Marketing site included and self-hosted** — like the whole field (Plausible/Fathom/Umami all lead with one), Perch ships its own GitHub Pages landing page that auto-deploys on push and dogfoods the tracker, so the product presents itself the moment it's pushed.
- **Own your data / self-host on free infra** — matches Umami/GoatCounter; cheaper and simpler than running Postgres.

**Gaps the scan found, now folded in:** realtime "visitors now" (Plausible/Fathom have it), a conversion-rate/goal view (Plausible/Umami/Simple Analytics), CSV export + JSON API (Plausible/Simple Analytics), an ad-blocker-resistant first-party endpoint option (Simple Analytics sells this as "bypass"), and optional Core Web Vitals (Cloudflare's headline differentiator).

**Deliberate non-goals (documented so they aren't mistaken for omissions):**
- **Multi-step funnel builder** (Plausible Business, Umami) — a 2-step pageview→CTA conversion covers the landing-page need; full funnels are a future add on the same D1 event log, no schema change.
- **Retention / cohort analysis** (Umami) — aimed at product apps, not landing pages.
- **Scroll-depth & time-on-page/visit-duration** — deferred; would need an engagement/exit beacon that grows the tracker. Revisit if demand appears (the D1 model already supports adding it).
- **Emailed/scheduled reports** (Plausible/Fathom) — needs email infra; out of scope for a static+Worker tool.
- **Ecommerce revenue attribution** (Plausible Business) — not a landing-page concern.

These stay out to protect the "feature-rich but still tiny" line. Each can be added later without re-architecting, because every metric is a query over the raw D1 event log.
