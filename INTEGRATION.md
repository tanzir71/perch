# Integrate Perch into a landing page

This guide is written for the LLM or developer performing the integration. Follow it in order, substitute the manifest values literally, and run every verification before handing the result back.

## 1. What this is and what integration produces

Perch adds a tiny, cookieless analytics tracker to a landing page. Events go to the owner’s Cloudflare Worker, raw events stay in the owner’s D1 database, and the Worker serves a finished multi-project dashboard from its own URL.

At the end of this guide you will have:

- one registered project in the owner’s shared Perch backend;
- one tracker script in the target page;
- stable IDs on the page’s primary CTAs;
- a public ingest endpoint at `WORKER_URL/collect`;
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

### CLI path

From the Perch repository:

```bash
npm install
npm run build
npx wrangler d1 create perch
# Paste the returned database_id into worker/wrangler.toml.
npx wrangler d1 execute perch --config worker/wrangler.toml --file=worker/schema.sql --remote
npx wrangler secret put SALT --config worker/wrangler.toml
# Paste the generated SALT when prompted.
npx wrangler deploy --config worker/wrangler.toml
# Save the printed https://<name>.<account-subdomain>.workers.dev as WORKER_URL.
```

If the installed Wrangler version treats D1 execution as remote by default, the documented command without the explicit flag is:

```bash
npx wrangler d1 execute perch --config worker/wrangler.toml --file=worker/schema.sql
```

Do not put `SALT` in `wrangler.toml`, `.dev.vars`, the landing page, a shell transcript committed to Git, or any response to the owner.

### Dashboard alternative

For an environment without the CLI:

1. Open **Cloudflare dashboard → Storage & databases → D1 SQL database → Create**. Name it `perch`.
2. Open its console and run all of `worker/schema.sql`.
3. Open **Workers & Pages → Create application → Worker**, name it with `WORKER_NAME`, and deploy the built `dist/worker.js`.
4. In the Worker’s **Settings → Bindings**, add D1 binding `DB` pointing to the database.
5. In **Settings → Variables and Secrets**, add encrypted secret `SALT`.
6. Deploy and copy the Worker URL.

### Recommended first-party endpoint

Requests to `*.workers.dev` are sometimes blocked by privacy extensions. If the landing page’s zone is on Cloudflare, add a Worker custom domain such as `https://a.example.com` under **Workers & Pages → Perch Worker → Settings → Domains & Routes → Add → Custom domain**. Use that URL as `WORKER_URL`. A same-site endpoint is much less likely to be blocked.

### Protect `/` and `/api/*`; bypass only `/collect`

Cloudflare Access is the only authentication layer. Do not add a login form, API token, passphrase, or authentication branch to the Worker.

Use two path-aware self-hosted Access applications so the more-specific public path overrides the protected hostname:

1. Open **Cloudflare dashboard → Zero Trust → Access controls → Applications → Add an application → Self-hosted**.
2. Create **Perch dashboard** for the `WORKER_URL` hostname with the path left empty. This covers `/` and every path, including `/api/*`.
3. Add an **Allow** policy with **Include → Emails → `OWNER_EMAIL`**. Enable Google, GitHub, or one-time PIN as the identity provider. Save.
4. Create a second **Self-hosted** application named **Perch public ingest** for the same hostname with path `/collect`.
5. Give that more-specific application a **Bypass** policy with **Include → Everyone**. Save.
6. Confirm there is no broader Bypass on the hostname. Access path specificity makes `/collect` public while `/` and `/api/*` keep the owner-only Allow policy.

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
```

`cloudflared` does not create Access applications or policies; it is used for tunnels and Access-authenticated clients. For Perch’s publicly routed Worker, use the dashboard, API above, or equivalent Terraform `cloudflare_zero_trust_access_application` resources.

## 4. Register the project

Escape any single quote in manifest values by doubling it before placing it in SQL. Run against the remote D1 database:

```bash
npx wrangler d1 execute perch --config worker/wrangler.toml --remote --command \
  "INSERT OR REPLACE INTO projects (id,name,origin,created_at) VALUES ('$PROJECT_ID','$PROJECT_NAME','$ALLOW_ORIGIN',datetime('now'));"
```

Keep `PROJECT_ID` stable. The friendly name and origin may be updated by re-running the command.

## 5. Add the tracker once

Inspect `LANDING_PAGE_HTML` first. Search case-insensitively for `perch.js`, `perch.min.js`, `data-project-id`, and `window.perch`.

- If a Perch script already has the correct project and endpoint, leave it in place.
- If it exists with stale values, update that one tag.
- Never insert a second copy.

Place this tag near the end of `<body>` or in the page’s normal deferred-script area:

```html
<script
  src="https://YOUR-GITHUB-USER.github.io/YOUR-REPO/perch.min.js"
  data-endpoint="$WORKER_URL/collect"
  data-project-id="$PROJECT_ID"
  defer
></script>
```

Replace shell-style placeholders with literal values in HTML. `data-endpoint` must end in `/collect`; the bare Worker URL is the dashboard, not ingest.

Optional configuration:

```html
data-respect-dnt
data-skip-bots
data-no-outbound
data-perf
```

`data-perf` opts this page into coarse LCP, INP, and CLS events. It is off by default. Use `src/perch.js` temporarily only while debugging the tracker source.

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

Opening it routes the owner through Cloudflare Access once, then shows “All projects” and the populated project dropdown. Future sites only need sections 4–6 and automatically appear in the same dashboard behind the same identity gate.

## 10. Verification checklist

Run all checks and report the actual results. Do not claim success based only on deployed command output.

```bash
# Public ingest works without Access identity.
curl -s -X POST "$WORKER_URL/collect" \
  -H 'content-type: application/json' \
  -d '{"type":"pageview","path":"/","projectId":"'"$PROJECT_ID"'","ts":"'"$(date -u +%FT%TZ)"'"}'
# Expect: {"ok":true}

npx wrangler d1 execute perch --config worker/wrangler.toml --remote --command \
  "SELECT type,path,country FROM events WHERE project_id='$PROJECT_ID' ORDER BY id DESC LIMIT 1;"
# Expect one pageview row. Country may be XX only during local development.

# Dashboard API is gated. An anonymous request must redirect to Access.
curl -s -o /dev/null -w '%{http_code}\n' "$WORKER_URL/api/projects"
# Expect 302, not 200.
```

Then:

1. Open `WORKER_URL` in a browser and sign in as `OWNER_EMAIL`.
2. Confirm `PROJECT_NAME` appears in the selector.
3. Open the landing page and click one instrumented CTA.
4. Query D1:

   ```bash
   npx wrangler d1 execute perch --config worker/wrangler.toml --remote --command \
     "SELECT type,name,path FROM events WHERE project_id='$PROJECT_ID' ORDER BY id DESC LIMIT 5;"
   ```

5. Confirm a `cta` row with the expected ID.
6. Refresh the dashboard and confirm the project detail, realtime tile, and CTA leaderboard update.
7. Download Export CSV and confirm it opens as a valid table.

## 11. Guardrails

- Never add cookies, fingerprinting libraries, or client storage for identity.
- Never put personal information in event `props` or `name`.
- Never insert the Perch script twice.
- Never commit, expose, log, or return `SALT`.
- Keep one stable `PROJECT_ID` per site.
- Always keep the specific `/collect` Bypass application; anonymous ingest must not be sent to Access login.
- Keep `/` and `/api/*` behind the owner-only Access application.
- Reuse one backend, one D1 database, and one Worker-served dashboard for all projects. Do not create a backend per site.
- Keep the tracker’s endpoint on `/collect`; never point it at the dashboard root.
- Treat device, browser, OS, session, and country values as coarse analytics, not user profiles.

## 12. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Anonymous `curl /api/projects` returns 200 | Access does not cover the hostname/root | Create or fix the owner-only application for the hostname with its path empty. |
| `/collect` returns 302 or an Access page | The specific Bypass application is missing or has the wrong path | Create the same-host `/collect` application with Bypass → Everyone. |
| Browser reports CORS failure | Endpoint, origin, or route is wrong | Confirm the tag uses `WORKER_URL/collect`, the Worker handles `OPTIONS`, and `ALLOW_ORIGIN` matches the site reference. |
| Ingest says database binding is missing | `DB` binding is absent | Bind the deployed D1 database as exactly `DB`, then redeploy. |
| No rows appear | Wrong `database_id`, stale deployment, or malformed `projectId` | Check `worker/wrangler.toml`, deployment logs, and the curl response. Use a lowercase kebab-case ID. |
| Project is missing from the dropdown | Registry insert was skipped or used another database | Re-run section 4 against remote D1. A project with events also appears through the event fallback. |
| Country is always `XX` locally | Local requests do not have Cloudflare request geography | Expected locally; verify after deployment on Cloudflare. |
| Events are missing only in production | A blocker is filtering `workers.dev` | Use the recommended first-party custom domain and update the one existing tracker tag. |
| Dashboard says “Please sign in again” | Access session expired or redirected the API | Reload and complete the existing identity sign-in. Do not add a Perch login form. |
| Tracker emits no pageview | DNT/bot controls, wrong script URL, or duplicate tab guard | Inspect the tag, network request, and optional attributes; use a fresh tab for the automatic pageview. |

Cloudflare’s current product documentation confirms the D1 Wrangler commands, path-specific Access applications, owner Allow policies, and narrowly scoped Bypass policies used in this guide:

- [D1 Wrangler commands](https://developers.cloudflare.com/d1/wrangler-commands/)
- [Access application paths](https://developers.cloudflare.com/cloudflare-one/access-controls/policies/app-paths/)
- [Access policies](https://developers.cloudflare.com/cloudflare-one/access-controls/policies/)
- [Create a self-hosted Access application](https://developers.cloudflare.com/learning-paths/clientless-access/access-application/create-access-app/)
