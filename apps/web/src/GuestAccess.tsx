import { lazy, Suspense, useEffect, useState, type FormEvent } from "react";
import { BoardPage } from "./App";
import { BrandMark } from "./BrandMark";
import { PRODUCT_NAME, PRODUCT_TAGLINE } from "./product";
import { ThemeMenu } from "./theme";
import {
  guestAccessEnded,
  setGuestSession,
  type GuestSession,
} from "./guest-client";
import "./auth.css";
import "./guest-sharing.css";

const GuestTour = lazy(() =>
  import("./OnboardingTour").then((module) => ({
    default: module.OnboardingHost,
  })),
);
const noAccountRefresh = async () => undefined;

type LinkInfo = {
  id: string;
  title: string | null;
  passwordRequired: boolean;
  role: string;
};
export function GuestAccess() {
  const [guest, setGuest] = useState<GuestSession>();
  const [info, setInfo] = useState<LinkInfo>();
  const [csrf, setCsrf] = useState("");
  const [name, setName] = useState(""),
    [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [ended, setEnded] = useState("");
  let boardId = "";
  try {
    boardId = decodeURIComponent(location.pathname.slice("/guest/".length));
  } catch {
    /* Show an unavailable link below. */
  }
  const token = new URLSearchParams(location.hash.slice(1)).get("link");
  useEffect(() => {
    let live = true;
    const entry = async () => {
      const response = await fetch(
        `/api/v1/guest-links/session?board=${encodeURIComponent(boardId)}`,
        { credentials: "same-origin", cache: "no-store" },
      );
      const value = await response.json();
      if (!response.ok)
        throw new Error(value.error ?? "Guest access is unavailable.");
      if (!live) return;
      setCsrf(value.entryCsrf);
      if (value.guest && !token) {
        setGuestSession(value.guest);
        setGuest(value.guest);
        return;
      }
      if (!token)
        throw new Error("Open the full guest link shared by the board owner.");
      const inspected = await fetch("/api/v1/guest-links/inspect", {
        method: "POST",
        credentials: "same-origin",
        headers: {
          "Content-Type": "application/json",
          "X-Canvas-CSRF": value.entryCsrf,
        },
        body: JSON.stringify({ boardId, token }),
      });
      const detail = await inspected.json();
      if (!inspected.ok)
        throw new Error(detail.error ?? "This guest link is unavailable.");
      if (!live) return;
      const scopedResponse = await fetch(
        `/api/v1/guest-links/session?board=${encodeURIComponent(boardId)}&linkId=${encodeURIComponent(detail.id)}`,
        { credentials: "same-origin", cache: "no-store" },
      );
      const scoped = await scopedResponse.json();
      if (!scopedResponse.ok)
        throw new Error(scoped.error ?? "Guest access is unavailable.");
      if (live) {
        setCsrf(scoped.entryCsrf);
        if (scoped.guest) {
          setGuestSession(scoped.guest);
          setGuest(scoped.guest);
        } else {
          setInfo(detail);
          setName(value.guest?.user.name ?? "");
        }
      }
    };
    void entry().catch((failure) => {
      if (live) setError(failure.message);
    });
    const changed = (event: Event) =>
      setEnded((event as CustomEvent<string>).detail);
    window.addEventListener("huddle-guest-ended", changed);
    return () => {
      live = false;
      setGuestSession();
      window.removeEventListener("huddle-guest-ended", changed);
    };
  }, [boardId, token]);
  useEffect(() => {
    if (!guest) return;
    let live = true;
    const check = async () => {
      try {
        const response = await fetch(
          `/api/v1/guest-links/session?board=${encodeURIComponent(boardId)}&linkId=${encodeURIComponent(guest.linkId)}`,
          { credentials: "same-origin", cache: "no-store" },
        );
        const value = await response.json();
        if (live && response.ok && value.guest?.sessionId !== guest.sessionId)
          guestAccessEnded(
            value.guest
              ? "This guest session changed in another tab. Open this link again to continue."
              : "Your guest access has ended. Ask the owner for a new link.",
          );
      } catch {
        /* Connection status is also shown by the editor. */
      }
    };
    const timer = setInterval(() => void check(), 30000);
    window.addEventListener("focus", check);
    return () => {
      live = false;
      clearInterval(timer);
      window.removeEventListener("focus", check);
    };
  }, [guest, boardId]);
  const join = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/v1/guest-links/join", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json", "X-Canvas-CSRF": csrf },
        body: JSON.stringify({ boardId, token, name, password }),
      });
      const value = await response.json();
      if (!response.ok)
        throw new Error(value.error ?? "Could not join this board.");
      setGuestSession(value.guest);
      setGuest(value.guest);
      setPassword("");
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : "Could not join this board.",
      );
    } finally {
      setBusy(false);
    }
  };
  if (guest)
    return (
      <>
        <BoardPage boardId={boardId} guest />
        {!ended && (
          <Suspense fallback={null}>
            <GuestTour
              localOnly
              refresh={noAccountRefresh}
              bootstrap={{
                mode: "native",
                configured: true,
                setup: false,
                cacheNamespace: `guest-link:${guest.linkId}`,
                user: { ...guest.user, email: "", avatarUrl: null },
              }}
            />
          </Suspense>
        )}
        {ended && (
          <aside className="guest-ended" role="alert">
            <strong>Guest access ended</strong>
            <span>
              {ended} Download any unsaved edits from the canvas recovery
              message before leaving.
            </span>
            <button onClick={() => location.reload()}>Open link again</button>
          </aside>
        )}
      </>
    );
  return (
    <main className="guest-entry">
      <div className="guest-entry-theme">
        <ThemeMenu />
      </div>
      <section className="guest-entry-card">
        <a className="guest-entry-brand" href="/">
          <BrandMark />
          <span>{PRODUCT_NAME}</span>
        </a>
        <p className="eyebrow">A place for your next idea</p>
        <h1>
          {info?.title ??
            (info
              ? "Join a shared board"
              : error
                ? "This link needs attention"
                : "Opening your invitation…")}
        </h1>
        {info && (
          <p className="guest-entry-intro">
            {info.role === "editor"
              ? "Add ideas, move notes and build together."
              : info.role === "commenter"
                ? "Explore the board and add your comments."
                : "Take a look around the board."}{" "}
            No account needed.
          </p>
        )}
        {error && (
          <p className="guest-entry-error" role="alert">
            {error}
          </p>
        )}
        {info && (
          <form onSubmit={(event) => void join(event)}>
            <label>
              <span>Your name</span>
              <input
                autoFocus
                autoComplete="nickname"
                maxLength={60}
                required
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="What should we call you?"
              />
            </label>
            {info.passwordRequired && (
              <label>
                <span>Board password</span>
                <input
                  type="password"
                  autoComplete="off"
                  maxLength={128}
                  required
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  placeholder="Provided by the board owner"
                />
              </label>
            )}
            <button
              className="guest-entry-join"
              disabled={busy || !name.trim()}
            >
              {busy ? "Joining…" : "Join board"}
              <span aria-hidden="true">↗</span>
            </button>
            <small>
              Your name is visible to people on this board. Guest access lasts
              up to eight hours.
            </small>
          </form>
        )}
        <p className="guest-entry-footer">{PRODUCT_TAGLINE}.</p>
      </section>
      <div className="guest-entry-art" aria-hidden="true">
        <img src="/brand/huddle.webp" alt="" />
        <p>
          Pull up a chair.
          <br />
          <em>Bring your ideas.</em>
        </p>
      </div>
    </main>
  );
}
