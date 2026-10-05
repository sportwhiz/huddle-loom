import type { NativeEnv } from "../auth/types";
import { currentRelease } from "./build";
import {
  compatibleRelease,
  compareVersions,
  parseRelease,
  RELEASE_REPOSITORY_ID,
  type Release,
} from "./release";
import { boundedBody, randomToken } from "../security/primitives";
import { HttpError } from "../security/errors";
import { seal, open } from "../security/secret-store";
import { auditStatement } from "../security/audit";

type Settings = {
  hook_ciphertext: string | null;
  automatic_security: number;
  checked_at: number | null;
  check_error: string | null;
  available_release: string | null;
  runner_seen_at: number | null;
  runner_origin: string | null;
};
export const ACTIVE =
  "('queued','building','deploying','verifying','uncertain')";
export function validHook(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^https:\/\/api\.cloudflare\.com\/client\/v4\/workers\/builds\/deploy_hooks\/[a-f0-9-]{32,36}$/.test(
      value,
    )
  )
    throw new HttpError(
      400,
      "Paste the Cloudflare deployment hook URL.",
      "INVALID_HOOK",
    );
  return value;
}
export async function settings(env: NativeEnv) {
  return (await env.CATALOG.prepare(
    "SELECT * FROM software_update_settings WHERE id='instance'",
  ).first<Settings>())!;
}
export function runnerReady(env: NativeEnv, configuration: Settings) {
  return (
    !!configuration.runner_seen_at &&
    configuration.runner_origin ===
      (env.SOFTWARE_UPDATE_RUNNER_ORIGIN ?? env.AUTH_ORIGIN)
  );
}
async function remoteJson(response: Response) {
  if (!response.ok)
    throw new Error(
      "Published releases are unavailable. The repository may still be private.",
    );
  return JSON.parse(
    new TextDecoder().decode(await boundedBody(response, 65536)),
  );
}
export function publishedRelease(version: string): Promise<Release>;
export function publishedRelease(): Promise<Release | null>;
export async function publishedRelease(
  version?: string,
): Promise<Release | null> {
  if (version && !/^\d{1,5}\.\d{1,5}\.\d{1,5}$/.test(version))
    throw new Error("Invalid release version.");
  const headers = {
    "User-Agent": "Open-Whiteboard-Updater",
    Accept: "application/vnd.github+json",
  };
  const response = await fetch(
    `https://api.github.com/repositories/${RELEASE_REPOSITORY_ID}/releases/${version ? `tags/v${version}` : "latest"}`,
    { headers, signal: AbortSignal.timeout(15000), redirect: "manual" },
  );
  if (!version && response.status === 404) {
    // GitHub also returns 404 when a public repository has only previews.
    // Confirm that the repository is readable before reporting an empty channel.
    const releases = await remoteJson(
      await fetch(
        `https://api.github.com/repositories/${RELEASE_REPOSITORY_ID}/releases?per_page=100`,
        { headers, signal: AbortSignal.timeout(15000), redirect: "manual" },
      ),
    );
    if (
      Array.isArray(releases) &&
      releases.every(
        (item) => item && (item.draft === true || item.prerelease === true),
      )
    )
      return null;
    throw new Error("The latest stable release could not be verified.");
  }
  const release = await remoteJson(response);
  if (
    release.draft ||
    release.prerelease ||
    !/^v\d+\.\d+\.\d+$/.test(release.tag_name)
  )
    throw new Error("No stable release is available.");
  const asset = release.assets?.find(
    (a: { name: string }) => a.name === "huddle-loom-release.json",
  );
  if (!asset || !Number.isSafeInteger(asset.id) || asset.size > 65536)
    throw new Error("This release has no verified update manifest.");
  const manifest = parseRelease(
    await remoteJson(
      await fetch(
        `https://api.github.com/repositories/${RELEASE_REPOSITORY_ID}/releases/assets/${asset.id}`,
        {
          headers: { ...headers, Accept: "application/octet-stream" },
          signal: AbortSignal.timeout(15000),
        },
      ),
    ),
  );
  if (
    `v${manifest.version}` !== release.tag_name ||
    (version && version !== manifest.version)
  )
    throw new Error("Release version does not match its manifest.");
  return manifest;
}
export async function checkReleases(env: NativeEnv) {
  const now = Date.now();
  const lease = await env.CATALOG.prepare(
    "UPDATE software_update_settings SET check_lease_until=? WHERE id='instance' AND check_lease_until<?",
  )
    .bind(now + 60000, now)
    .run();
  if (!lease.meta.changes) return;
  try {
    const release = await publishedRelease();
    await env.CATALOG.prepare(
      "UPDATE software_update_settings SET available_release=?,checked_at=?,check_error=NULL,check_lease_until=0 WHERE id='instance'",
    )
      .bind(release ? JSON.stringify(release) : null, now)
      .run();
  } catch {
    await env.CATALOG.prepare(
      "UPDATE software_update_settings SET checked_at=?,check_error=?,check_lease_until=0 WHERE id='instance'",
    )
      .bind(
        now,
        "Could not check published releases. Your installed version is unchanged. Try again later.",
      )
      .run();
  }
}
export async function updateStatus(env: NativeEnv) {
  const configuration = await settings(env);
  const history = (
    await env.CATALOG.prepare(
      "SELECT id,version,status,created_at,updated_at,build_id,checkpoint,message,release,previous_release,COALESCE(json_extract(release,'$.deploymentKind'),'update') AS kind FROM software_updates ORDER BY created_at DESC LIMIT 20",
    ).all<{
      id: string;
      version: string;
      status: string;
      created_at: number;
      updated_at: number;
      build_id: string | null;
      checkpoint: string | null;
      message: string | null;
      release: string;
      previous_release: string;
      kind: "update" | "rebuild" | "source";
    }>()
  ).results;
  const available = configuration.available_release
    ? parseRelease(JSON.parse(configuration.available_release))
    : null;
  return {
    current: currentRelease,
    deploymentMode:
      env.HOSTING_PLATFORM && env.HOSTING_PLATFORM !== "cloudflare"
        ? "manual-node"
        : "cloudflare",
    available,
    updateAvailable:
      !!available &&
      compareVersions(available.version, currentRelease.version) > 0,
    incompatibility: available
      ? compatibleRelease(available, currentRelease)
      : null,
    connected: !!(configuration.hook_ciphertext || env.SOFTWARE_UPDATE_HOOK),
    managedConnection: !!env.SOFTWARE_UPDATE_HOOK,
    runnerReady: runnerReady(env, configuration),
    automaticSecurity: !!configuration.automatic_security,
    checkedAt: configuration.checked_at,
    checkError: configuration.check_error,
    history: history.map(({ release, previous_release, ...row }) => {
      const previous = JSON.parse(previous_release) as Release;
      const target = JSON.parse(release) as Release;
      return {
        ...row,
        delayed:
          !["succeeded", "failed"].includes(row.status) &&
          Date.now() - row.updated_at > 20 * 60 * 1000,
        rollbackVersion:
          row.kind === "update" &&
          row.status === "succeeded" &&
          target.commit === currentRelease.commit &&
          /^[a-f0-9]{40}$/.test(previous.commit) &&
          !compatibleRelease(previous, currentRelease, true)
            ? previous.version
            : null,
      };
    }),
  };
}
/** Only public release information, without deployment history or credentials. */
export async function releaseNotice(env: NativeEnv) {
  let configuration = await settings(env);
  if ((configuration.checked_at ?? 0) < Date.now() - 86400000) {
    await checkReleases(env);
    configuration = await settings(env);
  }
  const available = configuration.available_release
    ? parseRelease(JSON.parse(configuration.available_release))
    : null;
  if (!available || compareVersions(available.version, currentRelease.version) <= 0 ||
      !(available.security || available.important)) return null;
  const active = await env.CATALOG.prepare(
    `SELECT status,updated_at FROM software_updates WHERE status IN ${ACTIVE} LIMIT 1`,
  ).first<{ status: string; updated_at: number }>();
  return {
    id: `${available.version}:${available.commit}`,
    version: available.version,
    security: available.security,
    notes: available.notes.slice(0, 2000),
    inProgress: Boolean(active && active.status !== "uncertain" && active.updated_at > Date.now() - 1200000),
    guidedUpgrade: Boolean(compatibleRelease(available, currentRelease)),
    deploymentMode: env.HOSTING_PLATFORM && env.HOSTING_PLATFORM !== "cloudflare"
      ? "manual-node" as const : "cloudflare" as const,
  };
}
export async function saveConnection(
  env: NativeEnv,
  hook: unknown,
  actor: string,
) {
  const encrypted = await seal(env, validHook(hook), "software-update-hook");
  await env.CATALOG.batch([
    env.CATALOG.prepare(
      "UPDATE software_update_settings SET hook_ciphertext=? WHERE id='instance'",
    ).bind(encrypted),
    auditStatement(env.CATALOG, actor, "updates.connection_saved"),
  ]);
}
export async function requestUpdate(
  env: NativeEnv,
  release: Release,
  actor: string | null,
  rollback = false,
) {
  const configuration = await settings(env);
  if (
    !(configuration.hook_ciphertext || env.SOFTWARE_UPDATE_HOOK) ||
    !runnerReady(env, configuration)
  )
    throw new HttpError(
      409,
      "Connect deployment updates and deploy the update runner first.",
      "UPDATER_NOT_CONNECTED",
    );
  const incompatibility = compatibleRelease(release, currentRelease, rollback);
  if (incompatibility)
    throw new HttpError(409, incompatibility, "UPDATE_INCOMPATIBLE");
  if (
    !rollback &&
    compareVersions(release.version, currentRelease.version) <= 0
  )
    throw new HttpError(
      409,
      "This version is already installed or older.",
      "UPDATE_NOT_NEWER",
    );
  const hook = validHook(
    configuration.hook_ciphertext
      ? await open(env, configuration.hook_ciphertext, "software-update-hook")
      : env.SOFTWARE_UPDATE_HOOK,
  );
  const id = randomToken(18),
    now = Date.now();
  const result = await env.CATALOG.prepare(
    `INSERT INTO software_updates(id,release,previous_release,version,status,actor_id,created_at,updated_at)
    SELECT ?,?,?,?,'queued',?,?,? WHERE NOT EXISTS(SELECT 1 FROM software_updates WHERE status IN ${ACTIVE})`,
  )
    .bind(
      id,
      JSON.stringify(release),
      JSON.stringify(currentRelease),
      release.version,
      actor,
      now,
      now,
    )
    .run();
  if (!result.meta.changes)
    throw new HttpError(
      409,
      "An update is already in progress.",
      "UPDATE_IN_PROGRESS",
    );
  await auditStatement(
    env.CATALOG,
    actor,
    rollback ? "updates.rollback_requested" : "updates.requested",
    id,
    "success",
    { version: release.version },
  ).run();
  return triggerUpdate(env, id, hook);
}
async function triggerUpdate(env: NativeEnv, id: string, hook: string) {
  // A timeout is ambiguous: Cloudflare may already have accepted the build.
  // Keep the singleton lock until the runner or operator resolves it.
  try {
    const response = await fetch(hook, {
      method: "POST",
      redirect: "manual",
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) {
      if (response.status >= 400 && response.status < 500) {
        await env.CATALOG.prepare(
          "UPDATE software_updates SET status=CASE WHEN checkpoint IS NULL THEN 'failed' ELSE 'uncertain' END,message=?,updated_at=? WHERE id=? AND status='queued'",
        )
          .bind(
            "Cloudflare rejected the deployment connection. Reconnect and try again.",
            Date.now(),
            id,
          )
          .run();
        return { id };
      }
      throw new Error("Hook unavailable");
    }
    const payload = await remoteJson(response);
    if (!payload.success || typeof payload.result?.build_uuid !== "string")
      throw new Error("Unconfirmed build");
    await env.CATALOG.prepare(
      "UPDATE software_updates SET build_id=? WHERE id=?",
    )
      .bind(payload.result.build_uuid.slice(0, 80), id)
      .run();
  } catch {
    await env.CATALOG.prepare(
      "UPDATE software_updates SET message=? WHERE id=? AND status='queued'",
    )
      .bind(
        "Waiting for Cloudflare to confirm the build. Check build history before retrying.",
        id,
      )
      .run();
  }
  return { id };
}
export async function retryDeployment(
  env: NativeEnv,
  id: unknown,
  stopped: unknown,
  actor: string,
) {
  if (typeof id !== "string" || stopped !== true)
    throw new HttpError(
      400,
      "Confirm the old Cloudflare build has stopped before retrying.",
      "BUILD_CANCELLATION_REQUIRED",
    );
  const configuration = await settings(env);
  if (
    !runnerReady(env, configuration) ||
    !(configuration.hook_ciphertext || env.SOFTWARE_UPDATE_HOOK)
  )
    throw new HttpError(
      409,
      "Reconnect deployment updates before retrying.",
      "UPDATER_NOT_CONNECTED",
    );
  const hook = validHook(
    configuration.hook_ciphertext
      ? await open(env, configuration.hook_ciphertext, "software-update-hook")
      : env.SOFTWARE_UPDATE_HOOK,
  );
  const row = await env.CATALOG.prepare(
    "SELECT release FROM software_updates WHERE id=? AND (status='uncertain' OR (status IN ('deploying','verifying') AND updated_at<?))",
  )
    .bind(id, Date.now() - 20 * 60 * 1000)
    .first<{ release: string }>();
  if (!row)
    throw new HttpError(
      409,
      "This deployment is still running or its status changed. Refresh before retrying.",
      "UPDATE_CHANGED",
    );
  const release = JSON.parse(row.release);
  if (
    release.deploymentKind !== "source" &&
    compatibleRelease(parseRelease(release), currentRelease)
  )
    throw new HttpError(
      409,
      "This release needs a guided upgrade before it can be retried.",
      "UPDATE_INCOMPATIBLE",
    );
  // Retain the approved target, checkpoint, and singleton operation. A partial
  // migration may have happened; recovery must move forward with the same code.
  const [changed] = await env.CATALOG.batch([
    env.CATALOG.prepare(
      "UPDATE software_updates SET status='queued',runner_id=NULL,build_id=NULL,message='Retrying the same deployment after the owner confirmed its build stopped.',updated_at=? WHERE id=? AND release=? AND (status='uncertain' OR (status IN ('deploying','verifying') AND updated_at<?)) RETURNING id",
    ).bind(Date.now(), id, row.release, Date.now() - 20 * 60 * 1000),
    auditStatement(env.CATALOG, actor, "updates.deployment_retried", id),
  ]);
  if (!changed.meta.changes)
    throw new HttpError(
      409,
      "The deployment status changed. Refresh before retrying.",
      "UPDATE_CHANGED",
    );
  return triggerUpdate(env, id, hook);
}
export async function automaticUpdates(env: NativeEnv) {
  if (env.HOSTING_PLATFORM && env.HOSTING_PLATFORM !== "cloudflare") return;
  const configuration = await settings(env);
  if ((configuration.checked_at ?? 0) < Date.now() - 86400000)
    await checkReleases(env);
  const refreshed = await settings(env);
  if (
    !(refreshed.hook_ciphertext || env.SOFTWARE_UPDATE_HOOK) ||
    !refreshed.runner_seen_at ||
    !refreshed.automatic_security ||
    refreshed.check_error ||
    !refreshed.available_release
  )
    return;
  const candidate = parseRelease(JSON.parse(refreshed.available_release));
  // Security automation is deliberately limited to compatible patch releases.
  if (
    !candidate.security ||
    candidate.version.split(".").slice(0, 2).join(".") !==
      currentRelease.version.split(".").slice(0, 2).join(".") ||
    candidate.schema !== currentRelease.schema ||
    compatibleRelease(candidate, currentRelease)
  )
    return;
  if (compareVersions(candidate.version, currentRelease.version) <= 0) return;
  // Never loop a failed unattended release. An owner can explicitly retry it.
  if (
    await env.CATALOG.prepare(
      "SELECT id FROM software_updates WHERE version=? LIMIT 1",
    )
      .bind(candidate.version)
      .first()
  )
    return;
  await requestUpdate(env, candidate, null).catch(() => undefined);
}
