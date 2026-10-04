import { createServer } from "node:net";
import { describe, it, expect } from "vitest";
import { smtpSender } from "./node-smtp";

describe("Node SMTP transport", () => {
  it("refuses a server without TLS before sending credentials or message content", async () => {
    let transcript = "";
    const server = createServer((socket) => {
      socket.write("220 fixture.local ESMTP\r\n");
      socket.on("data", (bytes) => {
        transcript += bytes.toString();
        if (bytes.toString().startsWith("EHLO"))
          socket.write("250-fixture.local\r\n250 AUTH PLAIN LOGIN\r\n");
        else socket.end("502 TLS unavailable\r\n");
      });
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    try {
      const address = server.address();
      if (!address || typeof address === "string")
        throw new Error("No fixture listener");
      const sender = smtpSender({
        host: "127.0.0.1",
        port: address.port,
        user: "fixture",
        password: "private-canary",
      });
      await expect(
        sender.send({
          id: "fixture-mail",
          from: "canvas@example.invalid",
          to: "fixture@example.invalid",
          subject: "Fixture",
          text: "private-link-canary",
          html: "private-link-canary",
        }),
      ).rejects.toThrow("SMTP delivery was not accepted");
      expect(transcript).not.toMatch(
        /AUTH |MAIL FROM|private-canary|private-link-canary/,
      );
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
});
