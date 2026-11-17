import dashboardHtml from "./dashboard.generated.js";
import trackerJs from "./tracker.generated.js";

const EVENT_TYPES = new Set(["pageview", "cta", "outbound", "custom", "engagement"]);
const PROJECT_ID = /^[a-z0-9][a-z0-9-]{0,79}$/;
const TEST_EVENT = "__perch_test";
const SESSION_SECONDS = 1800;
const REALTIME_MS = 5 * 60 * 1000;
const DAY_MS = 86_400_000;
const encoder = new TextEncoder();

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function text(value, max = 500) {
  return String(value == null ? "" : value).trim().slice(0, max);
}

function number(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function clampInt(value, min, max) {
  const parsed = Math.round(Number(value));
  if (!Number.isFinite(parsed)) return null;
  return Math.min(max, Math.max(min, parsed));
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

function rows(result) {
  return result?.results || [];
}

async function queryAll(statement) {
  return rows(await statement.all());
}

export function utcDay(date) {
  return new Date(date).toISOString().slice(0, 10);
}

export function addDays(day, delta) {
  return utcDay(Date.parse(`${day}T00:00:00.000Z`) + delta * DAY_MS);
}

function dayStart(day) {
  return `${day}T00:00:00.000Z`;
}

function hostOf(value) {
  try {
    return new URL(value).hostname.toLowerCase();
  } catch {
    return "";
  }
}

function sameSite(a, b) {
  const strip = (host) => host.replace(/^www\./, "");
  return Boolean(a && b) && strip(a) === strip(b);
}

// ---------------------------------------------------------------------------
// Server-side enrichment (pure, unit-tested)
// ---------------------------------------------------------------------------

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

export function isBot(userAgent = "") {
  return /bot\b|bot\/|crawl|spider|slurp|headless|lighthouse|facebookexternalhit|bingpreview|embedly|preview|pingdom|uptime/i.test(String(userAgent));
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

const AI_HOSTS = [
  "chatgpt.com", "chat.openai.com", "openai.com", "perplexity.ai", "claude.ai",
  "gemini.google.com", "bard.google.com", "copilot.microsoft.com", "deepseek.com",
  "grok.com", "x.ai", "meta.ai", "you.com", "phind.com", "poe.com", "mistral.ai"
];
const EMAIL_HOSTS = ["mail.google.com", "outlook.live.com", "outlook.office.com", "mail.yahoo.com", "mail.proton.me", "fastmail.com", "app.fastmail.com"];
const SEARCH_HOST = /(^|\.)(google\.[a-z.]+|bing\.com|duckduckgo\.com|yahoo\.[a-z.]+|yandex\.[a-z.]+|baidu\.com|ecosia\.org|search\.brave\.com|startpage\.com|qwant\.com|naver\.com|seznam\.cz|kagi\.com)$/;
const SOCIAL_HOST = /(^|\.)(facebook\.com|fb\.com|instagram\.com|t\.co|twitter\.com|x\.com|linkedin\.com|lnkd\.in|reddit\.com|news\.ycombinator\.com|youtube\.com|youtu\.be|tiktok\.com|pinterest\.[a-z.]+|threads\.net|bsky\.app|mastodon\.social|producthunt\.com|discord\.com|t\.me|whatsapp\.com|quora\.com|medium\.com|substack\.com)$/;

function matchesHost(host, list) {
  return list.some((entry) => host === entry || host.endsWith(`.${entry}`));
}

/**
 * Groups a visit into a channel. UTM medium wins, then the referring host.
 * `pageHost` comes from the beacon's Origin header and marks internal navigation.
 */
export function channelFor(referrerHost = "", utm = {}, pageHost = "") {
  const medium = text(utm.medium, 120).toLowerCase();
  if (/^(cpc|ppc|paid|paidsearch|paid[-_ ]?social|display|banner|cpm|retargeting)$/.test(medium)) return "Paid";
  if (/e-?mail|newsletter/.test(medium)) return "Email";
  if (/social/.test(medium)) return "Social";
  const host = String(referrerHost || "").toLowerCase();
  if (host && pageHost && sameSite(host, pageHost)) return "Internal";
  if (host) {
    if (matchesHost(host, AI_HOSTS)) return "AI assistants";
    if (matchesHost(host, EMAIL_HOSTS)) return "Email";
    if (SEARCH_HOST.test(host)) return "Search";
    if (SOCIAL_HOST.test(host)) return "Social";
    return "Referral";
  }
  if (text(utm.source)) return "Campaign";
  return "Direct";
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
  if (!PROJECT_ID.test(projectId)) throw new Error("Invalid projectId");

  const userAgent = request.headers.get("user-agent") || "";
  const ip = request.headers.get("cf-connecting-ip") || "";
  const timestamp = now instanceof Date ? now : new Date(now);
  const ua = parseUA(userAgent);
  const utm = event.utm && typeof event.utm === "object" ? event.utm : {};
  const referrerHost = refHost(event.ref);
  const pageHost = hostOf(request.headers.get("origin") || "");
  const engagement = type === "engagement";

  return {
    project_id: projectId,
    type,
    name: type === "pageview" || engagement ? null : text(event.name, 120) || null,
    path: text(event.path || "/", 500) || "/",
    referrer_host: referrerHost,
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
    channel: channelFor(referrerHost, utm, pageHost),
    scroll_pct: engagement ? clampInt(event.scroll, 0, 100) : null,
    engaged_ms: engagement ? clampInt(event.ms, 0, 1_800_000) : null,
    ts: timestamp.toISOString()
  };
}

// ---------------------------------------------------------------------------
// Ingest
// ---------------------------------------------------------------------------

const registryCache = new WeakMap();

async function projectRegistry(env, expectedId = "") {
  const cached = registryCache.get(env.DB);
  const age = cached ? Date.now() - cached.at : Infinity;
  // Reuse the registry for a minute, but re-read sooner when a newly registered project shows up.
  if (cached && (age < 60_000) && (!expectedId || cached.projects.has(expectedId) || age < 5_000)) return cached.projects;
  const list = await queryAll(env.DB.prepare("SELECT id, origin FROM projects"));
  const projects = new Map(list.map((project) => [project.id, project]));
  registryCache.set(env.DB, { at: Date.now(), projects });
  return projects;
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
    if (isBot(request.headers.get("user-agent"))) return json({ ok: true, skipped: "bot" }, { headers });

    const projectId = text(event?.projectId, 80);
    const registry = await projectRegistry(env, projectId);
    if (registry.size && PROJECT_ID.test(projectId)) {
      const project = registry.get(projectId);
      if (!project) throw new Error("Unknown project");
      const origin = hostOf(request.headers.get("origin") || "");
      const registered = hostOf(project.origin || "");
      if (env.STRICT_ORIGIN === "1" && origin && registered && !sameSite(origin, registered)) {
        throw new Error("Origin does not match the project");
      }
    }

    const row = await rowFromEvent(event, request, env.SALT, new Date());
    await env.DB.prepare(`
      INSERT INTO events (
        project_id, type, name, path, referrer_host,
        utm_source, utm_medium, utm_campaign,
        country, device, browser, os, visitor_hash,
        screen_bucket, lang, props, channel, scroll_pct, engaged_ms, ts
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      row.project_id, row.type, row.name, row.path, row.referrer_host,
      row.utm_source, row.utm_medium, row.utm_campaign,
      row.country, row.device, row.browser, row.os, row.visitor_hash,
      row.screen_bucket, row.lang, row.props, row.channel, row.scroll_pct, row.engaged_ms, row.ts
    ).run();
    return json({ ok: true }, { status: 200, headers });
  } catch (error) {
    return json({ ok: false, error: errorMessage(error) }, { status: 200, headers });
  }
}

// ---------------------------------------------------------------------------
// Aggregation: one SQL statement per range, shared by the API and the nightly rollup
// ---------------------------------------------------------------------------

const BREAKDOWN_KEYS = {
  country: (a) => `COALESCE(NULLIF(${a}country, ''), 'XX')`,
  page: (a) => `COALESCE(NULLIF(${a}path, ''), '/')`,
  referrer: (a) => `COALESCE(NULLIF(${a}referrer_host, ''), '(direct)')`,
  source: (a) => `COALESCE(NULLIF(${a}utm_source, ''), '(none)')`,
  medium: (a) => `COALESCE(NULLIF(${a}utm_medium, ''), '(none)')`,
  campaign: (a) => `COALESCE(NULLIF(${a}utm_campaign, ''), '(none)')`,
  device: (a) => `COALESCE(NULLIF(${a}device, ''), '(unknown)')`,
  browser: (a) => `COALESCE(NULLIF(${a}browser, ''), '(unknown)')`,
  os: (a) => `COALESCE(NULLIF(${a}os, ''), '(unknown)')`,
  lang: (a) => `COALESCE(NULLIF(${a}lang, ''), '(unknown)')`,
  channel: (a) => `COALESCE(${a}channel, CASE WHEN COALESCE(${a}referrer_host, '') = '' THEN 'Direct' ELSE 'Referral' END)`
};
export const FILTER_DIMS = [...Object.keys(BREAKDOWN_KEYS), "cta", "event"];
const ALL_DIMS = [
  "total", "day", "sessions", "cta_total", ...Object.keys(BREAKDOWN_KEYS),
  "cta", "event", "eventprop", "outbound", "entry", "exit", "scroll", "time", "vital"
];
const NOT_INTERNAL = (a) => `COALESCE(${a}channel, '') <> 'Internal'`;
const ACTION = `(type IN ('cta', 'outbound') OR (type = 'custom' AND COALESCE(name, '') NOT IN ('web-vital', '${TEST_EVENT}')))`;

export function parseFilters(url) {
  const filters = [];
  for (const raw of url.searchParams.getAll("filter").slice(0, 5)) {
    const index = raw.indexOf(":");
    if (index < 1) continue;
    const dim = raw.slice(0, index);
    const value = text(raw.slice(index + 1), 500);
    if (FILTER_DIMS.includes(dim) && value) filters.push({ dim, value });
  }
  return filters;
}

function filterClause(filters, alias = "") {
  const clauses = [];
  const params = [];
  for (const { dim, value } of filters) {
    params.push(value);
    const slot = `?${3 + params.length}`;
    if (dim === "cta" || dim === "event") {
      const type = dim === "cta" ? "cta" : "custom";
      clauses.push(`${alias}visitor_hash IN (SELECT visitor_hash FROM events WHERE project_id = ?1 AND ts >= ?2 AND ts < ?3 AND type = '${type}' AND name = ${slot})`);
    } else {
      clauses.push(`${BREAKDOWN_KEYS[dim](alias)} = ${slot}`);
    }
  }
  return { sql: clauses.map((clause) => ` AND ${clause}`).join(""), params };
}

/**
 * Builds one UNION ALL statement returning (dim, key, events, visitors) rows for a project
 * and time range. Parameters: ?1 project, ?2 from (inclusive ISO), ?3 to (exclusive ISO),
 * then one per filter.
 */
export function aggregateSql(filters = [], dims = ALL_DIMS) {
  const plain = filterClause(filters);
  const aliased = filterClause(filters, "e.");
  const where = `project_id = ?1 AND ts >= ?2 AND ts < ?3${plain.sql}`;
  const pv = `${where} AND type = 'pageview'`;
  const visitors = "COUNT(DISTINCT visitor_hash)";
  const branch = {
    total: `SELECT 'total' AS dim, '' AS key, COUNT(*) AS events, ${visitors} AS visitors FROM events WHERE ${pv}`,
    day: `SELECT 'day', substr(ts, 1, 10), COUNT(*), ${visitors} FROM events WHERE ${pv} GROUP BY substr(ts, 1, 10)`,
    sessions: `SELECT 'sessions', '', COUNT(*), COALESCE(SUM(CASE WHEN views > 1 OR actions > 0 OR engaged >= 10000 THEN 1 ELSE 0 END), 0)
      FROM (SELECT SUM(type = 'pageview') AS views, SUM(${ACTION}) AS actions, SUM(COALESCE(engaged_ms, 0)) AS engaged
              FROM events WHERE ${where} GROUP BY visitor_hash, unixepoch(ts) / ${SESSION_SECONDS}) WHERE views > 0`,
    cta_total: `SELECT 'cta_total', '', COUNT(*), ${visitors} FROM events WHERE ${where} AND type = 'cta'`,
    cta: `SELECT 'cta', COALESCE(name, '(unnamed)'), COUNT(*), ${visitors} FROM events WHERE ${where} AND type = 'cta' GROUP BY 2`,
    event: `SELECT 'event', name, COUNT(*), ${visitors} FROM events WHERE ${where} AND type = 'custom' AND COALESCE(name, '') NOT IN ('', 'web-vital', '${TEST_EVENT}') GROUP BY 2`,
    eventprop: `SELECT 'eventprop', e.name || ' · ' || j.key || ': ' || CAST(j.value AS TEXT), COUNT(*), COUNT(DISTINCT e.visitor_hash)
      FROM events e, json_each(CASE WHEN json_valid(e.props) THEN e.props ELSE '{}' END) j
      WHERE e.project_id = ?1 AND e.ts >= ?2 AND e.ts < ?3${aliased.sql} AND e.type = 'custom'
        AND COALESCE(e.name, '') NOT IN ('', 'web-vital', '${TEST_EVENT}') GROUP BY 2`,
    outbound: `SELECT 'outbound', COALESCE(name, '(unknown)'), COUNT(*), ${visitors} FROM events WHERE ${where} AND type = 'outbound' GROUP BY 2`,
    entry: `SELECT 'entry', p, COUNT(*), COUNT(*) FROM (
      SELECT COALESCE(NULLIF(path, ''), '/') AS p, ROW_NUMBER() OVER (PARTITION BY visitor_hash, unixepoch(ts) / ${SESSION_SECONDS} ORDER BY ts, id) AS n
        FROM events WHERE ${pv}) WHERE n = 1 GROUP BY p`,
    exit: `SELECT 'exit', p, COUNT(*), COUNT(*) FROM (
      SELECT COALESCE(NULLIF(path, ''), '/') AS p, ROW_NUMBER() OVER (PARTITION BY visitor_hash, unixepoch(ts) / ${SESSION_SECONDS} ORDER BY ts DESC, id DESC) AS n
        FROM events WHERE ${pv}) WHERE n = 1 GROUP BY p`,
    scroll: `SELECT 'scroll', COALESCE(NULLIF(path, ''), '/'), SUM(scroll_pct), COUNT(*) FROM events WHERE ${where} AND type = 'engagement' AND scroll_pct IS NOT NULL GROUP BY 2`,
    time: `SELECT 'time', COALESCE(NULLIF(path, ''), '/'), SUM(COALESCE(engaged_ms, 0)), COUNT(*) FROM events WHERE ${where} AND type = 'engagement' GROUP BY 2`,
    vital: `SELECT 'vital', metric || ':' || bucket, COUNT(*), 0 FROM (
      SELECT json_extract(props, '$.metric') AS metric,
             CASE WHEN json_extract(props, '$.metric') = 'CLS'
                  THEN printf('%.2f', CAST(json_extract(props, '$.value') * 100 AS INTEGER) / 100.0)
                  ELSE CAST(CAST(json_extract(props, '$.value') / 100 AS INTEGER) * 100 AS TEXT) END AS bucket
        FROM events WHERE ${where} AND type = 'custom' AND name = 'web-vital' AND json_valid(props))
      WHERE metric IN ('LCP', 'INP', 'CLS') GROUP BY 2`
  };
  for (const [dim, keyOf] of Object.entries(BREAKDOWN_KEYS)) {
    const external = dim === "referrer" || dim === "channel" ? ` AND ${NOT_INTERNAL("")}`
      : dim === "source" || dim === "medium" || dim === "campaign" ? ` AND COALESCE(utm_${dim}, '') <> ''` : "";
    branch[dim] = `SELECT '${dim}', ${keyOf("")}, COUNT(*), ${visitors} FROM events WHERE ${pv}${external} GROUP BY 2`;
  }
  const sql = dims.filter((dim) => branch[dim]).map((dim) => branch[dim]).join("\nUNION ALL\n");
  return { sql, params: plain.params };
}

async function aggregateRaw(env, projectId, fromIso, toIso, filters = [], dims = ALL_DIMS) {
  const { sql, params } = aggregateSql(filters, dims);
  return queryAll(env.DB.prepare(sql).bind(projectId, fromIso, toIso, ...params));
}

async function readDaily(env, projectId, fromDay, toDay, dims = null) {
  const dimClause = dims ? ` AND dim IN (${dims.map((dim) => `'${dim}'`).join(", ")})` : "";
  return queryAll(env.DB.prepare(`
    SELECT dim, key, SUM(events) AS events, SUM(visitors) AS visitors
      FROM daily
     WHERE project_id = ?1 AND day >= ?2 AND day <= ?3${dimClause}
     GROUP BY dim, key
  `).bind(projectId, fromDay, toDay));
}

async function rolledUntil(env, projectId) {
  try {
    return (await env.DB.prepare("SELECT rolled_until FROM rollup_state WHERE project_id = ?1")
      .bind(projectId).first("rolled_until")) || null;
  } catch {
    return null;
  }
}

/** Unfiltered ranges read summarised days from `daily` and only the rest from raw events. */
async function collectRange(env, projectId, range, filters = [], dims = ALL_DIMS) {
  const collected = [];
  let rawFrom = range.fromDay;
  const rolled = filters.length ? null : await rolledUntil(env, projectId);
  if (rolled && rolled >= range.fromDay) {
    const end = rolled < range.toDay ? rolled : range.toDay;
    collected.push(...await readDaily(env, projectId, range.fromDay, end, dims === ALL_DIMS ? null : dims));
    rawFrom = addDays(end, 1);
  }
  if (rawFrom <= range.toDay) {
    collected.push(...await aggregateRaw(env, projectId, dayStart(rawFrom), dayStart(addDays(range.toDay, 1)), filters, dims));
  }
  return collected;
}

function groupRows(list) {
  const groups = new Map();
  for (const row of list) {
    if (!groups.has(row.dim)) groups.set(row.dim, new Map());
    const group = groups.get(row.dim);
    const key = row.key == null ? "" : String(row.key);
    const item = group.get(key) || { events: 0, visitors: 0 };
    item.events += number(row.events);
    item.visitors += number(row.visitors);
    group.set(key, item);
  }
  return groups;
}

function listOf(groups, dim, limit = 50) {
  return [...(groups.get(dim) || new Map())]
    .map(([name, value]) => ({ name, events: value.events, visitors: value.visitors }))
    .sort((a, b) => b.visitors - a.visitors || b.events - a.events || a.name.localeCompare(b.name))
    .slice(0, limit);
}

function p75(groups, metric) {
  const buckets = [...(groups.get("vital") || new Map())]
    .filter(([key]) => key.startsWith(`${metric}:`))
    .map(([key, value]) => ({ bucket: Number(key.slice(metric.length + 1)), count: value.events }))
    .sort((a, b) => a.bucket - b.bucket);
  const samples = buckets.reduce((sum, item) => sum + item.count, 0);
  if (!samples) return null;
  let seen = 0;
  const width = metric === "CLS" ? 0.01 : 100;
  for (const item of buckets) {
    seen += item.count;
    if (seen >= samples * 0.75) {
      const value = item.bucket + width / 2;
      return { p75: metric === "CLS" ? Math.round(value * 1000) / 1000 : Math.round(value), samples };
    }
  }
  return null;
}

export function shapeRollup(list) {
  const groups = groupRows(list);
  const one = (dim) => (groups.get(dim) || new Map()).get("") || { events: 0, visitors: 0 };
  const total = one("total");
  const sessions = one("sessions");
  const ctas = one("cta_total");
  const scroll = [...(groups.get("scroll") || new Map()).values()].reduce((sum, item) => ({ events: sum.events + item.events, visitors: sum.visitors + item.visitors }), { events: 0, visitors: 0 });
  const time = [...(groups.get("time") || new Map()).values()].reduce((sum, item) => sum + item.events, 0);
  const pageviews = total.events;
  const uniques = total.visitors;
  const conversionRate = uniques ? ctas.visitors / uniques : 0;
  const engagedRate = sessions.events ? sessions.visitors / sessions.events : 0;

  const scrollByPath = groups.get("scroll") || new Map();
  const timeByPath = groups.get("time") || new Map();
  const byPath = listOf(groups, "page").map((item) => {
    const s = scrollByPath.get(item.name);
    const t = timeByPath.get(item.name);
    return {
      ...item,
      scroll: s && s.visitors ? Math.round(s.events / s.visitors) : null,
      timeMs: t && item.events ? Math.round(t.events / item.events) : null
    };
  });

  return {
    totals: {
      pageviews,
      uniques,
      sessions: sessions.events,
      bounceRate: sessions.events ? 1 - engagedRate : 0,
      engagedRate,
      pagesPerSession: sessions.events ? pageviews / sessions.events : 0,
      conversionRate,
      ctaClicks: ctas.events,
      avgScroll: scroll.visitors ? Math.round(scroll.events / scroll.visitors) : null,
      avgTimeMs: pageviews && time ? Math.round(time / pageviews) : null
    },
    goal: { name: "Pageview → CTA", visitors: uniques, convertedVisitors: ctas.visitors, conversionRate },
    byDay: [...(groups.get("day") || new Map())]
      .map(([date, value]) => ({ date, pv: value.events, uv: value.visitors }))
      .sort((a, b) => a.date.localeCompare(b.date)),
    byCountry: listOf(groups, "country"),
    byPath,
    byReferrer: listOf(groups, "referrer"),
    bySource: listOf(groups, "source"),
    byMedium: listOf(groups, "medium"),
    byCampaign: listOf(groups, "campaign"),
    byChannel: listOf(groups, "channel"),
    byDevice: listOf(groups, "device"),
    byBrowser: listOf(groups, "browser"),
    byOS: listOf(groups, "os"),
    byLanguage: listOf(groups, "lang"),
    byCta: listOf(groups, "cta").map((item) => ({ ...item, conversionRate: uniques ? item.visitors / uniques : 0 })),
    byEvent: listOf(groups, "event").map((item) => ({ ...item, conversionRate: uniques ? item.visitors / uniques : 0 })),
    byEventProps: listOf(groups, "eventprop"),
    topOutbound: listOf(groups, "outbound"),
    entryPages: listOf(groups, "entry"),
    exitPages: listOf(groups, "exit"),
    vitals: { LCP: p75(groups, "LCP"), INP: p75(groups, "INP"), CLS: p75(groups, "CLS") }
  };
}

// ---------------------------------------------------------------------------
// Read API
// ---------------------------------------------------------------------------

export function dateRange(url, now = new Date()) {
  const today = utcDay(now);
  const fromValue = url.searchParams.get("from");
  const toValue = url.searchParams.get("to");
  const valid = (value) => value && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value));
  const toDay = valid(toValue) ? toValue : today;
  const fromDay = valid(fromValue) ? fromValue : addDays(toDay, -29);
  if (fromDay > toDay) throw new Error("Invalid date range");
  const days = Math.round((Date.parse(toDay) - Date.parse(fromDay)) / DAY_MS) + 1;
  if (days > 3700) throw new Error("Date range is too long");
  return {
    fromDay,
    toDay,
    days,
    from: dayStart(fromDay),
    to: dayStart(addDays(toDay, 1))
  };
}

function previousRange(range) {
  const toDay = addDays(range.fromDay, -1);
  const fromDay = addDays(toDay, -(range.days - 1));
  return { fromDay, toDay, days: range.days, from: dayStart(fromDay), to: dayStart(addDays(toDay, 1)) };
}

function projectIdFrom(url, required = true) {
  const id = text(url.searchParams.get("projectId"), 80);
  if (required && !PROJECT_ID.test(id)) throw new Error("A valid projectId is required");
  if (id && !PROJECT_ID.test(id)) throw new Error("Invalid projectId");
  return id;
}

async function realtimeFor(env, projectId, now = new Date()) {
  const cutoff = new Date(now.valueOf() - REALTIME_MS).toISOString();
  return number(await env.DB.prepare(`
    SELECT COUNT(DISTINCT visitor_hash) AS realtime FROM events WHERE project_id = ?1 AND ts >= ?2
  `).bind(projectId, cutoff).first("realtime"));
}

async function lastEventAt(env, projectId) {
  return (await env.DB.prepare("SELECT MAX(ts) AS ts FROM events WHERE project_id = ?1")
    .bind(projectId).first("ts")) || null;
}

export async function getRollup(env, url, now = new Date()) {
  const projectId = projectIdFrom(url);
  const range = dateRange(url, now);
  const filters = parseFilters(url);
  const compare = url.searchParams.get("compare") === "1";
  const [current, realtime, previous] = await Promise.all([
    collectRange(env, projectId, range, filters),
    realtimeFor(env, projectId, now),
    compare
      ? collectRange(env, projectId, previousRange(range), filters, ["total", "day", "sessions", "cta_total"])
      : Promise.resolve(null)
  ]);
  const shaped = shapeRollup(current);
  const result = {
    projectId,
    range: { from: range.fromDay, to: range.toDay },
    filters,
    ...shaped,
    totals: { ...shaped.totals, realtime }
  };
  if (previous) {
    const before = previousRange(range);
    const prior = shapeRollup(previous);
    result.previous = { range: { from: before.fromDay, to: before.toDay }, totals: prior.totals, byDay: prior.byDay };
  }
  return result;
}

export async function getProjects(env) {
  const registered = await queryAll(env.DB.prepare("SELECT id, name, origin FROM projects ORDER BY name COLLATE NOCASE, id"));
  if (registered.length) return registered;
  // Bootstrap only: nothing registered yet, so list whatever has sent events.
  return queryAll(env.DB.prepare(`
    SELECT DISTINCT project_id AS id, project_id AS name, NULL AS origin FROM events ORDER BY id
  `));
}

const OVERVIEW_DIMS = ["total", "day", "sessions", "cta_total", "channel"];

export async function getOverview(env, url, now = new Date()) {
  const range = dateRange(url, now);
  const compare = url.searchParams.get("compare") === "1";
  const projects = await getProjects(env);
  const items = await Promise.all(projects.map(async (project) => {
    const [current, realtime, last, previous] = await Promise.all([
      collectRange(env, project.id, range, [], OVERVIEW_DIMS),
      realtimeFor(env, project.id, now),
      lastEventAt(env, project.id),
      compare ? collectRange(env, project.id, previousRange(range), [], ["total", "cta_total"]) : Promise.resolve(null)
    ]);
    const shaped = shapeRollup(current);
    const item = {
      projectId: project.id,
      name: project.name,
      origin: project.origin,
      pageviews: shaped.totals.pageviews,
      uniques: shaped.totals.uniques,
      sessions: shaped.totals.sessions,
      engagedRate: shaped.totals.engagedRate,
      conversionRate: shaped.totals.conversionRate,
      realtime,
      lastEventAt: last,
      byDay: shaped.byDay,
      byChannel: shaped.byChannel
    };
    if (previous) {
      const prior = shapeRollup(previous).totals;
      item.previous = { pageviews: prior.pageviews, uniques: prior.uniques, conversionRate: prior.conversionRate };
    }
    return item;
  }));
  return items.sort((a, b) => b.uniques - a.uniques || b.pageviews - a.pageviews || String(a.name).localeCompare(String(b.name)));
}

export async function getStatus(env, url) {
  const projectId = projectIdFrom(url);
  const project = await env.DB.prepare("SELECT id, name, origin FROM projects WHERE id = ?1").bind(projectId).first();
  const recent = await queryAll(env.DB.prepare(`
    SELECT type, name, path, country, ts FROM events WHERE project_id = ?1 ORDER BY ts DESC LIMIT 200
  `).bind(projectId));
  const count = (predicate) => recent.filter(predicate).length;
  return {
    projectId,
    registered: Boolean(project),
    project: project || null,
    lastEventAt: recent[0]?.ts || null,
    received: {
      pageview: count((event) => event.type === "pageview"),
      cta: count((event) => event.type === "cta"),
      outbound: count((event) => event.type === "outbound"),
      custom: count((event) => event.type === "custom" && event.name !== TEST_EVENT),
      engagement: count((event) => event.type === "engagement"),
      test: count((event) => event.type === "custom" && event.name === TEST_EVENT)
    },
    recent: recent.slice(0, 8)
  };
}

function csvCell(value) {
  const string = value == null ? "" : String(value);
  return /[",\r\n]/.test(string) ? `"${string.replaceAll('"', '""')}"` : string;
}

export async function getExport(env, url, now = new Date()) {
  const projectId = projectIdFrom(url, false);
  const range = dateRange(url, now);
  const columns = [
    "project_id", "type", "name", "path", "referrer_host", "channel",
    "utm_source", "utm_medium", "utm_campaign", "country",
    "device", "browser", "os", "screen_bucket", "lang", "props", "scroll_pct", "engaged_ms", "ts"
  ];
  const ids = projectId ? [projectId] : (await getProjects(env)).map((project) => project.id);
  const statement = env.DB.prepare(`
    SELECT ${columns.join(", ")} FROM events
     WHERE project_id = ?1 AND ts >= ?2 AND ts < ?3
     ORDER BY ts ASC, id ASC
  `);
  const data = [];
  for (const id of ids) data.push(...await queryAll(statement.bind(id, range.from, range.to)));
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

// ---------------------------------------------------------------------------
// Nightly maintenance: daily rollups and optional retention
// ---------------------------------------------------------------------------

export async function rollupDay(env, projectId, day) {
  const { sql } = aggregateSql([], ALL_DIMS);
  await env.DB.batch([
    env.DB.prepare("DELETE FROM daily WHERE project_id = ?1 AND day = ?2").bind(projectId, day),
    env.DB.prepare(`
      INSERT INTO daily (project_id, day, dim, key, events, visitors)
      SELECT ?1, ?4, dim, COALESCE(key, ''), COALESCE(events, 0), COALESCE(visitors, 0) FROM (${sql})
    `).bind(projectId, dayStart(day), dayStart(addDays(day, 1)), day),
    env.DB.prepare(`
      INSERT INTO rollup_state (project_id, rolled_until) VALUES (?1, ?2)
      ON CONFLICT(project_id) DO UPDATE SET rolled_until = excluded.rolled_until
    `).bind(projectId, day)
  ]);
}

export async function runMaintenance(env, now = new Date(), maxDays = 60) {
  const yesterday = addDays(utcDay(now), -1);
  const projects = await getProjects(env);
  const report = [];
  for (const project of projects) {
    const state = await rolledUntil(env, project.id);
    let start = state ? addDays(state, 1) : null;
    if (!start) {
      const first = await env.DB.prepare("SELECT MIN(ts) AS ts FROM events WHERE project_id = ?1").bind(project.id).first("ts");
      start = first ? String(first).slice(0, 10) : null;
    }
    let rolled = 0;
    for (let day = start; day && day <= yesterday && rolled < maxDays; day = addDays(day, 1)) {
      await rollupDay(env, project.id, day);
      rolled += 1;
    }
    let deleted = 0;
    const keepDays = Number.parseInt(env.RETENTION_DAYS || "", 10);
    const until = await rolledUntil(env, project.id);
    if (keepDays > 0 && until) {
      const retentionCut = addDays(utcDay(now), -keepDays);
      const safeCut = addDays(until, 1);
      const cut = retentionCut < safeCut ? retentionCut : safeCut;
      const result = await env.DB.prepare("DELETE FROM events WHERE project_id = ?1 AND ts < ?2").bind(project.id, dayStart(cut)).run();
      deleted = number(result?.meta?.changes);
    }
    report.push({ projectId: project.id, rolledDays: rolled, rolledUntil: until, deletedEvents: deleted });
  }
  return report;
}

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

async function handleApi(request, env, url) {
  try {
    if (!env.DB) throw new Error("Database binding is missing");
    if (request.method === "POST" && url.pathname === "/api/maintenance") return json({ ok: true, projects: await runMaintenance(env) });
    if (request.method !== "GET") return json({ error: "Method not allowed" }, { status: 405 });
    if (url.pathname === "/api/projects") return json(await getProjects(env));
    if (url.pathname === "/api/overview") return json(await getOverview(env, url));
    if (url.pathname === "/api/rollup") return json(await getRollup(env, url));
    if (url.pathname === "/api/status") return json(await getStatus(env, url));
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
  if (request.method === "GET" && url.pathname === "/perch.js") {
    return new Response(trackerJs, {
      headers: {
        "content-type": "text/javascript; charset=utf-8",
        "cache-control": "public, max-age=3600",
        "access-control-allow-origin": "*",
        "x-content-type-options": "nosniff"
      }
    });
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
  if (url.pathname.startsWith("/api/")) {
    return handleApi(request, env, url);
  }
  return json({ error: "Not found" }, { status: 404 });
}

export default {
  fetch: route,
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(runMaintenance(env));
  }
};
