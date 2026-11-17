# Integrate Perch into a landing page

This guide is written for the LLM or developer performing the integration. Follow it in order, substitute the manifest values literally, and run every verification before handing the result back.

## 1. What this is and what integration produces

Perch adds a tiny, cookieless analytics tracker to a landing page. Events go to the owner’s Cloudflare Worker, raw events stay in the owner’s D1 database, and the Worker serves a finished multi-project dashboard from its own URL.

At the end of this guide you will have:

- one registered project in the owner’s shared Perch backend;
- one tracker script in the target page;
- stable IDs on the page’s primary CTAs;
- a public ingest endpoint at `WORKER_URL/collect` and the tracker served from `WORKER_URL/perch.js`;
- a dashboard and JSON API protected by Cloudflare Access; and
- a live, user-friendly `WORKER_URL` the owner can bookmark.

## 2. Fill the integration manifest first

Do not edit or deploy until every non-derived value is filled.

```dotenv
PROJECT_ID=my-portfolio
PROJECT_NAME=My Portfolio
WORKER_NAME=perch
SALT=GENERATE_AT_LEAST_32_RANDOM_BYTES
ALLOW_ORIGIN=https://portfolio.example
OWNER_EMAIL=owner@example.com
LANDING_PAGE_HTML=site/index.html

# Derived after deploy:
WORKER_URL=https://perch.<account-subdomain>.workers.dev
INGEST_ENDPOINT=$WORKER_URL/collect
```

Filled example:

```dotenv
PROJECT_ID=studio-launch
PROJECT_NAME=Studio Launch
WORKER_NAME=perch
SALT=uRFxWpd2DB3g2L9qj4FvV7mrR4dqJm1n6xP8QeZsM0c
ALLOW_ORIGIN=https://studio.example
OWNER_EMAIL=alex@studio.example
LANDING_PAGE_HTML=public/index.html
WORKER_URL=https://perch.alex-example.workers.dev
INGEST_ENDPOINT=https://perch.alex-example.workers.dev/collect
```

Generate the salt with `openssl rand -base64 48` or an equivalent cryptographically secure generator. Do not reuse a public token, and never commit the result.

**Reuse rule:** if the owner already has a Perch backend, do not create another Worker or D1 database and do not repeat Access setup. Use the existing `WORKER_URL`, then perform sections 4–6. The new project appears in the existing dropdown behind the same sign-in gate.

## 3. Deploy the backend and gate the dashboard

### One-click path

Open `https://deploy.workers.cloudflare.com/?url=https://github.com/tanzir71/perch`. Cloudflare copies the repository into the owner's GitHub account, creates the D1 database, and runs `npm run deploy`, which applies the migrations and deploys the Worker. When it asks for `SALT` (listed in `.dev.vars.example`), paste the generated salt. If it was skipped, set it afterwards in **Workers & Pages → perch → Settings → Variables and Secrets** as an encrypted secret, or with `npx wrangler secret put SALT`.

Save the Worker URL as `WORKER_URL` and continue with Access below.

### CLI path

From the Perch repository:

```bash
npm install
npx wrangler d1 create perch
# Paste the returned database_id into wrangler.toml (repository root).
npx wrangler secret put SALT
# Paste the generated SALT when prompted.
npm run deploy
# Builds, applies every pending migration in migrations/ to the remote database, and deploys.
# Save the printed https://<name>.<account-subdomain>.workers.dev as WORKER_URL.
```

`npm run deploy` is safe to re-run after every upgrade: `wrangler d1 migrations apply` only applies migrations the database has not seen. `wrangler.toml` also registers a nightly Cron Trigger (`15 0 * * *`) that summarises finished days; it uses one of the account's free Cron Triggers.

Do not put `SALT` in `wrangler.toml`, `.dev.vars.example`, the landing page, a shell transcript committed to Git, or any response to the owner. For local development only, put it in an uncommitted `.dev.vars`.

### Upgrading an existing Perch backend

Older installs created tables by running `worker/schema.sql` by hand, so Wrangler has no migration history. Mark the first migration as applied once, then deploy:

```bash
npx wrangler d1 execute perch --remote --command \
  "CREATE TABLE IF NOT EXISTS d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP); INSERT OR IGNORE INTO d1_migrations (name) VALUES ('0001_init.sql');"
npm run deploy
```

Then run the first summary immediately instead of waiting for the nightly job: sign in to the dashboard and run `fetch('/api/maintenance', { method: 'POST' })` from its browser console, or wait for the next night.

### Dashboard alternative

For an environment without the CLI:

1. Open **Cloudflare dashboard → Storage & databases → D1 SQL database → Create**. Name it `perch`.
2. Open its console and run `migrations/0001_init.sql`, then `migrations/0002_v2.sql`, in that order.
3. Open **Workers & Pages → Create application → Worker**, name it with `WORKER_NAME`, and deploy the built `dist/worker.js` (from `npm run build`).
4. In the Worker's **Settings → Bindings**, add D1 binding `DB` pointing to the database.
5. In **Settings → Variables and Secrets**, add encrypted secret `SALT`.
6. In **Settings → Triggers → Cron Triggers**, add `15 0 * * *`.
7. Deploy and copy the Worker URL.

### Recommended first-party endpoint

Requests to `*.workers.dev` are sometimes blocked by privacy extensions. If the landing page’s zone is on Cloudflare, add a Worker custom domain such as `https://a.example.com` under **Workers & Pages → Perch Worker → Settings → Domains & Routes → Add → Custom domain**. Use that URL as `WORKER_URL`. A same-site endpoint is much less likely to be blocked.

### Protect `/` and `/api/*`; bypass only `/collect` and `/perch.js`

Cloudflare Access is the only authentication layer. Do not add a login form, API token, passphrase, or authentication branch to the Worker.

Use two path-aware self-hosted Access applications so the more-specific public path overrides the protected hostname:

1. Open **Cloudflare dashboard → Zero Trust → Access controls → Applications → Add an application → Self-hosted**.
2. Create **Perch dashboard** for the `WORKER_URL` hostname with the path left empty. This covers `/` and every path, including `/api/*`.
3. Add an **Allow** policy with **Include → Emails → `OWNER_EMAIL`**. Enable Google, GitHub, or one-time PIN as the identity provider. Save.
4. Create a second **Self-hosted** application named **Perch public ingest** for the same hostname with path `/collect`, and add a second public hostname entry to the same application with path `/perch.js`.
5. Give that more-specific application a **Bypass** policy with **Include → Everyone**. Save.
6. Confirm there is no broader Bypass on the hostname. Access path specificity makes `/collect` and `/perch.js` public while `/` and `/api/*` keep the owner-only Allow policy.

On first visit the owner authenticates with an identity they already have. After that, they open one bookmark and see the dashboard—there is no Perch password or page configuration.

For API-managed environments, use an API token with **Access: Apps and Policies Write**. Set `ACCESS_DOMAIN` to the hostname only, without `https://`:

```bash
export ACCOUNT_ID="<cloudflare-account-id>"
export CLOUDFLARE_API_TOKEN="<token-with-access-apps-and-policies-write>"
export ACCESS_DOMAIN="a.example.com"

# Protected hostname: owner only.
curl "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID/access/apps" \
  --request POST \
  --header "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  --header "Content-Type: application/json" \
  --data '{
    "name": "Perch dashboard",
    "type": "self_hosted",
    "domain": "'"$ACCESS_DOMAIN"'",
    "session_duration": "24h",
    "policies": [{
      "name": "Allow Perch owner",
      "decision": "allow",
      "precedence": 1,
      "include": [{"email": {"email": "'"$OWNER_EMAIL"'"}}]
    }]
  }'

# More-specific public endpoint: anonymous beacons only.
curl "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID/access/apps" \
  --request POST \
  --header "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  --header "Content-Type: application/json" \
  --data '{
    "name": "Perch public ingest",
    "type": "self_hosted",
    "domain": "'"$ACCESS_DOMAIN"'/collect",
    "policies": [{
      "name": "Bypass Perch collect",
      "decision": "bypass",
      "precedence": 1,
      "include": [{"everyone": {}}]
    }]
  }'

# Repeat the previous request with "name": "Perch public tracker" and
# "domain": "'"$ACCESS_DOMAIN"'/perch.js" so pages can load the tracker.
```

`cloudflared` does not create Access applications or policies; it is used for tunnels and Access-authenticated clients. For Perch’s publicly routed Worker, use the dashboard, API above, or equivalent Terraform `cloudflare_zero_trust_access_application` resources.

## 4. Register the project

Register before adding the tag. Once at least one project is registered, the Worker rejects events for any unknown project ID (`{"ok":false,"error":"Unknown project"}`), so typos and copied tags cannot pollute the dashboard. While no project is registered at all, every well-formed event is accepted, so a first test works before registration. A newly registered ID is picked up within a few seconds.

Escape any single quote in manifest values by doubling it before placing it in SQL. Run against the remote D1 database:

```bash
npx wrangler d1 execute perch --remote --command \
  "INSERT OR REPLACE INTO projects (id,name,origin,created_at) VALUES ('$PROJECT_ID','$PROJECT_NAME','$ALLOW_ORIGIN',datetime('now'));"
```

Keep `PROJECT_ID` stable. The friendly name and origin may be updated by re-running the command.

Optional hardening: set `STRICT_ORIGIN = "1"` in `wrangler.toml` and redeploy to also reject browser events whose `Origin` header does not match the project's registered origin.

## 5. Add the tracker once

Inspect `LANDING_PAGE_HTML` first. Search case-insensitively for `perch.js`, `perch.min.js`, `data-project-id`, and `window.perch`.

- If a Perch script already has the correct project and endpoint, leave it in place.
- If it exists with stale values, update that one tag.
- Never insert a second copy.

Place this tag near the end of `<body>` or in the page's normal deferred-script area:

```html
<script src="$WORKER_URL/perch.js" data-project-id="$PROJECT_ID" defer></script>
```

Replace shell-style placeholders with literal values in HTML. Loaded from the Worker, the tracker sends events to the same origin's `/collect`, so no endpoint attribute is needed. It is always the version that matches the deployed Worker.

If the tracker must come from somewhere else (a CDN, the site's own assets, or `https://tanzir71.github.io/perch/perch.min.js`), set the endpoint explicitly. `data-endpoint` must end in `/collect`; the bare Worker URL is the dashboard, not ingest:

```html
<script
  src="https://tanzir71.github.io/perch/perch.min.js"
  data-endpoint="$WORKER_URL/collect"
  data-project-id="$PROJECT_ID"
  defer
></script>
```

Optional configuration:

```html
data-respect-dnt
data-skip-bots
data-no-outbound
data-no-engagement
data-perf
```

`data-no-engagement` turns off the single scroll-depth and visible-time event sent when a visitor leaves a page. `data-perf` opts this page into coarse LCP, INP, and CLS events. It is off by default. Use `src/perch.js` temporarily only while debugging the tracker source.

The tracker sends one pageview per page load and stores nothing in the browser. For single-page apps, call this after each client-side route change; Perch reads the new path and first closes out the previous page's scroll and time:

```js
window.perch?.track("pageview");
```

## 6. Instrument CTAs without restructuring

Find elements that trigger the primary outcomes: sign up, start, buy, contact, book a demo, download, subscribe, open pricing, or submit a lead form. Prioritize the hero, navigation, pricing, and final CTA surfaces.

Add `data-perch-cta="<intent>-<location>"` to the existing clickable element. Use stable, lowercase kebab-case IDs:

- `signup-hero`
- `demo-nav`
- `buy-pro-pricing`
- `contact-footer`
- `download-resources`

Do not use visible copy as the only identifier because copy changes. Do not wrap elements, change destinations, add click handlers, or restructure the page merely for Perch. See [examples/before-after.md](./examples/before-after.md) for four complete transformations.

## 7. Outbound links and custom events

Perch automatically records a click on an HTTP(S) link whose host differs from the current page. The event name is only the destination host. Add `data-perch-ignore` to an external link that should not be counted.

Use a custom event for meaningful success that is not represented by a stable click—typically an asynchronous form success:

```js
window.perch?.track("newsletter_signup", {
  source: "footer",
  variant: "short-form"
});
```

Properties may contain short categorical values and numbers only. Never send email addresses, names, phone numbers, account IDs, full URLs containing identifiers, free-form form fields, messages, or any other personal information. Perch drops several obvious PII-shaped property keys, but the integration must still avoid collecting them.

## 8. UTM campaigns

UTM acquisition is automatic. Perch reads `utm_source`, `utm_medium`, and `utm_campaign` from the landing URL and stores them with the event.

Give the marketer links in this form:

```text
https://studio.example/pricing?utm_source=newsletter&utm_medium=email&utm_campaign=summer-launch
```

Use stable lowercase campaign values where possible. No page code is needed.

## 9. Hand over the ready-to-go stats page

There is no separate dashboard deployment. The Worker already serves the dashboard at `GET /` and calls its own `/api/*` routes.

Hand the owner this one bookmark:

```text
$WORKER_URL
```

Opening it routes the owner through Cloudflare Access once, then shows "All projects": every site ranked by visitors and compared with the previous period. A project that has not sent an event yet opens on an install check that shows its snippet, confirms each event type as it arrives, and can send a test event. Future sites only need sections 4–6 and automatically appear in the same dashboard behind the same identity gate.

Nightly summaries keep long ranges cheap, so the dashboard stays well inside the D1 free tier for the traffic Perch is designed for. To cap storage, set `RETENTION_DAYS` in `wrangler.toml` (for example `"400"`); raw events older than that are deleted after they are summarised, and the daily summaries are kept.

## 10. Verification checklist

Run all checks and report the actual results. Do not claim success based only on deployed command output.

```bash
# Public ingest works without Access identity.
curl -s -X POST "$WORKER_URL/collect" \
  -H 'content-type: application/json' \
  -d '{"type":"pageview","path":"/","projectId":"'"$PROJECT_ID"'","ts":"'"$(date -u +%FT%TZ)"'"}'
# Expect: {"ok":true}

# The tracker is public too.
curl -s -o /dev/null -w '%{http_code} %{content_type}\n' "$WORKER_URL/perch.js"
# Expect: 200 text/javascript; charset=utf-8

npx wrangler d1 execute perch --remote --command \
  "SELECT type,path,country FROM events WHERE project_id='$PROJECT_ID' ORDER BY id DESC LIMIT 1;"
# Expect one pageview row. Country may be XX only during local development.

# Dashboard API is gated. An anonymous request must redirect to Access.
curl -s -o /dev/null -w '%{http_code}\n' "$WORKER_URL/api/projects"
# Expect 302, not 200.
```

Then:

1. Open `WORKER_URL` in a browser and sign in as `OWNER_EMAIL`.
2. Choose `PROJECT_NAME` in the selector. Until real traffic arrives it shows the install check, which reads `WORKER_URL/api/status?projectId=$PROJECT_ID`.
3. Open the landing page and click one instrumented CTA. The install check ticks off the pageview and the CTA within a few seconds.
4. Query D1:

   ```bash
   npx wrangler d1 execute perch --remote --command \
     "SELECT type,name,path FROM events WHERE project_id='$PROJECT_ID' ORDER BY id DESC LIMIT 5;"
   ```

5. Confirm a `cta` row with the expected ID.
6. Open the dashboard and confirm the project detail, "Visitors now" tile, and the Goals panel show the CTA.
7. Download Export CSV and confirm it opens as a valid table.

## 11. Guardrails

- Never add cookies, fingerprinting libraries, or any client storage. The tracker uses none.
- Never put personal information in event `props` or `name`.
- Never insert the Perch script twice.
- Never commit, expose, log, or return `SALT`.
- Keep one stable `PROJECT_ID` per site.
- Always keep the specific `/collect` and `/perch.js` Bypass application; anonymous ingest must not be sent to Access login.
- Register a project before tagging its site.
- Keep `/` and `/api/*` behind the owner-only Access application.
- Reuse one backend, one D1 database, and one Worker-served dashboard for all projects. Do not create a backend per site.
- Keep the tracker’s endpoint on `/collect`; never point it at the dashboard root.
- Treat device, browser, OS, session, and country values as coarse analytics, not user profiles.

## 12. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Anonymous `curl /api/projects` returns 200 | Access does not cover the hostname/root | Create or fix the owner-only application for the hostname with its path empty. |
| `/collect` or `/perch.js` returns 302 or an Access page | The specific Bypass application is missing or has the wrong path | Create the same-host `/collect` and `/perch.js` application with Bypass → Everyone. |
| `/collect` answers `Unknown project` | The project ID is not registered, or has a typo | Run section 4 with the exact ID used in the tag. |
| `wrangler d1 migrations apply` fails with "table already exists" | An older install created the tables by hand | Follow "Upgrading an existing Perch backend" in section 3. |
| Browser reports CORS failure | Endpoint, origin, or route is wrong | Confirm the tag uses `WORKER_URL/collect`, the Worker handles `OPTIONS`, and `ALLOW_ORIGIN` matches the site reference. |
| Ingest says database binding is missing | `DB` binding is absent | Bind the deployed D1 database as exactly `DB`, then redeploy. |
| No rows appear | Wrong `database_id`, stale deployment, or malformed `projectId` | Check `wrangler.toml`, deployment logs, and the curl response. Use a lowercase kebab-case ID. |
| Project is missing from the dropdown | Registry insert was skipped or used another database | Re-run section 4 against remote D1. A project with events also appears through the event fallback. |
| Country is always `XX` locally | Local requests do not have Cloudflare request geography | Expected locally; verify after deployment on Cloudflare. |
| Events are missing only in production | A blocker is filtering `workers.dev` | Use the recommended first-party custom domain and update the one existing tracker tag. |
| Dashboard says “Please sign in again” | Access session expired or redirected the API | Reload and complete the existing identity sign-in. Do not add a Perch login form. |
| Tracker emits no pageview | DNT/bot controls, wrong script URL, or a second copy of the tag | Inspect the tag, the network request, and optional attributes. Perch initialises once per page, so a duplicate tag is ignored rather than counted twice. |
| A dashboard range looks flat before today | Nightly summaries have not run yet after an upgrade | Run `POST /api/maintenance` once from the signed-in dashboard, or wait for the nightly job. |

Cloudflare’s current product documentation confirms the D1 Wrangler commands, path-specific Access applications, owner Allow policies, and narrowly scoped Bypass policies used in this guide:

- [D1 Wrangler commands](https://developers.cloudflare.com/d1/wrangler-commands/)
- [Access application paths](https://developers.cloudflare.com/cloudflare-one/access-controls/policies/app-paths/)
- [Access policies](https://developers.cloudflare.com/cloudflare-one/access-controls/policies/)
- [Create a self-hosted Access application](https://developers.cloudflare.com/learning-paths/clientless-access/access-application/create-access-app/)
