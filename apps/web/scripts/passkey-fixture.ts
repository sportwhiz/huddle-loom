// A software authenticator for cryptographic HTTP conformance. No browser or device credentials are used.
import {
  createHash,
  generateKeyPairSync,
  randomBytes,
  sign,
} from "node:crypto";

type Client = {
  call: (
    path: string,
    body?: unknown,
    expected?: number,
    method?: string,
  ) => Promise<any>;
};
function cbor(value: unknown): Buffer {
  const header = (major: number, n: number) =>
    n < 24
      ? Buffer.from([(major << 5) | n])
      : n < 256
        ? Buffer.from([(major << 5) | 24, n])
        : Buffer.from([(major << 5) | 25, n >> 8, n & 255]);
  if (typeof value === "number")
    return value >= 0 ? header(0, value) : header(1, -1 - value);
  if (typeof value === "string") {
    const b = Buffer.from(value);
    return Buffer.concat([header(3, b.length), b]);
  }
  if (Buffer.isBuffer(value))
    return Buffer.concat([header(2, value.length), value]);
  if (value instanceof Map)
    return Buffer.concat([
      header(5, value.size),
      ...[...value].flatMap(([key, val]) => [cbor(key), cbor(val)]),
    ]);
  throw new Error("Unsupported CBOR fixture value");
}
export function softwarePasskey(origin: string) {
  const { privateKey, publicKey } = generateKeyPairSync("ec", {
    namedCurve: "prime256v1",
  });
  const jwk = publicKey.export({ format: "jwk" }),
    id = randomBytes(32).toString("base64url");
  const rpHash = createHash("sha256").update(new URL(origin).hostname).digest();
  let userId = "",
    counter = 0;
  return {
    id,
    async register(client: Client, { verified = true, expected = 200 } = {}) {
      const options = await client.call(
        "/api/auth/passkey/generate-register-options",
      );
      userId = options.user.id;
      const authData = Buffer.concat([
        rpHash,
        Buffer.from([verified ? 0x45 : 0x41]),
        Buffer.alloc(4),
        Buffer.alloc(16),
        Buffer.from([0, 32]),
        Buffer.from(id, "base64url"),
        cbor(
          new Map<unknown, unknown>([
            [1, 2],
            [3, -7],
            [-1, 1],
            [-2, Buffer.from(jwk.x!, "base64url")],
            [-3, Buffer.from(jwk.y!, "base64url")],
          ]),
        ),
      ]);
      const clientDataJSON = Buffer.from(
        JSON.stringify({
          type: "webauthn.create",
          challenge: options.challenge,
          origin,
          crossOrigin: false,
        }),
      ).toString("base64url");
      const attestationObject = cbor(
        new Map<unknown, unknown>([
          ["fmt", "none"],
          ["attStmt", new Map()],
          ["authData", authData],
        ]),
      ).toString("base64url");
      return client.call(
        "/api/auth/passkey/verify-registration",
        {
          name: "Conformance device",
          response: {
            id,
            rawId: id,
            type: "public-key",
            response: {
              clientDataJSON,
              attestationObject,
              transports: ["internal"],
            },
            clientExtensionResults: {},
          },
        },
        expected,
      );
    },
    async authenticate(
      client: Client,
      { verified = true, responseOrigin = origin, expected = 200 } = {},
    ) {
      const options = await client.call(
        "/api/auth/passkey/generate-authenticate-options",
      );
      const count = Buffer.alloc(4);
      count.writeUInt32BE(++counter);
      const authData = Buffer.concat([
        rpHash,
        Buffer.from([verified ? 0x05 : 0x01]),
        count,
      ]);
      const clientData = Buffer.from(
        JSON.stringify({
          type: "webauthn.get",
          challenge: options.challenge,
          origin: responseOrigin,
          crossOrigin: false,
        }),
      );
      const signature = sign(
        "sha256",
        Buffer.concat([
          authData,
          createHash("sha256").update(clientData).digest(),
        ]),
        privateKey,
      );
      const body = {
        response: {
          id,
          rawId: id,
          type: "public-key",
          response: {
            clientDataJSON: clientData.toString("base64url"),
            authenticatorData: authData.toString("base64url"),
            signature: signature.toString("base64url"),
            userHandle: userId,
          },
          clientExtensionResults: {},
        },
      };
      await client.call(
        "/api/auth/passkey/verify-authentication",
        body,
        expected,
      );
      return body;
    },
  };
}
