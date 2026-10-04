import nodemailer from "nodemailer";
import type { MailSender } from "../auth/repository";

/** Node portability adapter; the persistent outbox, not this transport, retries. */
export function smtpSender(config: {
  host: string;
  port: number;
  user: string;
  password: string;
  servername?: string;
}): MailSender {
  if (
    !config.host ||
    !Number.isInteger(config.port) ||
    config.port < 1 ||
    config.port > 65535
  )
    throw new Error("Invalid SMTP host or port.");
  const transport = nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.port === 465,
    requireTLS: true,
    tls: {
      rejectUnauthorized: true,
      minVersion: "TLSv1.2",
      servername: config.servername ?? config.host,
    },
    auth: { user: config.user, pass: config.password },
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 15000,
    dnsTimeout: 5000,
    disableFileAccess: true,
    disableUrlAccess: true,
    logger: false,
    debug: false,
  });
  return {
    async send(message) {
      if (!/^[a-zA-Z0-9_-]{1,100}$/.test(message.id))
        throw new Error("Invalid outbox message ID.");
      if (
        [message.from, message.to, message.subject].some((value) =>
          /[\r\n]/.test(value),
        )
      )
        throw new Error("Invalid mail header.");
      try {
        const result = await transport.sendMail({
          from: message.from,
          to: message.to,
          subject: message.subject,
          text: message.text,
          html: message.html,
          messageId: `<canvas-${message.id}@${config.servername ?? config.host}>`,
        });
        if (!result.accepted.length || result.rejected.length)
          throw new Error("Recipient rejected");
        return { providerId: result.messageId };
      } catch {
        throw new Error(
          "SMTP delivery was not accepted. Check the configured sender.",
        );
      }
    },
  };
}
