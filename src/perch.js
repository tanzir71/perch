(function () {
  "use strict";

  try {
    var script = document.currentScript;
    if (!script) {
      var scripts = document.getElementsByTagName("script");
      script = scripts[scripts.length - 1];
    }

    var endpoint = script && script.getAttribute("data-endpoint");
    var projectId = script && script.getAttribute("data-project-id");
    if (!endpoint || !projectId) return;

    var enabled = true;
    var respectDnt = script.hasAttribute("data-respect-dnt");
    var skipBots = script.hasAttribute("data-skip-bots");
    var noOutbound = script.hasAttribute("data-no-outbound");
    var perfEnabled = script.hasAttribute("data-perf");
    var agent = navigator.userAgent || "";

    if (respectDnt && (navigator.doNotTrack === "1" || window.doNotTrack === "1")) enabled = false;
    if (skipBots && /bot|crawl|spider|headless|slurp|preview/i.test(agent)) enabled = false;

    function clean(value, limit) {
      return String(value == null ? "" : value).slice(0, limit || 300);
    }

    function safeProps(input) {
      if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
      var output = {};
      Object.keys(input).slice(0, 20).forEach(function (key) {
        if (/email|e-mail|phone|mobile|address|password|secret|token|full.?name/i.test(key)) return;
        var value = input[key];
        if (value == null || typeof value === "boolean" || typeof value === "number") {
          output[clean(key, 60)] = value;
        } else if (typeof value === "string") {
          output[clean(key, 60)] = clean(value, 200);
        }
      });
      return Object.keys(output).length ? output : undefined;
    }

    function utmValues() {
      try {
        var params = new URLSearchParams(location.search);
        var utm = {};
        ["source", "medium", "campaign"].forEach(function (key) {
          var value = params.get("utm_" + key);
          if (value) utm[key] = clean(value, 120);
        });
        return Object.keys(utm).length ? utm : undefined;
      } catch (_) {
        return undefined;
      }
    }

    function basePayload() {
      var payload = {
        path: clean(location.pathname || "/", 500),
        ref: clean(document.referrer || "", 1000),
        screen: Number(window.innerWidth || (screen && screen.width) || 0),
        lang: clean(navigator.language || "", 30),
        ts: new Date().toISOString(),
        projectId: clean(projectId, 80)
      };
      try {
        payload.tz = clean(Intl.DateTimeFormat().resolvedOptions().timeZone || "", 80);
      } catch (_) {}
      var utm = utmValues();
      if (utm) payload.utm = utm;
      return payload;
    }

    function transmit(payload) {
      if (!enabled) return;
      try {
        var body = JSON.stringify(payload);
        var sent = false;
        if (typeof navigator.sendBeacon === "function") {
          try {
            sent = navigator.sendBeacon(endpoint, new Blob([body], { type: "text/plain;charset=UTF-8" }));
          } catch (_) {}
        }
        if (!sent && typeof fetch === "function") {
          try {
            fetch(endpoint, {
              method: "POST",
              headers: { "content-type": "text/plain;charset=UTF-8" },
              body: body,
              keepalive: true,
              mode: "cors",
              credentials: "omit"
            }).catch(function () {});
          } catch (_) {}
        }
      } catch (_) {}
    }

    function emit(type, name, props) {
      try {
        var payload = basePayload();
        payload.type = type;
        if (name) payload.name = clean(name, 120);
        var filtered = safeProps(props);
        if (filtered) payload.props = filtered;
        transmit(payload);
      } catch (_) {}
    }

    function track(typeOrName, props) {
      try {
        var known = /^(pageview|cta|outbound|custom)$/;
        if (known.test(typeOrName)) {
          emit(typeOrName, props && props.name, typeOrName === "custom" ? props && props.props : undefined);
        } else if (typeof typeOrName === "string" && typeOrName) {
          emit("custom", typeOrName, props);
        }
      } catch (_) {}
    }

    window.perch = window.perch || {};
    window.perch.track = track;

    if (enabled) {
      try {
        var pageKey = "perch:pageview:" + projectId;
        if (!sessionStorage.getItem(pageKey)) {
          sessionStorage.setItem(pageKey, "1");
          emit("pageview");
        }
      } catch (_) {
        emit("pageview");
      }

      document.addEventListener("click", function (event) {
        try {
          var target = event.target && event.target.closest ? event.target : null;
          if (!target) return;

          var cta = target.closest("[data-perch-cta]");
          if (cta) emit("cta", cta.getAttribute("data-perch-cta"));

          if (noOutbound) return;
          var link = target.closest("a[href]");
          if (!link || link.hasAttribute("data-perch-ignore")) return;
          var url = new URL(link.href, location.href);
          if (/^https?:$/.test(url.protocol) && url.host !== location.host) {
            emit("outbound", url.host);
          }
        } catch (_) {}
      }, true);
    }

    if (enabled && perfEnabled && typeof PerformanceObserver === "function") {
      try {
        var cls = 0;
        new PerformanceObserver(function (list) {
          list.getEntries().forEach(function (entry) {
            if (!entry.hadRecentInput) cls += entry.value;
          });
        }).observe({ type: "layout-shift", buffered: true });

        ["largest-contentful-paint", "event"].forEach(function (kind) {
          try {
            new PerformanceObserver(function (list) {
              var entries = list.getEntries();
              var last = entries[entries.length - 1];
              if (last) {
                emit("custom", "web-vital", {
                  metric: kind === "event" ? "INP" : "LCP",
                  value: Math.round(kind === "event" ? last.duration : last.startTime)
                });
              }
            }).observe({ type: kind, buffered: true, durationThreshold: 40 });
          } catch (_) {}
        });

        addEventListener("pagehide", function () {
          emit("custom", "web-vital", { metric: "CLS", value: Math.round(cls * 1000) / 1000 });
        }, { once: true });
      } catch (_) {}
    }
  } catch (_) {}
})();
