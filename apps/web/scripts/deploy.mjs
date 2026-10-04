import {
  beginSourceDeployment,
  managedDeployment,
  registerRunner,
} from "./update-runner.mjs";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { installationConfig } from "./installation-config.mjs";
import { resolve, dirname } from "node:path";

const redirect = JSON.parse(
  readFileSync(".wrangler/deploy/config.json", "utf8"),
);
const originalConfig = resolve(".wrangler/deploy", redirect.configPath);
const builtConfig = await installationConfig(
  JSON.parse(readFileSync(originalConfig, "utf8")),
);
if (builtConfig.vars?.AUTH_MODE === "native") {
  // Deployment identity stays stable when the dashboard login address changes.
  // Preview deployments never set this variable.
  builtConfig.vars.SOFTWARE_UPDATE_RUNNER_ORIGIN ??= builtConfig.vars.AUTH_ORIGIN;
}
const config = resolve(
  dirname(originalConfig),
  `wrangler.install-${randomUUID()}.json`,
);
writeFileSync(config, JSON.stringify(builtConfig), { mode: 0o600 });
process.on("exit", () => rmSync(config, { force: true }));
// Hosting administrators use this only after cancelling/stopping a first
// rollout whose previous application cannot offer an Updates recovery screen.
const recovery = { recoverBootstrap: process.argv.includes("--recover-source") };
if (await managedDeployment(config, builtConfig, recovery)) process.exit(0);
const catalog = builtConfig.d1_databases?.find(
  (database) => database.binding === "CATALOG",
);
const migrationArgs = [
  "d1",
  "migrations",
  "apply",
  "CATALOG",
  "--remote",
  "--config",
  config,
];
const deployArgs = ["deploy", "--config", config];

function runWrangler(args) {
  const result = spawnSync("wrangler", args, {
    encoding: "utf8",
    env: process.env,
  });

  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);

  if (result.error) throw result.error;

  return result;
}

function requireSuccess(result, action) {
  if (result.status === 0) return;

  const status = result.status ?? 1;
  console.error(`${action} failed with exit code ${status}.`);
  const error = new Error(`${action} failed with exit code ${status}.`);
  error.exitCode = status;
  throw error;
}

let source = beginSourceDeployment(config, builtConfig, recovery);
try {
  source?.beginPublication();
  const migration = runWrangler(migrationArgs);

  if (migration.status !== 0) {
    const output = `${migration.stdout ?? ""}\n${migration.stderr ?? ""}`;
    // A new, explicitly named catalog lets an existing Worker start fresh
    // without inheriting its old database. Never provision after a SQL or
    // permission error, or replace an explicitly pinned database ID.
    const needsProvisioning =
      !catalog?.database_id &&
      ((output.includes("Couldn't find an auto-provisioned D1 DB") &&
        output.includes("Run 'wrangler deploy' to provision it")) ||
        (catalog?.database_name &&
          output.includes(
            `Couldn't find a D1 DB named '${catalog.database_name}' (bound as 'CATALOG') in the API. Run 'wrangler d1 create ${catalog.database_name}' to create it.`,
          )));

    if (!needsProvisioning) {
      requireSuccess(migration, "D1 migration");
    }

    console.log(
      "Provisioning Cloudflare resources for the first deployment...",
    );
    requireSuccess(runWrangler(deployArgs), "Initial resource provisioning");
    requireSuccess(
      runWrangler(migrationArgs),
      "D1 migration after provisioning",
    );
  }

  // Initial provisioning creates the lock table. Acquire before the final publish.
  if (!source) {
    if (await managedDeployment(config, builtConfig, recovery)) process.exit(0);
    source = beginSourceDeployment(config, builtConfig, recovery);
    source?.beginPublication();
  }
  source?.assertOwned();
  requireSuccess(runWrangler(deployArgs), "Worker deployment");
  await registerRunner(config, builtConfig);
  source?.finish();
} catch (error) {
  source?.fail();
  console.error(error.message);
  process.exitCode = error.exitCode ?? 1;
}
