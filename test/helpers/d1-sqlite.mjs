// A tiny D1-compatible wrapper over node:sqlite so Worker queries can be tested with no installs.
import { readdir, readFile } from "node:fs/promises";

export async function sqliteAvailable() {
  try {
    await import("node:sqlite");
    return true;
  } catch {
    return false;
  }
}

function values(args) {
  return args.map((value) => (value === undefined ? null : typeof value === "boolean" ? Number(value) : value));
}

export async function createD1() {
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(":memory:");
  const statement = (sql, args = []) => ({
    bind: (...next) => statement(sql, next),
    async all() {
      return { results: db.prepare(sql).all(...values(args)), success: true };
    },
    async first(column) {
      const row = db.prepare(sql).get(...values(args));
      if (row == null) return null;
      return column ? (row[column] ?? null) : row;
    },
    async run() {
      const result = db.prepare(sql).run(...values(args));
      return { success: true, meta: { changes: Number(result.changes) } };
    }
  });
  const d1 = {
    raw: db,
    prepare: (sql) => statement(sql),
    async batch(list) {
      db.exec("BEGIN");
      try {
        const out = [];
        for (const item of list) out.push(await item.run());
        db.exec("COMMIT");
        return out;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
    async exec(sql) {
      db.exec(sql);
    }
  };
  return d1;
}

export async function applyMigrations(d1) {
  const dir = new URL("../../migrations/", import.meta.url);
  for (const name of (await readdir(dir)).filter((file) => file.endsWith(".sql")).sort()) {
    const sql = (await readFile(new URL(name, dir), "utf8")).replace(/--.*$/gm, "");
    await d1.exec(sql);
  }
}
