import { cp, mkdir, rm } from "node:fs/promises";

const output = new URL("../dist/pages/", import.meta.url);
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
await cp(new URL("../site/index.html", import.meta.url), new URL("index.html", output));
await cp(new URL("../src/perch.min.js", import.meta.url), new URL("perch.min.js", output));

console.log("Built GitHub Pages artifact in dist/pages");
