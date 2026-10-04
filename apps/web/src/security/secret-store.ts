import type { NativeEnv } from "../auth/types";
import { base64url, encoder, unbase64url } from "./primitives";
import { HttpError } from "./errors";
function keys(env: NativeEnv) {
  try {
    const list = JSON.parse(env.AUTH_ENCRYPTION_KEYS ?? "") as {
      id: string;
      key: string;
    }[];
    if (
      !Array.isArray(list) ||
      !list.length ||
      list.some(
        (item) =>
          !/^[a-zA-Z0-9_-]{1,32}$/u.test(item.id) ||
          unbase64url(item.key).length !== 32,
      ) ||
      new Set(list.map((item) => item.id)).size !== list.length
    )
      throw new Error();
    return list;
  } catch {
    throw new HttpError(
      503,
      "Encryption keys are missing or invalid.",
      "AUTH_NOT_CONFIGURED",
    );
  }
}
export function validateEncryptionKeys(env: NativeEnv) {
  keys(env);
}
export async function seal(env: NativeEnv, value: string, purpose: string) {
  const active = keys(env)[0];
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await crypto.subtle.importKey(
    "raw",
    unbase64url(active.key),
    "AES-GCM",
    false,
    ["encrypt"],
  );
  const data = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: encoder.encode(purpose) },
    key,
    encoder.encode(value),
  );
  return `${active.id}.${base64url(iv)}.${base64url(new Uint8Array(data))}`;
}
export async function open(env: NativeEnv, envelope: string, purpose: string) {
  const [id, iv, data] = envelope.split(".");
  const selected = keys(env).find((item) => item.id === id);
  if (!selected)
    throw new HttpError(
      503,
      "A retained encryption key is required.",
      "KEY_UNAVAILABLE",
    );
  try {
    const key = await crypto.subtle.importKey(
      "raw",
      unbase64url(selected.key),
      "AES-GCM",
      false,
      ["decrypt"],
    );
    return new TextDecoder().decode(
      await crypto.subtle.decrypt(
        {
          name: "AES-GCM",
          iv: unbase64url(iv),
          additionalData: encoder.encode(purpose),
        },
        key,
        unbase64url(data),
      ),
    );
  } catch {
    throw new HttpError(
      503,
      "Encrypted configuration could not be read.",
      "KEY_UNAVAILABLE",
    );
  }
}
