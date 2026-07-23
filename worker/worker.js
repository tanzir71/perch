import dashboardHtml from "./dashboard.generated.js";

const EVENT_TYPES = new Set(["pageview", "cta", "outbound", "custom"]);
const encoder = new TextEncoder();

function text(value, max = 500) {
  return String(value == null ? "" : value).trim().slice(0, max);
}

function number(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function json(data, init = {}) {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  headers.set("cache-control", "no-store");
  return new Response(JSON.stringify(data), { ...init, headers });
}

function corsHeaders(request) {
  const origin = request.headers.get("origin") || "*";
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "POST, OPTIONS",
    "access-control-allow-headers": "content-type",
    "access-control-max-age": "86400",
    "vary": "Origin"
  };
}

function errorMessage(error) {
  return error instanceof Error ? error.message : "Unexpected error";
}

export async function hashVisitor(ip, userAgent, when, salt) {
  const date = new Date(when);
  if (Number.isNaN(date.valueOf())) throw new Error("Invalid hash date");
  const day = date.toISOString().slice(0, 10);
  const input = `${ip || ""}|${userAgent || ""}|${day}|${salt || ""}`;
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(input));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function parseUA(userAgent = "") {
  const ua = String(userAgent);
  let browser = "Other";
  let os = "Other";
  let device = "Desktop";

  if (/Edg\//i.test(ua)) browser = "Edge";
  else if (/OPR\/|Opera/i.test(ua)) browser = "Opera";
  else if (/Firefox\/|FxiOS\//i.test(ua)) browser = "Firefox";
  else if (/CriOS\/|Chrome\//i.test(ua)) browser = "Chrome";
  else if (/Safari\//i.test(ua)) browser = "Safari";

  if (/Windows NT/i.test(ua)) os = "Windows";
  else if (/Android/i.test(ua)) os = "Android";
  else if (/iPhone|iPad|iPod/i.test(ua)) os = "iOS";
  else if (/Mac OS X|Macintosh/i.test(ua)) os = "macOS";
  else if (/CrOS/i.test(ua)) os = "ChromeOS";
  else if (/Linux/i.test(ua)) os = "Linux";

  if (/iPad|Tablet|Nexus 7|Nexus 9|SM-T/i.test(ua)) device = "Tablet";
  else if (/Mobi|iPhone|Android.+Mobile/i.test(ua)) device = "Mobile";

  return { device, browser, os };
}

export function refHost(referrer = "") {
  if (!referrer) return "";
  try {
    return new URL(referrer).hostname.toLowerCase().slice(0, 253);
  } catch {
    return "";
  }
}

export function bucketScreen(width) {
  const value = number(width);
  if (value < 768) return "mobile";
  if (value < 1024) return "tablet";
  if (value < 1440) return "desktop";
  return "wide";
}

function sanitizeProps(props) {
  if (!props || typeof props !== "object" || Array.isArray(props)) return null;
  const safe = {};
  for (const [key, value] of Object.entries(props).slice(0, 20)) {
    if (/email|e-mail|phone|mobile|address|password|secret|token|full.?name/i.test(key)) continue;
    if (value == null || ["string", "number", "boolean"].includes(typeof value)) {
      safe[text(key, 60)] = typeof value === "string" ? text(value, 200) : value;
    }
  }
  return Object.keys(safe).length ? JSON.stringify(safe) : null;
}

export async function rowFromEvent(event, request, salt, now = new Date()) {
  if (!event || typeof event !== "object") throw new Error("Body must be a JSON object");
  const type = text(event.type, 30);
  const projectId = text(event.projectId, 80);
  if (!EVENT_TYPES.has(type)) throw new Error("Invalid event type");
  if (!/^[a-z0-9][a-z0-9-]{0,79}$/.test(projectId)) throw new Error("Invalid projectId");

  const userAgent = request.headers.get("user-agent") || "";
  const ip = request.headers.get("cf-connecting-ip") || "";
  const timestamp = now instanceof Date ? now : new Date(now);
  const ua = parseUA(userAgent);
  const utm = event.utm && typeof event.utm === "object" ? event.utm : {};

  return {
    project_id: projectId,
    type,
    name: type === "pageview" ? null : text(event.name, 120) || null,
    path: text(event.path || "/", 500) || "/",
    referrer_host: refHost(event.ref),
    utm_source: text(utm.source, 120) || null,
    utm_medium: text(utm.medium, 120) || null,
    utm_campaign: text(utm.campaign, 120) || null,
    country: text(request.cf?.country || "XX", 2).toUpperCase() || "XX",
    device: ua.device,
    browser: ua.browser,
    os: ua.os,
    visitor_hash: await hashVisitor(ip, userAgent, timestamp, salt),
    screen_bucket: bucketScreen(event.screen),
    lang: text(event.lang, 30) || null,
    props: type === "custom" ? sanitizeProps(event.props) : null,
    ts: timestamp.toISOString()
  };
}

async function readEvent(request) {
  const raw = await request.text();
  if (!raw || raw.length > 64_000) throw new Error("Invalid request body");
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error("Malformed JSON");
  }
}

export async function handleCollect(request, env) {
  const headers = corsHeaders(request);
  try {
    if (!env.DB) throw new Error("Database binding is missing");
    if (!env.SALT) throw new Error("SALT secret is missing");
    const event = await readEvent(request);
    const row = await rowFromEvent(event, request, env.SALT, new Date());
    await env.DB.prepare(`
      INSERT INTO events (
        project_id, type, name, path, referrer_host,
        utm_source, utm_medium, utm_campaign,
        country, device, browser, os, visitor_hash,
        screen_bucket, lang, props, ts
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      row.project_id, row.type, row.name, row.path, row.referrer_host,
      row.utm_source, row.utm_medium, row.utm_campaign,
      row.country, row.device, row.browser, row.os, row.visitor_hash,
      row.screen_bucket, row.lang, row.props, row.ts
    ).run();
    return json({ ok: true }, { status: 200, headers });
  } catch (error) {
    return json({ ok: false, error: errorMessage(error) }, { status: 200, headers });
  }
}

function rows(result) {
  return result?.results || [];
}

function dateRange(url) {
  const now = new Date();
  const defaultFrom = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 29));
  const fromValue = url.searchParams.get("from");
  const toValue = url.searchParams.get("to");
  const from = fromValue && /^\d{4}-\d{2}-\d{2}$/.test(fromValue)
    ? new Date(`${fromValue}T00:00:00.000Z`)
    : defaultFrom;
  const toDay = toValue && /^\d{4}-\d{2}-\d{2}$/.test(toValue)
    ? new Date(`${toValue}T00:00:00.000Z`)
    : new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const toExclusive = new Date(toDay.valueOf() + 86_400_000);
  if (Number.isNaN(from.valueOf()) || Number.isNaN(toExclusive.valueOf()) || from >= toExclusive) {
    throw new Error("Invalid date range");
  }
  return {
    from: from.toISOString(),
    to: toExclusive.toISOString(),
    fromDay: from.toISOString().slice(0, 10),
    toDay: toDay.toISOString().slice(0, 10)
  };
}

function projectIdFrom(url, required = true) {
  const id = text(url.searchParams.get("projectId"), 80);
  if (required && !/^[a-z0-9][a-z0-9-]{0,79}$/.test(id)) {
    throw new Error("A valid projectId is required");
  }
  if (id && !/^[a-z0-9][a-z0-9-]{0,79}$/.test(id)) {
    throw new Error("Invalid projectId");
  }
  return id;
}

async function queryAll(statement) {
  return rows(await statement.all());
}

function breakdownSql(column, extra = "") {
  return `
    SELECT COALESCE(NULLIF(${column}, ''), '(unknown)') AS name,
           COUNT(*) AS events,
           COUNT(DISTINCT visitor_hash) AS visitors
      FROM events
     WHERE project_id = ? AND ts >= ? AND ts < ? ${extra}
     GROUP BY ${column}
     ORDER BY events DESC, name ASC
     LIMIT 20
  `;
}

export async function getRollup(env, url) {
  const projectId = projectIdFrom(url);
  const range = dateRange(url);
  const bind = (sql) => env.DB.prepare(sql).bind(projectId, range.from, range.to);

  const [
    totalsRows,
    sessionRows,
    liveRows,
    byDay,
    byCountry,
    byPath,
    byReferrer,
    bySource,
    byDevice,
    byBrowser,
    byOS,
    byLanguage,
    byCta,
    topOutbound,
    entryPages
  ] = await Promise.all([
    queryAll(bind(`
      SELECT
        SUM(CASE WHEN type = 'pageview' THEN 1 ELSE 0 END) AS pageviews,
        COUNT(DISTINCT CASE WHEN type = 'pageview' THEN visitor_hash END) AS uniques,
        COUNT(DISTINCT CASE WHEN type = 'cta' THEN visitor_hash END) AS cta_visitors
      FROM events
      WHERE project_id = ? AND ts >= ? AND ts < ?
    `)),
    queryAll(bind(`
      WITH sessions AS (
        SELECT visitor_hash, CAST(unixepoch(ts) / 1800 AS INTEGER) AS bucket, COUNT(*) AS views
          FROM events
         WHERE project_id = ? AND ts >= ? AND ts < ? AND type = 'pageview'
         GROUP BY visitor_hash, bucket
      )
      SELECT COUNT(*) AS sessions,
             SUM(CASE WHEN views = 1 THEN 1 ELSE 0 END) AS bounces
        FROM sessions
    `)),
    queryAll(env.DB.prepare(`
      SELECT COUNT(DISTINCT visitor_hash) AS realtime
        FROM events
       WHERE project_id = ? AND ts >= datetime('now', '-5 minutes')
    `).bind(projectId)),
    queryAll(bind(`
      SELECT substr(ts, 1, 10) AS date,
             SUM(CASE WHEN type = 'pageview' THEN 1 ELSE 0 END) AS pv,
             COUNT(DISTINCT CASE WHEN type = 'pageview' THEN visitor_hash END) AS uv
        FROM events
       WHERE project_id = ? AND ts >= ? AND ts < ?
       GROUP BY substr(ts, 1, 10)
       ORDER BY date ASC
    `)),
    queryAll(bind(breakdownSql("country", "AND type = 'pageview'"))),
    queryAll(bind(breakdownSql("path", "AND type = 'pageview'"))),
    queryAll(bind(breakdownSql("referrer_host", "AND type = 'pageview'"))),
    queryAll(bind(breakdownSql("utm_source", "AND type = 'pageview'"))),
    queryAll(bind(breakdownSql("device", "AND type = 'pageview'"))),
    queryAll(bind(breakdownSql("browser", "AND type = 'pageview'"))),
    queryAll(bind(breakdownSql("os", "AND type = 'pageview'"))),
    queryAll(bind(breakdownSql("lang", "AND type = 'pageview'"))),
    queryAll(bind(breakdownSql("name", "AND type = 'cta'"))),
    queryAll(bind(breakdownSql("name", "AND type = 'outbound'"))),
    queryAll(bind(`
      WITH ranked AS (
        SELECT path, visitor_hash,
               CAST(unixepoch(ts) / 1800 AS INTEGER) AS bucket,
               ROW_NUMBER() OVER (
                 PARTITION BY visitor_hash, CAST(unixepoch(ts) / 1800 AS INTEGER)
                 ORDER BY ts, id
               ) AS position
          FROM events
         WHERE project_id = ? AND ts >= ? AND ts < ? AND type = 'pageview'
      )
      SELECT COALESCE(NULLIF(path, ''), '/') AS name, COUNT(*) AS events
        FROM ranked
       WHERE position = 1
       GROUP BY path
       ORDER BY events DESC, name ASC
       LIMIT 20
    `))
  ]);

  const rawTotals = totalsRows[0] || {};
  const rawSessions = sessionRows[0] || {};
  const pageviews = number(rawTotals.pageviews);
  const uniques = number(rawTotals.uniques);
  const sessions = number(rawSessions.sessions);
  const bounces = number(rawSessions.bounces);
  const ctaVisitors = number(rawTotals.cta_visitors);
  const conversionRate = uniques ? ctaVisitors / uniques : 0;

  return {
    projectId,
    range: { from: range.fromDay, to: range.toDay },
    totals: {
      pageviews,
      uniques,
      sessions,
      bounceRate: sessions ? bounces / sessions : 0,
      pagesPerSession: sessions ? pageviews / sessions : 0,
      realtime: number(liveRows[0]?.realtime),
      conversionRate
    },
    goal: {
      name: "Pageview → CTA",
      visitors: uniques,
      convertedVisitors: ctaVisitors,
      conversionRate
    },
    byDay,
    byCountry,
    byPath,
    byReferrer,
    bySource,
    byDevice,
    byBrowser,
    byOS,
    byLanguage,
    byCta,
    topOutbound,
    entryPages
  };
}

export async function getProjects(env) {
  return queryAll(env.DB.prepare(`
    SELECT id, name, origin
      FROM projects
    UNION ALL
    SELECT DISTINCT e.project_id AS id, e.project_id AS name, NULL AS origin
      FROM events e
     WHERE NOT EXISTS (SELECT 1 FROM projects p WHERE p.id = e.project_id)
    ORDER BY name COLLATE NOCASE, id
  `));
}

export async function getOverview(env, url) {
  const range = dateRange(url);
  const [projects, totals, sessions, live, daily] = await Promise.all([
    getProjects(env),
    queryAll(env.DB.prepare(`
      SELECT project_id,
             SUM(CASE WHEN type = 'pageview' THEN 1 ELSE 0 END) AS pageviews,
             COUNT(DISTINCT CASE WHEN type = 'pageview' THEN visitor_hash END) AS uniques
        FROM events
       WHERE ts >= ? AND ts < ?
       GROUP BY project_id
    `).bind(range.from, range.to)),
    queryAll(env.DB.prepare(`
      WITH grouped AS (
        SELECT project_id, visitor_hash,
               CAST(unixepoch(ts) / 1800 AS INTEGER) AS bucket
          FROM events
         WHERE ts >= ? AND ts < ? AND type = 'pageview'
         GROUP BY project_id, visitor_hash, bucket
      )
      SELECT project_id, COUNT(*) AS sessions
        FROM grouped
       GROUP BY project_id
    `).bind(range.from, range.to)),
    queryAll(env.DB.prepare(`
      SELECT project_id, COUNT(DISTINCT visitor_hash) AS realtime
        FROM events
       WHERE ts >= datetime('now', '-5 minutes')
       GROUP BY project_id
    `)),
    queryAll(env.DB.prepare(`
      SELECT project_id, substr(ts, 1, 10) AS date, COUNT(*) AS pv
        FROM events
       WHERE ts >= ? AND ts < ? AND type = 'pageview'
       GROUP BY project_id, substr(ts, 1, 10)
       ORDER BY date ASC
    `).bind(range.from, range.to))
  ]);

  const totalsById = new Map(totals.map((row) => [row.project_id, row]));
  const sessionsById = new Map(sessions.map((row) => [row.project_id, row]));
  const liveById = new Map(live.map((row) => [row.project_id, row]));
  const dailyById = new Map();
  for (const row of daily) {
    if (!dailyById.has(row.project_id)) dailyById.set(row.project_id, []);
    dailyById.get(row.project_id).push({ date: row.date, pv: number(row.pv) });
  }

  return projects.map((project) => {
    const projectTotals = totalsById.get(project.id) || {};
    return {
      projectId: project.id,
      name: project.name,
      origin: project.origin,
      pageviews: number(projectTotals.pageviews),
      uniques: number(projectTotals.uniques),
      sessions: number(sessionsById.get(project.id)?.sessions),
      realtime: number(liveById.get(project.id)?.realtime),
      byDay: dailyById.get(project.id) || []
    };
  }).sort((a, b) => b.pageviews - a.pageviews || a.name.localeCompare(b.name));
}

function csvCell(value) {
  const string = value == null ? "" : String(value);
  return /[",\r\n]/.test(string) ? `"${string.replaceAll('"', '""')}"` : string;
}

export async function getExport(env, url) {
  const projectId = projectIdFrom(url, false);
  const range = dateRange(url);
  const columns = [
    "project_id", "type", "name", "path", "referrer_host",
    "utm_source", "utm_medium", "utm_campaign", "country",
    "device", "browser", "os", "screen_bucket", "lang", "props", "ts"
  ];
  const whereProject = projectId ? "project_id = ? AND " : "";
  const statement = env.DB.prepare(`
    SELECT ${columns.join(", ")}
      FROM events
     WHERE ${whereProject}ts >= ? AND ts < ?
     ORDER BY ts ASC, id ASC
  `);
  const data = projectId
    ? await queryAll(statement.bind(projectId, range.from, range.to))
    : await queryAll(statement.bind(range.from, range.to));
  const csv = [
    columns.join(","),
    ...data.map((row) => columns.map((column) => csvCell(row[column])).join(","))
  ].join("\r\n");
  const filename = `perch-${projectId || "all-projects"}-${range.fromDay}-${range.toDay}.csv`;
  return new Response(csv, {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="${filename}"`,
      "cache-control": "no-store"
    }
  });
}

async function handleApi(request, env, url) {
  try {
    if (!env.DB) throw new Error("Database binding is missing");
    if (url.pathname === "/api/projects") return json(await getProjects(env));
    if (url.pathname === "/api/overview") return json(await getOverview(env, url));
    if (url.pathname === "/api/rollup") return json(await getRollup(env, url));
    if (url.pathname === "/api/export.csv") return getExport(env, url);
    return json({ error: "Not found" }, { status: 404 });
  } catch (error) {
    return json({ error: errorMessage(error) }, { status: 400 });
  }
}

export async function route(request, env) {
  const url = new URL(request.url);

  if (request.method === "OPTIONS" && url.pathname === "/collect") {
    return new Response(null, { status: 204, headers: corsHeaders(request) });
  }
  if (request.method === "POST" && url.pathname === "/collect") {
    return handleCollect(request, env);
  }
  if (request.method === "GET" && url.pathname === "/") {
    return new Response(dashboardHtml, {
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-cache",
        "x-content-type-options": "nosniff",
        "referrer-policy": "same-origin"
      }
    });
  }
  if (request.method === "GET" && url.pathname.startsWith("/api/")) {
    return handleApi(request, env, url);
  }
  return json({ error: "Not found" }, { status: 404 });
}

export default {
  fetch: route
};
