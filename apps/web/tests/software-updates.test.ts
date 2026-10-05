import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import type { NativeEnv } from "../src/auth/types";
import {
  parseRelease,
  compatibleRelease,
  compareVersions,
} from "../src/updates/release";
import {
  automaticUpdates,
  checkReleases,
  publishedRelease,
  releaseNotice,
  requestUpdate,
  retryDeployment,
  saveConnection,
  updateStatus,
  validHook,
} from "../src/updates/service";
vi.mock("../src/updates/build", () => ({
  currentRelease: {
    version: "1.2.0",
    commit: "a".repeat(40),
    schema: "b".repeat(64),
    protocol: 1,
    dataFormat: 1,
    security: false,
    notes: "",
  },
}));
const current = {
  version: "1.2.0",
  commit: "a".repeat(40),
  schema: "b".repeat(64),
  protocol: 1,
  dataFormat: 1,
  security: false,
  notes: "",
};
const release = {
  ...current,
  version: "1.2.1",
  commit: "c".repeat(40),
  security: true,
  notes: "Corrects a security issue.",
};
const hook =
  "https://api.cloudflare.com/client/v4/workers/builds/deploy_hooks/11111111-1111-1111-1111-111111111111";
function adapter(db: DatabaseSync): D1Database {
  function prepare(sql: string, args: SQLInputValue[] = []): any {
    const execute = () => ({
      success: true,
      results: db.prepare(sql).all(...args),
      meta: db.prepare("SELECT changes() AS changes").get(),
    });
    return {
      bind: (...values: SQLInputValue[]) => prepare(sql, values),
      first: async () => db.prepare(sql).get(...args) ?? null,
      all: async () => execute(),
      run: async () => execute(),
      execute,
    };
  }
  return {
    prepare,
    batch: async (statements: any[]) => {
      db.exec("BEGIN");
      try {
        const result = statements.map((s) => s.execute());
        db.exec("COMMIT");
        return result;
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
    },
  } as unknown as D1Database;
}
describe("software release control", () => {
  let db: DatabaseSync, env: NativeEnv;
  beforeEach(() => {
    db = new DatabaseSync(":memory:");
    const directory = new URL("../migrations/", import.meta.url);
    for (const file of readdirSync(directory)
      .filter((f) => f.endsWith(".sql"))
      .sort())
      db.exec(readFileSync(new URL(file, directory), "utf8"));
    env = {
      CATALOG: adapter(db),
      AUTH_ORIGIN: "https://studio.example.com",
      AUTH_ENCRYPTION_KEYS: JSON.stringify([
        { id: "test", key: Buffer.alloc(32, 7).toString("base64url") },
      ]),
      SOFTWARE_UPDATE_HOOK: hook,
    };
    db.prepare(
      "UPDATE software_update_settings SET runner_seen_at=1,runner_origin=?",
    ).run(env.AUTH_ORIGIN!);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url === hook)
          return Response.json({
            success: true,
            result: { build_uuid: "build-123" },
          });
        if (url.endsWith("/assets/123")) return Response.json(release);
        return Response.json({
          tag_name: "v1.2.1",
          draft: false,
          prerelease: false,
          assets: [{ id: 123, name: "huddle-loom-release.json", size: 600 }],
        });
      }),
    );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    db.close();
  });
  it("pins published release identity and rejects mismatched manifests", async () => {
    expect(await publishedRelease()).toEqual(release);
    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining("/releases/latest"),
      expect.objectContaining({ redirect: "manual" }),
    );
    await expect(publishedRelease("1.2.2")).rejects.toThrow("does not match");
    await expect(publishedRelease("../../bad")).rejects.toThrow("Invalid");
  });
  it("rejects redirected release discovery without following it", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(null, {
        status: 302,
        headers: { Location: "https://unexpected.example/" },
      }),
    );
    await expect(publishedRelease()).rejects.toThrow("unavailable");
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ redirect: "manual" }),
    );
  });
  it("keeps latest and versioned release checks pinned to the official repository identity", async () => {
    expect(await publishedRelease()).toEqual(release);
    expect(await publishedRelease("1.2.1")).toEqual(release);
    expect(vi.mocked(fetch).mock.calls.map(([url]) => String(url))).toEqual([
      "https://api.github.com/repositories/1404455583/releases/latest",
      "https://api.github.com/repositories/1404455583/releases/assets/123",
      "https://api.github.com/repositories/1404455583/releases/tags/v1.2.1",
      "https://api.github.com/repositories/1404455583/releases/assets/123",
    ]);
  });
  it("uses the same repository identity when checking an empty stable channel", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(new Response("", { status: 404 }))
      .mockResolvedValueOnce(Response.json([]));
    expect(await publishedRelease()).toBeNull();
    expect(vi.mocked(fetch).mock.calls.map(([url]) => String(url))).toEqual([
      "https://api.github.com/repositories/1404455583/releases/latest",
      "https://api.github.com/repositories/1404455583/releases?per_page=100",
    ]);
  });
  it("discovers important releases without a deploy hook and exposes only public notice data", async () => {
    const local = { ...env, SOFTWARE_UPDATE_HOOK: undefined };
    db.exec("UPDATE software_update_settings SET runner_seen_at=NULL,runner_origin=NULL");
    const notice = await releaseNotice(local);
    expect(notice).toEqual({
      id: `${release.version}:${release.commit}`, version: release.version,
      security: true, notes: release.notes, inProgress: false,
      guidedUpgrade: false, deploymentMode: "cloudflare",
    });
    expect(JSON.stringify(notice)).not.toContain(hook);
    expect(JSON.stringify(notice)).not.toContain("checkpoint");
    const calls = vi.mocked(fetch).mock.calls.length;
    await releaseNotice(local);
    expect(fetch).toHaveBeenCalledTimes(calls);
    expect((await updateStatus(local)).history).toHaveLength(0);
  });
  it.each([
    { candidate: { ...release, security: false }, visible: false },
    { candidate: { ...release, security: false, important: true }, visible: true },
    { candidate: { ...release, security: true, important: false }, visible: true },
    { candidate: { ...current, important: true }, visible: false },
    { candidate: { ...release, version: "1.1.9", important: true }, visible: false },
  ])("shows only newer priority releases: $candidate.version / $visible", async ({candidate, visible}) => {
    db.prepare("UPDATE software_update_settings SET available_release=?,checked_at=?").run(JSON.stringify(candidate), Date.now());
    expect(Boolean(await releaseNotice(env))).toBe(visible);
    expect(fetch).not.toHaveBeenCalled();
  });
  it("shows guided and Node updates without starting deployments", async () => {
    db.prepare("UPDATE software_update_settings SET available_release=?,checked_at=?").run(JSON.stringify({ ...release, protocol: 2 }), Date.now());
    const notice = await releaseNotice({ ...env, HOSTING_PLATFORM: "godaddy" });
    expect(notice?.guidedUpgrade).toBe(true);
    expect(notice?.deploymentMode).toBe("manual-node");
    expect(fetch).not.toHaveBeenCalled();
  });
  it("keeps discovery independent of installing automatic patches", async () => {
    db.exec("UPDATE software_update_settings SET automatic_security=1");
    await releaseNotice(env);
    const calls = vi.mocked(fetch).mock.calls.length;
    await automaticUpdates(env);
    expect(fetch).toHaveBeenCalledTimes(calls + 1);
    expect((await updateStatus(env)).history).toHaveLength(1);
  });
  it("distinguishes a running update from an uncertain or stalled deployment", async () => {
    await checkReleases(env);
    await requestUpdate(env, release, null);
    expect((await releaseNotice(env))?.inProgress).toBe(true);
    db.exec("UPDATE software_updates SET status='uncertain'");
    expect((await releaseNotice(env))?.inProgress).toBe(false);
    db.exec("UPDATE software_updates SET status='building',updated_at=0");
    expect((await releaseNotice(env))?.inProgress).toBe(false);
  });
  it("rejects invalid priority metadata and keeps old manifests compatible", () => {
    expect(parseRelease(release)).toEqual(release);
    expect(parseRelease({ ...release, important: true }).important).toBe(true);
    expect(() => parseRelease({ ...release, important: "true" })).toThrow();
  });
  it.each([
    { releases: [] },
    { releases: [{ tag_name: "v0.1.0", draft: false, prerelease: true }] },
  ])(
    "treats a readable repository without stable releases as a successful empty check: %j",
    async ({ releases }) => {
      await checkReleases(env);
      db.exec(
        "UPDATE software_update_settings SET check_error='Previous failure',automatic_security=1,checked_at=0",
      );
      vi.mocked(fetch).mockImplementation(async (input) =>
        String(input).endsWith("/releases?per_page=100")
          ? Response.json(releases)
          : Response.json({ message: "Not Found" }, { status: 404 }),
      );
      await automaticUpdates(env);
      const status = await updateStatus(env);
      expect(status.available).toBeNull();
      expect(status.checkError).toBeNull();
      expect(status.checkedAt).toBeGreaterThan(0);
      expect(status.updateAvailable).toBe(false);
      expect(status.history).toHaveLength(0);
    },
  );
  it.each([403, 404, 429, 500])(
    "keeps lookup failures visible when the fallback repository request fails with %i",
    async (statusCode) => {
      await checkReleases(env);
      vi.mocked(fetch).mockImplementation(async (input) =>
        new Response("", {
          status: String(input).endsWith("/releases/latest") ? 404 : statusCode,
        }),
      );
      await checkReleases(env);
      const status = await updateStatus(env);
      expect(status.checkError).toBeTruthy();
      expect(status.available).toEqual(release);
    },
  );
  it("does not treat a missing requested release as an empty channel", async () => {
    vi.mocked(fetch).mockResolvedValue(new Response("", { status: 404 }));
    await expect(publishedRelease("1.2.1")).rejects.toThrow();
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it.each([
    { releases: [{ tag_name: "v1.2.1", draft: false, prerelease: false }] },
    { releases: [{}] },
    { releases: { message: "invalid response" } },
  ])(
    "rejects inconsistent or malformed fallback metadata: %j",
    async ({ releases }) => {
      vi.mocked(fetch)
        .mockResolvedValueOnce(new Response("", { status: 404 }))
        .mockResolvedValueOnce(Response.json(releases));
      await expect(publishedRelease()).rejects.toThrow("could not be verified");
    },
  );
  it("never accepts a preview as a stable installation target", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      Response.json({ tag_name: "v1.2.1", draft: false, prerelease: true }),
    );
    await expect(publishedRelease("1.2.1")).rejects.toThrow("No stable release");
  });
  it("serializes concurrent update requests and never discloses hook credentials", async () => {
    const results = await Promise.allSettled([
      requestUpdate(env, release, null),
      requestUpdate(env, release, null),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
    const status = await updateStatus(env);
    expect(status.history).toHaveLength(1);
    expect(status.history[0].status).toBe("queued");
    expect(JSON.stringify(status)).not.toContain(hook);
  });
  it("encrypts manual hooks and requires an exact provider endpoint", async () => {
    await saveConnection(env, hook, "fixture-owner");
    const stored = db
      .prepare("SELECT hook_ciphertext FROM software_update_settings")
      .get()!.hook_ciphertext as string;
    expect(stored).not.toContain("cloudflare");
    await requestUpdate(
      { ...env, SOFTWARE_UPDATE_HOOK: undefined },
      release,
      null,
    );
    expect(vi.mocked(fetch)).toHaveBeenCalledWith(
      hook,
      expect.objectContaining({ method: "POST", redirect: "manual" }),
    );
    for (const value of [
      "https://evil.test/",
      "http://api.cloudflare.com/client/v4/workers/builds/deploy_hooks/1",
      hook + "?secret=x",
      hook.replace("api.cloudflare.com", "api.cloudflare.com.evil.test"),
    ])
      expect(() => validHook(value)).toThrow();
  });
  it("retains a lock after an ambiguous hook timeout, but allows a retry after rejection", async () => {
    vi.mocked(fetch).mockRejectedValueOnce(new Error("timeout"));
    await requestUpdate(env, release, null);
    expect((await updateStatus(env)).history[0].status).toBe("queued");
    await expect(requestUpdate(env, release, null)).rejects.toThrow(
      "already in progress",
    );
    db.exec("DELETE FROM software_updates");
    vi.mocked(fetch).mockResolvedValueOnce(new Response("", { status: 403 }));
    await requestUpdate(env, release, null);
    expect((await updateStatus(env)).history[0].status).toBe("failed");
    await expect(requestUpdate(env, release, null)).resolves.toBeTruthy();
  });
  it("only auto-installs compatible security patches, once per release", async () => {
    db.exec("UPDATE software_update_settings SET automatic_security=1");
    await automaticUpdates(env);
    expect((await updateStatus(env)).history).toHaveLength(1);
    db.exec(
      "UPDATE software_updates SET status='failed'; UPDATE software_update_settings SET checked_at=0",
    );
    await automaticUpdates(env);
    expect((await updateStatus(env)).history).toHaveLength(1);
  });
  it.each([
    { ...release, security: false },
    { ...release, schema: "d".repeat(64) },
    { ...release, version: "1.3.0" },
    { ...release, dataFormat: 2 },
  ])(
    "does not auto-install incompatible or feature releases",
    async (candidate) => {
      db.exec("UPDATE software_update_settings SET automatic_security=1");
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: RequestInfo | URL) =>
          String(input).endsWith("/assets/123")
            ? Response.json(candidate)
            : Response.json({
                tag_name: `v${candidate.version}`,
                assets: [
                  { id: 123, name: "huddle-loom-release.json", size: 500 },
                ],
              }),
        ),
      );
      await automaticUpdates(env);
      expect((await updateStatus(env)).history).toHaveLength(0);
    },
  );
  it("retains release knowledge on a failed check without claiming a successful check", async () => {
    await checkReleases(env);
    vi.mocked(fetch).mockRejectedValueOnce(new Error("private repository"));
    await checkReleases(env);
    const status = await updateStatus(env);
    expect(status.available?.version).toBe(release.version);
    expect(status.checkError).toBeTruthy();
  });
  it("rejects downgrade, different deployment origins and unsupported data formats", async () => {
    await expect(requestUpdate(env, current, null)).rejects.toThrow("older");
    await expect(
      requestUpdate(
        { ...env, AUTH_ORIGIN: "https://other.test" },
        release,
        null,
      ),
    ).rejects.toThrow("Connect");
    await expect(
      requestUpdate(env, { ...release, dataFormat: 2 }, null),
    ).rejects.toThrow("guided");
  });
  it("allows dashboard login-address changes while rejecting an unrelated deployment identity", async () => {
    env.SOFTWARE_UPDATE_RUNNER_ORIGIN = env.AUTH_ORIGIN;
    env.AUTH_ORIGIN = "https://custom.example.com";
    expect((await updateStatus(env)).runnerReady).toBe(true);
    const job = await requestUpdate(env, release, null);
    db.prepare("UPDATE software_updates SET status='uncertain',checkpoint='retained' WHERE id=?").run(job.id);
    await expect(retryDeployment(env, job.id, true, "owner")).resolves.toEqual({ id: job.id });
    expect(db.prepare("SELECT checkpoint FROM software_updates WHERE id=?").get(job.id)!.checkpoint).toBe("retained");
    const unrelated = { ...env, SOFTWARE_UPDATE_RUNNER_ORIGIN: "https://different-worker.example.com" };
    expect((await updateStatus(unrelated)).runnerReady).toBe(false);
    await expect(requestUpdate(unrelated, release, null)).rejects.toThrow("Connect");
  });
  it("retries the same uncertain release without freeing the singleton or checkpoint", async () => {
    const initial = await requestUpdate(env, release, null);
    db.prepare(
      "UPDATE software_updates SET status='uncertain',runner_id='old-runner',checkpoint='before-publication' WHERE id=?",
    ).run(initial.id);
    await expect(
      retryDeployment(env, initial.id, false, "owner"),
    ).rejects.toThrow("Confirm the old");
    const retry = await retryDeployment(env, initial.id, true, "owner");
    expect(retry.id).toBe(initial.id);
    const row = db
      .prepare("SELECT * FROM software_updates WHERE id=?")
      .get(initial.id)!;
    expect(row.status).toBe("queued");
    expect(row.runner_id).toBeNull();
    expect(row.checkpoint).toBe("before-publication");
    expect(JSON.parse(row.release as string).commit).toBe(release.commit);
    await expect(
      requestUpdate(env, { ...release, version: "1.2.2" }, null),
    ).rejects.toThrow("already in progress");
    await expect(
      retryDeployment(env, initial.id, true, "owner"),
    ).rejects.toThrow("still running");
  });
  it("retains uncertain recovery when its hook rejects the retry", async () => {
    const initial = await requestUpdate(env, release, null);
    db.prepare(
      "UPDATE software_updates SET status='uncertain',checkpoint='before-publication' WHERE id=?",
    ).run(initial.id);
    vi.mocked(fetch).mockResolvedValueOnce(new Response("", { status: 403 }));
    await retryDeployment(env, initial.id, true, "owner");
    expect((await updateStatus(env)).history[0].status).toBe("uncertain");
    await expect(requestUpdate(env, release, null)).rejects.toThrow(
      "already in progress",
    );
  });
  it("only recovers a publishing operation after it has stalled", async () => {
    const initial = await requestUpdate(env, release, null);
    db.prepare(
      "UPDATE software_updates SET status='deploying',checkpoint='before-publication',updated_at=? WHERE id=?",
    ).run(Date.now(), initial.id);
    await expect(
      retryDeployment(env, initial.id, true, "owner"),
    ).rejects.toThrow("still running");
    db.prepare("UPDATE software_updates SET updated_at=0 WHERE id=?").run(
      initial.id,
    );
    await expect(
      retryDeployment(env, initial.id, true, "owner"),
    ).resolves.toEqual({ id: initial.id });
  });
  it("blocks update requests while an ordinary source build owns publication", async () => {
    db.prepare(
      "INSERT INTO software_updates(id,release,previous_release,version,status,runner_id,created_at,updated_at) VALUES('source',?,?,?,'building','runner',0,0)",
    ).run(
      JSON.stringify({ ...current, deploymentKind: "source" }),
      JSON.stringify(current),
      current.version,
    );
    await expect(requestUpdate(env, release, null)).rejects.toThrow(
      "already in progress",
    );
    expect(fetch).not.toHaveBeenCalled();
    expect((await updateStatus(env)).history[0].kind).toBe("source");
  });
  it("compares numeric versions and gates rollback on schema compatibility", () => {
    expect(compareVersions("1.10.0", "1.9.0")).toBe(1);
    expect(
      compatibleRelease({ ...release, schema: "d".repeat(64) }, current, true),
    ).toContain("schema");
    expect(compatibleRelease(release, current, true)).toBeNull();
    expect(() => parseRelease({ ...release, commit: "main" })).toThrow();
  });
});
