// Assembles the GitHub Pages site in dist/pages from committed files. No dependencies.
import { cp, mkdir, rm } from "node:fs/promises";

const file = (path) => new URL(`../${path}`, import.meta.url);
const out = file("dist/pages/");

await rm(out, { recursive: true, force: true });
await mkdir(file("dist/pages/dashboard/"), { recursive: true });

const copies = [
  ["site/index.html", "index.html"],
  ["site/favicon.svg", "favicon.svg"],
  ["site/og.png", "og.png"],
  ["site/llms.txt", "llms.txt"],
  ["src/perch.min.js", "perch.min.js"],
  ["src/perch.js", "perch.js"],
  ["stats/index.html", "dashboard/index.html"],
  ["stats/demo-data.js", "dashboard/demo-data.js"],
  ["site/favicon.svg", "dashboard/favicon.svg"]
];
for (const [from, to] of copies) await cp(file(from), new URL(to, out));

console.log("Built GitHub Pages artifact in dist/pages");
