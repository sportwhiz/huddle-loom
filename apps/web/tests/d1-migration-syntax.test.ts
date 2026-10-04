import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";

const directory = new URL("../migrations/", import.meta.url);

// Portability guard for the remote /query parsing failure reported in
// https://github.com/cloudflare/workers-sdk/issues/4727. SQLite and Wrangler's
// current local splitter accept bare CASE/END in triggers, so a normal local
// migration test cannot detect this remote incompatibility.
// This check is not a substitute for a remote D1 migration rehearsal.
function hasBareCase(sql: string) {
  const tokens = sql.matchAll(
    /--[^\n]*|\/\*[\s\S]*?\*\/|'(?:''|[^'])*'|"(?:""|[^"])*"|`(?:``|[^`])*`|\[[^\]]*\]|[A-Za-z_][A-Za-z_0-9]*|[()]/g,
  );
  let depth = 0;
  for (const [token] of tokens) {
    if (token === "(") depth++;
    else if (token === ")") depth--;
    else if (token.toUpperCase() === "CASE" && depth === 0) return true;
  }
  return false;
}

describe("remote D1 migration syntax", () => {
  it("detects the reported trigger pattern without confusing literals or nested expressions", () => {
    expect(
      hasBareCase(
        "BEGIN SELECT CASE WHEN 1 THEN RAISE(ABORT, 'blocked') END; END;",
      ),
    ).toBe(true);
    expect(
      hasBareCase(
        "BEGIN SELECT /* comment */ case WHEN 1 THEN RAISE(ABORT, 'blocked') end; END;",
      ),
    ).toBe(true);
    expect(
      hasBareCase(
        "BEGIN SELECT (CASE WHEN 1 THEN RAISE(ABORT, 'blocked') END); END;",
      ),
    ).toBe(false);
    expect(
      hasBareCase(
        "WHEN 1 = (SELECT CASE WHEN 1 THEN 1 END) BEGIN SELECT 'case '' )', \"case\", `case`, [case]; -- CASE\n /* CASE */ END;",
      ),
    ).toBe(false);
  });

  it("keeps every migration trigger compatible with remote statement boundaries", () => {
    const database = new DatabaseSync(":memory:");
    database.exec("PRAGMA foreign_keys = ON");
    try {
      for (const name of readdirSync(directory)
        .filter((name) => name.endsWith(".sql"))
        .sort()) {
        database.exec(readFileSync(new URL(name, directory), "utf8"));
        // Check after each file, including definitions a later migration drops.
        const triggers = database
          .prepare("SELECT name, sql FROM sqlite_schema WHERE type = 'trigger'")
          .all() as { name: string; sql: string }[];
        const incompatible = triggers
          .filter((trigger) => hasBareCase(trigger.sql))
          .map((trigger) => trigger.name);
        expect(
          incompatible,
          `${name}: wrap trigger CASE expressions in parentheses before deploying to D1`,
        ).toEqual([]);
      }
    } finally {
      database.close();
    }
  });
});
