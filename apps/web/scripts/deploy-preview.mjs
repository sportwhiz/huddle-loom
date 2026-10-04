import { installationConfig, deploymentAccount, deploymentToken } from './installation-config.mjs';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// One persistent preview keeps OAuth callbacks, passkeys and Durable Objects
// on the same origin across branch builds. The latest preview build wins.
export const previewName = 'staging';

export function cloudflareApi(accountId, token, fetcher = fetch) {
  if (!/^[a-f0-9]{32}$/i.test(accountId ?? '') || !token) {
    throw new Error('Preview provisioning needs CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID (or account_id in Wrangler config). Configure the build token in Cloudflare Settings > Build.');
  }
  return async function request(path, body) {
    const response = await fetcher(`https://api.cloudflare.com/client/v4/accounts/${accountId}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    const data = await response.json();
    if (!response.ok || data.success !== true) {
      // Do not echo response bodies, request headers, or environment secrets.
      const codes = (data.errors ?? []).map(error => error.code).filter(Number.isInteger);
      const error = new Error(`Cloudflare ${body === undefined ? 'GET' : 'POST'} ${path.split('?')[0]} failed (HTTP ${response.status}; codes ${codes.join(', ') || 'unknown'}). Check the build token has D1 and Workers R2 Storage edit permissions.`);
      error.status = response.status;
      error.codes = codes;
      throw error;
    }
    return data;
  };
}

async function findDatabase(api, name) {
  for (let page = 1; ; page++) {
    const data = await api(`/d1/database?name=${encodeURIComponent(name)}&page=${page}&per_page=100`);
    const match = data.result.find(database => database.name === name);
    if (match) return match;
    if (data.result.length < 100 || page >= (data.result_info?.total_pages ?? Infinity)) return null;
  }
}

async function ensureDatabase(api, name, pinnedId) {
  const existing = await findDatabase(api, name);
  if (existing) return existing;
  if (pinnedId) throw new Error('Pinned preview database was not found; refusing to create a replacement.');
  try {
    return (await api('/d1/database', { name })).result;
  } catch (error) {
    // A simultaneous build may have created it. Never mask auth failures.
    if (error.status === 401 || error.status === 403) throw error;
    const raced = await findDatabase(api, name);
    if (raced) return raced;
    throw error;
  }
}

async function ensureBucket(api, name) {
  const path = `/r2/buckets/${encodeURIComponent(name)}`;
  try {
    await api(path);
    return;
  } catch (error) {
    // 10006 is R2's missing-bucket code (also used by Wrangler).
    if (!error.codes?.includes(10006) || error.status === 401 || error.status === 403) throw error;
  }
  try {
    await api('/r2/buckets', { name });
  } catch (error) {
    if (error.status === 401 || error.status === 403) throw error;
    // Verify a concurrent creation rather than retrying destructive operations.
    try { await api(path); } catch { throw error; }
  }
}

export async function deployPreview({ configPath, api, run, log = console.log, preparedConfig }) {
  const config = preparedConfig ?? JSON.parse(readFileSync(configPath, 'utf8'));
  const catalog = config.previews?.d1_databases?.find(item => item.binding === 'CATALOG');
  const bucket = config.previews?.r2_buckets?.find(item => item.binding === 'BLOBS');
  const productionCatalog = config.d1_databases?.find(item => item.binding === 'CATALOG');
  const productionBucket = config.r2_buckets?.find(item => item.binding === 'BLOBS');
  if (!catalog?.database_name || !bucket?.bucket_name) {
    throw new Error('Preview CATALOG.database_name and BLOBS.bucket_name must be set in Wrangler config.');
  }
  if (catalog.database_name === productionCatalog?.database_name || bucket.bucket_name === productionBucket?.bucket_name) {
    throw new Error('Preview storage must be separate from production.');
  }
  const origin = config.previews.vars?.AUTH_ORIGIN;
  const expectedHostPrefix = `${previewName}-${config.name}.`;
  if (!origin || new URL(origin).origin !== origin || !origin.startsWith('https://') ||
      !new URL(origin).hostname.startsWith(expectedHostPrefix) || !new URL(origin).hostname.endsWith('.workers.dev') ||
      config.previews.vars.AUTH_MODE !== 'native') {
    throw new Error(`Set previews.vars.AUTH_ORIGIN to https://${previewName}-${config.name}.<your-subdomain>.workers.dev and AUTH_MODE to native.`);
  }
  log('Preparing dedicated preview storage...');
  const database = await ensureDatabase(api, catalog.database_name, catalog.database_id);
  if (!database.uuid || (catalog.database_id && catalog.database_id !== database.uuid) || database.uuid === productionCatalog?.database_id) {
    throw new Error('Preview D1 identifier is missing or conflicts with the configured database.');
  }
  await ensureBucket(api, bucket.bucket_name);

  // Vite rebases the top-level migration path, but not previews.migrations_dir.
  // Keep this file beside the built config so assets/modules still resolve.
  const d1 = { ...catalog, database_id: database.uuid, migrations_dir: productionCatalog?.migrations_dir ?? catalog.migrations_dir };
  const prepared = {
    ...config,
    vars: config.previews.vars,
    d1_databases: [d1],
    r2_buckets: [bucket],
    previews: { ...config.previews, d1_databases: [d1], r2_buckets: [bucket] },
  };
  const temporary = resolve(dirname(configPath), `wrangler.preview-${randomUUID()}.json`);
  writeFileSync(temporary, JSON.stringify(prepared, null, 2), { mode: 0o600 });
  try {
    log(`Applying migrations to ${catalog.database_name}...`);
    await run(['d1', 'migrations', 'apply', 'CATALOG', '--remote', '--config', temporary]);
    log(`Publishing ${previewName} preview...`);
    await run(['preview', '--name', previewName, '--config', temporary]);
    log(`Preview: ${origin}`);
  } finally {
    rmSync(temporary, { force: true });
  }
}

async function main() {
  const redirect = JSON.parse(readFileSync('.wrangler/deploy/config.json', 'utf8'));
  const configPath = resolve('.wrangler/deploy', redirect.configPath);
  const config = await installationConfig(JSON.parse(readFileSync(configPath, 'utf8')));
  const api = cloudflareApi(
    deploymentAccount(config),
    deploymentToken(),
  );
  await deployPreview({ configPath, api, preparedConfig:config, run(args) {
    const result = spawnSync('wrangler', args, { stdio: 'inherit', env: { ...process.env, CI: 'true' } });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`Preview ${args[0]} step failed with exit code ${result.status ?? 1}.`);
  } });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
