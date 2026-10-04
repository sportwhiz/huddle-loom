import { lazy, Suspense, useEffect, useState, type ReactNode } from "react";
import {
  authSnapshot,
  bootstrapAuth,
  subscribeAuth,
  type AuthBootstrap,
} from "./auth-client";
import { useAppLocation } from "./app-navigation";
import { SessionDrafts } from "./SessionDrafts";
const OnboardingHost = lazy(() =>
  import("./OnboardingTour").then((module) => ({
    default: module.OnboardingHost,
  })),
);
const AuthPage = lazy(() =>
  import("./AuthPage").then((module) => ({ default: module.AuthPage })),
);
const GuestAccess = lazy(() => import('./GuestAccess').then(module => ({default:module.GuestAccess})));
export function AuthGate({ children }: { children: ReactNode }) {
  const location = useAppLocation();
  if (location.pathname.startsWith('/guest/')) return <Suspense fallback={<main className="canvas-loading">Opening your shared board…</main>}><GuestAccess /></Suspense>;
  return (
    <>
      <AuthContent>{children}</AuthContent>
      <SessionDrafts />
    </>
  );
}
function AuthContent({ children }: { children: ReactNode }) {
  const location = useAppLocation();
  const [bootstrap, setBootstrap] = useState<AuthBootstrap>();
  const [error, setError] = useState("");
  const refresh = async () => {
    const value = await bootstrapAuth(true);
    setBootstrap(value);
    return value;
  };
  useEffect(() => {
    let live = true;
    const load = () => {
      void bootstrapAuth()
        .then((value) => {
          if (live) {
            setBootstrap(value);
            setError("");
          }
        })
        .catch((failure) => {
          if (live) {
            setBootstrap(undefined);
            setError(failure.message);
          }
        });
    };
    load();
    const unsubscribe = subscribeAuth(() => {
      setBootstrap(undefined);
      load();
    });
    const timer = setInterval(() => {
      void bootstrapAuth(true)
        .then((value) => {
          if (live) setBootstrap(value);
        })
        .catch(() => {});
    }, 60_000);
    const visibility = () => {
      if (document.visibilityState === "visible")
        void bootstrapAuth(true)
          .then((value) => {
            if (live) setBootstrap(value);
          })
          .catch(() => {});
    };
    document.addEventListener("visibilitychange", visibility);
    return () => {
      live = false;
      unsubscribe();
      clearInterval(timer);
      document.removeEventListener("visibilitychange", visibility);
    };
  }, []);
  useEffect(() => {
    if (bootstrap?.mode !== "native" || !bootstrap.account?.expiresAt) return;
    const delay = Date.parse(bootstrap.account.expiresAt) - Date.now();
    const timer = setTimeout(
      () => {
        setBootstrap(undefined);
        void refresh().catch((failure) => setError(failure.message));
      },
      Math.min(Math.max(delay, 0), 2_147_483_647),
    );
    return () => clearTimeout(timer);
  }, [bootstrap?.account?.expiresAt]);
  if (error)
    return (
      <main className="identity-page">
        <section className="identity-card">
          <h1>Sign-in is unavailable</h1>
          <p role="alert">{error}</p>
          <button
            className="identity-secondary"
            onClick={() => {
              setError("");
              void refresh().catch((failure) => setError(failure.message));
            }}
          >
            Try again
          </button>
        </section>
      </main>
    );
  if (!bootstrap)
    return (
      <main className="canvas-loading" role="status">
        Opening Huddle Loom…
      </main>
    );
  if (bootstrap.mode !== "native") return children;
  const account = bootstrap.account;
  const identityPage =
    [
      "/login",
      "/setup",
      "/verify",
      "/recover",
      "/operator-recovery",
      "/magic",
      "/invite",
      "/account/owner-transfer",
    ].includes(location.pathname) ||
    location.hash.startsWith("#invite=") ||
    location.hash.startsWith("#invitation=");
  const restrictedSettings =
    location.pathname === "/settings/account" && Boolean(account?.verified);
  if (
    identityPage ||
    (!restrictedSettings &&
      (!account ||
        !account.verified ||
        account.status !== "active" ||
        bootstrap.setup ||
        account.needsMfa ||
        account.recoveryRequired))
  )
    return (
      <Suspense
        fallback={
          <main className="canvas-loading" role="status">
            Opening sign-in…
          </main>
        }
      >
        <AuthPage bootstrap={bootstrap} refresh={refresh} />
      </Suspense>
    );
  return (
    <div
      key={`${authSnapshot()?.cacheNamespace}:${bootstrap.user?.id}:${account?.authVersion}`}
      className="authenticated-root"
    >
      {children}
      <Suspense fallback={null}>
        <OnboardingHost bootstrap={bootstrap} refresh={refresh} />
      </Suspense>
    </div>
  );
}
