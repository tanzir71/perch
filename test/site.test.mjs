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

async function open(width, path = "/dist/pages/index.html") {
  const page = await browser.newPage({ viewport: { width, height: 900 } });
  const errors = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/collect", (route) => route.fulfill({ status: 200, contentType: "application/json", body: "{\"ok\":true}" }));
  await page.goto(`${server.origin}${path}`, { waitUntil: "networkidle" });
  return { page, errors };
}

test("marketing page renders every section, keeps its hooks, and fits a phone", async () => {
  for (const width of [1440, 375]) {
    const { page, errors } = await open(width);
    await page.getByRole("heading", { level: 1, name: /Cookieless analytics for every site you run/ }).waitFor();
    assert.match(await page.locator(".pill").innerText(), /A quiet vantage point over all your sites/);
    for (const id of ["audience", "install", "why", "features", "how", "dashboard-preview", "comparison", "privacy", "faq", "open-source"]) {
      assert.equal(await page.locator(`#${id}`).count(), 1, id);
    }
    assert.match(await page.locator("#install-code").innerText(), /data-project-id=/);
    assert.match(await page.locator("#install-code").innerText(), /perch\.js/);
    for (const cta of ["get-started-nav", "get-started-hero", "demo-hero", "get-started-band", "github-band", "donate-footer"]) {
      assert.equal(await page.locator(`[data-perch-cta="${cta}"]`).count(), 1, cta);
    }
    const tracker = page.locator('script[src="./perch.min.js"]');
    assert.equal(await tracker.count(), 1);
    assert.equal(await tracker.getAttribute("data-project-id"), "perch-site");
    assert.equal(await page.locator("details").count(), 8);
    assert.equal(await page.locator('[data-perch-cta="donate-footer"]').getAttribute("href"), "https://buymeacoffee.com/tanzir");

    // Nothing may stick out sideways unless it sits inside its own scroll area.
    const overflowing = await page.evaluate(() => [...document.querySelectorAll("body *")].filter((element) => {
      const rect = element.getBoundingClientRect();
      if (rect.width === 0 || rect.right <= window.innerWidth + 1) return false;
      for (let node = element.parentElement; node; node = node.parentElement) {
        if (/(auto|scroll)/.test(getComputedStyle(node).overflowX)) return false;
      }
      return true;
    }).map((element) => element.className || element.tagName));
    assert.deepEqual(overflowing, [], `overflow at ${width}px`);
    assert.deepEqual(errors, []);
    await page.close();
  }
});

test("install tabs switch and snippets copy", async () => {
  const { page, errors } = await open(1440);
  await page.locator("#copy-install").click();
  await page.getByText("Copied", { exact: true }).waitFor();
  await page.locator('[data-path="agent"]').click();
  assert.equal(await page.locator("#code-file").innerText(), "agent-prompt.md");
  assert.match(await page.locator('pre[data-panel="agent"]').innerText(), /INTEGRATION\.md/);
  assert.equal(await page.locator("#install-code").isVisible(), false);
  assert.deepEqual(errors, []);
  await page.close();
});

test("the Pages build ships the live demo dashboard and llms.txt", async () => {
  const { page, errors } = await open(1280, "/dist/pages/dashboard/?demo");
  await page.getByText("Project ranking").waitFor();
  assert.ok((await page.locator("#project-select option").count()) > 2);
  assert.deepEqual(errors, []);
  await page.close();
  const llms = await readFile(new URL("../dist/pages/llms.txt", import.meta.url), "utf8");
  assert.match(llms, /INTEGRATION\.md/);
});

test("Pages workflow publishes the static site on main pushes without installing dependencies", async () => {
  const source = await readFile(new URL("../.github/workflows/pages.yml", import.meta.url), "utf8");
  const workflow = parse(source);
  assert.deepEqual(workflow.on.push.branches, ["main"]);
  assert.equal(workflow.permissions.pages, "write");
  assert.equal(workflow.permissions["id-token"], "write");
  assert.equal(workflow.jobs.deploy.environment.name, "github-pages");
  assert.match(source, /actions\/upload-pages-artifact@v3/);
  assert.match(source, /actions\/deploy-pages@v4/);
  assert.match(source, /node scripts\/build-pages\.mjs/);
  assert.match(source, /path: dist\/pages/);
  assert.doesNotMatch(source, /npm ci/);

  const ci = parse(await readFile(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8"));
  assert.ok(JSON.stringify(ci.jobs).includes("npm run test:all"));
});
