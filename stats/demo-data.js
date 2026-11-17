// Sample data for the public demo dashboard (GitHub Pages, or any URL with ?demo).
// It answers the same requests as the Worker API, deterministically, with made-up sites.
(function () {
  "use strict";

  var DAY = 86400000;
  var PROJECTS = [
    { id: "studio-launch", name: "Studio launch", origin: "https://studio.example", base: 205, trend: 0.011, cta: 0.074, spike: 7 },
    { id: "field-notes", name: "Field notes", origin: "https://notes.example", base: 150, trend: 0.003, cta: 0.031 },
    { id: "tiny-tools", name: "Tiny tools", origin: "https://tools.example", base: 150, trend: -0.05, cta: 0.052 },
    { id: "portfolio", name: "Portfolio", origin: "https://me.example", base: 64, trend: 0.001, cta: 0.089 },
    { id: "acme", name: "Acme (client)", origin: "https://acme.example", base: 30, trend: 0.022, cta: 0.112, ai: true },
    { id: "northwind", name: "Northwind (client)", origin: "https://northwind.example", base: 0 }
  ];
  var testEvents = {};

  function hash(text) {
    var h = 2166136261;
    for (var i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 16777619); }
    return h >>> 0;
  }
  function noise(text) {
    return (hash(text) % 1000) / 1000;
  }
  function iso(ms) { return new Date(ms).toISOString().slice(0, 10); }
  function addDays(day, n) { return iso(Date.parse(day + "T00:00:00Z") + n * DAY); }
  function dayList(from, to) { var out = []; for (var d = from; d <= to; d = addDays(d, 1)) out.push(d); return out; }
  function project(id) { return PROJECTS.find(function (p) { return p.id === id; }); }

  function visitors(p, day) {
    if (!p.base) return 0;
    var today = iso(Date.now());
    var age = (Date.parse(today) - Date.parse(day)) / DAY;
    var weekday = new Date(day + "T00:00:00Z").getUTCDay();
    var week = weekday === 0 || weekday === 6 ? 0.72 : 1;
    var v = p.base * Math.max(0.2, 1 - p.trend * age / 4) * week * (0.85 + noise(p.id + day) * 0.3);
    if (p.spike && Math.round(age) === p.spike) v *= 2.6;
    if (p.spike && Math.round(age) === p.spike - 1) v *= 1.5;
    if (day === today) v *= Math.min(1, (Date.now() % DAY) / DAY + 0.15);
    return Math.max(0, Math.round(v));
  }

  function share(total, table, seed) {
    var weights = table.map(function (row) { return row[1] * (0.85 + noise(seed + row[0]) * 0.3); });
    var sum = weights.reduce(function (a, b) { return a + b; }, 0);
    return table.map(function (row, i) {
      var v = Math.round(total * weights[i] / sum);
      return { name: row[0], visitors: v, events: Math.round(v * (row[2] || 1.25)) };
    }).filter(function (row) { return row.visitors > 0; }).sort(function (a, b) { return b.visitors - a.visitors; });
  }

  function filterFactor(filters) {
    return filters.reduce(function (f, item) { return f * (0.16 + noise(item.dim + item.value) * 0.22); }, 1);
  }

  function totalsFor(p, from, to, factor) {
    var byDay = dayList(from, to).map(function (day) {
      var uv = Math.round(visitors(p, day) * factor);
      return { date: day, uv: uv, pv: Math.round(uv * (1.28 + noise(p.id + day + "pv") * 0.25)) };
    });
    var uniques = byDay.reduce(function (a, d) { return a + d.uv; }, 0);
    var pageviews = byDay.reduce(function (a, d) { return a + d.pv; }, 0);
    var sessions = Math.round(uniques * 1.07);
    var engagedRate = 0.52 + noise(p.id + from) * 0.1;
    var conversionRate = p.cta ? p.cta * (0.9 + noise(p.id + to) * 0.2) : 0;
    return {
      byDay: byDay,
      totals: {
        pageviews: pageviews, uniques: uniques, sessions: sessions,
        engagedRate: engagedRate, bounceRate: 1 - engagedRate,
        pagesPerSession: sessions ? pageviews / sessions : 0,
        conversionRate: conversionRate, ctaClicks: Math.round(uniques * conversionRate * 1.3),
        avgScroll: uniques ? 58 + Math.round(noise(p.id) * 14) : null,
        avgTimeMs: uniques ? 32000 + Math.round(noise(p.id + "t") * 25000) : null
      }
    };
  }

  function channels(p, uniques) {
    return share(uniques, [["Direct", 0.3], ["Search", 0.26], ["AI assistants", p.ai ? 0.34 : 0.17], ["Social", 0.14], ["Email", 0.07], ["Referral", 0.05], ["Campaign", 0.02]], p.id);
  }

  function rollup(params) {
    var p = project(params.get("projectId"));
    if (!p) return { error: "Unknown project" };
    var from = params.get("from"), to = params.get("to");
    var filters = params.getAll("filter").map(function (raw) { var i = raw.indexOf(":"); return { dim: raw.slice(0, i), value: raw.slice(i + 1) }; });
    var factor = filterFactor(filters);
    var current = totalsFor(p, from, to, factor);
    var u = current.totals.uniques;
    var pv = current.totals.pageviews;
    var conv = current.totals.conversionRate;
    var result = {
      projectId: p.id,
      range: { from: from, to: to },
      filters: filters,
      totals: Object.assign({}, current.totals, { realtime: u ? Math.max(1, Math.round(p.base / 16 * factor * (0.6 + noise(iso(Date.now()) + p.id) * 0.8))) : 0 }),
      byDay: current.byDay.map(function (d) { return { date: d.date, pv: d.pv, uv: d.uv }; }),
      byChannel: channels(p, u),
      byReferrer: share(u * 0.62, [["google.com", 0.32], ["chatgpt.com", p.ai ? 0.24 : 0.12], ["news.ycombinator.com", 0.12], ["perplexity.ai", 0.06], ["x.com", 0.08], ["linkedin.com", 0.07], ["claude.ai", 0.04], ["duckduckgo.com", 0.05], ["github.com", 0.04]], p.id + "ref"),
      byCampaign: share(u * 0.16, [["launch-week", 0.5], ["newsletter-nov", 0.3], ["producthunt", 0.2]], p.id + "cmp"),
      bySource: share(u * 0.16, [["newsletter", 0.45], ["producthunt", 0.25], ["twitter", 0.3]], p.id + "src"),
      byMedium: share(u * 0.16, [["email", 0.5], ["social", 0.5]], p.id + "med"),
      byPath: share(u, [["/", 0.62], ["/pricing", 0.21], ["/blog/launch", 0.18], ["/docs", 0.08], ["/changelog", 0.03]], p.id + "page").map(function (row, i) {
        return Object.assign(row, { events: Math.round(pv * [0.5, 0.2, 0.17, 0.09, 0.04][i] || 1), scroll: [71, 58, 82, 44, 39][i], timeMs: [38000, 52000, 96000, 61000, 22000][i] });
      }),
      entryPages: share(Math.round(u * 1.07), [["/", 0.7], ["/blog/launch", 0.18], ["/pricing", 0.08], ["/docs", 0.04]], p.id + "entry", 1),
      exitPages: share(Math.round(u * 1.07), [["/", 0.45], ["/pricing", 0.28], ["/blog/launch", 0.17], ["/docs", 0.1]], p.id + "exit", 1),
      byCta: share(u * conv * 1.1, [["signup-hero", 0.55], ["demo-nav", 0.25], ["pricing-footer", 0.15], ["contact-footer", 0.05]], p.id + "cta", 1.3),
      byEvent: share(u * conv * 0.3, [["newsletter_signup", 0.8], ["copy_snippet", 0.2]], p.id + "evt", 1.1),
      byEventProps: share(u * conv * 0.3, [["newsletter_signup · source: footer", 0.6], ["newsletter_signup · source: hero", 0.4]], p.id + "props", 1),
      topOutbound: share(u * 0.06, [["github.com", 0.6], ["docs.example", 0.25], ["x.com", 0.15]], p.id + "out"),
      byCountry: share(u, [["US", 0.31], ["GB", 0.1], ["DE", 0.09], ["IN", 0.09], ["BD", 0.06], ["CA", 0.06], ["FR", 0.05], ["NL", 0.04], ["BR", 0.04]], p.id + "geo"),
      byLanguage: share(u, [["en-US", 0.46], ["en-GB", 0.13], ["de-DE", 0.09], ["fr-FR", 0.05], ["bn-BD", 0.05], ["es-ES", 0.05]], p.id + "lang"),
      byDevice: share(u, [["Desktop", 0.61], ["Mobile", 0.35], ["Tablet", 0.04]], p.id + "dev"),
      byBrowser: share(u, [["Chrome", 0.58], ["Safari", 0.24], ["Firefox", 0.08], ["Edge", 0.07], ["Opera", 0.02]], p.id + "br"),
      byOS: share(u, [["Windows", 0.34], ["macOS", 0.26], ["iOS", 0.2], ["Android", 0.15], ["Linux", 0.05]], p.id + "os"),
      vitals: u ? { LCP: { p75: 1850 + Math.round(noise(p.id + "lcp") * 900), samples: Math.round(u * 0.4) }, INP: { p75: 120 + Math.round(noise(p.id + "inp") * 140), samples: Math.round(u * 0.3) }, CLS: { p75: 0.04, samples: Math.round(u * 0.4) } } : { LCP: null, INP: null, CLS: null }
    };
    result.byCta.forEach(function (row) { row.conversionRate = u ? row.visitors / u : 0; });
    result.byEvent.forEach(function (row) { row.conversionRate = u ? row.visitors / u : 0; });
    if (params.get("compare") === "1") {
      var days = dayList(from, to).length;
      var prevTo = addDays(from, -1), prevFrom = addDays(prevTo, -(days - 1));
      var prev = totalsFor(p, prevFrom, prevTo, factor);
      result.previous = { range: { from: prevFrom, to: prevTo }, totals: prev.totals, byDay: prev.byDay };
    }
    return result;
  }

  function overview(params) {
    var from = params.get("from"), to = params.get("to");
    var days = dayList(from, to).length;
    var prevTo = addDays(from, -1), prevFrom = addDays(prevTo, -(days - 1));
    return PROJECTS.map(function (p) {
      var cur = totalsFor(p, from, to, 1);
      var prev = totalsFor(p, prevFrom, prevTo, 1);
      return {
        projectId: p.id, name: p.name, origin: p.origin,
        pageviews: cur.totals.pageviews, uniques: cur.totals.uniques, sessions: cur.totals.sessions,
        engagedRate: cur.totals.engagedRate, conversionRate: cur.totals.conversionRate,
        realtime: p.base ? Math.max(1, Math.round(p.base / 16 * (0.6 + noise(iso(Date.now()) + p.id) * 0.8))) : 0,
        lastEventAt: p.base ? new Date(Date.now() - 60000 * (1 + (hash(p.id) % 9))).toISOString() : null,
        byDay: cur.byDay, byChannel: channels(p, cur.totals.uniques),
        previous: params.get("compare") === "1" ? { pageviews: prev.totals.pageviews, uniques: prev.totals.uniques, conversionRate: prev.totals.conversionRate } : undefined
      };
    }).sort(function (a, b) { return b.uniques - a.uniques; });
  }

  function status(params) {
    var p = project(params.get("projectId"));
    var live = p && p.base;
    return {
      projectId: params.get("projectId"), registered: Boolean(p), project: p ? { id: p.id, name: p.name, origin: p.origin } : null,
      lastEventAt: live ? new Date(Date.now() - 120000).toISOString() : (testEvents[params.get("projectId")] || null),
      received: { pageview: live ? 200 : 0, cta: live ? 12 : 0, outbound: live ? 4 : 0, custom: 0, engagement: live ? 150 : 0, test: testEvents[params.get("projectId")] ? 1 : 0 },
      recent: []
    };
  }

  window.PERCH_DEMO = {
    request: function (path) {
      var url = new URL(path, "https://demo.perch");
      var data;
      if (url.pathname === "/api/projects") data = PROJECTS.map(function (p) { return { id: p.id, name: p.name, origin: p.origin }; });
      else if (url.pathname === "/api/overview") data = overview(url.searchParams);
      else if (url.pathname === "/api/rollup") data = rollup(url.searchParams);
      else if (url.pathname === "/api/status") data = status(url.searchParams);
      else return Promise.reject(new Error("Not available in the demo"));
      return new Promise(function (resolve) { setTimeout(function () { resolve(JSON.parse(JSON.stringify(data))); }, 120); });
    },
    collect: function (body) {
      try { testEvents[JSON.parse(body).projectId] = new Date().toISOString(); } catch (_) {}
      return Promise.resolve({ ok: true });
    }
  };
})();
