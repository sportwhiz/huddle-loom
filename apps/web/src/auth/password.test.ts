import { afterEach, describe, expect, it, vi } from "vitest";
import {
  derivePasswordHash,
  hashPassword,
  rejectCompromisedPassword,
  validatePassword,
  verifyPassword,
} from "./password";

afterEach(() => vi.unstubAllGlobals());

describe("password credential boundaries", () => {
  it("accepts pasted Unicode phrases without composition rules and bounds new credentials", () => {
    expect(() => validatePassword("🟢".repeat(128))).not.toThrow();
    expect(() =>
      validatePassword("  a long pasted phrase with spaces  "),
    ).not.toThrow();
    for (const value of [
      "short",
      "passwordpassword",
      "x".repeat(129),
      "🟢".repeat(129),
    ]) {
      expect(() => validatePassword(value)).toThrow();
    }
  });

  it("uses fresh salts and the same normalization when creating and checking a password", async () => {
    const password = "A long phrase with café and 8 words";
    const first = await derivePasswordHash(password);
    const second = await derivePasswordHash(password);
    expect(first).not.toBe(second);
    expect(
      await verifyPassword({
        hash: first,
        password: password.normalize("NFD"),
      }),
    ).toBe(true);
    expect(
      await verifyPassword({ hash: first, password: `${password}!` }),
    ).toBe(false);
  });

  it("does not apply new-password screening to the unknown-user timing hash", async () => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    const hash = await derivePasswordHash("short");
    expect(await verifyPassword({ hash, password: "short" })).toBe(true);
    await expect(hashPassword("short")).rejects.toThrow("15–128");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("rejects a breached credential using only a padded hash-prefix lookup", async () => {
    const value = "a disposable breach fixture 2986";
    const digest = Buffer.from(
      await crypto.subtle.digest("SHA-1", new TextEncoder().encode(value)),
    )
      .toString("hex")
      .toUpperCase();
    const fetcher = vi.fn(async () => new Response(`${digest.slice(5)}:4\r\n`));
    vi.stubGlobal("fetch", fetcher);
    await expect(rejectCompromisedPassword(value)).rejects.toThrow(
      "known breach",
    );
    expect(fetcher).toHaveBeenCalledWith(
      `https://api.pwnedpasswords.com/range/${digest.slice(0, 5)}`,
      expect.objectContaining({
        headers: expect.objectContaining({ "Add-Padding": "true" }),
        redirect: "manual",
      }),
    );
    expect(JSON.stringify(fetcher.mock.calls)).not.toContain(value);
  });

  it("keeps new credential creation closed when screening is unavailable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("unavailable", { status: 503 })),
    );
    await expect(
      hashPassword("a separate unavailable screening fixture 5623"),
    ).rejects.toThrow("temporarily unavailable");
  });
});
