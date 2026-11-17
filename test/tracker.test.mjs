import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { after, before, test } from "node:test";
import { chromium } from "playwright";

// The tracker runs in a real browser. Pages live on fake origins served by request
// interception, and sendBeacon/fetch are replaced so every payload is captured in order.
const source = await readFile(new URL("../src/perch.js", import.meta.url), "utf8");
const defaultAttributes = `data-endpoint="https://stats.example/collect" data-project-id="demo-project"`;

let browser;

before(async () => {
  browser = await chromium.launch({ headless: true });
});

after(async () => {
  await browser?.close();
});

async function trackerPage(body = "", options = {}) {
  const context = await browser.newContext({ viewport: { width: 1000, height: 700 } });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(({ failing, dnt }) => {
    window.__events = [];
    window.__endpoints = [];
    const RealBlob = window.Blob;
    window.Blob = function (parts, init) {
      const blob = new RealBlob(parts, init);
      blob.__body = parts.join("");
      return blob;
    };
    if (dnt) Object.defineProperty(Navigator.prototype, "doNotTrack", { configurable: true, get: () => "1" });
    navigator.sendBeacon = (endpoint, blob) => {
      if (failing) throw new Error("blocked");
      window.__endpoints.push(endpoint);
      window.__events.push(JSON.parse(blob.__body));
      return true;
    };
    window.fetch = () => {
      if (failing) throw new Error("blocked too");
      return Promise.resolve(new Response("{}"));
    };
  }, { failing: Boolean(options.failing), dnt: Boolean(options.dnt) });

  const url = options.url || "https://site.example/pricing?utm_source=launch&utm_medium=email&utm_campaign=spring";
  const tag = options.src
    ? `<script src="${options.src}" ${options.attributes ?? ""}></script>`
    : `<script ${options.attributes ?? defaultAttributes}>${source}</script>`;
  await context.route("https://**/*", (route) => {
    const requested = route.request().url();
    if (requested.endsWith("/perch.js")) {
      return route.fulfill({ status: 200, contentType: "text/javascript", body: source });
    }
    return route.fulfill({
      status: 200,
      contentType: "text/html",
      body: `<!doctype html><html><body>${body}<div style="height:3000px"></div>${tag}</body></html>`
    });
  });
  await page.goto(url, { referer: "https://news.example/story" });
  const events = () => page.evaluate(() => window.__events);
  const reset = () => page.evaluate(() => { window.__events.length = 0; });
  const hide = () => page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
    document.dispatchEvent(new Event("visibilitychange"));
    window.dispatchEvent(new Event("pagehide"));
  });
  return { page, context, errors, events, reset, hide };
}

test("one pageview per page load, even if the tag runs twice, with no client storage", async () => {
  const { page, context, events, errors } = await trackerPage();
  await page.evaluate(source);
  const sent = await events();
  assert.equal(sent.filter((event) => event.type === "pageview").length, 1);
  assert.equal(sent[0].projectId, "demo-project");
  assert.deepEqual(await page.evaluate(() => [sessionStorage.length, localStorage.length, document.cookie]), [0, 0, ""]);
  assert.deepEqual(errors, []);
  await context.close();
});

test("every page of a multi-page visit is counted", async () => {
  const first = await trackerPage("", { url: "https://site.example/" });
  const second = await trackerPage("", { url: "https://site.example/pricing" });
  assert.equal((await first.events())[0].path, "/");
  assert.equal((await second.events())[0].type, "pageview");
  assert.equal((await second.events())[0].path, "/pricing");
  await first.context.close();
  await second.context.close();
});

test("captures CTA, outbound, custom, and manual SPA pageview events", async () => {
  const { page, context, events, reset } = await trackerPage(`
    <a id="cta" href="/join" data-perch-cta="signup-hero"><span>Join</span></a>
    <a id="external" href="https://docs.example.net/start">Docs</a>
    <a id="internal" href="/inside">Inside</a>
    <a id="ignored" href="https://ignored.example" data-perch-ignore>Ignored</a>
  `, { attributes: `${defaultAttributes} data-no-engagement` });
  await reset();
  await page.evaluate(() => {
    document.addEventListener("click", (event) => {
      if (event.target.closest?.("a")) event.preventDefault();
    });
  });
  await page.click("#cta span");
  await page.click("#external");
  await page.click("#internal");
  await page.click("#ignored");
  await page.evaluate(() => {
    window.perch.track("newsletter_signup", { source: "footer", email: "must-not-ship@example.com" });
    window.perch.track("pageview");
  });
  const sent = await events();
  assert.deepEqual(sent.map(({ type, name }) => [type, name]), [
    ["cta", "signup-hero"],
    ["outbound", "docs.example.net"],
    ["custom", "newsletter_signup"],
    ["pageview", undefined]
  ]);
  assert.deepEqual(sent[2].props, { source: "footer" });
  await context.close();
});

test("sends one engagement event with scroll depth and visible time when the page is hidden", async () => {
  const { page, context, events, hide } = await trackerPage();
  await page.mouse.wheel(0, 900);
  await page.waitForTimeout(150);
  await hide();
  const engagement = (await events()).filter((event) => event.type === "engagement");
  assert.equal(engagement.length, 1);
  assert.equal(typeof engagement[0].scroll, "number");
  assert.ok(engagement[0].scroll > 0 && engagement[0].scroll <= 100);
  assert.equal(typeof engagement[0].ms, "number");
  assert.equal(engagement[0].name, undefined);
  await context.close();
});

test("SPA pageviews flush the previous page's engagement first", async () => {
  const { page, context, events, reset } = await trackerPage();
  await reset();
  await page.evaluate(() => window.perch.track("pageview"));
  assert.deepEqual((await events()).map((event) => event.type), ["engagement", "pageview"]);
  await context.close();
});

test("the endpoint defaults to the script's own origin when the Worker serves it", async () => {
  const { page, context } = await trackerPage("", { src: "https://a.site.example/perch.js", attributes: `data-project-id="demo-project"` });
  await page.waitForFunction(() => window.__endpoints.length > 0);
  assert.equal(await page.evaluate(() => window.__endpoints[0]), "https://a.site.example/collect");
  await context.close();
});

test("parses UTM values and never sends server-derived or identity fields", async () => {
  const { context, events } = await trackerPage();
  const payload = (await events())[0];
  assert.deepEqual(payload.utm, { source: "launch", medium: "email", campaign: "spring" });
  for (const forbidden of ["ip", "country", "visitorHash", "visitor_hash", "device", "channel"]) {
    assert.equal(Object.hasOwn(payload, forbidden), false);
  }
  assert.equal(payload.projectId, "demo-project");
  assert.equal(payload.path, "/pricing");
  await context.close();
});

test("transport and event-handler failures never escape", async () => {
  const { page, context, errors, hide } = await trackerPage(`<button data-perch-cta="safe">Safe</button>`, { failing: true });
  await page.click("button");
  await page.evaluate(() => window.perch.track("custom_action", { value: 1 }));
  await hide();
  assert.deepEqual(errors, []);
  await context.close();
});

test("respects optional DNT and outbound controls", async () => {
  const { page, context, events, hide } = await trackerPage(`<a href="https://elsewhere.example">Elsewhere</a>`, {
    url: "https://site.example/",
    dnt: true,
    attributes: `${defaultAttributes} data-respect-dnt data-no-outbound`
  });
  await page.evaluate(() => document.querySelector("a").addEventListener("click", (event) => event.preventDefault()));
  await page.click("a");
  await hide();
  assert.deepEqual(await events(), []);
  await context.close();
});
