import {
  Kysely,
  MysqlAdapter,
  MysqlQueryCompiler,
  MysqlIntrospector,
  type Dialect,
  type Driver,
  type DatabaseConnection,
  type CompiledQuery,
  type QueryResult,
  type DatabaseMetadataOptions,
} from "kysely";
import type {
  Pool,
  PoolConnection,
  ResultSetHeader,
  RowDataPacket,
} from "mysql2/promise";
import { compileCatalogSql } from "./catalog-sql";
import {
  beginCatalogTransaction,
  mysqlParameters,
  type CatalogOwnershipGuard,
} from "./mysql-catalog";

/** Uses the real MySQL dialect while sharing catalog serialization with policy SQL.
 * ISO date strings are deliberate: policy queries and exports use the same format. */
class AuthConnection implements DatabaseConnection {
  private active = false;
  private reusable = true;
  constructor(
    readonly connection: PoolConnection,
    private readonly guard?: CatalogOwnershipGuard,
  ) {}
  async begin() {
    // Acquisition itself can fail after BEGIN (for example waiting for the
    // catalog mutex). Mark active first so that path cannot leak a transaction.
    this.active = true;
    try {
      await beginCatalogTransaction(this.connection, this.guard);
    } catch (error) {
      try {
        await this.rollback();
      } catch {
        /* release destroys it */
      }
      throw error;
    }
  }
  async commit() {
    try {
      await this.connection.commit();
    } catch (error) {
      this.reusable = false;
      throw error;
    } finally {
      this.active = false;
    }
  }
  async rollback() {
    try {
      await this.connection.rollback();
    } catch (error) {
      this.reusable = false;
      throw error;
    } finally {
      this.active = false;
    }
  }
  async release() {
    try {
      if (this.active) await this.rollback();
    } finally {
      if (this.reusable) this.connection.release();
      else this.connection.destroy();
    }
  }
  async executeQuery<R>(query: CompiledQuery): Promise<QueryResult<R>> {
    const own = !this.active;
    if (own) await this.begin();
    try {
      const update = /^\s*update\b/i.test(query.sql)
        ? compileCatalogSql(query.sql)
        : undefined;
      await this.connection.query("SET @hl_catalog_update_columns = ?", [
        update?.kind === "update"
          ? JSON.stringify(update.assignments.map((a) => a.column))
          : null,
      ]);
      const [result] = await this.connection.execute<
        RowDataPacket[] | ResultSetHeader
      >(query.sql, mysqlParameters(query.parameters));
      const output: QueryResult<R> = Array.isArray(result)
        ? { rows: result as R[] }
        : {
            rows: [],
            numAffectedRows: BigInt(result.affectedRows),
            numChangedRows: BigInt(result.changedRows ?? result.affectedRows),
            insertId: result.insertId ? BigInt(result.insertId) : undefined,
          };
      if (own) await this.commit();
      return output;
    } catch (error) {
      if (own && this.active) await this.rollback();
      throw error;
    }
  }
  async *streamQuery<R>(
    _query: CompiledQuery,
  ): AsyncIterableIterator<QueryResult<R>> {
    throw new Error("Authentication streaming queries are unsupported.");
  }
}
class CatalogIntrospector extends MysqlIntrospector {
  constructor(
    db: Kysely<unknown>,
    private readonly logicalTable: (physical: string) => string | undefined,
  ) {
    super(db);
  }
  override async getTables(options?: DatabaseMetadataOptions) {
    const tables = await super.getTables(options);
    return tables.flatMap((table) => {
      const name = this.logicalTable(table.name);
      return name ? [{ ...table, name }] : [];
    });
  }
}
export function createNativeAuthDatabase(
  pool: Pool,
  guard?: CatalogOwnershipGuard,
  logicalTable: (physical: string) => string | undefined = (name) => name,
) {
  const driver: Driver = {
    async init() {},
    async acquireConnection() {
      return new AuthConnection(await pool.getConnection(), guard);
    },
    async beginTransaction(connection) {
      await (connection as AuthConnection).begin();
    },
    async commitTransaction(connection) {
      await (connection as AuthConnection).commit();
    },
    async rollbackTransaction(connection) {
      await (connection as AuthConnection).rollback();
    },
    async releaseConnection(connection) {
      await (connection as AuthConnection).release();
    },
    async destroy() {
      /* Runtime owns pool. */
    },
  };
  const dialect: Dialect = {
    createDriver: () => driver,
    createQueryCompiler: () => new MysqlQueryCompiler(),
    createAdapter: () => new MysqlAdapter(),
    createIntrospector: (db) => new CatalogIntrospector(db, logicalTable),
  };
  return {
    db: new Kysely<Record<string, never>>({ dialect }),
    type: "mysql" as const,
    transaction: false,
  };
}
