import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { chromium } from "playwright";
import { startServer } from "./browser-server.mjs";

let browser;
let server;

const now = new Date().toISOString();
const projects = [
  { id: "alpha", name: "Alpha Studio", origin: "https://alpha.example" },
  { id: "beta", name: "Beta Notes", origin: "https://beta.example" }
];
const overview = [
  {
    projectId: "alpha", name: "Alpha Studio", origin: "https://alpha.example",
    pageviews: 940, uniques: 610, sessions: 690, engagedRate: 0.57, conversionRate: 0.087, realtime: 12,
    lastEventAt: now, byDay: [{ date: "2026-07-21", pv: 24, uv: 18 }], byChannel: [{ name: "Search", visitors: 300, events: 300 }],
    previous: { pageviews: 800, uniques: 500, conversionRate: 0.07 }
  },
  {
    projectId: "beta", name: "Beta Notes", origin: "https://beta.example",
    pageviews: 0, uniques: 0, sessions: 0, engagedRate: 0, conversionRate: 0, realtime: 0,
    lastEventAt: null, byDay: [], byChannel: [], previous: { pageviews: 0, uniques: 0, conversionRate: 0 }
  }
];
const rollup = {
  projectId: "alpha",
  range: { from: "2026-06-24", to: "2026-07-23" },
  filters: [],
  totals: { pageviews: 940, uniques: 610, sessions: 690, bounceRate: 0.43, engagedRate: 0.57, pagesPerSession: 1.4, realtime: 12, conversionRate: 0.087, avgScroll: 64, avgTimeMs: 41000 },
  previous: { range: { from: "2026-05-25", to: "2026-06-23" }, totals: { pageviews: 800, uniques: 500, conversionRate: 0.07, engagedRate: 0.5 }, byDay: [] },
  byDay: [{ date: "2026-07-21", pv: 24, uv: 18 }, { date: "2026-07-22", pv: 42, uv: 31 }],
  byChannel: [{ name: "Search", events: 300, visitors: 280 }, { name: "AI assistants", events: 90, visitors: 80 }],
  byReferrer: [{ name: "google.com", events: 250, visitors: 230 }],
  byCampaign: [], bySource: [], byMedium: [],
  byPath: [{ name: "/", events: 640, visitors: 500, scroll: 71, timeMs: 30000 }],
  entryPages: [{ name: "/", events: 580, visitors: 580 }],
  exitPages: [{ name: "/", events: 400, visitors: 400 }],
  byCta: [{ name: "signup-hero", events: 84, visitors: 53, conversionRate: 0.087 }],
  byEvent: [], byEventProps: [], topOutbound: [{ name: "docs.example", events: 31, visitors: 30 }],
  byCountry: [{ name: "BD", events: 350, visitors: 300 }],
  byLanguage: [{ name: "en-US", events: 730, visitors: 500 }],
  byDevice: [{ name: "Desktop", events: 550, visitors: 400 }],
  byBrowser: [{ name: "Chrome", events: 610, visitors: 420 }],
  byOS: [{ name: "Windows", events: 440, visitors: 300 }],
  vitals: { LCP: { p75: 2150, samples: 120 }, INP: null, CLS: null }
};
const emptyRollup = { ...rollup, projectId: "beta", totals: { ...rollup.totals, pageviews: 0, uniques: 0, sessions: 0, realtime: 0, conversionRate: 0 }, byDay: [], byCta: [] };
const emptyStatus = { projectId: "beta", registered: true, project: projects[1], lastEventAt: null, received: { pageview: 0, cta: 0, outbound: 0, custom: 0, engagement: 0, test: 0 }, recent: [] };

before(async () => {
  browser = await chromium.launch({ headless: true });
  server = await startServer();
});

after(async () => {
  await browser?.close();
  await server?.close();
});

async function pageWithApi(mode = "normal", path = "/stats/index.html") {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  const requests = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    requests.push(url.pathname + url.search);
    if (mode === "auth") {
      await route.fulfill({ status: 401, contentType: "text/plain", body: "Access login" });
      return;
    }
    let body;
    if (url.pathname === "/api/projects") body = projects;
    else if (url.pathname === "/api/overview") body = overview;
    else if (url.pathname === "/api/status") body = emptyStatus;
    else if (url.searchParams.get("projectId") === "beta") body = emptyRollup;
    else body = rollup;
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
  });
  await page.goto(`${server.origin}${path}`, { waitUntil: "networkidle" });
  return { page, errors, requests };
}

test("portfolio ranking, drill-down, filters, URL state, export and the install check", async () => {
  const { page, errors, requests } = await pageWithApi();
  assert.deepEqual(await page.locator("#project-select option").allTextContents(), ["All projects", "Alpha Studio", "Beta Notes"]);
  await page.getByText("Alpha Studio is attracting the most traffic this period.").waitFor();
  const main = () => page.locator("main").innerText();
  assert.match(await main(), /Project ranking/);
  assert.match(await main(), /\+22%/);
  assert.match(await main(), /Beta Notes: waiting for its first event/);
  assert.ok(requests.some((url) => url.startsWith("/api/overview?") && url.includes("compare=1")));

  await page.locator('[data-project="alpha"]').click();
  await page.getByText("Traffic over time").waitFor();
  assert.match(await main(), /Conversion rate/);
  assert.match(await main(), /8\.7%/);
  assert.match(await main(), /\+1\.7 pt/);
  assert.match(page.url(), /project=alpha/);
  assert.match(await page.locator("#export-link").getAttribute("href"), /\/api\/export\.csv\?.*projectId=alpha/);

  await page.locator('[data-panel="sources"] [data-tab="1"]').click();
  await page.locator('[data-filter-dim="referrer"][data-filter-value="google.com"]').click();
  await page.getByText("Referrer is google.com").waitFor();
  assert.ok(requests.some((url) => url.includes("filter=referrer%3Agoogle.com")));
  assert.match(page.url(), /filter=referrer%3Agoogle\.com/);

  await page.locator('[data-metric="pageviews"]').click();
  assert.match(page.url(), /metric=pageviews/);

  await page.locator("#project-select").selectOption("beta");
  await page.getByText("Waiting for the first event from beta.example").waitFor();
  assert.ok(requests.some((url) => url.startsWith("/api/status?projectId=beta")));
  assert.match(await main(), /data-project-id="beta"/);
  assert.deepEqual(errors, []);
  await page.close();
});

test("expired Access session produces a friendly sign-in state", async () => {
  const { page, errors } = await pageWithApi("auth");
  await page.getByText("Please sign in again").waitFor();
  assert.match(await page.locator("main").innerText(), /Reload dashboard/);
  assert.deepEqual(errors.filter((message) => !message.includes("401 (Unauthorized)")), []);
  await page.close();
});

test("demo mode runs without any API", async () => {
  const { page, errors, requests } = await pageWithApi("normal", "/stats/index.html?demo");
  await page.getByText("Live demo.").waitFor();
  await page.getByText("Project ranking").waitFor();
  await page.locator('[data-project="studio-launch"]').click();
  await page.getByText("Traffic over time").waitFor();
  assert.deepEqual(requests, []);
  assert.deepEqual(errors, []);
  await page.close();
});
