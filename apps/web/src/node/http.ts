import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { readFile, realpath, stat } from "node:fs/promises";
import { resolve, extname, sep } from "node:path";
import { WebSocketServer } from "ws";

type Application = { fetch(request: Request): Promise<Response> };
const mime: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".txt": "text/plain; charset=utf-8",
};

export async function staticAssets(directory: string): Promise<Application> {
  const root = await realpath(directory);
  return {
    async fetch(request) {
      if (!["GET", "HEAD"].includes(request.method))
        return new Response(null, { status: 405 });
      const url = new URL(request.url);
      let pathname: string;
      try {
        pathname = decodeURIComponent(url.pathname);
      } catch {
        return new Response(null, { status: 400 });
      }
      let path = resolve(root, `.${pathname}`);
      if (path !== root && !path.startsWith(root + sep))
        return new Response(null, { status: 404 });
      try {
        if (!(await stat(path)).isFile()) throw new Error("not a file");
      } catch {
        // The site root is an explicit document route, including for host health
        // probes that omit Accept or send */*. Other SPA routes need HTML Accept
        // so fallback never hides missing scripts/images or API routes.
        if (
          (pathname !== "/" &&
            !request.headers.get("Accept")?.includes("text/html")) ||
          extname(pathname)
        )
          return new Response(null, { status: 404 });
        path = resolve(root, "index.html");
      }
      const actual = await realpath(path);
      if (!actual.startsWith(root + sep))
        return new Response(null, { status: 404 });
      const metadata = await stat(actual);
      const headers = new Headers({
        "Content-Type": mime[extname(actual)] ?? "application/octet-stream",
        "Content-Length": String(metadata.size),
        "Cache-Control": /\/assets\/[^/]+-[a-zA-Z0-9_-]+\.[a-z0-9]+$/u.test(
          pathname,
        )
          ? "public, max-age=31536000, immutable"
          : "no-cache",
      });
      return new Response(
        request.method === "HEAD"
          ? null
          : new Uint8Array(await readFile(actual)),
        { headers },
      );
    },
  };
}

function webRequest(
  incoming: IncomingMessage,
  origin: URL,
  controller: AbortController,
  websocket = false,
) {
  if (incoming.headers.host?.toLowerCase() !== origin.host.toLowerCase())
    throw new Error("Unrecognized host");
  if (!incoming.url?.startsWith("/") || incoming.url.startsWith("//"))
    throw new Error("Invalid request target");
  const url = new URL(incoming.url, origin);
  if (url.origin !== origin.origin) throw new Error("Invalid request origin");
  const headers = new Headers();
  for (const [name, value] of Object.entries(incoming.headers)) {
    // Forwarding and platform identity headers from the public connection are
    // not trusted. The application gets the direct peer until a provider proxy
    // contract has been qualified; this errs toward shared rate limits.
    if (/^(?:cf-|x-forwarded-|forwarded$|x-real-ip$)/i.test(name)) continue;
    for (const item of Array.isArray(value) ? value : value ? [value] : [])
      headers.append(name, item);
  }
  headers.set("CF-Connecting-IP", incoming.socket.remoteAddress ?? "unknown");
  const hasBody =
    !websocket && !["GET", "HEAD"].includes(incoming.method ?? "GET");
  return new Request(url, {
    method: incoming.method,
    headers,
    signal: controller.signal,
    ...(hasBody
      ? {
          body: Readable.toWeb(incoming) as ReadableStream<Uint8Array>,
          duplex: "half",
        }
      : {}),
  } as RequestInit);
}
async function writeResponse(
  response: Response,
  outgoing: ServerResponse,
  head = false,
) {
  outgoing.statusCode = response.status;
  response.headers.forEach((value, name) => {
    if (name !== "set-cookie") outgoing.setHeader(name, value);
  });
  const cookies = response.headers.getSetCookie();
  if (cookies.length) outgoing.setHeader("Set-Cookie", cookies);
  if (head || !response.body) {
    outgoing.end();
    return;
  }
  await pipeline(Readable.fromWeb(response.body as never), outgoing);
}

export function createNodeHttpServer(
  application: Application,
  canonicalOrigin: string,
) {
  const origin = new URL(canonicalOrigin);
  if (
    origin.origin !== canonicalOrigin ||
    !["http:", "https:"].includes(origin.protocol)
  )
    throw new Error("Canonical origin must be an exact HTTP(S) origin");
  const sockets = new WebSocketServer({
    noServer: true,
    maxPayload: 2_000_000,
    perMessageDeflate: false,
  });
  const server = createServer(
    { requestTimeout: 60_000, headersTimeout: 15_000 },
    async (incoming, outgoing) => {
      const controller = new AbortController();
      outgoing.on("close", () => {
        if (!outgoing.writableFinished) controller.abort();
      });
      incoming.on("aborted", () => controller.abort());
      try {
        let request: Request;
        try {
          request = webRequest(incoming, origin, controller);
        } catch {
          outgoing.writeHead(400).end("Invalid request");
          return;
        }
        const response = await application.fetch(request);
        await writeResponse(response, outgoing, incoming.method === "HEAD");
      } catch {
        if (!outgoing.headersSent)
          outgoing
            .writeHead(500, { "Cache-Control": "no-store" })
            .end("The request could not be completed.");
        else outgoing.destroy();
      }
    },
  );
  server.on("upgrade", async (incoming, socket, head) => {
    // Node stops handling errors on a socket it hands over for an upgrade. A
    // client that resets while the request is authorized would otherwise emit
    // an unhandled 'error' event and stop the process.
    const abandon = () => socket.destroy();
    socket.on("error", abandon);
    try {
      const response = await application.fetch(
        webRequest(incoming, origin, new AbortController(), true),
      );
      const client = (
        response as Response & { webSocket?: { attach(socket: unknown): void } }
      ).webSocket;
      if (response.status !== 101 || !client) {
        socket.end(
          `HTTP/1.1 ${response.status === 101 ? 500 : response.status} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
        );
        return;
      }
      // ws installs its own error handling for the accepted socket.
      socket.off("error", abandon);
      sockets.handleUpgrade(incoming, socket, head, (websocket) =>
        client.attach(websocket),
      );
    } catch {
      socket.end(
        "HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n",
      );
    }
  });
  let closing: Promise<void> | undefined;
  return {
    server,
    close() {
      return (closing ??= (async () => {
        for (const socket of sockets.clients)
          socket.close(1012, "Server restarting");
        const force = setTimeout(() => {
          for (const socket of sockets.clients) socket.terminate();
          server.closeAllConnections();
        }, 5000);
        force.unref();
        try {
          if (server.listening)
            await new Promise<void>((resolve, reject) =>
              server.close((error) => (error ? reject(error) : resolve())),
            );
        } finally {
          clearTimeout(force);
          sockets.close();
        }
      })());
    },
  };
}
