import { guestSession, guestBoardRequest, guestAccessEnded, guestEndedReason } from './guest-client';
export type AuthBootstrap = {
  mode: "native" | "access" | "development";
  configured: boolean;
  hostingPlatform?: "cloudflare" | "godaddy" | "node";
  setup: boolean;
  unlocked?: boolean;
  setupState?: string;
  setupReserved?: boolean;
  returnTo?: string;
  setupReview?: {
    registration: string;
    memberLimit: number;
    guestLimit: number;
    boardLimit: number;
  };
  title?: string;
  csrf?: string;
  email?: boolean;
  localAccounts?: boolean;
  setupPassword?: boolean;
  setupCredentialConfigured?: boolean;
  registration?: "invite" | "closed" | "public";
  magicLink?: boolean;
  cacheNamespace?: string;
  providers?: string[];
  access?: boolean;
  user?: {
    id: string;
    name: string;
    email: string;
    color: string;
    avatarUrl: string | null;
  };
  account?: {
    status: string;
    role: string | null;
    verified: boolean;
    localUsername?: string;
    emailVerified?: boolean;
    assurance: string;
    needsMfa: boolean;
    recoveryRequired: boolean;
    twoFactorEnabled: boolean;
    setupUser: boolean;
    authVersion: number;
    expiresAt: string;
    onboarding: number;
  } | null;
};
let snapshot: AuthBootstrap | undefined;
let pending: Promise<AuthBootstrap> | undefined;
let generation = 0;
let observedIdentity: string | undefined;
const listeners = new Set<() => void>();
const channel =
  typeof BroadcastChannel === "function"
    ? new BroadcastChannel("canvas-session")
    : null;
function invalidate(notify = true) {
  generation++;
  snapshot = undefined;
  pending = undefined;
  if (notify) listeners.forEach((listener) => listener());
}
channel?.addEventListener("message", (event) => {
  if (event.data?.type === "identity" && event.data.value === observedIdentity)
    return;
  invalidate();
});
export function subscribeAuth(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
export function authSnapshot() {
  return snapshot;
}
export function cacheIdentity(userId?: string) {
  const guest = guestSession();
  if (guest) {
    if (userId && guest.user.id !== userId) throw new Error('Guest recovery belongs to another session.');
    return `guest:${encodeURIComponent(location.origin)}:${encodeURIComponent(guest.sessionId)}:${encodeURIComponent(guest.user.id)}`;
  }
  const id =
    snapshot?.user?.id ?? (snapshot?.mode !== "native" ? userId : undefined);
  if (!id || (userId && id !== userId))
    throw new Error("An authenticated account is required for local recovery.");
  return [
    snapshot?.cacheNamespace ?? location.origin,
    id,
    snapshot?.account?.authVersion ?? 1,
  ]
    .map((value) => encodeURIComponent(String(value)))
    .join(":");
}
export function announceAuthChange() {
  invalidate();
  channel?.postMessage("changed");
}
export async function bootstrapAuth(force = false): Promise<AuthBootstrap> {
  if (!force && snapshot) return snapshot;
  if (pending) return pending;
  const version = generation;
  const current = fetch("/api/v1/auth/bootstrap", {
    credentials: "same-origin",
    cache: "no-store",
    signal: AbortSignal.timeout(10000),
  })
    .then(async (response) => {
      const data = await response.json();
      if (!response.ok)
        throw new Error(data.error ?? "Sign-in settings are unavailable.");
      if (version !== generation) return bootstrapAuth(true);
      snapshot = data;
      if (data.mode === "native") {
        const identity = JSON.stringify([
          data.cacheNamespace,
          data.user?.id,
          data.account?.authVersion,
          data.account?.status,
          data.account?.assurance,
        ]);
        if (identity !== observedIdentity) {
          observedIdentity = identity;
          // Also covers provider callbacks and passkey sign-in, which can
          // establish a session without going through apiFetch.
          channel?.postMessage({ type: "identity", value: identity });
        }
      }
      return data as AuthBootstrap;
    })
    .finally(() => {
      if (pending === current) pending = undefined;
    });
  pending = current;
  return current;
}
const sessionChanges = new Set([
  "/api/auth/sign-out",
  "/api/auth/operator-recovery",
  "/api/auth/sign-in/email",
  "/api/v1/auth/verify",
  "/api/v1/account/secure",
  "/api/v1/account/logout-all",
  "/api/v1/account/delete",
  "/api/v1/account/recovery-complete",
  "/api/auth/reset-password",
  "/api/auth/change-password",
  "/api/v1/account/password",
]);
export async function apiFetch(
  input: RequestInfo | URL,
  init: RequestInit = {},
) {
  const base =
    input instanceof Request
      ? input
      : new Request(new URL(input.toString(), location.origin));
  const request = new Request(base, init);
  const url = new URL(request.url);
  if (url.origin !== location.origin) return fetch(request);
  if (
    [
      "/api/auth/sign-out",
      "/api/v1/account/logout-all",
      "/api/v1/account/secure",
      "/api/v1/account/delete",
      "/api/auth/change-password",
      "/api/v1/account/password",
    ].includes(url.pathname)
  ) {
    const { draftIdentity, prepareAccountExit } = await import(
      "./session-drafts"
    );
    const identity = draftIdentity(await bootstrapAuth());
    if (identity) await prepareAccountExit(identity);
  }
  const headers = new Headers(request.headers);
  const guest = guestBoardRequest(url.pathname);
  if (guest) {
    if (guestEndedReason())
      return Response.json({ error: guestEndedReason(), code: 'GUEST_ACCESS_ENDED' }, { status: 401 });
    headers.set('X-Huddle-Guest', guest.boardId);
    headers.set('X-Huddle-Guest-Link', guest.linkId);
    headers.set('X-Huddle-Guest-CSRF', guest.csrf);
  }
  if (
    ["POST", "PUT", "PATCH", "DELETE"].includes(request.method.toUpperCase()) &&
    url.pathname.startsWith("/api/") && !guest
  ) {
    const auth = await bootstrapAuth();
    if (auth.mode === "native" && auth.csrf)
      headers.set("X-Canvas-CSRF", auth.csrf);
  }
  const response = await fetch(
    new Request(request, {
      headers,
      credentials: "same-origin",
      cache: "no-store",
    }),
  );
  if (guest && [401, 403].includes(response.status)) {
    const value = await response.clone().json().catch(() => ({}));
    if (response.status === 401 || value.code === 'CSRF_REJECTED') {
      guestAccessEnded(value.code === 'CSRF_REJECTED'
        ? 'This guest session changed. Open this link again to continue.'
        : value.error);
      return response;
    }
  }
  if (response.ok && sessionChanges.has(url.pathname)) {
    const challenge =
      url.pathname === "/api/auth/sign-in/email" &&
      (
        await response
          .clone()
          .json()
          .catch(() => ({}))
      ).twoFactorRedirect === true;
    if (challenge) {
      // The challenge cookie is not a signed-in session. Keep the current
      // sign-in form mounted so it can show the second-factor step.
      invalidate(false);
      channel?.postMessage("changed");
    } else announceAuthChange();
  } else if (
    [401, 403].includes(response.status) &&
    url.pathname.startsWith("/api/v1/") &&
    !url.pathname.startsWith("/api/v1/auth/")
  ) {
    const body = await response
      .clone()
      .json()
      .catch(() => ({}));
    if (
      [
        "AUTHENTICATION_REQUIRED",
        "SESSION_REVOKED",
        "MFA_REQUIRED",
        "RECOVERY_REQUIRED",
        "ADMISSION_REQUIRED",
      ].includes(body.code)
    )
      announceAuthChange();
  }
  return response;
}
export async function api<T = Record<string, unknown>>(
  path: string,
  body?: unknown,
  method = body === undefined ? "GET" : "POST",
): Promise<T> {
  const response = await apiFetch(path, {
    method,
    signal: AbortSignal.timeout(20000),
    ...(body === undefined
      ? {}
      : {
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }),
  });
  const value = await response.json().catch(() => ({}));
  if (!response.ok)
    throw new ApiError(
      value.error ?? value.message ?? "This action could not be completed.",
      value.code ?? "REQUEST_FAILED",
      response.status,
    );
  return value as T;
}
export class ApiError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number,
  ) {
    super(message);
  }
}
export function returnPath() {
  const value = new URLSearchParams(location.search).get("returnTo");
  return value &&
    value.startsWith("/") &&
    !value.startsWith("//") &&
    !/[\\\u0000-\u001f]/u.test(value)
    ? value
    : "/";
}
