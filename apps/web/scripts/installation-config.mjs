import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";

const commandOptions = (environment) => ({
  encoding: "utf8",
  // `wrangler auth token` otherwise writes its output to Wrangler's debug log.
  env: {
    ...environment,
    CI: "true",
    WRANGLER_WRITE_LOGS: "false",
    WRANGLER_LOG: "log",
    WRANGLER_LOG_SANITIZE: "true",
  },
  stdio: "pipe",
  timeout: 30000,
  maxBuffer: 65536,
});

/** Capture Wrangler's supported credential output privately. Never forward the
 * command's stdout/stderr or attach it to an error: both can contain secrets. */
export function deploymentToken(environment = process.env, run = spawnSync) {
  const selected = environment.CLOUDFLARE_API_TOKEN ?? environment.CF_API_TOKEN;
  if (selected) return selected;
  try {
    const result = run(
      "wrangler",
      ["auth", "token", "--json"],
      commandOptions(environment),
    );
    if (result.status === 0) {
      const credentials = JSON.parse(result.stdout);
      if (
        ["oauth", "api_token"].includes(credentials.type) &&
        typeof credentials.token === "string" &&
        credentials.token.trim()
      ) {
        return credentials.token;
      }
    }
  } catch {
    /* Only the safe diagnostic below leaves this boundary. */
  }
  throw new Error(
    "Cloudflare authentication is unavailable. Run wrangler login, or configure CLOUDFLARE_API_TOKEN for automated builds.",
  );
}

export function deploymentAccount(
  config,
  environment = process.env,
  run = spawnSync,
) {
  const selected =
    environment.CLOUDFLARE_ACCOUNT_ID ??
    environment.CF_ACCOUNT_ID ??
    config.account_id;
  if (selected) return selected;
  let accounts;
  try {
    const result = run(
      "wrangler",
      ["whoami", "--json"],
      commandOptions(environment),
    );
    if (result.status === 0) accounts = JSON.parse(result.stdout).accounts;
  } catch {
    /* Do not echo credential/provider output. */
  }
  if (!Array.isArray(accounts))
    throw new Error(
      "Cloudflare could not identify the deployment account. Run wrangler login or reconnect the Cloudflare build.",
    );
  if (accounts?.length !== 1)
    throw new Error(
      "Cloudflare did not provide one deployment account. Select the account in the deployment form, or set account_id in the terminal configuration.",
    );
  return accounts[0].id;
}

export async function installationConfig(
  config,
  {
    environment = process.env,
    fetcher = fetch,
    accountId,
    run = spawnSync,
  } = {},
) {
  if (config.vars?.AUTH_MODE !== "native") return config;
  const name = environment.WRANGLER_CI_OVERRIDE_NAME ?? config.name;
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/u.test(name ?? ""))
    throw new Error("A valid Cloudflare Worker name is required.");
  const defaults = new Map(
    ["huddle-loom"].flatMap((prefix) =>
      [
        "native-catalog",
        "native-blobs",
        "preview-catalog",
        "preview-blobs",
      ].map((suffix) => [`${prefix}-${suffix}`, suffix]),
    ),
  );
  const resourceName = (value) => {
    const suffix = defaults.get(value);
    if (!suffix) return value; // Deliberately named resources retain their identity.
    const candidate = `${name}-${suffix}`;
    // Worker names can be 63 characters before adding a storage suffix.
    if (candidate.length <= 63) return candidate;
    const digest = createHash("sha256")
      .update(candidate)
      .digest("hex")
      .slice(0, 12);
    return `${candidate.slice(0, 50)}-${digest}`;
  };
  const resources = (section) => ({
    ...section,
    ...(section.d1_databases
      ? {
          d1_databases: section.d1_databases.map((binding) =>
            binding.database_id
              ? binding
              : {
                  ...binding,
                  database_name: resourceName(binding.database_name),
                },
          ),
        }
      : {}),
    ...(section.r2_buckets
      ? {
          r2_buckets: section.r2_buckets.map((binding) => ({
            ...binding,
            bucket_name: resourceName(binding.bucket_name),
          })),
        }
      : {}),
  });
  const scoped = {
    ...resources(config),
    name,
    ...(config.previews ? { previews: resources(config.previews) } : {}),
  };
  // Storage isolation must also apply when a custom domain is explicitly set.
  if (config.vars.AUTH_ORIGIN) return scoped;
  const account = accountId ?? deploymentAccount(config, environment, run);
  if (!/^[a-f0-9]{32}$/iu.test(account ?? ""))
    throw new Error("A valid Cloudflare deployment account is required.");
  const token = deploymentToken(environment, run);
  let subdomain;
  try {
    const response = await fetcher(
      `https://api.cloudflare.com/client/v4/accounts/${account}/workers/subdomain`,
      {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(30000),
        redirect: "error",
      },
    );
    const result = await response.json();
    if (response.ok && result.success) subdomain = result.result?.subdomain;
  } catch {
    /* Only the safe diagnostic below leaves this boundary. */
  }
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/u.test(subdomain ?? ""))
    throw new Error(
      "Cloudflare could not find the workers.dev address for this account.",
    );
  return {
    ...scoped,
    account_id: account,
    vars: {
      ...config.vars,
      AUTH_ORIGIN: `https://${name}.${subdomain}.workers.dev`,
    },
    ...(scoped.previews
      ? {
          previews: {
            ...scoped.previews,
            vars: {
              ...scoped.previews.vars,
              AUTH_ORIGIN:
                scoped.previews.vars?.AUTH_ORIGIN ??
                `https://staging-${name}.${subdomain}.workers.dev`,
            },
          },
        }
      : {}),
  };
}
