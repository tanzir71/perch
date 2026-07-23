import assert from "node:assert/strict";
import test from "node:test";
import worker, {
  bucketScreen,
  hashVisitor,
  parseUA,
  refHost,
  rowFromEvent
} from "../worker/worker.js";

test("hashVisitor is deterministic and rotates each UTC day", async () => {
  const a = await hashVisitor("203.0.113.1", "Browser", "2026-07-22T23:59:00Z", "salt");
  const b = await hashVisitor("203.0.113.1", "Browser", "2026-07-22T01:00:00Z", "salt");
  const c = await hashVisitor("203.0.113.1", "Browser", "2026-07-23T00:00:00Z", "salt");
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.match(a, /^[a-f0-9]{64}$/);
});

test("parseUA classifies representative browsers, systems, and devices", () => {
  const fixtures = [
    [
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0 Safari/537.36 Edg/126.0",
      { browser: "Edge", os: "Windows", device: "Desktop" }
    ],
    [
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 Version/17.5 Mobile/15E148 Safari/604.1",
      { browser: "Safari", os: "iOS", device: "Mobile" }
    ],
    [
      "Mozilla/5.0 (Android 14; SM-T970) AppleWebKit/537.36 Chrome/125.0 Safari/537.36",
      { browser: "Chrome", os: "Android", device: "Tablet" }
    ],
    [
      "Mozilla/5.0 (X11; Linux x86_64; rv:127.0) Gecko/20100101 Firefox/127.0",
      { browser: "Firefox", os: "Linux", device: "Desktop" }
    ]
  ];
  for (const [ua, expected] of fixtures) assert.deepEqual(parseUA(ua), expected);
});

test("refHost and bucketScreen normalize inputs", () => {
  assert.equal(refHost("https://News.Example.com/story?q=1"), "news.example.com");
  assert.equal(refHost("not a URL"), "");
  assert.equal(bucketScreen(390), "mobile");
  assert.equal(bucketScreen(800), "tablet");
  assert.equal(bucketScreen(1280), "desktop");
  assert.equal(bucketScreen(1600), "wide");
});

test("rowFromEvent derives coarse server-side fields without retaining an IP", async () => {
  const request = new Request("https://perch.example/collect", {
    method: "POST",
    headers: {
      "user-agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) Version/17.5 Mobile Safari/604.1",
      "cf-connecting-ip": "203.0.113.8"
    }
  });
  Object.defineProperty(request, "cf", { value: { country: "bd" } });
  const row = await rowFromEvent({
    type: "pageview",
    projectId: "my-project",
    path: "/pricing",
    ref: "https://search.example/result",
    screen: 390,
    lang: "en-US"
  }, request, "secret", new Date("2026-07-23T10:00:00Z"));
  assert.equal(row.country, "BD");
  assert.equal(row.device, "Mobile");
  assert.equal(row.referrer_host, "search.example");
  assert.equal(row.project_id, "my-project");
  assert.equal(Object.hasOwn(row, "ip"), false);
  assert.match(row.visitor_hash, /^[a-f0-9]{64}$/);
});

test("POST /collect inserts one normalized row and returns CORS", async () => {
  const calls = [];
  const env = {
    SALT: "test-salt",
    DB: {
      prepare(sql) {
        return {
          bind(...values) {
            return {
              async run() {
                calls.push({ sql, values });
                return { success: true };
              }
            };
          }
        };
      }
    }
  };
  const response = await worker.fetch(new Request("https://perch.example/collect", {
    method: "POST",
    headers: {
      origin: "https://site.example",
      "content-type": "text/plain",
      "cf-connecting-ip": "203.0.113.9",
      "user-agent": "Mozilla/5.0 (Windows NT 10.0) Chrome/126.0"
    },
    body: JSON.stringify({
      type: "cta",
      name: "signup-hero",
      path: "/",
      projectId: "site-one"
    })
  }), env);
  assert.deepEqual(await response.json(), { ok: true });
  assert.equal(response.headers.get("access-control-allow-origin"), "https://site.example");
  assert.equal(calls.length, 1);
  assert.match(calls[0].sql, /INSERT INTO events/);
  assert.equal(calls[0].values[0], "site-one");
  assert.equal(calls[0].values[1], "cta");

  const preflight = await worker.fetch(new Request("https://perch.example/collect", {
    method: "OPTIONS",
    headers: { origin: "https://site.example" }
  }), env);
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get("access-control-allow-origin"), "https://site.example");
  assert.match(preflight.headers.get("access-control-allow-methods"), /POST/);
});

test("malformed and invalid beacons fail closed without throwing", async () => {
  const env = {
    SALT: "test-salt",
    DB: {
      prepare() {
        throw new Error("must not insert");
      }
    }
  };
  const malformed = await worker.fetch(new Request("https://perch.example/collect", {
    method: "POST",
    body: "{"
  }), env);
  assert.equal(malformed.status, 200);
  assert.deepEqual(await malformed.json(), { ok: false, error: "Malformed JSON" });

  const invalid = await worker.fetch(new Request("https://perch.example/collect", {
    method: "POST",
    body: JSON.stringify({ type: "unknown", projectId: "bad id" })
  }), env);
  assert.equal((await invalid.json()).ok, false);
});
