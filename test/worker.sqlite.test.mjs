// Worker queries against real SQLite (node:sqlite). Needs no installs; skipped on Node < 22.5.
import assert from "node:assert/strict";
import test from "node:test";
import { applyMigrations, createD1, sqliteAvailable } from "./helpers/d1-sqlite.mjs";

const available = await sqliteAvailable();
const SALT = "sqlite-test-salt";
const NOW = new Date("2026-11-17T12:00:00.000Z");

async function setup({ register = true } = {}) {
  const worker = await import("../worker/worker.js");
  const DB = await createD1();
  await applyMigrations(DB);
  if (register) {
    await DB.prepare("INSERT INTO projects (id, name, origin, created_at) VALUES (?1, ?2, ?3, ?4), (?5, ?6, ?7, ?8)")
      .bind("alpha", "Alpha Studio", "https://alpha.example", NOW.toISOString(), "beta", "Beta Notes", "https://beta.example", NOW.toISOString())
      .run();
  }
  return { worker, env: { DB, SALT } };
}

function request(path, { body, ip = "203.0.113.1", ua = "Mozilla/5.0 (Windows NT 10.0) Chrome/126.0", origin = "https://alpha.example", method = "POST" } = {}) {
  return new Request(`https://perch.example${path}`, {
    method,
    headers: { "content-type": "text/plain", "user-agent": ua, "cf-connecting-ip": ip, origin },
    body: body ? JSON.stringify(body) : undefined
  });
}

/** Inserts an event at a chosen time, exactly as /collect would derive it. */
async function seed(worker, env, event, { at, ip = "198.51.100.1", origin = "https://alpha.example" }) {
  const req = request("/collect", { body: event, ip, origin });
  const row = await worker.rowFromEvent(event, req, SALT, new Date(at));
  const columns = Object.keys(row);
  await env.DB.prepare(`INSERT INTO events (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`)
    .bind(...columns.map((column) => row[column]))
    .run();
}

const api = (worker, env, path) => {
  const url = new URL(`https://perch.example${path}`);
  if (url.pathname === "/api/rollup") return worker.getRollup(env, url, NOW);
  if (url.pathname === "/api/overview") return worker.getOverview(env, url, NOW);
  throw new Error(path);
};

test("realtime counts only the last five minutes", { skip: !available }, async () => {
  const { worker, env } = await setup();
  await seed(worker, env, { type: "pageview", projectId: "alpha", path: "/" }, { at: "2026-11-17T09:00:00.000Z", ip: "1.1.1.1" });
  await seed(worker, env, { type: "pageview", projectId: "alpha", path: "/" }, { at: "2026-11-17T11:50:00.000Z", ip: "1.1.1.2" });
  await seed(worker, env, { type: "pageview", projectId: "alpha", path: "/" }, { at: "2026-11-17T11:58:00.000Z", ip: "1.1.1.3" });
  const result = await api(worker, env, "/api/rollup?projectId=alpha&from=2026-11-17&to=2026-11-17");
  assert.equal(result.totals.realtime, 1);
  assert.equal(result.totals.uniques, 3);
});

test("ingest keeps every pageview, classifies channels, and rejects unknown projects", { skip: !available }, async () => {
  const { worker, env } = await setup();
  const send = async (body, options) => (await worker.route(request("/collect", { body, ...options }), env)).json();
  assert.deepEqual(await send({ type: "pageview", projectId: "alpha", path: "/", ref: "https://chatgpt.com/" }), { ok: true });
  assert.deepEqual(await send({ type: "pageview", projectId: "alpha", path: "/pricing", ref: "https://alpha.example/" }), { ok: true });
  assert.deepEqual(await send({ type: "cta", projectId: "alpha", name: "signup-hero", path: "/pricing" }), { ok: true });
  assert.deepEqual(await send({ type: "pageview", projectId: "alpha", path: "/", ref: "https://www.google.com/" }, { ip: "9.9.9.9" }), { ok: true });
  assert.deepEqual(await send({ type: "pageview", projectId: "alpha", path: "/", utm: { source: "news", medium: "email" } }, { ip: "9.9.9.8" }), { ok: true });
  assert.equal((await send({ type: "pageview", projectId: "gamma", path: "/" })).error, "Unknown project");
  assert.equal((await send({ type: "pageview", projectId: "alpha" }, { ua: "Googlebot/2.1 (+http://www.google.com/bot.html)" })).skipped, "bot");

  const result = await worker.getRollup(env, new URL("https://perch.example/api/rollup?projectId=alpha"), new Date());
  assert.equal(result.totals.pageviews, 4);
  assert.equal(result.totals.uniques, 3);
  assert.equal(result.totals.realtime, 3);
  const channels = Object.fromEntries(result.byChannel.map((item) => [item.name, item.visitors]));
  assert.deepEqual(channels, { "AI assistants": 1, Search: 1, Email: 1 });
  assert.equal(result.byPath.find((item) => item.name === "/pricing").events, 1);
  assert.equal(result.byCta[0].name, "signup-hero");
  assert.ok(Math.abs(result.byCta[0].conversionRate - 1 / 3) < 1e-9);
});

test("bootstrap mode accepts any project until one is registered", { skip: !available }, async () => {
  const { worker, env } = await setup({ register: false });
  const response = await worker.route(request("/collect", { body: { type: "pageview", projectId: "fresh-site", path: "/" } }), env);
  assert.deepEqual(await response.json(), { ok: true });
  const projects = await worker.getProjects(env);
  assert.deepEqual(projects.map((project) => project.id), ["fresh-site"]);
});

test("engaged visits replace page-count bounce for landing pages", { skip: !available }, async () => {
  const { worker, env } = await setup();
  const at = "2026-11-16T10:00:00.000Z";
  await seed(worker, env, { type: "pageview", projectId: "alpha", path: "/" }, { at, ip: "2.2.2.1" });
  await seed(worker, env, { type: "pageview", projectId: "alpha", path: "/" }, { at, ip: "2.2.2.2" });
  await seed(worker, env, { type: "engagement", projectId: "alpha", path: "/", scroll: 90, ms: 15000 }, { at: "2026-11-16T10:00:20.000Z", ip: "2.2.2.2" });
  await seed(worker, env, { type: "pageview", projectId: "alpha", path: "/" }, { at, ip: "2.2.2.3" });
  await seed(worker, env, { type: "cta", projectId: "alpha", path: "/", name: "signup-hero" }, { at: "2026-11-16T10:00:05.000Z", ip: "2.2.2.3" });
  await seed(worker, env, { type: "pageview", projectId: "alpha", path: "/" }, { at, ip: "2.2.2.4" });
  await seed(worker, env, { type: "engagement", projectId: "alpha", path: "/", scroll: 30, ms: 2000 }, { at: "2026-11-16T10:00:03.000Z", ip: "2.2.2.4" });
  const result = await api(worker, env, "/api/rollup?projectId=alpha&from=2026-11-16&to=2026-11-16");
  assert.equal(result.totals.sessions, 4);
  assert.equal(result.totals.engagedRate, 0.5);
  assert.equal(result.totals.bounceRate, 0.5);
  assert.equal(result.totals.avgScroll, 60);
  assert.equal(result.byPath[0].scroll, 60);
  assert.equal(result.totals.avgTimeMs, Math.round(17000 / 4));
});

test("filters scope every number, and compare returns the previous period", { skip: !available }, async () => {
  const { worker, env } = await setup();
  await seed(worker, env, { type: "pageview", projectId: "alpha", path: "/", ref: "https://news.ycombinator.com/" }, { at: "2026-11-16T08:00:00.000Z", ip: "3.3.3.1" });
  await seed(worker, env, { type: "cta", projectId: "alpha", path: "/", name: "signup-hero", ref: "https://news.ycombinator.com/" }, { at: "2026-11-16T08:00:10.000Z", ip: "3.3.3.1" });
  await seed(worker, env, { type: "pageview", projectId: "alpha", path: "/docs", ref: "https://www.bing.com/" }, { at: "2026-11-16T09:00:00.000Z", ip: "3.3.3.2" });
  await seed(worker, env, { type: "pageview", projectId: "alpha", path: "/" }, { at: "2026-11-09T09:00:00.000Z", ip: "3.3.3.3" });

  const hn = await api(worker, env, "/api/rollup?projectId=alpha&from=2026-11-10&to=2026-11-16&filter=referrer:news.ycombinator.com&compare=1");
  assert.equal(hn.totals.uniques, 1);
  assert.equal(hn.totals.conversionRate, 1);
  assert.deepEqual(hn.filters, [{ dim: "referrer", value: "news.ycombinator.com" }]);
  assert.equal(hn.previous.range.from, "2026-11-03");
  assert.equal(hn.previous.totals.uniques, 0);

  const clickers = await api(worker, env, "/api/rollup?projectId=alpha&from=2026-11-10&to=2026-11-16&filter=cta:signup-hero");
  assert.equal(clickers.totals.uniques, 1);
  const search = await api(worker, env, "/api/rollup?projectId=alpha&from=2026-11-10&to=2026-11-16&filter=channel:Search");
  assert.equal(search.byPath[0].name, "/docs");

  const all = await api(worker, env, "/api/rollup?projectId=alpha&from=2026-11-10&to=2026-11-16&compare=1");
  assert.equal(all.totals.uniques, 2);
  assert.equal(all.previous.totals.uniques, 1);
});

test("nightly rollups give the same answer as raw events, then retention trims raw rows", { skip: !available }, async () => {
  const { worker, env } = await setup();
  const days = ["2026-11-13", "2026-11-14", "2026-11-15", "2026-11-16"];
  let n = 0;
  for (const day of days) {
    for (let visitor = 0; visitor < 3; visitor += 1) {
      const ip = `10.0.${n}.${visitor}`;
      await seed(worker, env, { type: "pageview", projectId: "alpha", path: visitor ? "/pricing" : "/", ref: visitor === 2 ? "https://claude.ai/" : "" }, { at: `${day}T10:0${visitor}:00.000Z`, ip });
      if (visitor === 1) await seed(worker, env, { type: "cta", projectId: "alpha", path: "/pricing", name: "buy-pro" }, { at: `${day}T10:01:30.000Z`, ip });
      if (visitor === 2) await seed(worker, env, { type: "custom", projectId: "alpha", path: "/pricing", name: "newsletter_signup", props: { plan: "pro" } }, { at: `${day}T10:02:30.000Z`, ip });
    }
    await seed(worker, env, { type: "custom", projectId: "alpha", path: "/", name: "web-vital", props: { metric: "LCP", value: 1800 + n * 400 } }, { at: `${day}T11:00:00.000Z`, ip: "7.7.7.7" });
    n += 1;
  }
  await seed(worker, env, { type: "pageview", projectId: "alpha", path: "/" }, { at: "2026-11-17T08:00:00.000Z", ip: "10.9.9.9" });

  const path = "/api/rollup?projectId=alpha&from=2026-11-13&to=2026-11-17";
  const raw = await api(worker, env, path);
  const report = await worker.runMaintenance(env, NOW);
  assert.equal(report.find((item) => item.projectId === "alpha").rolledUntil, "2026-11-16");
  const rolled = await api(worker, env, path);
  for (const key of ["totals", "byDay", "byPath", "byChannel", "byCta", "byEvent", "byEventProps", "entryPages", "exitPages", "vitals"]) {
    assert.deepEqual(rolled[key], raw[key], key);
  }
  assert.equal(raw.totals.uniques, 13);
  assert.equal(raw.byChannel.find((item) => item.name === "AI assistants").visitors, 4);
  assert.equal(raw.byEventProps[0].name, "newsletter_signup · plan: pro");
  assert.equal(raw.vitals.LCP.samples, 4);

  env.RETENTION_DAYS = "2";
  await worker.runMaintenance(env, NOW);
  const remaining = await env.DB.prepare("SELECT MIN(ts) AS ts FROM events WHERE project_id = 'alpha'").first("ts");
  assert.ok(remaining >= "2026-11-15");
  const afterRetention = await api(worker, env, path);
  assert.deepEqual(afterRetention.totals, raw.totals);
});

test("overview, status, export and the hosted tracker", { skip: !available }, async () => {
  const { worker, env } = await setup();
  await seed(worker, env, { type: "pageview", projectId: "alpha", path: "/" }, { at: "2026-11-17T11:59:00.000Z", ip: "4.4.4.1" });
  await seed(worker, env, { type: "pageview", projectId: "alpha", path: "/" }, { at: "2026-11-16T11:00:00.000Z", ip: "4.4.4.2" });
  await seed(worker, env, { type: "pageview", projectId: "beta", path: "/" }, { at: "2026-11-16T11:00:00.000Z", ip: "4.4.4.3" });
  await seed(worker, env, { type: "custom", projectId: "beta", path: "/", name: "__perch_test" }, { at: "2026-11-17T11:00:00.000Z", ip: "4.4.4.3" });

  const overview = await api(worker, env, "/api/overview?compare=1");
  assert.deepEqual(overview.map((item) => item.projectId), ["alpha", "beta"]);
  assert.equal(overview[0].uniques, 2);
  assert.equal(overview[0].realtime, 1);
  assert.equal(overview[0].lastEventAt, "2026-11-17T11:59:00.000Z");
  assert.ok(overview[0].previous);

  const status = await worker.getStatus(env, new URL("https://perch.example/api/status?projectId=beta"));
  assert.equal(status.registered, true);
  assert.equal(status.received.pageview, 1);
  assert.equal(status.received.test, 1);
  const beta = await api(worker, env, "/api/rollup?projectId=beta&from=2026-11-16&to=2026-11-17");
  assert.deepEqual(beta.byEvent, []);

  const csv = await (await worker.getExport(env, new URL("https://perch.example/api/export.csv?from=2026-11-16&to=2026-11-17"), NOW)).text();
  assert.match(csv.split("\r\n")[0], /channel/);
  assert.equal(csv.trim().split("\r\n").length, 5);

  const js = await worker.route(new Request("https://perch.example/perch.js"), env);
  assert.match(js.headers.get("content-type"), /javascript/);
  assert.match(await js.text(), /data-project-id/);

  const maintenance = await worker.route(new Request("https://perch.example/api/maintenance", { method: "POST" }), env);
  assert.equal((await maintenance.json()).ok, true);
});
