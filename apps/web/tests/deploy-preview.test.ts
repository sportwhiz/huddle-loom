import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { cloudflareApi, deployPreview } from '../scripts/deploy-preview.mjs';

const account = 'a'.repeat(32);
const token = 'test-secret-never-log';
const dbName = 'whiteboard-preview-catalog';
const bucketName = 'whiteboard-preview-blobs';
const database = { name: dbName, uuid: '11111111-2222-4333-8444-555555555555' };
const fixture = () => ({
  name: 'whiteboard', main: 'index.js', assets: { directory: '../client' },
  d1_databases: [{ binding: 'CATALOG', database_name: 'production-catalog', database_id: 'production-id', migrations_dir: '../../migrations' }],
  r2_buckets: [{ binding: 'BLOBS', bucket_name: 'production-blobs' }],
  previews: {
    vars: { AUTH_MODE: 'native', AUTH_ORIGIN: 'https://staging-whiteboard.test.workers.dev', ACCESS_INTEGRATION: 'off' },
    durable_objects: { bindings: [{ name: 'BOARD_ROOMS', class_name: 'BoardRoom' }] },
    d1_databases: [{ binding: 'CATALOG', database_name: dbName, migrations_dir: 'migrations' }],
    r2_buckets: [{ binding: 'BLOBS', bucket_name: bucketName }],
  },
});

type Reply = { result?: unknown; status?: number; code?: number; pages?: number };
async function rehearsal(replies: Reply[], options: { config?: ReturnType<typeof fixture>; failCommand?: string } = {}) {
  const directory = mkdtempSync(resolve(tmpdir(), 'loom-preview-'));
  const configPath = resolve(directory, 'wrangler.json');
  const config = options.config ?? fixture();
  writeFileSync(configPath, JSON.stringify(config));
  const requests: { path: string; method: string; body?: unknown }[] = [];
  const calls: { args: string[]; config: any }[] = [];
  const logs: string[] = [];
  const api = cloudflareApi(account, token, async (url: string, init: RequestInit) => {
    expect(new Headers(init.headers).get('Authorization')).toBe(`Bearer ${token}`);
    expect(new URL(url).origin).toBe('https://api.cloudflare.com');
    requests.push({ path: new URL(url).pathname.replace(`/client/v4/accounts/${account}`, '') + new URL(url).search, method: init.method!, body: init.body && JSON.parse(init.body as string) });
    const reply = replies.shift();
    if (!reply) throw new Error('Unexpected API request');
    return new Response(JSON.stringify({ success: !reply.status, result: reply.result, result_info: { total_pages: reply.pages }, errors: reply.status ? [{ code: reply.code, message: token }] : [] }), { status: reply.status ?? 200 });
  });
  let error: Error | undefined;
  try {
    await deployPreview({ configPath, api, log: (line: string) => logs.push(line), run: (args: string[]) => {
      calls.push({ args, config: JSON.parse(readFileSync(args.at(-1)!, 'utf8')) });
      if (args[0] === options.failCommand) throw new Error('simulated command failure');
    } });
  } catch (caught) { error = caught as Error; }
  const temporaryRemoved = calls.every(call => !existsSync(call.args.at(-1)!));
  const originalUnchanged = readFileSync(configPath, 'utf8') === JSON.stringify(config);
  rmSync(directory, { recursive: true, force: true });
  return { requests, calls, error, logs, temporaryRemoved, originalUnchanged };
}

const existing = (): Reply[] => [{ result: [database] }, { result: { name: bucketName } }];

describe('native preview deployment', () => {
  it('creates missing storage, resolves the D1 ID, migrates then uploads only a preview', async () => {
    const result = await rehearsal([
      { result: [] }, { result: database },
      { status: 404, code: 10006 }, { result: { name: bucketName } },
    ]);
    expect(result.error).toBeUndefined();
    expect(result.requests.map(r => [r.method, r.path.split('?')[0]])).toEqual([
      ['GET', '/d1/database'], ['POST', '/d1/database'],
      ['GET', `/r2/buckets/${bucketName}`], ['POST', '/r2/buckets'],
    ]);
    expect(result.requests[1].body).toEqual({ name: dbName });
    expect(result.requests[3].body).toEqual({ name: bucketName });
    expect(result.calls.map(c => c.args.slice(0, -1))).toEqual([
      ['d1', 'migrations', 'apply', 'CATALOG', '--remote', '--config'],
      ['preview', '--name', 'staging', '--config'],
    ]);
    for (const { config } of result.calls) {
      expect(config.d1_databases[0]).toMatchObject({ database_name: dbName, database_id: database.uuid, migrations_dir: '../../migrations' });
      expect(config.previews.d1_databases).toEqual(config.d1_databases);
      expect(config.r2_buckets).toEqual(config.previews.r2_buckets);
      expect(config.r2_buckets[0].bucket_name).toBe(bucketName);
      expect(config.assets.directory).toBe('../client');
      expect(config.vars.AUTH_ORIGIN).toBe('https://staging-whiteboard.test.workers.dev');
      expect(config.previews.durable_objects).toEqual(fixture().previews.durable_objects);
      expect(JSON.stringify(config)).not.toContain('production');
      expect(JSON.stringify(config)).not.toContain(token);
    }
    expect(result.originalUnchanged && result.temporaryRemoved).toBe(true);
  });

  it('reuses named resources on later builds without provisioning or deleting', async () => {
    const result = await rehearsal(existing());
    expect(result.error).toBeUndefined();
    expect(result.requests.every(request => request.method === 'GET')).toBe(true);
    expect(result.calls).toHaveLength(2);
  });

  it.each(['d1', 'preview'])('cleans temporary config and stops on a %s failure', async failCommand => {
    const result = await rehearsal(existing(), { failCommand });
    expect(result.error?.message).toBe('simulated command failure');
    expect(result.calls).toHaveLength(failCommand === 'd1' ? 1 : 2);
    expect(result.temporaryRemoved && result.originalUnchanged).toBe(true);
  });

  it.each([
    [{ status: 403, code: 10000 }],
    [{ result: [] }, { status: 403, code: 10000 }],
    [{ result: [database] }, { status: 403, code: 10006 }],
    [{ result: [database] }, { status: 404, code: 9999 }],
  ])('does not provision or upload after an authentication or unrelated API error', async (...replies) => {
    const result = await rehearsal(replies);
    expect(result.error?.message).toContain('failed (HTTP');
    expect(result.error?.message).not.toContain(token);
    expect(result.calls).toHaveLength(0);
  });

  it('recovers when another build creates the same resources during provisioning', async () => {
    const result = await rehearsal([
      { result: [] }, { status: 409, code: 7502 }, { result: [database] },
      { status: 404, code: 10006 }, { status: 409, code: 10004 }, { result: { name: bucketName } },
    ]);
    expect(result.error).toBeUndefined();
    expect(result.calls).toHaveLength(2);
  });

  it('checks exact names and follows paginated database results', async () => {
    const result = await rehearsal([
      { result: Array.from({ length: 100 }, () => ({ name: `${dbName}-other`, uuid: 'other' })), pages: 2 },
      { result: [database], pages: 2 }, { result: { name: bucketName } },
    ]);
    expect(result.error).toBeUndefined();
    expect(result.requests[1].path).toContain('page=2');
  });

  it.each(['shared-database', 'shared-bucket', 'invalid-origin', 'dev-auth', 'missing-binding'])('rejects %s before making any API request', async problem => {
    const config = fixture();
    if (problem === 'shared-database') config.previews.d1_databases[0].database_name = 'production-catalog';
    if (problem === 'shared-bucket') config.previews.r2_buckets[0].bucket_name = 'production-blobs';
    if (problem === 'invalid-origin') config.previews.vars.AUTH_ORIGIN = 'https://preview.canvas.example.com';
    if (problem === 'dev-auth') config.previews.vars.AUTH_MODE = 'dev';
    if (problem === 'missing-binding') config.previews.r2_buckets = [];
    const result = await rehearsal([], { config });
    expect(result.error).toBeDefined();
    expect(result.requests).toHaveLength(0);
    expect(result.calls).toHaveLength(0);
  });

  it('never repoints a pinned preview database to a different ID', async () => {
    const config = fixture();
    Object.assign(config.previews.d1_databases[0], { database_id: 'pinned-id' });
    const result = await rehearsal([{ result: [database] }], { config });
    expect(result.error?.message).toContain('conflicts');
    expect(result.calls).toHaveLength(0);
  });

  it('does not create a replacement for a missing pinned database', async () => {
    const config = fixture();
    Object.assign(config.previews.d1_databases[0], { database_id: 'pinned-id' });
    const result = await rehearsal([{ result: [] }], { config });
    expect(result.error?.message).toContain('refusing to create a replacement');
    expect(result.requests).toHaveLength(1);
    expect(result.calls).toHaveLength(0);
  });

  it('fails clearly if no build credentials are configured', () => {
    expect(() => cloudflareApi(account, '')).toThrow('Configure the build token');
  });
});
