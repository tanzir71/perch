import { readFile } from "node:fs/promises";
import { gzipSync } from "node:zlib";

const source = await readFile(new URL("../src/perch.min.js", import.meta.url));
const bytes = gzipSync(source, { level: 9 }).byteLength;
const limit = 3 * 1024;

console.log(`perch.min.js: ${bytes} bytes gzipped (limit ${limit})`);
if (bytes >= limit) {
  process.exitCode = 1;
}
