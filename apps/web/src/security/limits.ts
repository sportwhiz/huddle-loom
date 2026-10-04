import { D1IdentityRepository } from "../auth/d1-repository";
import type { NativeEnv } from "../auth/types";
import { HttpError } from "./errors";
import { hmac } from "./primitives";
export async function consumeLimit(
  database: D1Database,
  key: string,
  max: number,
  seconds: number,
) {
  return new D1IdentityRepository(database).consumeLimit(
    key,
    max,
    seconds,
    Date.now(),
  );
}
export async function limit(
  env: NativeEnv,
  category: string,
  identifier: string,
  max: number,
  seconds: number,
) {
  const result = await consumeLimit(
    env.CATALOG,
    `${category}:${await hmac(env.AUTH_SECRET ?? env.ACCESS_AUD ?? "canvas-local-development-limits", identifier)}`,
    max,
    seconds,
  );
  if (!result.allowed)
    throw new HttpError(
      429,
      `Too many attempts. Try again in ${result.retryAfter} seconds.`,
      "RATE_LIMITED",
    );
}
export function clientIp(request: Request) {
  return request.headers.get("CF-Connecting-IP") ?? "unknown";
}
