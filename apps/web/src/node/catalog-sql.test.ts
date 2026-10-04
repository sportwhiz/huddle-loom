import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import ts from "typescript";
import { compileCatalogSql } from "./catalog-sql";

function sourceQueries() {
  const found: { file: string; sql: string }[] = [];
  function walk(folder: string) {
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      const file = join(folder, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "node") walk(file);
        continue;
      }
      if (!file.endsWith(".ts") || file.endsWith(".test.ts")) continue;
      const source = ts.createSourceFile(
        file,
        readFileSync(file, "utf8"),
        ts.ScriptTarget.Latest,
        true,
      );
      const declarations = new Map<string, ts.Expression[]>();
      const functions = new Map<string, ts.Expression[]>();
      function collect(node: ts.Node) {
        if (ts.isFunctionDeclaration(node) && node.name && node.body)
          functions.set(
            node.name.text,
            node.body.statements.flatMap((statement) =>
              ts.isReturnStatement(statement) && statement.expression
                ? [statement.expression]
                : [],
            ),
          );
        if (
          ts.isVariableDeclaration(node) &&
          ts.isIdentifier(node.name) &&
          node.initializer
        )
          declarations.set(node.name.text, [
            ...(declarations.get(node.name.text) ?? []),
            node.initializer,
          ]);
        ts.forEachChild(node, collect);
      }
      collect(source);
      for (const statement of source.statements) {
        if (
          !ts.isImportDeclaration(statement) ||
          !ts.isStringLiteral(statement.moduleSpecifier) ||
          !statement.moduleSpecifier.text.startsWith(".")
        )
          continue;
        const importedPath =
          join(dirname(file), statement.moduleSpecifier.text) + ".ts";
        const bindings = statement.importClause?.namedBindings;
        if (
          !existsSync(importedPath) ||
          !bindings ||
          !ts.isNamedImports(bindings)
        )
          continue;
        const imported = ts.createSourceFile(
          importedPath,
          readFileSync(importedPath, "utf8"),
          ts.ScriptTarget.Latest,
          true,
        );
        for (const binding of bindings.elements)
          for (const declaration of imported.statements) {
            if (!ts.isVariableStatement(declaration)) continue;
            for (const variable of declaration.declarationList.declarations)
              if (
                ts.isIdentifier(variable.name) &&
                variable.name.text ===
                  (binding.propertyName?.text ?? binding.name.text) &&
                variable.initializer
              )
                declarations.set(binding.name.text, [variable.initializer]);
          }
      }

      function strings(
        value: ts.Expression,
        seen = new Set<string>(),
      ): string[] {
        if (
          ts.isStringLiteral(value) ||
          ts.isNoSubstitutionTemplateLiteral(value)
        )
          return [value.text];
        if (ts.isConditionalExpression(value))
          return [
            ...strings(value.whenTrue, seen),
            ...strings(value.whenFalse, seen),
          ];
        if (ts.isIdentifier(value) && !seen.has(value.text)) {
          const candidates = declarations.get(value.text) ?? [];
          const ancestors: ts.Node[] = [];
          for (
            let node: ts.Node | undefined = value.parent;
            node;
            node = node.parent
          )
            ancestors.push(node);
          const ranked = candidates
            .map((item) => {
              let scope: ts.Node | undefined = item.parent;
              while (scope && !ts.isBlock(scope) && !ts.isSourceFile(scope))
                scope = scope.parent;
              return { item, depth: scope ? ancestors.indexOf(scope) : -1 };
            })
            .filter((item) => item.depth >= 0)
            .sort((a, b) => a.depth - b.depth);
          const visible = ranked.length
            ? ranked
                .filter((item) => item.depth === ranked[0].depth)
                .map((item) => item.item)
            : candidates;
          return visible.flatMap((item) =>
            strings(item, new Set([...seen, value.text])),
          );
        }
        if (
          ts.isCallExpression(value) &&
          ts.isIdentifier(value.expression) &&
          functions.has(value.expression.text)
        )
          return functions
            .get(value.expression.text)!
            .flatMap((item) => strings(item, seen));
        if (
          ts.isCallExpression(value) &&
          value.getText(source).startsWith("entries.map(") &&
          value.getText(source).includes(".join(")
        ) {
          const keys = (declarations.get("allowed") ?? []).flatMap((item) =>
            ts.isArrayLiteralExpression(item)
              ? item.elements.flatMap((element) =>
                  ts.isStringLiteral(element) ? [element.text] : [],
                )
              : [],
          );
          return keys.length
            ? [keys.map((key) => `${key} = ?`).join(", ")]
            : [];
        }
        if (ts.isTemplateExpression(value)) {
          let values = [value.head.text];
          for (const span of value.templateSpans)
            values = values.flatMap((prefix) =>
              strings(span.expression, seen).map(
                (part) => prefix + part + span.literal.text,
              ),
            );
          return values;
        }
        return [];
      }
      function visit(node: ts.Node) {
        if (
          ts.isCallExpression(node) &&
          ts.isPropertyAccessExpression(node.expression) &&
          node.expression.name.text === "prepare"
        ) {
          const value = node.arguments[0];
          if (value) {
            const variants = strings(value);
            if (!variants.length)
              throw new Error(
                `Unresolved SQL template in ${file}: ${value.getText(source)}`,
              );
            for (const sql of new Set(variants)) found.push({ file, sql });
          }
        }
        ts.forEachChild(node, visit);
      }
      visit(source);
    }
  }
  walk(join(import.meta.dirname, ".."));
  return found;
}
describe("Native catalog operation compiler", () => {
  it("compiles every application prepared statement and SQL template variant", () => {
    const queries = sourceQueries();
    expect(queries.length).toBeGreaterThan(300);
    for (const name of ["guest-links.server.ts", "guest-policy.server.ts"]) {
      const guestQueries = queries.filter(query => query.file.endsWith(name));
      expect(guestQueries.length).toBeGreaterThan(0);
      expect(guestQueries.some(query => query.sql.includes("security.recovery_required=0"))).toBe(true);
    }
    const failures = queries.flatMap(({ file, sql }) => {
      try {
        compileCatalogSql(sql);
        return [];
      } catch (error) {
        return [{ file, sql, error: String(error) }];
      }
    });
    expect(failures).toEqual([]);
  });
  it("captures exact UPDATE rows before changing predicates and preserves input indexes", () => {
    const plan = compileCatalogSql(
      "UPDATE security_outbox SET status = ?, attempts = attempts + 1 WHERE id = ? AND status = ? RETURNING id, attempts",
    );
    expect(plan.kind).toBe("update");
    if (plan.kind !== "update") return;
    expect(plan.selection.sql).toContain("FOR UPDATE");
    expect(plan.selection.bindings).toEqual([
      { kind: "input", index: 1 },
      { kind: "input", index: 2 },
    ]);
    expect(plan.assignments[0].expression.bindings).toEqual([
      { kind: "input", index: 0 },
    ]);
    expect(plan.returning!.sql).toBe("`id` , `attempts`");
  });
  it("keeps conflict target and condition distinct from ordinary unique violations", () => {
    const plan = compileCatalogSql(
      "INSERT INTO mfa_replay(user_id, code_hash, expires_at) VALUES (?, ?, ?) ON CONFLICT(user_id, code_hash) DO UPDATE SET expires_at = excluded.expires_at WHERE expires_at < ? RETURNING user_id",
    );
    expect(plan.kind).toBe("insert");
    if (plan.kind !== "insert") return;
    expect(plan.conflict!.target).toEqual(["user_id", "code_hash"]);
    expect(plan.conflict!.assignments![0].expression.bindings).toEqual([
      { kind: "candidate", column: "expires_at" },
    ]);
    expect(plan.conflict!.where!.bindings).toEqual([
      { kind: "input", index: 3 },
    ]);
    expect(plan.source.bindings).toEqual(
      [0, 1, 2].map((index) => ({ kind: "input", index })),
    );
  });
  it("does not interpret SQL text within string literals", () => {
    const value =
      "SELECT 'ON CONFLICT(x) DO UPDATE; ? \\ secret' AS note, ? AS value";
    const plan = compileCatalogSql(value);
    if (plan.kind !== "query") throw new Error();
    expect(plan.statement.bindings).toEqual([{ kind: "input", index: 0 }]);
    expect(plan.statement.sql).toContain(
      Buffer.from("ON CONFLICT(x) DO UPDATE; ? \\ secret").toString("hex"),
    );
  });
  it("renders JSON table transfer and scalar schema comparisons", () => {
    const plan = compileCatalogSql(
      "SELECT json_extract(value, '$.id') FROM json_each(?) WHERE json_extract(value, '$.type') = 'board'",
    );
    if (plan.kind !== "query") throw new Error();
    expect(plan.statement.sql).toContain("JSON_TABLE");
    expect(plan.statement.sql).toContain("JSON_UNQUOTE");
    expect(plan.statement.bindings).toEqual([{ kind: "input", index: 0 }]);
    const schema = compileCatalogSql(
      "SELECT id FROM software_updates WHERE json_extract(release,'$.schema')=? AND runner_id IS ?",
    );
    if (schema.kind !== "query") throw new Error();
    expect(schema.statement.sql).toContain("AS UNSIGNED");
    expect(schema.statement.sql).toContain("<=> ?");
  });
  it("fails closed for unsupported or multiple statements", () => {
    expect(() =>
      compileCatalogSql("DELETE FROM users; DELETE FROM boards"),
    ).toThrow("Multiple");
    expect(() => compileCatalogSql("SELECT randomblob(10)")).toThrow(
      "Unsupported SQL function",
    );
  });
});

describe.skipIf(!process.env.CATALOG_MYSQL_TEST_URL)(
  "Catalog operation execution against MySQL",
  () => {
    it("preserves conditional upserts, exact returning rows, old-row assignments, and ASCII comparisons", async () => {
      const { createPool } = await import("mysql2/promise");
      const { MysqlCatalog } = await import("./mysql-catalog");
      const { DatabaseSync } = await import("node:sqlite");
      const url = process.env.CATALOG_MYSQL_TEST_URL!;
      if (!new URL(url).pathname.endsWith("_test"))
        throw new Error("Test database name must end in _test");
      const pool = createPool(url);
      const sqlite = new DatabaseSync(":memory:");
      const table = `compiler_${crypto.randomUUID().replaceAll("-", "")}`;
      const schema = `CREATE TABLE ${table}(id VARCHAR(100) PRIMARY KEY, email VARCHAR(200) NOT NULL UNIQUE, a INTEGER NOT NULL CHECK(a>=0), b INTEGER NOT NULL)`;
      const quote = (value: string) => "`" + value + "`";
      try {
        await pool.query(schema + " CHARACTER SET utf8mb4 COLLATE utf8mb4_bin");
        sqlite.exec(schema);
        const catalog = new MysqlCatalog(pool);
        await catalog.initializeMetadata();
        async function differential(
          sql: string,
          parameters: (string | number | null)[] = [],
        ) {
          const expected = sqlite
            .prepare(sql)
            .all(...parameters)
            .map((row) => ({ ...row }));
          const actual = (
            await catalog
              .prepare(sql)
              .bind(...parameters)
              .all()
          ).results;
          expect(actual).toEqual(expected);
          return actual;
        }
        await differential(
          `INSERT INTO ${table}(id,email,a,b) VALUES(?,?,?,?) RETURNING id,a,b`,
          ["one", "TEST@example.com", 2, 8],
        );
        await differential(
          `UPDATE ${table} SET a=a+1,b=a WHERE id=? AND a=? RETURNING id,a,b`,
          ["one", 2],
        );
        await differential(
          `UPDATE ${table} SET a=99 WHERE id=? AND a=? RETURNING id`,
          ["one", 2],
        );
        await differential(
          `UPDATE ${table} SET a=a WHERE id=? RETURNING id,a`,
          ["one"],
        );
        const upsert = `INSERT INTO ${table}(id,email,a,b) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET a=excluded.a,b=a WHERE a < ? RETURNING id,a,b`;
        await differential(upsert, ["one", "TEST@example.com", 9, 99, 5]);
        await differential(upsert, ["one", "TEST@example.com", 20, 99, 5]);
        await differential(
          `SELECT id FROM ${table} WHERE email = ? COLLATE NOCASE`,
          ["test@EXAMPLE.com"],
        );
        await differential(
          `INSERT INTO ${table}(id,email,a,b) VALUES(?,?,?,?) RETURNING id`,
          ["unicode", "Å@example.com", 1, 2],
        );
        await differential(
          `SELECT id FROM ${table} WHERE email = ? COLLATE NOCASE`,
          ["å@example.com"],
        );
        await differential(
          `SELECT id FROM ${table} WHERE email LIKE ? ORDER BY id`,
          ["test@EXAMPLE%"],
        );
        await differential(
          `SELECT id FROM ${table} WHERE email LIKE ? ORDER BY id`,
          ["_@example.com"],
        );
        await differential(
          `SELECT id FROM ${table} WHERE email LIKE ? ORDER BY id`,
          ["å@%"],
        );
        await differential(
          `SELECT id FROM ${table} WHERE email LIKE ? ORDER BY id`,
          ["TEST\\%@example.com"],
        );
        await differential(`SELECT id FROM ${table} WHERE id IS ?`, [null]);
        const conflict = `INSERT INTO ${table}(id,email,a,b) VALUES(?,?,?,?) ON CONFLICT(id) DO NOTHING`;
        expect(() =>
          sqlite.prepare(conflict).run("other", "TEST@example.com", 1, 1),
        ).toThrow();
        await expect(
          catalog
            .prepare(conflict)
            .bind("other", "TEST@example.com", 1, 1)
            .run(),
        ).rejects.toThrow();
        for (const invalid of [
          ["one", null, 20, 1, 100],
          ["one", "TEST@example.com", -1, 1, 100],
        ] as (string | number | null)[][]) {
          expect(() => sqlite.prepare(upsert).all(...invalid)).toThrow();
          await expect(
            catalog
              .prepare(upsert)
              .bind(...invalid)
              .all(),
          ).rejects.toThrow();
        }
        const trigger = table + "_guard";
        sqlite.exec(
          `CREATE TRIGGER ${trigger} BEFORE INSERT ON ${table} WHEN NEW.email='blocked@example.com' BEGIN SELECT RAISE(ABORT,'candidate guard'); END`,
        );
        await pool.query(
          `CREATE TRIGGER ${trigger} BEFORE INSERT ON ${table} FOR EACH ROW BEGIN IF NEW.email='blocked@example.com' THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='candidate guard'; END IF; END`,
        );
        expect(() =>
          sqlite.prepare(upsert).all("one", "blocked@example.com", 20, 1, 100),
        ).toThrow("candidate guard");
        await expect(
          catalog
            .prepare(upsert)
            .bind("one", "blocked@example.com", 20, 1, 100)
            .all(),
        ).rejects.toThrow("candidate guard");
        await differential(`SELECT id,a,b FROM ${table} WHERE id=?`, ["one"]);
        await pool.query(
          `ALTER TABLE ${table} ADD normalized_email VARCHAR(200) GENERATED ALWAYS AS (LOWER(email)) STORED, ADD UNIQUE(normalized_email)`,
        );
        await catalog.initializeMetadata();
        const ignored = `INSERT OR IGNORE INTO ${table}(id,email,a,b) VALUES(?,?,?,?)`;
        expect(
          (
            await catalog
              .prepare(ignored)
              .bind("other", "TEST@example.com", 1, 1)
              .run()
          ).meta.changes,
        ).toBe(0);
        expect(
          (
            await catalog
              .prepare(ignored)
              .bind("generated-conflict", "test@EXAMPLE.com", 1, 1)
              .run()
          ).meta.changes,
        ).toBe(0);
        const concurrent = `INSERT INTO ${table}(id,email,a,b) VALUES(?,?,1,0) ON CONFLICT(id) DO UPDATE SET a=a+1 RETURNING a`;
        const returned = await Promise.all(
          Array.from({ length: 12 }, () =>
            catalog
              .prepare(concurrent)
              .bind("counter", "counter@example.com")
              .first<{ a: number }>(),
          ),
        );
        expect(returned.map((row) => row!.a).sort((a, b) => a - b)).toEqual(
          Array.from({ length: 12 }, (_, index) => index + 1),
        );
      } finally {
        await pool.query(`DROP TABLE IF EXISTS ${quote(table)}`);
        sqlite.close();
        await pool.end();
      }
    });
    it("executes JSON candidate transfer, recursive ancestors, concatenation and derived tables", async () => {
      const { createPool } = await import("mysql2/promise");
      const { MysqlCatalog } = await import("./mysql-catalog");
      const url = process.env.CATALOG_MYSQL_TEST_URL!;
      if (!new URL(url).pathname.endsWith("_test"))
        throw new Error("Test database required");
      const pool = createPool(url);
      const table = `compiler_${crypto.randomUUID().replaceAll("-", "")}`;
      try {
        await pool.query(
          `CREATE TABLE ${table}(id VARCHAR(100) PRIMARY KEY, type VARCHAR(100), parent_id VARCHAR(100)) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin`,
        );
        const catalog = new MysqlCatalog(pool);
        await catalog.initializeMetadata();
        const input = JSON.stringify([
          { id: "one", type: "board" },
          { id: "two", type: "folder" },
        ]);
        await catalog
          .prepare(
            `INSERT INTO ${table}(id,type) SELECT json_extract(value,'$.id'), json_extract(value,'$.type') FROM json_each(?) WHERE json_extract(value,'$.type')='board' ON CONFLICT(id) DO UPDATE SET type=excluded.type`,
          )
          .bind(input)
          .run();
        expect(
          await catalog.prepare(`SELECT id,type FROM ${table}`).all(),
        ).toMatchObject({ results: [{ id: "one", type: "board" }] });
        await catalog
          .prepare(
            `UPDATE ${table} SET parent_id='matched' WHERE EXISTS(SELECT 1 FROM json_each(?) WHERE json_extract(value,'$.id')=${table}.id AND json_extract(value,'$.type')=${table}.type)`,
          )
          .bind(input)
          .run();
        expect(
          await catalog
            .prepare(`SELECT parent_id FROM ${table} WHERE id='one'`)
            .first(),
        ).toEqual({ parent_id: "matched" });
        await catalog
          .prepare(`UPDATE ${table} SET parent_id=NULL WHERE id='one'`)
          .run();
        const result = await catalog
          .prepare(
            `SELECT * FROM (SELECT id,type FROM ${table} UNION ALL SELECT id,type FROM ${table}) WHERE type || ':' || id > ? ORDER BY type,id`,
          )
          .bind("board:")
          .all();
        expect(result.results).toHaveLength(2);
        await catalog
          .prepare(
            `INSERT INTO ${table}(id,type,parent_id) VALUES('child','folder','one')`,
          )
          .run();
        const ancestors = await catalog
          .prepare(
            `WITH RECURSIVE ancestors(id,parent_id) AS (SELECT id,parent_id FROM ${table} WHERE id=? UNION SELECT f.id,f.parent_id FROM ${table} f JOIN ancestors a ON f.id=a.parent_id) SELECT id FROM ancestors ORDER BY id`,
          )
          .bind("child")
          .all();
        expect(ancestors.results).toEqual([{ id: "child" }, { id: "one" }]);
      } finally {
        await pool.query(`DROP TABLE IF EXISTS ${table}`);
        await pool.end();
      }
    });
  },
);

describe.skipIf(!process.env.CATALOG_MYSQL_TEST_URL)(
  "Full catalog SQL syntax against MySQL schema",
  () => {
    it("explains every operation plan against the installed native schema", async () => {
      const { createPool } = await import("mysql2/promise");
      const { migrateCatalogSchema } = await import("./catalog-schema");
      const url = process.env.CATALOG_MYSQL_TEST_URL!;
      if (!new URL(url).pathname.endsWith("_test"))
        throw new Error("Test database required");
      const pool = createPool(url);
      try {
        await migrateCatalogSchema(pool);
        const failures: { sql: string; error: string }[] = [];
        for (const { sql } of sourceQueries()) {
          const plan = compileCatalogSql(sql);
          const fragments =
            plan.kind === "query"
              ? [plan.statement]
              : plan.kind === "insert"
                ? [plan.source]
                : [plan.selection];
          if (
            plan.kind === "update" ||
            (plan.kind === "insert" && plan.conflict?.action === "update")
          ) {
            const assignments =
              plan.kind === "update"
                ? plan.assignments
                : plan.conflict!.assignments!;
            for (const assignment of assignments)
              fragments.push({
                sql: `SELECT ${assignment.expression.sql} FROM \`${plan.table}\` WHERE 0`,
                bindings: assignment.expression.bindings,
              });
          }
          if (plan.kind !== "query" && plan.returning)
            fragments.push({
              sql: `SELECT ${plan.returning.sql} FROM \`${plan.table}\` WHERE 0`,
              bindings: plan.returning.bindings,
            });
          for (const fragment of fragments) {
            try {
              await pool.execute(
                "EXPLAIN " + fragment.sql,
                fragment.bindings.map(() => null),
              );
            } catch (error) {
              failures.push({ sql: fragment.sql, error: String(error) });
            }
          }
        }
        expect(failures).toEqual([]);
      } finally {
        await pool.end();
      }
    }, 30000);
  },
);
