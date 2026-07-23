import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { chromium } from "playwright";
import { startServer } from "./browser-server.mjs";

let browser;
let server;

before(async () => {
  browser = await chromium.launch({ headless: true });
  server = await startServer();
});

after(async () => {
  await browser?.close();
  await server?.close();
});

test("demo exercises pageview, CTA, outbound, custom, and internal-link rules", async () => {
  const page = await browser.newPage();
  const events = [];
  const errors = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/collect", async (route) => {
    events.push(JSON.parse(route.request().postData() || "{}"));
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ok: true })
    });
  });

  await page.goto(`${server.origin}/demo/index.html`, { waitUntil: "networkidle" });
  assert.equal(events.filter((event) => event.type === "pageview").length, 1);

  await page.evaluate(() => {
    document.querySelectorAll("a").forEach((link) => link.addEventListener("click", (event) => event.preventDefault()));
  });
  await page.locator('[data-perch-cta="contact-hero"]').click();
  await page.locator('[data-perch-cta="newsletter-hero"]').click();
  await page.getByText("Read the field guide").click();
  await page.getByText("Internal link").click();
  await page.locator("#custom-event").click();
  await page.waitForTimeout(50);

  assert.equal(events.filter((event) => event.type === "cta").length, 2);
  assert.equal(events.filter((event) => event.type === "outbound").length, 1);
  assert.equal(events.find((event) => event.type === "outbound").name, "developer.mozilla.org");
  assert.equal(events.filter((event) => event.type === "custom").length, 1);
  for (const event of events) {
    assert.equal(event.projectId, "perch-demo");
    for (const field of ["ip", "country", "visitorHash", "visitor_hash", "device"]) {
      assert.equal(Object.hasOwn(event, field), false);
    }
  }
  assert.deepEqual(errors, []);
  await page.close();
});
