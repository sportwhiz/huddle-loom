import type { NativeEnv } from "../auth/types";
import { nativePrincipal } from "../auth/session";
import { requireAdministrator } from "../auth/policy";
import { json } from "../security/primitives";
import { limit } from "../security/limits";
import { HttpError } from "../security/errors";
import { auditStatement } from "../security/audit";
import { currentRelease } from "./build";
import {
  ACTIVE,
  checkReleases,
  publishedRelease,
  releaseNotice,
  requestUpdate,
  retryDeployment,
  runnerReady,
  saveConnection,
  settings,
  updateStatus,
} from "./service";
import { compatibleRelease } from "./release";
export async function updateRoutes(
  request: Request,
  env: NativeEnv,
): Promise<Response | null> {
  const path = new URL(request.url).pathname;
  if (path === "/api/v1/updates/notice") {
    if (request.method !== "GET")
      throw new HttpError(405, "Method not allowed.", "METHOD_NOT_ALLOWED");
    await nativePrincipal(request, env);
    return Response.json({ notice: await releaseNotice(env) }, {
      headers: { "Cache-Control": "no-store" },
    });
  }
  if (!path.startsWith("/api/v1/admin/updates")) return null;
  const { principal } = await nativePrincipal(request, env);
  await requireAdministrator(
    env,
    principal,
    request.method !== "GET",
    request.method !== "GET",
  );
  if (path === "/api/v1/admin/updates" && request.method === "GET")
    return Response.json(await updateStatus(env));
  if (request.method !== "POST")
    throw new HttpError(405, "Method not allowed.", "METHOD_NOT_ALLOWED");
  if (env.HOSTING_PLATFORM && env.HOSTING_PLATFORM !== "cloudflare")
    throw new HttpError(
      409,
      "Deploy Node.js updates through your hosting dashboard. Keep the existing database and setup settings.",
      "HOSTING_UPDATE_REQUIRED",
    );
  await limit(env, "software-updates", principal.id, 12, 600);
  const input = await json(request);
  if (path.endsWith("/check")) await checkReleases(env);
  else if (path.endsWith("/connection")) {
    if (input.disconnect === true) {
      if (env.SOFTWARE_UPDATE_HOOK)
        throw new HttpError(
          409,
          "This connection is managed by deployment. Remove SOFTWARE_UPDATE_HOOK in Cloudflare to disconnect.",
          "MANAGED_CONNECTION",
        );
      if (
        await env.CATALOG.prepare(
          `SELECT id FROM software_updates WHERE status IN ${ACTIVE}`,
        ).first()
      )
        throw new HttpError(
          409,
          "Wait for the current update to finish.",
          "UPDATE_IN_PROGRESS",
        );
      await env.CATALOG.batch([
        env.CATALOG.prepare(
          "UPDATE software_update_settings SET hook_ciphertext=NULL,automatic_security=0 WHERE id='instance'",
        ),
        auditStatement(env.CATALOG, principal.id, "updates.disconnected"),
      ]);
    } else await saveConnection(env, input.hook, principal.id);
  } else if (path.endsWith("/policy")) {
    if (typeof input.automaticSecurity !== "boolean")
      throw new HttpError(400, "Choose an update policy.", "INVALID_INPUT");
    const configuration = await settings(env);
    if (
      input.automaticSecurity &&
      (!(configuration.hook_ciphertext || env.SOFTWARE_UPDATE_HOOK) ||
        !runnerReady(env, configuration))
    )
      throw new HttpError(
        409,
        "Connect updates first.",
        "UPDATER_NOT_CONNECTED",
      );
    await env.CATALOG.batch([
      env.CATALOG.prepare(
        "UPDATE software_update_settings SET automatic_security=? WHERE id='instance'",
      ).bind(Number(input.automaticSecurity)),
      auditStatement(
        env.CATALOG,
        principal.id,
        "updates.policy_changed",
        null,
        "success",
        { policy: input.automaticSecurity ? "security" : "manual" },
      ),
    ]);
  } else if (path.endsWith("/retry-deployment")) {
    return Response.json(
      await retryDeployment(env, input.id, input.cancelledBuild, principal.id),
      { status: 202 },
    );
  } else if (path.endsWith("/retry-preparation")) {
    if (typeof input.id !== "string" || input.cancelledBuild !== true)
      throw new HttpError(
        400,
        "Cancel the old Cloudflare build before retrying.",
        "BUILD_CANCELLATION_REQUIRED",
      );
    const result = await env.CATALOG.prepare(
      "UPDATE software_updates SET status=CASE WHEN checkpoint IS NULL THEN 'failed' ELSE 'uncertain' END,runner_id=NULL,message='Preparation stopped. If publication previously began, retry this same deployment.',updated_at=? WHERE id=? AND status IN ('queued','building') AND updated_at<? RETURNING id",
    )
      .bind(Date.now(), input.id, Date.now() - 20 * 60 * 1000)
      .first();
    if (!result)
      throw new HttpError(
        409,
        "This update has progressed or is still preparing. Refresh its status.",
        "UPDATE_CHANGED",
      );
    await auditStatement(
      env.CATALOG,
      principal.id,
      "updates.preparation_cancelled",
      input.id,
    ).run();
  } else if (path.endsWith("/verify")) {
    const result = await env.CATALOG.prepare(
      "SELECT id,release,runner_id FROM software_updates WHERE status IN ('verifying','uncertain') AND json_extract(release,'$.commit')=? AND json_extract(release,'$.schema')=?",
    )
      .bind(currentRelease.commit, currentRelease.schema)
      .first<{ id: string; release: string; runner_id: string | null }>();
    if (!result)
      throw new HttpError(
        409,
        "The requested version is not running here yet. Check the Cloudflare build history.",
        "UPDATE_NOT_VERIFIED",
      );
    await env.CATALOG.batch([
      env.CATALOG.prepare(
        "UPDATE software_update_settings SET active_release=? WHERE id='instance' AND EXISTS(SELECT 1 FROM software_updates WHERE id=? AND COALESCE(json_extract(release,'$.deploymentKind'),'update')<>'source' AND runner_id IS ? AND status IN ('verifying','uncertain'))",
      ).bind(result.release, result.id, result.runner_id),
      env.CATALOG.prepare(
        "UPDATE software_updates SET status='succeeded',message=NULL,updated_at=? WHERE id=? AND runner_id IS ? AND status IN ('verifying','uncertain')",
      ).bind(Date.now(), result.id, result.runner_id),
      auditStatement(env.CATALOG, principal.id, "updates.verified", result.id),
    ]);
  } else if (path.endsWith("/install")) {
    if (typeof input.version !== "string")
      throw new HttpError(400, "Choose a release.", "INVALID_INPUT");
    let release;
    try {
      release = await publishedRelease(input.version);
    } catch {
      throw new HttpError(
        503,
        "The published release could not be verified. Try again later.",
        "RELEASE_UNAVAILABLE",
      );
    }
    const rollback = input.rollback === true;
    if (rollback) {
      const row = await env.CATALOG.prepare(
        "SELECT previous_release FROM software_updates WHERE status='succeeded' AND COALESCE(json_extract(release,'$.deploymentKind'),'update')='update' AND json_extract(release,'$.commit')=? ORDER BY created_at DESC LIMIT 1",
      )
        .bind(currentRelease.commit)
        .first<{ previous_release: string }>();
      if (
        !row ||
        JSON.parse(row.previous_release).commit !== release.commit ||
        compatibleRelease(release, currentRelease, true)
      )
        throw new HttpError(
          409,
          "This release is not a compatible rollback target.",
          "ROLLBACK_UNAVAILABLE",
        );
    }
    return Response.json(
      await requestUpdate(env, release, principal.id, rollback),
      { status: 202 },
    );
  } else throw new HttpError(404, "Update action not found.", "NOT_FOUND");
  return Response.json(await updateStatus(env));
}
