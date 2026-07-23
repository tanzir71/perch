import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Miniflare } from "miniflare";
import sourceWorker from "../worker/worker.js";

const scriptPath = new URL("../dist/worker.js", import.meta.url);
const schema = await readFile(new URL("../worker/schema.sql", import.meta.url), "utf8");
const mf = new Miniflare({
  modules: true,
  scriptPath: fileURLToPath(scriptPath),
  compatibilityDate: "2026-07-23",
  d1Databases: { DB: "perch-test" },
  bindings: { SALT: "integration-test-salt" }
});

try {
  const db = await mf.getD1Database("DB");
  const schemaStatements = schema
    .replace(/--.*$/gm, "")
    .split(";")
    .map((statement) => statement.trim())
    .filter(Boolean);
  await db.batch(schemaStatements.map((statement) => db.prepare(statement)));
  await db.prepare(`
    INSERT INTO projects (id, name, origin, created_at)
    VALUES (?, ?, ?, ?), (?, ?, ?, ?)
  `).bind(
    "alpha", "Alpha Studio", "https://alpha.example", new Date().toISOString(),
    "beta", "Beta Notes", "https://beta.example", new Date().toISOString()
  ).run();

  async function collect(projectId, type, ip, name = "") {
    const response = await mf.dispatchFetch("http://localhost/collect", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "user-agent": "Integration Browser",
        "cf-connecting-ip": ip
      },
      body: JSON.stringify({
        type,
        name,
        path: "/",
        projectId
      })
    });
    const body = await response.json();
    assert.equal(body.ok, true, body.error);
  }

  await collect("alpha", "pageview", "203.0.113.1");
  await collect("alpha", "pageview", "203.0.113.1");
  let response = await mf.dispatchFetch("http://localhost/api/rollup?projectId=alpha");
  let alpha = await response.json();
  assert.equal(alpha.totals.pageviews, 2);
  assert.equal(alpha.totals.uniques, 1);
  assert.equal(alpha.totals.sessions, 1);
  assert.equal(alpha.totals.bounceRate, 0);

  await collect("alpha", "pageview", "203.0.113.2");
  await collect("alpha", "cta", "203.0.113.2", "signup-hero");
  await collect("beta", "pageview", "203.0.113.3");

  response = await mf.dispatchFetch("http://localhost/api/rollup?projectId=alpha");
  alpha = await response.json();
  assert.equal(alpha.totals.pageviews, 3);
  assert.equal(alpha.totals.uniques, 2);
  assert.equal(alpha.totals.sessions, 2);
  assert.equal(alpha.totals.bounceRate, 0.5);
  assert.ok(alpha.totals.conversionRate > 0);
  assert.ok(alpha.totals.realtime >= 1);

  response = await mf.dispatchFetch("http://localhost/api/rollup?projectId=beta");
  const beta = await response.json();
  assert.equal(beta.totals.pageviews, 1);
  assert.equal(beta.totals.uniques, 1);

  response = await mf.dispatchFetch("http://localhost/api/overview");
  const overview = await response.json();
  assert.deepEqual(overview.map((project) => project.projectId), ["alpha", "beta"]);
  assert.equal(overview[0].pageviews, 3);

  response = await mf.dispatchFetch("http://localhost/api/projects");
  const projects = await response.json();
  assert.deepEqual(projects.map((project) => project.id), ["alpha", "beta"]);

  response = await mf.dispatchFetch("http://localhost/api/export.csv?projectId=alpha");
  assert.match(response.headers.get("content-type"), /^text\/csv/);
  const csv = await response.text();
  assert.equal(csv.trim().split(/\r?\n/).length, 5);
  assert.match(csv, /signup-hero/);

  const noCfResponse = await sourceWorker.fetch(new Request("http://localhost/collect", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "user-agent": "Direct integration browser",
      "cf-connecting-ip": "203.0.113.20"
    },
    body: JSON.stringify({ type: "pageview", projectId: "no-cf", path: "/" })
  }), { DB: db, SALT: "integration-test-salt" });
  assert.equal((await noCfResponse.json()).ok, true);
  const country = await db.prepare(
    "SELECT country FROM events WHERE project_id = ? ORDER BY id DESC LIMIT 1"
  ).bind("no-cf").first("country");
  assert.equal(country, "XX");

  response = await mf.dispatchFetch("http://localhost/api/projects");
  assert.ok((await response.json()).some((project) => project.id === "no-cf"));

  response = await mf.dispatchFetch("http://localhost/");
  assert.match(response.headers.get("content-type"), /^text\/html/);
  assert.match(await response.text(), /All your sites, one quiet view/);

  console.log("Worker integration gate passed");
} finally {
  await mf.dispose();
}
