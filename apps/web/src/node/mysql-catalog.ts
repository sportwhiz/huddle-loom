import type {
  Pool,
  PoolConnection,
  ResultSetHeader,
  RowDataPacket,
} from "mysql2/promise";
import {
  compileCatalogSql,
  type CatalogSqlFragment,
  type CatalogSqlPlan,
} from "./catalog-sql";

export type CatalogRow = Record<string, unknown>;
const identifier = (name: string) => "`" + name.replaceAll("`", "``") + "`";
export function mysqlParameters(values: readonly unknown[]) {
  return values.map((value) => {
    if (value === undefined) throw new Error("Undefined SQL binding");
    if (value instanceof Date) return value.toISOString();
    if (value instanceof ArrayBuffer) return Buffer.from(value);
    if (value instanceof Uint8Array) return Buffer.from(value);
    if (typeof value === "boolean") return value ? 1 : 0;
    if (
      value === null ||
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "bigint"
    )
      return value;
    throw new Error("Unsupported SQL binding");
  });
}
export type CatalogOwnershipGuard = (
  connection: PoolConnection,
) => Promise<void>;
export async function beginCatalogTransaction(
  connection: PoolConnection,
  guard?: CatalogOwnershipGuard,
) {
  await connection.query("SET TRANSACTION ISOLATION LEVEL READ COMMITTED");
  await connection.beginTransaction();
  await connection.query("SET @hl_catalog_update_columns = NULL");
  // SQLite serialized all catalog writes. Retain that invariant across Node
  // instances and native auth queries until operation-specific locks replace it.
  await connection.execute(
    "SELECT id FROM hl_catalog_mutex WHERE id = 1 FOR UPDATE",
  );
  await guard?.(connection);
}
export class MysqlCatalog {
  private metadata = new Map<
    string,
    { primary: string[]; unique: string[][] }
  >();
  constructor(
    readonly pool: Pool,
    private readonly guard?: CatalogOwnershipGuard,
    private readonly metadataTable: (physical: string) => string | undefined = (
      name,
    ) => name,
  ) {}
  async initializeMetadata() {
    await this.pool.query(
      "CREATE TABLE IF NOT EXISTS hl_catalog_mutex (id TINYINT PRIMARY KEY) ENGINE=InnoDB",
    );
    await this.pool.query(
      "INSERT INTO hl_catalog_mutex(id) VALUES(1) ON DUPLICATE KEY UPDATE id=id",
    );
    const [rows] = await this.pool.query<RowDataPacket[]>(
      "SELECT TABLE_NAME, INDEX_NAME, COLUMN_NAME, SEQ_IN_INDEX FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND NON_UNIQUE=0 ORDER BY TABLE_NAME,INDEX_NAME,SEQ_IN_INDEX",
    );
    this.metadata.clear();
    const tables = new Map<string, Map<string, string[]>>();
    for (const row of rows) {
      const table = this.metadataTable(row.TABLE_NAME);
      if (!table) continue;
      let indexes = tables.get(table);
      if (!indexes) {
        indexes = new Map();
        tables.set(table, indexes);
      }
      const columns = indexes.get(row.INDEX_NAME) ?? [];
      columns.push(row.COLUMN_NAME);
      indexes.set(row.INDEX_NAME, columns);
    }
    for (const [table, indexes] of tables)
      this.metadata.set(table, {
        primary: indexes.get("PRIMARY") ?? [],
        unique: [...indexes.values()],
      });
  }
  prepare(sql: string) {
    return new MysqlStatement(this, sql, []);
  }
  async transaction<T>(work: (connection: PoolConnection) => Promise<T>) {
    const connection = await this.pool.getConnection();
    let reusable = true;
    try {
      await beginCatalogTransaction(connection, this.guard);
      const result = await work(connection);
      try {
        await connection.commit();
      } catch (error) {
        reusable = false;
        throw error;
      }
      return result;
    } catch (error) {
      try {
        await connection.rollback();
      } catch {
        reusable = false;
      }
      throw error;
    } finally {
      if (reusable) connection.release();
      else connection.destroy();
    }
  }
  async batch<T>(statements: MysqlStatement[]) {
    return this.transaction(async (connection) => {
      const results = [];
      for (const statement of statements) {
        if (statement.owner !== this)
          throw new Error("Foreign statement in transaction");
        results.push(await statement.execute<T>(connection));
      }
      return results;
    });
  }
  async exec(sql: string) {
    const started = performance.now();
    await this.prepare(sql).run();
    return { count: 1, duration: performance.now() - started };
  }
  close() {
    /* The runtime owns the shared pool. */
  }
  private key(table: string, row: CatalogRow) {
    const columns = this.metadata.get(table)?.primary;
    if (!columns?.length)
      throw new Error(`No primary key for catalog table ${table}`);
    return {
      sql: columns.map((column) => `${identifier(column)} <=> ?`).join(" AND "),
      values: columns.map((column) => row[column]),
    };
  }
  private fragment(
    fragment: CatalogSqlFragment,
    parameters: unknown[],
    candidate?: CatalogRow,
  ) {
    return mysqlParameters(
      fragment.bindings.map((binding) =>
        binding.kind === "input"
          ? parameters[binding.index]
          : candidate?.[binding.column],
      ),
    );
  }
  async execute<T>(
    sql: string,
    parameters: unknown[],
    connection?: PoolConnection,
  ): Promise<{
    success: true;
    results: T[];
    meta: {
      changes: number;
      last_row_id: number;
      duration: number;
      rows_read: number;
      rows_written: number;
      changed_db: boolean;
      size_after: number;
    };
  }> {
    if (!connection)
      return this.transaction((c) => this.execute<T>(sql, parameters, c));
    const started = performance.now();
    const plan = compileCatalogSql(sql);
    const result = await this.executePlan(connection, plan, parameters);
    return {
      success: true,
      results: result.rows as T[],
      meta: {
        changes: result.changes,
        last_row_id: 0,
        duration: performance.now() - started,
        rows_read: result.rows.length,
        rows_written: result.changes,
        changed_db: result.changes > 0,
        size_after: 0,
      },
    };
  }
  private async executePlan(
    connection: PoolConnection,
    plan: CatalogSqlPlan,
    parameters: unknown[],
  ): Promise<{ rows: CatalogRow[]; changes: number }> {
    const query = async (
      fragment: CatalogSqlFragment,
      candidate?: CatalogRow,
    ) => {
      const [result] = await connection.execute<RowDataPacket[]>(
        fragment.sql,
        this.fragment(fragment, parameters, candidate),
      );
      return result as CatalogRow[];
    };
    if (plan.kind === "query")
      return { rows: await query(plan.statement), changes: 0 };
    const table = identifier(plan.table);
    const rows: CatalogRow[] = [];
    let changes = 0;
    const returning = async (
      row: CatalogRow,
      projection: CatalogSqlFragment,
    ) => {
      const key = this.key(plan.table, row);
      const [returned] = await connection.execute<RowDataPacket[]>(
        `SELECT ${projection.sql} FROM ${table} WHERE ${key.sql}`,
        [
          ...this.fragment(projection, parameters),
          ...mysqlParameters(key.values),
        ],
      );
      rows.push(...returned);
    };
    const update = async (
      row: CatalogRow,
      assignments: Extract<CatalogSqlPlan, { kind: "update" }>["assignments"],
      candidate?: CatalogRow,
      where?: CatalogSqlFragment,
    ) => {
      const key = this.key(plan.table, row);
      const values = assignments.flatMap((a) =>
        this.fragment(a.expression, parameters, candidate),
      );
      const predicate = where ? ` AND (${where.sql})` : "";
      // SQLite evaluates every SET expression against the old row. MySQL's
      // single-table UPDATE evaluates them left-to-right, so materialize first.
      const [evaluated] = await connection.execute<RowDataPacket[]>(
        `SELECT ${assignments.map((a, index) => `${a.expression.sql} AS ${identifier(`__hl_set_${index}`)}`).join(",")} FROM ${table} WHERE ${key.sql}${predicate}`,
        [
          ...values,
          ...mysqlParameters(key.values),
          ...(where ? this.fragment(where, parameters, candidate) : []),
        ],
      );
      if (!evaluated.length) return;
      const next = {
        ...row,
        ...Object.fromEntries(
          assignments.map((assignment, index) => [
            assignment.column,
            evaluated[0][`__hl_set_${index}`],
          ]),
        ),
      };
      await connection.query("SET @hl_catalog_update_columns = ?", [
        JSON.stringify(assignments.map((a) => a.column)),
      ]);
      const [result] = await connection.execute<ResultSetHeader>(
        `UPDATE ${table} SET ${assignments.map((a) => `${identifier(a.column)} = ?`).join(",")} WHERE ${key.sql}`,
        [
          ...mysqlParameters(assignments.map((a) => next[a.column])),
          ...mysqlParameters(key.values),
        ],
      );
      changes += result.affectedRows;
      if (result.affectedRows && plan.returning)
        await returning(next, plan.returning);
    };
    if (plan.kind === "insert") {
      for (const projected of await query(plan.source)) {
        const candidate = Object.fromEntries(
          plan.columns.map((column, index) => [
            column,
            projected[`__hl_insert_${index}`],
          ]),
        );
        const insertSql = `INSERT INTO ${table} (${plan.columns.map(identifier).join(",")}) VALUES (${plan.columns.map(() => "?").join(",")})`;
        const insertValues = mysqlParameters(
          plan.columns.map((column) => candidate[column]),
        );
        if (!plan.conflict) {
          const [result] = await connection.execute<ResultSetHeader>(
            insertSql,
            insertValues,
          );
          changes += result.affectedRows;
          if (plan.returning) await returning(candidate, plan.returning);
          continue;
        }
        // A real INSERT evaluates BEFORE INSERT guards and candidate CHECK/NOT
        // NULL constraints before choosing the duplicate branch, like SQLite.
        await connection.query("SAVEPOINT hl_catalog_candidate");
        let duplicate: unknown;
        try {
          const [result] = await connection.execute<ResultSetHeader>(
            insertSql,
            insertValues,
          );
          await connection.query("RELEASE SAVEPOINT hl_catalog_candidate");
          changes += result.affectedRows;
          if (plan.returning) await returning(candidate, plan.returning);
          continue;
        } catch (error) {
          await connection.query("ROLLBACK TO SAVEPOINT hl_catalog_candidate");
          await connection.query("RELEASE SAVEPOINT hl_catalog_candidate");
          if ((error as { errno?: number }).errno !== 1062) throw error;
          duplicate = error;
        }
        if (plan.conflict.action === "nothing" && !plan.conflict.target)
          continue;
        let conflict: CatalogRow | undefined;
        const indexes = plan.conflict.target
          ? [plan.conflict.target]
          : this.metadata.get(plan.table)?.unique;
        if (!indexes?.length)
          throw new Error(`No conflict keys for ${plan.table}`);
        for (const columns of indexes) {
          if (
            columns.some(
              (column) =>
                candidate[column] === null || candidate[column] === undefined,
            )
          )
            continue;
          const [matches] = await connection.execute<RowDataPacket[]>(
            `SELECT * FROM ${table} WHERE ${columns.map((column) => `${identifier(column)} = ?`).join(" AND ")} FOR UPDATE`,
            mysqlParameters(columns.map((column) => candidate[column])),
          );
          if (matches.length) {
            conflict = matches[0];
            break;
          }
        }
        if (!conflict) throw duplicate;
        if (plan.conflict.action === "update")
          await update(
            conflict,
            plan.conflict.assignments ?? [],
            candidate,
            plan.conflict.where,
          );
      }
    } else {
      const selected = await query(plan.selection);
      for (const row of selected) {
        if (plan.kind === "update") await update(row, plan.assignments);
        else {
          if (plan.returning) await returning(row, plan.returning);
          const key = this.key(plan.table, row);
          const [result] = await connection.execute<ResultSetHeader>(
            `DELETE FROM ${table} WHERE ${key.sql}`,
            mysqlParameters(key.values),
          );
          changes += result.affectedRows;
        }
      }
    }
    return { rows, changes };
  }
}
class MysqlStatement {
  constructor(
    readonly owner: MysqlCatalog,
    readonly sql: string,
    readonly parameters: unknown[],
  ) {}
  bind(...parameters: unknown[]) {
    return new MysqlStatement(this.owner, this.sql, parameters);
  }
  execute<T>(connection?: PoolConnection) {
    return this.owner.execute<T>(this.sql, this.parameters, connection);
  }
  all<T>() {
    return this.execute<T>();
  }
  run<T>() {
    return this.execute<T>();
  }
  async first<T>(column?: string): Promise<T | null> {
    const row = (await this.execute<CatalogRow>()).results[0];
    if (!row) return null;
    if (column && !(column in row)) throw new Error("SQL column not found");
    return (column ? row[column] : row) as T;
  }
  async raw<T>({ columnNames = false }: { columnNames?: boolean } = {}) {
    const rows = (await this.execute<CatalogRow>()).results;
    return [
      ...(columnNames && rows.length ? [Object.keys(rows[0])] : []),
      ...rows.map(Object.values),
    ] as T[];
  }
}
