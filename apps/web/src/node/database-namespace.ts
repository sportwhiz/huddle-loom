import { createHash } from "node:crypto";
import type { Pool } from "mysql2/promise";
import {
  CATALOG_DDL,
  CATALOG_FOREIGN_KEYS,
  CATALOG_MIGRATIONS,
  CATALOG_TABLES,
  CATALOG_TRIGGERS,
} from "./catalog-schema";
import { NODE_MIGRATIONS } from "./migrations";

// A namespace is an installation boundary within a provider-managed database.
// Existing installations keep their original names when this setting is absent.
export function validateDatabaseNamespace(value: string | undefined) {
  if (value === undefined || value === "") return "";
  if (!/^[a-z][a-z0-9_]{0,15}$/.test(value))
    throw new Error(
      "HUDDLE_DATABASE_NAMESPACE must be 1–16 lowercase letters, digits or underscores, starting with a letter.",
    );
  return value;
}

const objects = new Set<string>([
  ...Object.keys(CATALOG_TABLES),
  ...CATALOG_FOREIGN_KEYS.map((item) => item.name),
  ...CATALOG_TRIGGERS.map((item) => item.name),
  "hl_catalog_schema",
  "hl_catalog_mutex",
  "hl_catalog_migrations",
  "hl_catalog_migration_steps",
  "hl_catalog_migration_intents",
  "hl_node_migrations",
  "node_room_values",
  "node_room_alarms",
  "node_blobs",
  "node_blob_chunks",
]);
const definitions = [
  ...CATALOG_DDL.map((item) => item.sql),
  ...CATALOG_FOREIGN_KEYS.map((item) => item.sql),
  ...CATALOG_MIGRATIONS.flatMap((item) => item.steps.map((step) => step.sql)),
  ...NODE_MIGRATIONS.flatMap((item) => item.statements),
];
for (const sql of definitions) {
  for (const match of sql.matchAll(
    /\b(?:CREATE\s+TABLE(?:\s+IF\s+NOT\s+EXISTS)?|REFERENCES|CONSTRAINT|CREATE\s+(?:UNIQUE\s+)?INDEX|(?:UNIQUE\s+)?KEY|INDEX)\s+`?([a-zA-Z_][a-zA-Z_0-9]*)`?/g,
  ))
    objects.add(match[1]);
}

function databaseNames(namespace: string) {
  validateDatabaseNamespace(namespace);
  return new Map(
    [...objects].map((name) => {
      const candidate = `hn_${namespace}_${name}`;
      return [
        name,
        candidate.length <= 64
          ? candidate
          : `${candidate.slice(0, 47)}_${createHash("sha256").update(candidate).digest("hex").slice(0, 16)}`,
      ];
    }),
  );
}

export function logicalDatabaseTable(namespace: string) {
  if (!namespace) return (name: string): string | undefined => name;
  const names = new Map(
    [...databaseNames(namespace)].map(([logical, physical]) => [
      physical,
      logical,
    ]),
  );
  return (name: string): string | undefined => names.get(name);
}

export function namespaceSql(namespace: string) {
  const names = databaseNames(namespace);
  const identifier = (name: string) => names.get(name) ?? name;
  return (sql: string, values?: unknown[]) => {
    if (!namespace) return { sql, values };
    const metadata = /\binformation_schema\s*\./i.test(sql);
    // Tokenize quotations/comments before identifiers. Never replace names in
    // application literals, JSON paths, comments, or user-supplied parameters.
    const scoped = sql.replace(
      /\/\*[\s\S]*?\*\/|--[^\r\n]*|#[^\r\n]*|'(?:[^'\\]|\\.|'')*'|"(?:[^"\\]|\\.|"")*"|`(?:[^`]|``)*`|\b[a-zA-Z_][a-zA-Z_0-9]*\b/g,
      (token) => {
        if (
          token.startsWith("/*") ||
          token.startsWith("--") ||
          token.startsWith("#")
        )
          return token;
        if (token[0] === "`")
          return `\`${identifier(token.slice(1, -1).replaceAll("``", "`"))}\``;
        if (token[0] === "'" || token[0] === '"') {
          if (!metadata) return token;
          const name = token.slice(1, -1);
          return names.has(name)
            ? `${token[0]}${identifier(name)}${token[0]}`
            : token;
        }
        return identifier(token);
      },
    );
    const advisory = /\b(?:GET_LOCK|RELEASE_LOCK|IS_USED_LOCK)\s*\(/i.test(sql);
    const parameters = values?.map((value) => {
      if (typeof value !== "string") return value;
      if (metadata) return identifier(value);
      if (advisory && /^(?:huddle-rooms:|hl-migrate-)/.test(value))
        return `hn-lock:${createHash("sha256").update(`${namespace}\0${value}`).digest("hex").slice(0, 48)}`;
      return value;
    });
    return { sql: scoped, values: parameters };
  };
}

/** Every pool/transaction/auth/storage query uses the same physical namespace.
 * This is data isolation between deployment variants, not a SQL privilege boundary.
 * Never hand the unwrapped pool to an application service. */
export function namespaceMysqlPool(pool: Pool, namespace: string): Pool {
  if (!namespace) return pool;
  const scope = namespaceSql(namespace);
  const connections = new WeakMap<object, object>();
  function wrap<T extends object>(target: T): T {
    return new Proxy(target, {
      get(object, property) {
        const value = Reflect.get(object, property, object);
        if (property === "getConnection" && typeof value === "function")
          return async () => {
            const connection = (await Reflect.apply(
              value,
              object,
              [],
            )) as object;
            let wrapped = connections.get(connection);
            if (!wrapped) {
              wrapped = wrap(connection);
              connections.set(connection, wrapped);
            }
            return wrapped;
          };
        if (
          (property === "query" || property === "execute") &&
          typeof value === "function"
        )
          return (sql: string, values?: unknown[]) => {
            if (typeof sql !== "string")
              throw new Error(
                "Namespaced database queries require explicit SQL.",
              );
            const scoped = scope(sql, values);
            return Reflect.apply(
              value,
              object,
              scoped.values === undefined
                ? [scoped.sql]
                : [scoped.sql, scoped.values],
            );
          };
        return typeof value === "function" ? value.bind(object) : value;
      },
    });
  }
  return wrap(pool);
}
