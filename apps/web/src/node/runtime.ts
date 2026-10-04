import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";
import { resolve, sep } from "node:path";
import { realpath, mkdir, stat } from "node:fs/promises";
import { createPool } from "mysql2/promise";
import {
  logicalDatabaseTable,
  namespaceMysqlPool,
  validateDatabaseNamespace,
} from "./database-namespace";
import worker from "../worker";
import { SqliteCatalog } from "./sqlite-catalog";
import { MysqlCatalog } from "./mysql-catalog";
import { migrateCatalogSchema } from "./catalog-schema";
import { createNativeAuthDatabase } from "./auth-database";
import { buildMysqlPoolOptions, MysqlCoordinationStore } from "./database";
import { migrateNodeDatabase } from "./migrations";
import {
  createNodeRooms,
  acquireNodeOwnership,
  type NodeOwnership,
} from "./rooms";
import { createMysqlBlobBucket } from "./blobs";
import { createNodeHttpServer, staticAssets } from "./http";
import { sendGoDaddyMail } from "./godaddy-mail";
import { installationEnvironment } from "../auth/installation-keys";
import { securityMaintenance } from "../security/maintenance";
import { mailEnvironment } from "../mail/setup";
import type { NativeEnv } from "../auth/types";

type Environment = Record<string, string | undefined>;
export type NodeStartupPhase =
  | "configuration"
  | "assets"
  | "database"
  | "ownership"
  | "schema"
  | "keys"
  | "listen";
export class NodeStartupError extends Error {
  constructor(
    readonly phase: NodeStartupPhase,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "NodeStartupError";
  }
}
export function startupFailure(
  phase: NodeStartupPhase,
  error: unknown,
): NodeStartupError {
  if (error instanceof NodeStartupError) return error;
  const code =
    typeof error === "object" && error
      ? String((error as { code?: unknown }).code ?? "")
      : "";
  const errno =
    typeof error === "object" && error
      ? Number((error as { errno?: unknown }).errno)
      : 0;
  const message = error instanceof Error ? error.message : "";
  if (code === "ER_ACCESS_DENIED_ERROR" || errno === 1045)
    return new NodeStartupError(
      phase,
      "DATABASE_CREDENTIALS",
      "Check the managed database credentials supplied to this app.",
    );
  if (/CERT|SSL|TLS|SELF_SIGNED|UNABLE_TO_VERIFY/.test(code))
    return new NodeStartupError(
      phase,
      "DATABASE_TLS",
      "Check the database TLS requirements and trusted CA configuration.",
    );
  if (
    [
      "ENOTFOUND",
      "ECONNREFUSED",
      "ETIMEDOUT",
      "PROTOCOL_CONNECTION_LOST",
    ].includes(code)
  )
    return new NodeStartupError(
      phase,
      "DATABASE_UNREACHABLE",
      "Check that the managed database is available and reachable by this app.",
    );
  if (phase === "schema" && [1142, 1227, 1419].includes(errno))
    return new NodeStartupError(
      phase,
      "SCHEMA_PERMISSIONS",
      "The database account cannot install the required schema or security triggers. Confirm hosting database support.",
    );
  const defaults: Record<NodeStartupPhase, [string, string]> = {
    configuration: [
      "INVALID_CONFIGURATION",
      "Check AUTH_ORIGIN, PORT and the selected Node hosting settings.",
    ],
    assets: [
      "ASSETS_UNAVAILABLE",
      "Deploy the complete generated Node package, including client assets.",
    ],
    database: [
      "DATABASE_CONFIGURATION",
      "Check the injected DB_HOST, DB_PORT, DB_NAME, DB_USER, DB_PASSWORD and TLS settings.",
    ],
    ownership: [
      "OWNERSHIP_UNAVAILABLE",
      "Another app instance may still own this database. Stop it before starting a replacement.",
    ],
    schema: [
      "SCHEMA_INITIALIZATION",
      "Check schema compatibility and database privileges. Resume an interrupted upgrade with the same compatible release; rollback requires a matching database backup.",
    ],
    keys: [
      "INSTALLATION_KEYS",
      "Installation keys could not be verified. Restore the original keys and matching database backup.",
    ],
    listen: [
      "LISTENER_START",
      "Check that the assigned PORT is available and permitted.",
    ],
  };
  if (
    phase === "configuration" &&
    (/AUTH_ORIGIN/.test(message) || code === "ERR_INVALID_URL")
  )
    return new NodeStartupError(
      phase,
      "CANONICAL_ORIGIN",
      "Set AUTH_ORIGIN to the exact public HTTPS origin of this installation.",
    );
  if (phase === "assets" && /catalog directory/.test(message))
    return new NodeStartupError(
      phase,
      "PRIVATE_STORAGE",
      "Use a private catalog directory outside the public assets tree.",
    );
  if (phase === "configuration" && /setup password/i.test(message))
    return new NodeStartupError(
      phase,
      "SETUP_PASSWORD",
      "Set a private SETUP_PASSWORD of at least 16 characters for initial owner setup.",
    );
  if (
    phase === "schema" &&
    /history|checksum|altered|newer|frozen|Unsupported/i.test(message)
  )
    return new NodeStartupError(
      phase,
      "SCHEMA_VERSION",
      "The database migration history does not match this release. Use a compatible release; do not edit recorded checksums.",
    );
  if (phase === "listen" && code === "EADDRINUSE")
    return new NodeStartupError(
      phase,
      "PORT_IN_USE",
      "The assigned PORT is already in use. Stop the conflicting process or check the hosting port configuration.",
    );
  return new NodeStartupError(phase, ...defaults[phase]);
}
export function formatNodeStartupError(error: unknown): string {
  const safe =
    error instanceof NodeStartupError
      ? error
      : new NodeStartupError(
          "configuration",
          "STARTUP_FAILED",
          "Check the documented Node hosting configuration.",
        );
  return `Open Whiteboard startup failed [${safe.phase}/${safe.code}]: ${safe.message}`;
}
const APPLICATION_SETTINGS = [
  "AUTH_SECRET",
  "AUTH_SECRETS",
  "AUTH_ENCRYPTION_KEYS",
  "GITHUB_CLIENT_ID",
  "GITHUB_CLIENT_SECRET",
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "OIDC_CONFIG",
  "OIDC_ALLOWED_ORIGINS",
  "CIMD_ALLOWED_ORIGINS",
] as const;
/** Only documented application settings cross the process/application boundary. */
export function nodeApplicationSettings(
  config: Environment,
): Partial<NativeEnv> {
  return Object.fromEntries(
    APPLICATION_SETTINGS.flatMap((key) =>
      config[key] ? [[key, config[key]]] : [],
    ),
  );
}
/** Allow durable background work a short grace period; abandoned work retries after restart. */
export async function drainNodeTasks(
  tasks: Promise<unknown>[],
  timeoutMs = 2000,
) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.allSettled(tasks),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
/** Each resource is attempted even if a previous close failed. */
export async function closeNodeResources(
  closers: (() => void | Promise<void>)[],
) {
  const errors: unknown[] = [];
  for (const close of closers) {
    try {
      await close();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length)
    throw new AggregateError(errors, "Node runtime cleanup failed");
}
export function validateNodeConfiguration(config: Environment) {
  const platform = config.HUDDLE_PLATFORM ?? "godaddy";
  if (!["godaddy", "node-mysql", "node-private-volume"].includes(platform))
    throw new Error("Unknown Node hosting platform.");
  if (platform === "node-private-volume" && !config.HUDDLE_DATA_DIRECTORY)
    throw new Error("A private durable HUDDLE_DATA_DIRECTORY is required.");
  if (!config.AUTH_ORIGIN)
    throw new Error(
      "An explicit canonical AUTH_ORIGIN is required; request headers are not trusted for installation ownership.",
    );
  const origin = new URL(config.AUTH_ORIGIN);
  if (
    origin.origin !== config.AUTH_ORIGIN ||
    !(
      origin.protocol === "https:" ||
      (config.ENVIRONMENT === "test" &&
        origin.protocol === "http:" &&
        ["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname))
    )
  )
    throw new Error(
      "AUTH_ORIGIN must be an exact HTTPS origin (loopback HTTP is allowed only in tests).",
    );
  if (config.SETUP_PASSWORD && config.SETUP_PASSWORD.length < 16)
    throw new Error(
      "Choose a private setup password of at least 16 characters before deployment.",
    );
  const port = Number(config.PORT ?? 3000);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535)
    throw new Error("PORT is invalid.");
  return {
    port,
    origin: origin.origin,
    platform,
    databaseNamespace: validateDatabaseNamespace(
      config.HUDDLE_DATABASE_NAMESPACE,
    ),
    directory: config.HUDDLE_DATA_DIRECTORY
      ? resolve(config.HUDDLE_DATA_DIRECTORY)
      : platform === "godaddy"
        ? "/private/huddle-loom"
        : undefined,
  };
}

/** Native Node runtime. Provider deployment qualification is tracked separately. */
export async function startNodeRuntime(config: Environment = process.env) {
  let settings: ReturnType<typeof validateNodeConfiguration>;
  try {
    settings = validateNodeConfiguration(config);
  } catch (error) {
    throw startupFailure("configuration", error);
  }
  let pool: ReturnType<typeof createPool>;
  try {
    pool = namespaceMysqlPool(
      createPool(buildMysqlPoolOptions(config)),
      settings.databaseNamespace,
    );
  } catch (error) {
    throw startupFailure("database", error);
  }
  let phase: NodeStartupPhase = "assets";
  // mysql2 exposes the pool connection event and connection.destroy publicly.
  // Track only handles created by this runtime, never inspect pool internals.
  const databaseConnections = new Set<{ threadId: number; destroy(): void }>();
  pool.on("connection", (connection) => {
    databaseConnections.add(connection);
    connection.on("end", () => databaseConnections.delete(connection));
  });
  const destroyDatabaseConnections = (preservedThread?: number) => {
    for (const connection of databaseConnections)
      if (connection.threadId !== preservedThread) connection.destroy();
  };
  let catalog: SqliteCatalog | MysqlCatalog | undefined;
  let catalogClosed = false;
  const closeCatalog = () => {
    if (catalog && !catalogClosed) {
      catalogClosed = true;
      catalog.close();
    }
  };
  let rooms: Awaited<ReturnType<typeof createNodeRooms>> | undefined;
  let http: ReturnType<typeof createNodeHttpServer> | undefined;
  const pending = new Set<Promise<unknown>>();
  let interval: ReturnType<typeof setInterval> | undefined;
  let stopped = false;
  let ownership: NodeOwnership | undefined;
  let fatalError: Error | undefined;
  let closing: Promise<void> | undefined;
  let notifyFailure!: (error: Error) => void;
  const failure = new Promise<Error>((resolve) => {
    notifyFailure = resolve;
  });
  const context = {
    waitUntil(task: Promise<unknown>) {
      pending.add(task);
      task
        .catch(() => console.error("Background work will be retried."))
        .finally(() => pending.delete(task));
    },
  };
  function close() {
    if (closing) return closing;
    stopped = true;
    if (interval) clearInterval(interval);
    return (closing = closeNodeResources([
      () => http?.close(),
      () => drainNodeTasks([...pending]),
      () => destroyDatabaseConnections(ownership?.connection.threadId),
      async () => {
        let drained = !rooms;
        await drainNodeTasks(rooms ? [rooms.close().then(() => { drained = true; })] : []);
        // Never release a live room writer's lock. If it cannot drain, close
        // its socket so MySQL rolls it back before freeing exclusive ownership.
        await ownership?.close(!drained);
      },
      () => destroyDatabaseConnections(),
      closeCatalog,
      () => drainNodeTasks([pool.end()]),
    ]));
  }
  async function acquireOwnership() {
    phase = "ownership";
    ownership = await acquireNodeOwnership(pool);
    ownership.onLoss(() => {
      fatalError = new Error("Installation database ownership was lost");
      destroyDatabaseConnections();
      if (catalog instanceof SqliteCatalog) closeCatalog();
      notifyFailure(fatalError);
      if (http)
        void close().catch(() =>
          console.error("Runtime cleanup failed after ownership loss."),
        );
    });
    await ownership.drainCatalog();
  }
  const isReady = () => !stopped && !fatalError && ownership?.healthy === true;
  try {
    const assetsDirectory = await realpath(
      config.HUDDLE_ASSETS_DIRECTORY ?? resolve("client"),
    );
    if (
      settings.platform === "node-private-volume" ||
      settings.platform === "godaddy"
    ) {
      // Preserve the legacy location; scoped installations always get a distinct catalog.
      const catalogDirectory = settings.databaseNamespace
        ? resolve(settings.directory!, settings.databaseNamespace)
        : settings.directory!;
      await mkdir(catalogDirectory, { recursive: true, mode: 0o700 });
      const dataDirectory = await realpath(catalogDirectory);
      if (
        dataDirectory === assetsDirectory ||
        dataDirectory.startsWith(assetsDirectory + sep)
      )
        throw new Error(
          "The catalog directory must be outside the public assets directory.",
        );
      if ((await stat(dataDirectory)).mode & 0o077)
        throw new Error(
          "The catalog directory must be private to the application user.",
        );
      await acquireOwnership();
      phase = "schema";
      await migrateNodeDatabase(pool);
      // Refuse switching an initialized legacy MySQL catalog to a fresh SQLite file.
      const [tables] = await pool.execute(
        "SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='installation'",
      );
      if ((tables as unknown[]).length) {
        const [existing] = await pool.execute(
          "SELECT state FROM installation WHERE id='instance'",
        );
        if ((existing as { state: string }[])[0]?.state === "ready")
          throw new Error(
            "An initialized MySQL catalog exists. Keep its backend settings or perform an explicit migration.",
          );
      }
      await new MysqlCoordinationStore(pool).bindCatalogIdentity(
        createHash("sha256").update(`sqlite:${dataDirectory}`).digest(),
      );
      const establishedCatalog = await new MysqlCoordinationStore(
        pool,
      ).hasCatalogIdentity();
      if (establishedCatalog) {
        try {
          await stat(resolve(dataDirectory, "catalog.sqlite"));
        } catch {
          throw new Error(
            "Initialized catalog file is missing. Restore the complete installation from backup.",
          );
        }
      }
      catalog = await SqliteCatalog.open(
        resolve(dataDirectory, "catalog.sqlite"),
      );
      if (establishedCatalog) {
        const identity = await catalog
          .prepare("SELECT 1 FROM installation WHERE id='instance'")
          .first();
        if (!identity)
          throw new Error(
            "Initialized catalog is missing. Restore the complete installation from backup.",
          );
        if (
          (await new MysqlCoordinationStore(pool).hasCompletedCatalog()) &&
          !config.AUTH_SECRET &&
          !config.AUTH_ENCRYPTION_KEYS &&
          !(await catalog
            .prepare(
              "SELECT 1 FROM installation_key_identity WHERE id='automatic-v1'",
            )
            .first())
        )
          throw new Error(
            "Initialized catalog identity is missing. Restore the complete installation from backup.",
          );
      }
      await catalog.migrate(
        config.HUDDLE_MIGRATIONS_DIRECTORY ?? resolve("migrations"),
      );
    } else {
      await acquireOwnership();
      phase = "schema";
      await migrateNodeDatabase(pool);
      await new MysqlCoordinationStore(pool).bindCatalogIdentity(
        createHash("sha256").update("mysql").digest(),
      );
      if (await new MysqlCoordinationStore(pool).hasCatalogIdentity()) {
        const [tables] = await pool.execute(
          "SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='installation_key_identity'",
        );
        if (!(tables as unknown[]).length)
          throw new Error(
            "Initialized catalog is missing. Restore the complete installation from backup.",
          );
        const completed = await new MysqlCoordinationStore(
          pool,
        ).hasCompletedCatalog();
        const [identity] = await pool.execute(
          !completed || config.AUTH_SECRET || config.AUTH_ENCRYPTION_KEYS
            ? "SELECT 1 FROM installation WHERE id='instance'"
            : "SELECT 1 FROM installation_key_identity WHERE id='automatic-v1'",
        );
        if (!(identity as unknown[]).length)
          throw new Error(
            "Initialized catalog identity is missing. Restore the complete installation from backup.",
          );
      }
      await migrateCatalogSchema(pool);
      catalog = new MysqlCatalog(
        pool,
        ownership!.assertCatalogConnection,
        logicalDatabaseTable(settings.databaseNamespace),
      );
      await catalog.initializeMetadata();
    }
    const sql = catalog as unknown as D1Database;
    const installation = await sql
      .prepare("SELECT state FROM installation WHERE id='instance'")
      .first<{ state: string }>();
    if (installation?.state !== "ready" && !config.SETUP_PASSWORD)
      throw startupFailure(
        "configuration",
        new Error("Missing setup password"),
      );
    rooms = await createNodeRooms(pool, sql, ownership);
    const keyStore = new MysqlCoordinationStore(pool);
    const keysBinding = {
      idFromName: (name: string) => name,
      get: () => ({
        async fetch() {
          // Once catalog identity exists, key loss must never silently create a
          // replacement installation. Existing env overrides are handled upstream.
          const initialized = await sql
            .prepare(
              "SELECT 1 FROM installation_key_identity WHERE id='automatic-v1'",
            )
            .first();
          const read = (name: string, bytes: number) =>
            initialized
              ? keyStore.readSecret(name, bytes)
              : keyStore.getOrCreateSecret(name, bytes);
          const secret = await read("installation-auth-v1", 48);
          const encryption = await read("installation-encryption-v1", 32);
          return Response.json({
            AUTH_SECRET: Buffer.from(secret).toString("base64url"),
            AUTH_ENCRYPTION_KEYS: JSON.stringify([
              {
                id: "installation-v1",
                key: Buffer.from(encryption).toString("base64url"),
              },
            ]),
          });
        },
      }),
    };
    const env = {
      CATALOG: sql,
      ...(catalog instanceof MysqlCatalog
        ? {
            AUTH_DATABASE: createNativeAuthDatabase(
              pool,
              ownership!.assertCatalogConnection,
              logicalDatabaseTable(settings.databaseNamespace),
            ),
          }
        : {}),
      BLOBS: (await createMysqlBlobBucket(pool)) as unknown as R2Bucket,
      BOARD_ROOMS: rooms as unknown as DurableObjectNamespace,
      INSTALLATION_KEYS: keysBinding as unknown as DurableObjectNamespace,
      ASSETS: await staticAssets(
        config.HUDDLE_ASSETS_DIRECTORY ?? resolve("client"),
      ),
      HOSTING_PLATFORM:
        settings.platform === "godaddy" ||
        config.HUDDLE_MAIL_GATEWAY === "godaddy"
          ? "godaddy"
          : "node",
      AUTH_MODE: "native",
      ACCESS_INTEGRATION: "off",
      ENVIRONMENT: config.ENVIRONMENT ?? "production",
      AUTH_ORIGIN: settings.origin,
      SETUP_PASSWORD: config.SETUP_PASSWORD,
      ...nodeApplicationSettings(config),
      ...(config.HUDDLE_MAIL_GATEWAY === "godaddy" ||
      (settings.platform === "godaddy" && config.HUDDLE_MAIL_GATEWAY !== "off")
        ? { MAIL_PROVIDER: "godaddy", MANAGED_MAIL: { send: sendGoDaddyMail } }
        : {}),
    } as NativeEnv & {
      ASSETS: Fetcher;
      BOARD_ROOMS: DurableObjectNamespace;
      BLOBS: R2Bucket;
    };
    // Verify durable key identity before accepting requests, including restarts.
    phase = "keys";
    await installationEnvironment(env);
    await keyStore.getOrCreateSecret("catalog-provisioned-v1", 32);
    if (!isReady())
      throw fatalError ?? new Error("Installation ownership unavailable");
    phase = "listen";
    http = createNodeHttpServer(
      {
        fetch: (request) => {
          if (!isReady())
            return Promise.resolve(
              new Response("Service unavailable", {
                status: 503,
                headers: { "Cache-Control": "no-store" },
              }),
            );
          if (new URL(request.url).pathname === "/healthz")
            return Promise.resolve(
              Response.json(
                { ready: true },
                { headers: { "Cache-Control": "no-store" } },
              ),
            );
          return worker.fetch(request, env, context as ExecutionContext);
        },
      },
      settings.origin,
    );
    await new Promise<void>((resolve, reject) => {
      http!.server.once("error", reject);
      http!.server.listen(settings.port, "0.0.0.0", () => {
        http!.server.removeListener("error", reject);
        resolve();
      });
    });
    if (!isReady())
      throw fatalError ?? new Error("Installation ownership unavailable");
    let maintaining = false;
    const maintain = () => {
      if (maintaining || stopped) return;
      maintaining = true;
      const work = installationEnvironment(env)
        .then(mailEnvironment)
        .then(securityMaintenance);
      context.waitUntil(
        work.finally(() => {
          maintaining = false;
        }),
      );
    };
    interval = setInterval(maintain, 60_000);
    interval.unref();
    return { close, port: settings.port, failure, isReady };
  } catch (error) {
    try {
      await close();
    } catch {
      /* Preserve startup phase; every resource was attempted. */
    }
    throw startupFailure(phase, error);
  }
}
