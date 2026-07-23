import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { chromium } from "playwright";
import { startServer } from "./browser-server.mjs";

let browser;
let server;

const projects = [
  { id: "alpha", name: "Alpha Studio", origin: "https://alpha.example" },
  { id: "beta", name: "Beta Notes", origin: "https://beta.example" }
];
const overview = [
  {
    projectId: "alpha",
    name: "Alpha Studio",
    origin: "https://alpha.example",
    pageviews: 940,
    uniques: 610,
    sessions: 690,
    realtime: 12,
    byDay: [{ date: "2026-07-21", pv: 24 }, { date: "2026-07-22", pv: 42 }]
  },
  {
    projectId: "beta",
    name: "Beta Notes",
    origin: "https://beta.example",
    pageviews: 210,
    uniques: 160,
    sessions: 174,
    realtime: 3,
    byDay: [{ date: "2026-07-21", pv: 10 }, { date: "2026-07-22", pv: 13 }]
  }
];
const rollup = {
  projectId: "alpha",
  range: { from: "2026-06-24", to: "2026-07-23" },
  totals: {
    pageviews: 940,
    uniques: 610,
    sessions: 690,
    bounceRate: 0.43,
    pagesPerSession: 1.4,
    realtime: 12,
    conversionRate: 0.087
  },
  byDay: [{ date: "2026-07-21", pv: 24, uv: 18 }, { date: "2026-07-22", pv: 42, uv: 31 }],
  byCountry: [{ name: "BD", events: 350 }],
  byPath: [{ name: "/", events: 640 }],
  byReferrer: [{ name: "google.com", events: 250 }],
  bySource: [{ name: "newsletter", events: 90 }],
  byDevice: [{ name: "Desktop", events: 550 }],
  byBrowser: [{ name: "Chrome", events: 610 }],
  byOS: [{ name: "Windows", events: 440 }],
  byLanguage: [{ name: "en-US", events: 730 }],
  byCta: [{ name: "signup-hero", events: 84 }],
  topOutbound: [{ name: "docs.example", events: 31 }],
  entryPages: [{ name: "/", events: 580 }]
};
const emptyRollup = {
  ...rollup,
  projectId: "beta",
  totals: {
    pageviews: 0,
    uniques: 0,
    sessions: 0,
    bounceRate: 0,
    pagesPerSession: 0,
    realtime: 0,
    conversionRate: 0
  },
  byDay: [],
  byCountry: [],
  byPath: []
};

before(async () => {
  browser = await chromium.launch({ headless: true });
  server = await startServer();
});

after(async () => {
  await browser?.close();
  await server?.close();
});

async function pageWithApi(mode = "normal") {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  const requests = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/api/**", async (route) => {
    const requestUrl = new URL(route.request().url());
    requests.push(requestUrl.pathname + requestUrl.search);
    if (mode === "auth") {
      await route.fulfill({ status: 401, contentType: "text/plain", body: "Access login" });
      return;
    }
    let body;
    if (requestUrl.pathname === "/api/projects") body = projects;
    else if (requestUrl.pathname === "/api/overview") body = overview;
    else if (requestUrl.searchParams.get("projectId") === "beta") body = emptyRollup;
    else body = rollup;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(body)
    });
  });
  await page.goto(`${server.origin}/stats/index.html`, { waitUntil: "networkidle" });
  return { page, errors, requests };
}

test("global selector, ranking, drill-down, project switching, and export work", async () => {
  const { page, errors, requests } = await pageWithApi();
  const options = await page.locator("#project-select option").allTextContents();
  assert.deepEqual(options, ["All projects", "Alpha Studio", "Beta Notes"]);
  await assert.doesNotReject(() => page.getByText("Alpha Studio is attracting the most traffic this period.").waitFor());
  assert.match(await page.locator("main").innerText(), /Project ranking/);
  assert.match(await page.locator("main").innerText(), /Visitors now/i);

  await page.locator('[data-project="alpha"]').click();
  await page.getByText("Traffic over time").waitFor();
  assert.match(await page.locator("main").innerText(), /Conversion rate/i);
  assert.match(await page.locator("main").innerText(), /8\.7%/);
  assert.match(await page.locator("#export-link").getAttribute("href"), /\/api\/export\.csv\?.*projectId=alpha/);

  await page.locator("#project-select").selectOption("beta");
  await page.getByText("No data yet").waitFor();
  assert.ok(requests.some((url) => url.includes("projectId=alpha")));
  assert.ok(requests.some((url) => url.includes("projectId=beta")));
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
