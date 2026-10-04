import { HttpError } from "./errors";

export const encoder = new TextEncoder();
export function base64url(bytes: Uint8Array) {
  return btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(""))
    .replace(/\+/gu, "-")
    .replace(/\//gu, "_")
    .replace(/=+$/u, "");
}
export function unbase64url(text: string) {
  return Uint8Array.from(
    atob(text.replace(/-/gu, "+").replace(/_/gu, "/")),
    (char) => char.charCodeAt(0),
  );
}
export function randomToken(size = 32) {
  return base64url(crypto.getRandomValues(new Uint8Array(size)));
}
export async function sha256(value: string) {
  return base64url(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", encoder.encode(value)),
    ),
  );
}
export async function hmac(secret: string, value: string) {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return base64url(
    new Uint8Array(
      await crypto.subtle.sign("HMAC", key, encoder.encode(value)),
    ),
  );
}
export function equal(a: string, b: string) {
  let difference = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++)
    difference |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return difference === 0;
}
export function cookie(request: Request, name: string) {
  const item = request.headers
    .get("cookie")
    ?.split(";")
    .find((part) => part.trim().startsWith(`${name}=`));
  return item?.trim().slice(name.length + 1) ?? null;
}
export function safeReturnTo(value: unknown, fallback = "/") {
  if (
    typeof value !== "string" ||
    !value.startsWith("/") ||
    value.startsWith("//") ||
    /[\\\u0000-\u0020]/u.test(value) ||
    value.length > 4096
  )
    return fallback;
  const parsed = new URL(value, "https://return.invalid");
  return parsed.origin === "https://return.invalid"
    ? `${parsed.pathname}${parsed.search}${parsed.hash}`
    : fallback;
}
export function email(value: unknown) {
  if (
    typeof value !== "string" ||
    value.length > 254 ||
    !/^[^@\s]+@[^@\s]+\.[^@\s]+$/u.test(value)
  )
    throw new HttpError(400, "Enter a valid email address.", "INVALID_EMAIL");
  return value.trim().toLowerCase();
}
export function text(value: unknown, label: string, max = 120) {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.trim().length > max ||
    /[\u0000-\u001f]/u.test(value)
  )
    throw new HttpError(
      400,
      `${label} is required (up to ${max} characters).`,
      "INVALID_INPUT",
    );
  return value.trim();
}
export async function boundedBody(
  request: Pick<Request, "headers" | "body">,
  max = 32_768,
) {
  if (Number(request.headers.get("content-length") ?? 0) > max)
    throw new HttpError(413, "Request is too large.", "BODY_TOO_LARGE");
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > max) {
        await reader.cancel();
        throw new HttpError(413, "Request is too large.", "BODY_TOO_LARGE");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}
export async function json(
  request: Request,
  max = 32_768,
): Promise<Record<string, unknown>> {
  try {
    const value: unknown = JSON.parse(
      new TextDecoder().decode(await boundedBody(request, max)),
    );
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error();
    return value as Record<string, unknown>;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, "A JSON object is required.", "INVALID_INPUT");
  }
}
export function escapeHtml(value: string) {
  return value.replace(
    /[&<>"']/gu,
    (ch) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        ch
      ]!,
  );
}
