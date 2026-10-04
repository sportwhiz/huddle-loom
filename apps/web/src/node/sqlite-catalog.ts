/** Catalog on a provider-guaranteed private persistent volume. GoDaddy uses
 * this backend to retain SQLite security triggers without MySQL trigger privileges. */
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { createHash } from "node:crypto";
import { readdir, readFile, mkdir, chmod } from "node:fs/promises";
import { dirname, resolve } from "node:path";

export class SqliteCatalog {
  private readonly database: DatabaseSync;
  constructor(path: string) {
    this.database = new DatabaseSync(path);
    this.database.exec(
      "PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL;",
    );
  }
  static async open(path: string) {
    await mkdir(dirname(resolve(path)), { recursive: true, mode: 0o700 });
    const catalog = new SqliteCatalog(path);
    await chmod(path, 0o600);
    return catalog;
  }
  prepare(sql: string) {
    return new Statement(this, sql, []);
  }
  async batch<T>(statements: Statement[]) {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const results = statements.map((statement) => {
        if (statement.owner !== this)
          throw new Error("Foreign statement in transaction");
        return statement.execute<T>();
      });
      this.database.exec("COMMIT");
      return results;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }
  async exec(sql: string) {
    const start = performance.now();
    this.database.exec(sql);
    return { count: 1, duration: performance.now() - start };
  }
  execute<T>(sql: string, parameters: unknown[]) {
    const started = performance.now();
    const statement = this.database.prepare(sql);
    const values = parameters.map((value) => {
      if (value instanceof ArrayBuffer) return new Uint8Array(value);
      if (typeof value === "boolean") return value ? 1 : 0;
      if (value === undefined) throw new Error("Undefined SQL binding");
      return value as SQLInputValue;
    });
    const hasColumns = statement.columns().length > 0;
    const before = hasColumns
      ? this.database.prepare("SELECT total_changes() count").get()!.count
      : undefined;
    const rows = hasColumns ? statement.all(...values) : undefined;
    const changed = rows
      ? this.database
          .prepare("SELECT changes() changes, last_insert_rowid() last_row_id")
          .get()!
      : statement.run(...values);
    if (
      rows &&
      this.database.prepare("SELECT total_changes() count").get()!.count ===
        before
    )
      changed.changes = 0;
    return {
      success: true as const,
      results: (rows ?? []) as T[],
      meta: {
        changes: Number(changed.changes),
        last_row_id: Number(
          "lastInsertRowid" in changed
            ? changed.lastInsertRowid
            : changed.last_row_id,
        ),
        duration: performance.now() - started,
        rows_read: rows?.length ?? 0,
        rows_written: Number(changed.changes),
        changed_db: Number(changed.changes) > 0,
        size_after: 0,
      },
    };
  }
  async migrate(directory: string) {
    this.database.exec(
      "CREATE TABLE IF NOT EXISTS node_schema_migrations (name TEXT PRIMARY KEY, digest TEXT NOT NULL)",
    );
    const names = (await readdir(directory))
      .filter((name) => /^\d+.*\.sql$/.test(name))
      .sort();
    for (const applied of this.database
      .prepare("SELECT name FROM node_schema_migrations")
      .all()) {
      if (!names.includes(String(applied.name)))
        throw new Error(
          "This application version is older than its database migrations. Refusing startup.",
        );
    }
    for (const name of names) {
      const sql = await readFile(resolve(directory, name), "utf8");
      const digest = createHash("sha256").update(sql).digest("hex");
      this.database.exec("BEGIN IMMEDIATE");
      try {
        const prior = this.database
          .prepare("SELECT digest FROM node_schema_migrations WHERE name=?")
          .get(name);
        if (prior && prior.digest !== digest)
          throw new Error(`Applied migration changed: ${name}`);
        if (!prior) {
          this.database.exec(sql);
          this.database
            .prepare(
              "INSERT INTO node_schema_migrations(name,digest) VALUES (?,?)",
            )
            .run(name, digest);
        }
        this.database.exec("COMMIT");
      } catch (error) {
        this.database.exec("ROLLBACK");
        throw error;
      }
    }
  }
  close() {
    this.database.close();
  }
}
class Statement {
  constructor(
    readonly owner: SqliteCatalog,
    private sql: string,
    private parameters: unknown[],
  ) {}
  bind(...parameters: unknown[]) {
    return new Statement(this.owner, this.sql, parameters);
  }
  execute<T>() {
    return this.owner.execute<T>(this.sql, this.parameters);
  }
  async all<T>() {
    return this.execute<T>();
  }
  async run<T>() {
    return this.execute<T>();
  }
  async first<T>(column?: string): Promise<T | null> {
    const result = this.execute<Record<string, unknown>>().results[0];
    if (!result) return null;
    if (column && !(column in result)) throw new Error("SQL column not found");
    return (column ? result[column] : result) as T;
  }
  async raw<T>({ columnNames = false }: { columnNames?: boolean } = {}) {
    const rows = this.execute<Record<string, unknown>>().results;
    return [
      ...(columnNames && rows.length ? [Object.keys(rows[0])] : []),
      ...rows.map(Object.values),
    ] as T[];
  }
}
