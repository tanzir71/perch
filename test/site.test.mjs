import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { after, before, test } from "node:test";
import { chromium } from "playwright";
import { parse } from "yaml";
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

test("marketing page renders every product section and remains usable on mobile", async () => {
  const page = await browser.newPage({ viewport: { width: 375, height: 812 } });
  const errors = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${server.origin}/dist/pages/index.html`, { waitUntil: "networkidle" });

  await page.getByRole("heading", { name: /A quiet vantage point/ }).waitFor();
  assert.equal(await page.locator("#install").count(), 1);
  assert.equal(await page.locator("#why").count(), 1);
  assert.equal(await page.locator("#features").count(), 1);
  assert.equal(await page.locator("#comparison").count(), 1);
  assert.equal(await page.locator("#faq").count(), 1);
  assert.match(await page.locator("#install-code").innerText(), /data-endpoint=/);
  assert.equal(await page.locator('[data-perch-cta="get-started-hero"]').count(), 1);
  assert.equal(await page.locator('[data-perch-cta="demo-hero"]').count(), 1);
  const tracker = page.locator('script[src="./perch.min.js"]');
  assert.equal(await tracker.count(), 1);
  assert.equal(await tracker.getAttribute("data-project-id"), "perch-site");
  assert.match(await tracker.getAttribute("data-endpoint"), /YOUR-PERCH-WORKER/);

  await page.locator("#copy-install").click();
  await page.getByText("Copied", { exact: true }).waitFor();
  const fits = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
  assert.equal(fits, true);
  assert.deepEqual(errors, []);
  await page.close();
});

test("Pages workflow publishes site index and tracker on main pushes", async () => {
  const source = await readFile(new URL("../.github/workflows/pages.yml", import.meta.url), "utf8");
  const workflow = parse(source);
  assert.deepEqual(workflow.on.push.branches, ["main"]);
  assert.equal(workflow.permissions.pages, "write");
  assert.equal(workflow.permissions["id-token"], "write");
  assert.equal(workflow.jobs.deploy.environment.name, "github-pages");
  assert.match(source, /actions\/upload-pages-artifact@v3/);
  assert.match(source, /actions\/deploy-pages@v4/);
  assert.match(source, /npm ci/);
  assert.match(source, /npm run build/);
  assert.match(source, /cp site\/index\.html _site\/index\.html/);
  assert.match(source, /cp src\/perch\.min\.js _site\/perch\.min\.js/);
});
