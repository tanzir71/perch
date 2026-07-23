import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { JSDOM } from "jsdom";

const source = await readFile(new URL("../src/perch.js", import.meta.url), "utf8");

function trackerDom(body = "", options = {}) {
  const dom = new JSDOM(`<!doctype html><body>${body}<script
    data-endpoint="https://stats.example/collect"
    data-project-id="demo-project"
    ${options.attributes || ""}
  ></script></body>`, {
    url: options.url || "https://site.example/pricing?utm_source=launch&utm_medium=email&utm_campaign=spring",
    referrer: "https://news.example/story",
    runScripts: "outside-only"
  });
  const events = [];
  class MockBlob {
    constructor(parts, init) {
      this.body = parts.join("");
      this.type = init?.type || "";
    }
  }
  dom.window.Blob = MockBlob;
  Object.defineProperty(dom.window.navigator, "sendBeacon", {
    configurable: true,
    value: options.sendBeacon || ((_endpoint, blob) => {
      events.push(JSON.parse(blob.body));
      return true;
    })
  });
  dom.window.fetch = options.fetch || (() => Promise.resolve(new dom.window.Response()));
  dom.window.eval(source);
  return { dom, events };
}

test("sends exactly one automatic pageview per project in a tab", () => {
  const { dom, events } = trackerDom();
  dom.window.eval(source);
  assert.equal(events.filter((event) => event.type === "pageview").length, 1);
  assert.equal(events[0].projectId, "demo-project");
});

test("captures CTA, outbound, custom, and manual SPA pageview events", () => {
  const { dom, events } = trackerDom(`
    <a id="cta" href="/join" data-perch-cta="signup-hero"><span>Join</span></a>
    <a id="external" href="https://docs.example.net/start">Docs</a>
    <a id="internal" href="/inside">Inside</a>
    <a id="ignored" href="https://ignored.example" data-perch-ignore>Ignored</a>
  `);

  events.length = 0;
  dom.window.document.addEventListener("click", (event) => {
    if (event.target.closest?.("a")) event.preventDefault();
  });
  dom.window.document.querySelector("#cta span").dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }));
  dom.window.document.querySelector("#external").dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }));
  dom.window.document.querySelector("#internal").dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }));
  dom.window.document.querySelector("#ignored").dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }));
  dom.window.perch.track("newsletter_signup", { source: "footer", email: "must-not-ship@example.com" });
  dom.window.perch.track("pageview");

  assert.deepEqual(events.map(({ type, name }) => [type, name]), [
    ["cta", "signup-hero"],
    ["outbound", "docs.example.net"],
    ["custom", "newsletter_signup"],
    ["pageview", undefined]
  ]);
  assert.deepEqual(events[2].props, { source: "footer" });
});

test("parses UTM values and never sends server-derived or identity fields", () => {
  const { events } = trackerDom();
  const payload = events[0];
  assert.deepEqual(payload.utm, {
    source: "launch",
    medium: "email",
    campaign: "spring"
  });
  for (const forbidden of ["ip", "country", "visitorHash", "visitor_hash", "device"]) {
    assert.equal(Object.hasOwn(payload, forbidden), false);
  }
  assert.equal(payload.projectId, "demo-project");
  assert.equal(payload.path, "/pricing");
});

test("transport and event-handler failures never escape", () => {
  const { dom } = trackerDom(`<button data-perch-cta="safe">Safe</button>`, {
    sendBeacon() {
      throw new Error("blocked");
    },
    fetch() {
      throw new Error("blocked too");
    }
  });
  assert.doesNotThrow(() => {
    dom.window.document.querySelector("button").dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
    dom.window.perch.track("custom_action", { value: 1 });
  });
});

test("respects optional DNT and outbound controls", () => {
  const dom = new JSDOM(`<!doctype html><body>
    <a href="https://elsewhere.example">Elsewhere</a>
    <script data-endpoint="https://stats.example/collect" data-project-id="demo-project"
      data-respect-dnt data-no-outbound></script>
  </body>`, { url: "https://site.example", runScripts: "outside-only" });
  const events = [];
  Object.defineProperty(dom.window.navigator, "doNotTrack", { configurable: true, value: "1" });
  Object.defineProperty(dom.window.navigator, "sendBeacon", {
    configurable: true,
    value: (_url, blob) => {
      events.push(blob);
      return true;
    }
  });
  dom.window.eval(source);
  dom.window.document.querySelector("a").addEventListener("click", (event) => event.preventDefault());
  dom.window.document.querySelector("a").dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }));
  assert.equal(events.length, 0);
});
