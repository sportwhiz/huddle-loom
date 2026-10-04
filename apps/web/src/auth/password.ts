import { scrypt } from "node:crypto";
import {
  equal,
  randomToken,
  base64url,
  unbase64url,
  boundedBody,
} from "../security/primitives";
import { HttpError } from "../security/errors";
const parameters = { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 };
// One memory-hard operation per isolate keeps hashing within the Worker memory budget.
let hashing = false;
const waiters: (() => void)[] = [];
async function derive(password: string, salt: Uint8Array) {
  if (hashing) {
    if (waiters.length >= 8)
      throw new HttpError(
        503,
        "Sign-in is busy. Try again shortly.",
        "AUTH_BUSY",
      );
    await new Promise<void>((resolve) => waiters.push(resolve));
  } else hashing = true;
  try {
    return await new Promise<Uint8Array>((resolve, reject) =>
      scrypt(password, salt, 32, parameters, (error, hash) =>
        error ? reject(error) : resolve(new Uint8Array(hash)),
      ),
    );
  } finally {
    const next = waiters.shift();
    if (next) next();
    else hashing = false;
  }
}
const passwordRanges = new Map<string, { text: string; expires: number }>();
export async function rejectCompromisedPassword(value: string) {
  const digest = new Uint8Array(
    await crypto.subtle.digest(
      "SHA-1",
      new TextEncoder().encode(value.normalize("NFKC")),
    ),
  );
  const hash = [...digest]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")
    .toUpperCase();
  const prefix = hash.slice(0, 5);
  let entry = passwordRanges.get(prefix);
  if (!entry || entry.expires <= Date.now()) {
    try {
      const response = await fetch(
        `https://api.pwnedpasswords.com/range/${prefix}`,
        {
          headers: {
            "Add-Padding": "true",
            "User-Agent": "Huddle Loom password screening",
          },
          redirect: "manual",
          signal: AbortSignal.timeout(5000),
        },
      );
      if (!response.ok) throw new Error("range unavailable");
      const text = new TextDecoder().decode(
        await boundedBody(response, 128 * 1024),
      );
      if (
        !text
          .split(/\r?\n/u)
          .every((line) => !line || /^[A-F0-9]{35}:\d+$/u.test(line))
      )
        throw new Error("invalid range");
      entry = { text, expires: Date.now() + 86400_000 };
      if (passwordRanges.size >= 32)
        passwordRanges.delete(passwordRanges.keys().next().value!);
      passwordRanges.set(prefix, entry);
    } catch {
      throw new HttpError(
        503,
        "Password screening is temporarily unavailable. Try again shortly.",
        "PASSWORD_SCREENING_UNAVAILABLE",
      );
    }
  }
  if (
    entry.text
      .split(/\r?\n/u)
      .some(
        (line) =>
          line.startsWith(`${hash.slice(5)}:`) &&
          Number(line.split(":")[1]) > 0,
      )
  )
    throw new HttpError(
      400,
      "This password appears in a known breach. Choose a different phrase.",
      "WEAK_PASSWORD",
    );
}
const common = new Set([
  "passwordpassword",
  "password123456789",
  "123456789012345",
  "1234567890123456",
  "qwertyuiopasdfgh",
  "letmeinletmein123",
  "correcthorsebatterystaple",
]);
export function validatePassword(value: string) {
  if (
    [...value].length < 15 ||
    [...value].length > 128 ||
    new TextEncoder().encode(value).byteLength > 512 ||
    common.has(value.toLowerCase())
  )
    throw new HttpError(
      400,
      "Use 15–128 characters and avoid common passwords.",
      "WEAK_PASSWORD",
    );
}
export async function hashPassword(value: string) {
  validatePassword(value);
  await rejectCompromisedPassword(value);
  return derivePasswordHash(value);
}
// Better Auth also invokes its hasher for unknown-user sign-in timing. Creation
// policy belongs at the credential-creation boundary, never in that dummy hash.
export async function derivePasswordHash(value: string) {
  const salt = randomToken(16);
  const hash = base64url(
    await derive(value.normalize("NFKC"), unbase64url(salt)),
  );
  return `scrypt:32768:8:3:${salt}:${hash}`;
}
export async function verifyPassword(input: {
  hash: string;
  password: string;
}) {
  const [algorithm, n, r, p, salt, expected] = input.hash.split(":");
  if (
    algorithm !== "scrypt" ||
    n !== "32768" ||
    r !== "8" ||
    p !== "3" ||
    !salt ||
    !expected ||
    input.password.length > 512
  )
    return false;
  return equal(
    base64url(
      await derive(input.password.normalize("NFKC"), unbase64url(salt)),
    ),
    expected,
  );
}
