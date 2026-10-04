import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { deploymentAccount, deploymentToken } from "./installation-config.mjs";
import {
  buildInfo,
  schemaDigest,
} from "../../../scripts/releases/build-info.mjs";

const repository = "sportwhiz/huddle-loom";
const active = "('queued','building','deploying','verifying','uncertain')";
export const quote = (value) => "'" + String(value).replaceAll("'", "''") + "'";
function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    ...options,
  });
  if (result.status !== 0) {
    const error = new Error(`${command} failed. Inspect the build log.`);
    error.missingDatabase =
      /Couldn't find (?:an auto-provisioned D1 DB|a D1 DB)/.test(
        `${result.stderr ?? ""}\n${result.stdout ?? ""}`,
      );
    throw error;
  }
  return result.stdout;
}
export function databaseClient(config) {
  return (sql) => {
    const output = run("wrangler", [
      "d1",
      "execute",
      "CATALOG",
      "--remote",
      "--config",
      config,
      "--json",
      "--command",
      sql,
    ]);
    const parsed = JSON.parse(output);
    if (!Array.isArray(parsed) || parsed.some((r) => r.success === false))
      throw new Error("Update database command failed.");
    return parsed.flatMap((r) => r.results ?? []);
  };
}
function manifest(value) {
  if (
    !value ||
    !/^\d{1,5}\.\d{1,5}\.\d{1,5}$/.test(value.version) ||
    !/^[a-f0-9]{40}$/.test(value.commit) ||
    !/^[a-f0-9]{64}$/.test(value.schema) ||
    value.protocol !== 1 ||
    value.dataFormat !== 1
  )
    throw new Error("Unsupported release manifest.");
  return value;
}
export function preserveInstallation(releaseConfig, installed) {
  const config = structuredClone(releaseConfig);
  // Code entry points and migration files belong to the release. Resource
  // identities and operator configuration belong to the installation.
  for (const key of [
    "name",
    "account_id",
    "vars",
    "routes",
    "route",
    "workers_dev",
    "preview_urls",
    "limits",
    "observability",
    "send_email",
    "triggers",
    "placement",
    "custom_domains",
  ])
    if (installed[key] !== undefined)
      config[key] = structuredClone(installed[key]);
  config.keep_vars = true;
  for (const field of ["d1_databases", "r2_buckets", "durable_objects"]) {
    const expected =
      field === "durable_objects"
        ? (config[field]?.bindings ?? [])
        : (config[field] ?? []);
    const original =
      field === "durable_objects"
        ? (installed[field]?.bindings ?? [])
        : (installed[field] ?? []);
    const key = field === "durable_objects" ? "name" : "binding";
    if (
      expected.length !== original.length ||
      expected.some(
        (item) => !original.some((binding) => binding[key] === item[key]),
      )
    )
      throw new Error(
        "This release changes required storage bindings and needs a guided upgrade.",
      );
    const bindings = expected.map((item) => {
      const saved = original.find((binding) => binding[key] === item[key]);
      if (field === "durable_objects" && item.class_name !== saved.class_name)
        throw new Error("Durable Object class change needs a guided upgrade.");
      return {
        ...item,
        ...saved,
        ...(field === "d1_databases"
          ? { migrations_dir: item.migrations_dir }
          : {}),
      };
    });
    config[field] = field === "durable_objects" ? { bindings } : bindings;
  }
  return config;
}
export async function verifyDeployment(origin, release, fetcher = fetch) {
  const url = new URL("/api/v1/health", origin);
  if (url.protocol !== "https:")
    throw new Error("A public HTTPS installation address is required.");
  const response = await fetcher(url, {
    cache: "no-store",
    redirect: "error",
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) return false;
  const data = await response.json();
  return (
    data.ok === true &&
    data.release?.commit === release.commit &&
    data.release?.schema === release.schema
  );
}
export async function liveInstallation(installed, fetcher = fetch) {
  const account = installed.account_id ?? deploymentAccount(installed);
  if (!/^[a-f0-9]{32}$/i.test(account ?? ""))
    throw new Error(
      "Deployment credentials are required to preserve live installation settings.",
    );
  const token = deploymentToken();
  const response = await fetcher(
    `https://api.cloudflare.com/client/v4/accounts/${account}/workers/scripts/${installed.name}/settings`,
    {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(15000),
      redirect: "error",
    },
  );
  const data = await response.json();
  if (!response.ok || !data.success || !Array.isArray(data.result?.bindings))
    throw new Error("Could not read live installation settings.");
  const result = structuredClone(installed);
  result.vars = { ...result.vars };
  for (const binding of data.result.bindings) {
    if (binding.type === "plain_text") result.vars[binding.name] = binding.text;
    if (binding.type === "json") result.vars[binding.name] = binding.json;
    if (binding.type === "d1") {
      const entry = result.d1_databases?.find(
        (item) => item.binding === binding.name,
      );
      if (entry) {
        if (!binding.id) throw new Error("Live database identity is missing.");
        if (entry.database_id && entry.database_id !== binding.id)
          throw new Error("Live database identity differs from the installer.");
        if (!entry.database_id && entry.database_name) {
          const metadata = await fetcher(
            `https://api.cloudflare.com/client/v4/accounts/${account}/d1/database/${binding.id}`,
            {
              headers: { Authorization: `Bearer ${token}` },
              signal: AbortSignal.timeout(15000),
              redirect: "error",
            },
          );
          const detail = await metadata.json();
          if (
            !metadata.ok ||
            !detail.success ||
            detail.result?.name !== entry.database_name
          )
            throw new Error("Live database name differs from the installer.");
        }
        entry.database_id = binding.id;
      }
    }
    if (binding.type === "r2_bucket") {
      const entry = result.r2_buckets?.find(
        (item) => item.binding === binding.name,
      );
      if (entry) {
        if (!binding.bucket_name)
          throw new Error("Live bucket identity is missing.");
        entry.bucket_name = binding.bucket_name;
      }
    }
  }
  return result;
}
export async function managedDeployment(
  configPath,
  installed,
  dependencies = {},
) {
  const command = dependencies.command ?? run;
  const verify = dependencies.verify ?? verifyDeployment;
  const sleep =
    dependencies.sleep ??
    ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  if (
    process.env.HUDDLE_RELEASE_CHILD === "1" ||
    installed.vars?.AUTH_MODE !== "native"
  )
    return false;
  const db = dependencies.db ?? databaseClient(configPath);
  // Missing database/table is expected only on the first installer deployment.
  let exists;
  try {
    exists = db(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='software_update_settings'",
    ).length;
  } catch (error) {
    if (
      error.missingDatabase &&
      !installed.d1_databases?.find((x) => x.binding === "CATALOG")?.database_id
    )
      return false;
    throw error;
  }
  if (!exists) return false;
  const settings = db(
    "SELECT active_release,runner_origin,runner_seen_at FROM software_update_settings WHERE id='instance'",
  )[0];
  let job = db(
    `SELECT *,COALESCE(json_extract(release,'$.deploymentKind'),'update') AS kind FROM software_updates WHERE status IN ${active} LIMIT 1`,
  )[0];
  const readLive = async () => {
    const live = await (dependencies.liveInstallation ?? liveInstallation)(
      installed,
    );
    const configuredCatalog = JSON.parse(
      readFileSync(configPath, "utf8"),
    ).d1_databases?.find((x) => x.binding === "CATALOG");
    if (
      configuredCatalog?.database_id &&
      configuredCatalog.database_id !==
        live.d1_databases?.find((x) => x.binding === "CATALOG")?.database_id
    )
      throw new Error(
        "The live catalog differs from this installer. Reconnect the correct installation.",
      );
    if (
      settings?.runner_origin &&
      ![
        installed.vars.SOFTWARE_UPDATE_RUNNER_ORIGIN ?? installed.vars.AUTH_ORIGIN,
        live.vars.SOFTWARE_UPDATE_RUNNER_ORIGIN ?? live.vars.AUTH_ORIGIN,
      ].includes(settings.runner_origin)
    ) {
      throw new Error("Update runner belongs to a different installation origin.");
    }
    live.vars.SOFTWARE_UPDATE_RUNNER_ORIGIN =
      settings?.runner_origin ??
      installed.vars.SOFTWARE_UPDATE_RUNNER_ORIGIN ??
      installed.vars.AUTH_ORIGIN;
    return live;
  };
  const prepareSource = async () => {
    if (settings?.runner_seen_at || db("SELECT id FROM auth_users LIMIT 1").length) {
      // Ordinary source rebuilds also retain dashboard login/settings changes.
      Object.assign(installed, await readLive());
      writeFileSync(configPath, JSON.stringify(installed), { mode: 0o600 });
    }
    return false;
  };
  // Source deployments use the same singleton operation, but deploy their
  // already-built checkout instead of fetching a published release.
  if (job?.kind === "source") {
    if (
      job.status !== "queued" &&
      !(dependencies.recoverBootstrap === true && !settings?.runner_seen_at)
    )
      throw new Error(
        "Another deployment owns this installation. Recover it in Administration > Updates if its build has stopped.",
      );
    return prepareSource();
  }
  const selected = job?.release ?? settings?.active_release;
  if (!selected) return prepareSource();
  const target = manifest(JSON.parse(selected));
  const runner = randomUUID();
  if (job?.status === "deploying")
    throw new Error(
      "A deployment is still publishing. Confirm its build has stopped before recovering it in Administration > Updates.",
    );
  if (job && ["verifying", "uncertain"].includes(job.status)) {
    // Verification never republishes code. Its conditional writes cannot
    // overwrite a recovery request or a later deployment's release pointer.
    installed = await readLive();
    if (await verify(installed.vars.AUTH_ORIGIN, target).catch(() => false)) {
      db(
        `UPDATE software_update_settings SET active_release=${quote(selected)} WHERE id='instance' AND EXISTS(SELECT 1 FROM software_updates WHERE id=${quote(job.id)} AND runner_id IS ${job.runner_id === null ? "NULL" : quote(job.runner_id)} AND status IN ('verifying','uncertain'))`,
      );
      db(
        `UPDATE software_updates SET status='succeeded',updated_at=${Date.now()},message=NULL WHERE id=${quote(job.id)} AND runner_id IS ${job.runner_id === null ? "NULL" : quote(job.runner_id)} AND status IN ('verifying','uncertain')`,
      );
      return true;
    }
    throw new Error(
      "An earlier deployment needs verification. Check Cloudflare build history before recovering it.",
    );
  }
  if (!job) {
    const id = randomUUID();
    const claimed = db(
      `INSERT INTO software_updates(id,release,previous_release,version,status,runner_id,created_at,updated_at)
       SELECT ${quote(id)},json_set(active_release,'$.deploymentKind','rebuild'),active_release,${quote(target.version)},'building',${quote(runner)},${Date.now()},${Date.now()}
       FROM software_update_settings WHERE id='instance' AND active_release=${quote(selected)}
       AND NOT EXISTS(SELECT 1 FROM software_updates WHERE status IN ${active}) RETURNING *`,
    );
    if (!claimed.length)
      throw new Error("Another deployment owns this installation.");
    job = claimed[0];
  } else {
    const claimed = db(
      `UPDATE software_updates SET status='building',runner_id=${quote(runner)},updated_at=${Date.now()} WHERE id=${quote(job.id)} AND status='queued' RETURNING id`,
    );
    if (!claimed.length) throw new Error("Another build owns this update.");
  }
  let directory;
  let phase = "building";
  try {
    installed = await readLive();
    directory = mkdtempSync(resolve(tmpdir(), "huddle-release-"));
    console.log(`Preparing Huddle Loom ${target.version}.`);
    command("git", ["init", directory]);
    command(
      "git",
      [
        "-C",
        directory,
        "fetch",
        "--depth=1",
        `https://github.com/${repository}.git`,
        target.commit,
      ],
      { stdio: "inherit" },
    );
    command("git", ["-C", directory, "checkout", "--detach", "FETCH_HEAD"], {
      stdio: "inherit",
    });
    const actual = command("git", [
      "-C",
      directory,
      "rev-parse",
      "HEAD",
    ]).trim();
    if (
      actual !== target.commit ||
      schemaDigest(directory) !== target.schema ||
      JSON.parse(readFileSync(resolve(directory, "package.json"), "utf8"))
        .version !== target.version
    )
      throw new Error("Release integrity check failed.");
    const source = JSON.parse(
      readFileSync(resolve(directory, "wrangler.jsonc"), "utf8"),
    );
    const merged = preserveInstallation(source, installed);
    writeFileSync(resolve(directory, "wrangler.jsonc"), JSON.stringify(merged));
    const environment = { ...process.env, HUDDLE_RELEASE_CHILD: "1" };
    environment.WHITEBOARD_WRANGLER_CONFIG = "../../wrangler.jsonc";
    command("pnpm", ["install", "--frozen-lockfile"], {
      cwd: directory,
      env: environment,
      stdio: "inherit",
    });
    command("pnpm", ["run", "build"], {
      cwd: directory,
      env: environment,
      stdio: "inherit",
    });
    if (job) {
      // A D1 bookmark is a catalog recovery checkpoint, not a backup of R2 or
      // Durable Objects. Updates never automatically restore live user data.
      const checkpoint = JSON.parse(
        command("wrangler", [
          "d1",
          "time-travel",
          "info",
          "CATALOG",
          "--config",
          configPath,
          "--json",
        ]),
      );
      if (!checkpoint.bookmark || typeof checkpoint.bookmark !== "string")
        throw new Error("Catalog recovery checkpoint unavailable.");
      const owned = db(
        `UPDATE software_updates SET checkpoint=COALESCE(checkpoint,${quote(checkpoint.bookmark)}),status='deploying',updated_at=${Date.now()} WHERE id=${quote(job.id)} AND runner_id=${quote(runner)} AND status='building' RETURNING id`,
      );
      if (!owned.length)
        throw new Error("Update ownership changed before deployment.");
    }
    phase = "deploying";
    command("pnpm", ["run", "deploy"], {
      cwd: directory,
      env: environment,
      stdio: "inherit",
    });
    phase = "verifying";
    if (job)
      db(
        `UPDATE software_updates SET status='verifying',updated_at=${Date.now()} WHERE id=${quote(job.id)} AND runner_id=${quote(runner)} AND status='deploying'`,
      );
    let verified = false;
    for (let attempt = 0; attempt < 12; attempt++) {
      if (await verify(installed.vars.AUTH_ORIGIN, target).catch(() => false)) {
        verified = true;
        break;
      }
      await sleep(5000);
    }
    if (!verified) throw new Error("The new version could not be confirmed.");
    db(
      `UPDATE software_update_settings SET active_release=${quote(selected)} WHERE id='instance' AND EXISTS(SELECT 1 FROM software_updates WHERE id=${quote(job.id)} AND runner_id=${quote(runner)} AND status IN ('deploying','verifying','uncertain'))`,
    );
    if (job)
      db(
        `UPDATE software_updates SET status='succeeded',message=NULL,updated_at=${Date.now()} WHERE id=${quote(job.id)} AND runner_id=${quote(runner)} AND status IN ('deploying','verifying','uncertain')`,
      );
    console.log(`Huddle Loom ${target.version} is live and verified.`);
    return true;
  } catch (error) {
    if (job)
      db(
        `UPDATE software_updates SET status=CASE WHEN checkpoint IS NULL AND ${quote(phase)}='building' THEN 'failed' ELSE 'uncertain' END,message=${quote(phase === "building" ? "Release preparation failed. Check the hosting build log; the update was not deployed." : "Deployment needs verification. Check Cloudflare build history before recovery.")},updated_at=${Date.now()} WHERE id=${quote(job.id)} AND runner_id=${quote(runner)} AND status IN ${active}`,
      );
    throw error;
  } finally {
    if (directory) rmSync(directory, { recursive: true, force: true });
  }
}
// Native source builds participate in the same database lock as release
// builds. Never expire a lock automatically. A caught bootstrap failure can
// requeue its own operation after its child process has stopped; an interrupted
// or registered deployment still requires owner-confirmed recovery.
export function beginSourceDeployment(
  configPath,
  installed,
  dependencies = {},
) {
  if (
    process.env.HUDDLE_RELEASE_CHILD === "1" ||
    installed.vars?.AUTH_MODE !== "native"
  )
    return null;
  const db = dependencies.db ?? databaseClient(configPath);
  const command = dependencies.command ?? run;
  let exists;
  try {
    exists = db(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='software_update_settings'",
    ).length;
  } catch (error) {
    if (
      error.missingDatabase &&
      !installed.d1_databases?.find((x) => x.binding === "CATALOG")?.database_id
    )
      return null;
    throw error;
  }
  if (!exists) return null; // First provisioning: acquire immediately after migrations.
  const release =
    dependencies.release ??
    buildInfo(fileURLToPath(new URL("../../../", import.meta.url)));
  const runner = randomUUID();
  let job = db(
    `SELECT *,COALESCE(json_extract(release,'$.deploymentKind'),'update') AS kind FROM software_updates WHERE status IN ${active} LIMIT 1`,
  )[0];
  if (job) {
    const target = JSON.parse(job.release);
    const bootstrapRecovery =
      dependencies.recoverBootstrap === true &&
      !db("SELECT runner_seen_at FROM software_update_settings WHERE id='instance'")[0]?.runner_seen_at;
    if (
      job.kind !== "source" ||
      (job.status !== "queued" && !bootstrapRecovery) ||
      !/^[a-f0-9]{40}$/.test(target.commit) ||
      target.commit !== release.commit ||
      target.schema !== release.schema
    )
      throw new Error(
        "Another deployment owns this installation. A recovered source build must use its original revision.",
      );
    if (
      !db(
        `UPDATE software_updates SET status='building',runner_id=${quote(runner)},updated_at=${Date.now()},message=NULL WHERE id=${quote(job.id)} AND release=${quote(job.release)} AND runner_id IS ${job.runner_id === null ? "NULL" : quote(job.runner_id)} AND status=${quote(job.status)}${bootstrapRecovery ? " AND EXISTS(SELECT 1 FROM software_update_settings WHERE id='instance' AND runner_seen_at IS NULL)" : ""} RETURNING id`,
      ).length
    )
      throw new Error("Another build owns this deployment.");
  } else {
    const id = randomUUID(),
      value = JSON.stringify({ ...release, deploymentKind: "source" });
    const rows =
      db(`INSERT INTO software_updates(id,release,previous_release,version,status,runner_id,created_at,updated_at)
      SELECT ${quote(id)},${quote(value)},${quote(value)},${quote(release.version)},'building',${quote(runner)},${Date.now()},${Date.now()}
      WHERE NOT EXISTS(SELECT 1 FROM software_updates WHERE status IN ${active})
      AND EXISTS(SELECT 1 FROM software_update_settings WHERE id='instance' AND active_release IS NULL) RETURNING *`);
    if (!rows.length)
      throw new Error(
        "Another deployment owns this installation. Re-run the build to use its selected release.",
      );
    job = rows[0];
  }
  const owned = `id=${quote(job.id)} AND runner_id=${quote(runner)}`;
  return {
    beginPublication() {
      const checkpoint = JSON.parse(
        command("wrangler", [
          "d1",
          "time-travel",
          "info",
          "CATALOG",
          "--config",
          configPath,
          "--json",
        ]),
      );
      if (typeof checkpoint.bookmark !== "string" || !checkpoint.bookmark)
        throw new Error("Catalog recovery checkpoint unavailable.");
      if (
        !db(
          `UPDATE software_updates SET checkpoint=COALESCE(checkpoint,${quote(checkpoint.bookmark)}),status='deploying',updated_at=${Date.now()} WHERE ${owned} AND status='building' RETURNING id`,
        ).length
      )
        throw new Error("Deployment ownership changed before publication.");
    },
    assertOwned() {
      if (
        !db(
          `SELECT id FROM software_updates WHERE ${owned} AND status='deploying'`,
        ).length
      )
        throw new Error("Deployment ownership changed before publication.");
    },
    finish() {
      db(
        `UPDATE software_updates SET status='succeeded',message=NULL,updated_at=${Date.now()} WHERE ${owned} AND status='deploying'`,
      );
    },
    fail() {
      db(
        `UPDATE software_updates SET status=CASE WHEN checkpoint IS NULL THEN 'failed' WHEN EXISTS(SELECT 1 FROM software_update_settings WHERE id='instance' AND runner_seen_at IS NULL) THEN 'queued' ELSE 'uncertain' END,runner_id=NULL,message='Source deployment stopped. Retry this exact Git revision in Cloudflare build history; its checkpoint and target are retained.',updated_at=${Date.now()} WHERE ${owned} AND status IN ${active}`,
      );
    },
  };
}
export async function registerRunner(configPath, installed) {
  if (
    installed.vars?.AUTH_MODE !== "native" ||
    process.env.HUDDLE_RELEASE_CHILD === "1"
  )
    return;
  const db = databaseClient(configPath);
  db(
    `UPDATE software_update_settings SET runner_seen_at=${Date.now()},runner_origin=${quote(installed.vars.SOFTWARE_UPDATE_RUNNER_ORIGIN ?? installed.vars.AUTH_ORIGIN)} WHERE id='instance'`,
  );
  const token = process.env.CLOUDFLARE_API_TOKEN ?? process.env.CF_API_TOKEN;
  const branch = process.env.WORKERS_CI_BRANCH;
  const account = installed.account_id ?? process.env.CLOUDFLARE_ACCOUNT_ID;
  if (!token || !branch || !/^[a-f0-9]{32}$/.test(account ?? "")) return;
  const endpoint = `https://api.cloudflare.com/client/v4/accounts/${account}/builds/workers/${installed.name}/deploy_hooks`;
  const headers = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };
  try {
    const inventory = await fetch(endpoint, {
      headers,
      signal: AbortSignal.timeout(15000),
    });
    if (!inventory.ok) throw new Error();
    const hooks = await inventory.json();
    let hook = hooks.result?.find(
      (h) =>
        h.deploy_hook_name === "Huddle Loom updates" && h.branch === branch,
    );
    if (!hook) {
      const response = await fetch(endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify({
          branch,
          deploy_hook_name: "Huddle Loom updates",
        }),
        signal: AbortSignal.timeout(15000),
      });
      const created = await response.json();
      if (!response.ok || !created.success) throw new Error();
      hook = created.result;
    }
    if (!/^[a-f0-9-]{36}$/.test(hook?.deploy_hook_uuid ?? ""))
      throw new Error();
    const secret = `https://api.cloudflare.com/client/v4/workers/builds/deploy_hooks/${hook.deploy_hook_uuid}`;
    // Only the hook reaches runtime; the account-wide build token stays in CI.
    run(
      "wrangler",
      ["secret", "put", "SOFTWARE_UPDATE_HOOK", "--config", configPath],
      { input: secret },
    );
    console.log("Connected administration updates to Cloudflare Builds.");
  } catch {
    console.log(
      "Automatic update connection was unavailable. An owner can connect a deployment hook in Administration > Updates. The application deployment succeeded.",
    );
  }
}
