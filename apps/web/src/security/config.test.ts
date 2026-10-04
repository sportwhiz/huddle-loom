import { describe, it, expect } from "vitest";
import { canonicalOrigin, nativeConfigured } from "./config";
import { open, seal } from "./secret-store";
import type { NativeEnv } from "../auth/types";
const key = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const environment = {
  AUTH_ORIGIN: "https://canvas.example.com",
  AUTH_SECRET: "isolated-configuration-key-for-unit-tests",
  AUTH_ENCRYPTION_KEYS: JSON.stringify([{ id: "old", key }]),
} as NativeEnv;
describe("native deployment boundary", () => {
  it("requires real configuration and disallows production loopback and URL credentials", () => {
    expect(() => nativeConfigured({} as NativeEnv)).toThrow();
    expect(() =>
      canonicalOrigin({ ...environment, AUTH_ORIGIN: "http://localhost:5180" }),
    ).toThrow();
    expect(() =>
      canonicalOrigin({
        ...environment,
        AUTH_ORIGIN: "https://user:password@canvas.example.com",
      }),
    ).toThrow();
    expect(() =>
      nativeConfigured({ ...environment, AUTH_ENCRYPTION_KEYS: "[]" }),
    ).toThrow();
    expect(() =>
      nativeConfigured({
        ...environment,
        AUTH_SECRETS: '[{"version":1,"value":"short"}]',
      }),
    ).toThrow();
    expect(() => nativeConfigured(environment)).not.toThrow();
  });
  it("retains old encrypted configuration during rotation and binds it to its original purpose", async () => {
    const encrypted = await seal(
      environment,
      "fixture secret",
      "provider:github",
    );
    const rotated = {
      ...environment,
      AUTH_ENCRYPTION_KEYS: JSON.stringify([
        { id: "new", key: Buffer.alloc(32, 1).toString("base64url") },
        { id: "old", key },
      ]),
    };
    expect(await open(rotated, encrypted, "provider:github")).toBe(
      "fixture secret",
    );
    await expect(open(rotated, encrypted, "provider:google")).rejects.toThrow();
    const next = await seal(rotated, "fixture secret", "provider:github");
    expect(next).toMatch(/^new\./);
    await expect(open(environment, next, "provider:github")).rejects.toThrow();
  });
});
