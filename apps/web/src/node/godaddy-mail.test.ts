import { afterEach, describe, expect, it, vi } from "vitest";
import { sendGoDaddyMail } from "./godaddy-mail";
import { mailReady } from "../mail/outbox";
afterEach(() => vi.unstubAllGlobals());
describe("GoDaddy managed email", () => {
  it("uses the fixed loopback gateway without sender credentials and returns acceptance", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(
        Response.json({ success: true, messageId: "delivery:123" }),
      );
    vi.stubGlobal("fetch", fetch);
    expect(
      await sendGoDaddyMail({
        to: "person@example.com",
        subject: "Invitation",
        text: "Join",
        html: "<p>Join</p>",
      }),
    ).toEqual({ providerId: "delivery:123" });
    const [url, request] = fetch.mock.calls[0];
    expect(url).toBe("http://127.0.0.1:2525/api/email/send");
    expect(JSON.parse(request.body)).toEqual({
      to: ["person@example.com"],
      subject: "Invitation",
      text: "Join",
      html: "<p>Join</p>",
    });
    expect(request.redirect).toBe("error");
    expect(
      mailReady({
        CATALOG: {} as D1Database,
        MAIL_PROVIDER: "godaddy",
        MANAGED_MAIL: { send: sendGoDaddyMail },
      }),
    ).toBe(true);
  });
  it("never exposes provider details or treats a missing receipt as delivered", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          Response.json(
            { success: false, error: "private provider configuration" },
            { status: 400 },
          ),
        ),
    );
    await expect(
      sendGoDaddyMail({
        to: "person@example.com",
        subject: "Test",
        text: "Test",
        html: "",
      }),
    ).rejects.toThrow("did not accept");
  });
  it("bounds provider response bytes", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("x".repeat(32769))),
    );
    await expect(
      sendGoDaddyMail({
        to: "person@example.com",
        subject: "Test",
        text: "Test",
        html: "",
      }),
    ).rejects.toThrow("exceeded");
  });
});
