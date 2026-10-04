/** GoDaddy's managed gateway chooses the verified sender for the app. */
export async function sendGoDaddyMail(message: {
  to: string;
  subject: string;
  text: string;
  html: string;
}) {
  const response = await fetch("http://127.0.0.1:2525/api/email/send", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      to: [message.to],
      subject: message.subject,
      text: message.text,
      html: message.html,
    }),
    signal: AbortSignal.timeout(30_000),
    redirect: "error",
  });
  // Keep provider payloads out of app errors and diagnostics.
  const reader = response.body?.getReader();
  let bytes = 0;
  const chunks: Uint8Array[] = [];
  if (reader)
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > 32768)
          throw new Error("Email gateway response exceeded its limit");
        chunks.push(value);
      }
    } finally {
      await reader.cancel();
    }
  const buffer = new Uint8Array(bytes);
  let position = 0;
  for (const chunk of chunks) {
    buffer.set(chunk, position);
    position += chunk.byteLength;
  }
  let receipt: { success?: unknown; messageId?: unknown };
  try {
    receipt = JSON.parse(new TextDecoder().decode(buffer));
  } catch {
    throw new Error("Email gateway returned an invalid response");
  }
  if (
    !response.ok ||
    receipt.success !== true ||
    typeof receipt.messageId !== "string" ||
    !receipt.messageId ||
    receipt.messageId.length > 512
  )
    throw new Error("Email gateway did not accept the message");
  return { providerId: receipt.messageId };
}
