import { useEffect, useRef, useState, type CSSProperties } from "react";
import { api, type AuthBootstrap } from "./auth-client";
import { useAppLocation } from "./app-navigation";
import { useDialogFocus } from "./useDialogFocus";
import { UiIcon } from "./UiIcon";
import { OnboardingArt } from "./OnboardingArt";
import { PRODUCT_TAGLINE } from "./product";
import { MarkerTagline } from "./MarkerTagline";
import "./onboarding.css";

type Journey = "home" | "board" | "admin";
type Step = {
  title: string;
  text: string;
  hint: string;
  picture:
    | "welcome"
    | "organize"
    | "notes"
    | "connect"
    | "collaborate"
    | "assistant"
    | "security";
  target?: string;
};
const bits: Record<Journey, number> = { home: 1, board: 2, admin: 4 };
const homeSteps: Step[] = [
  {
    title: PRODUCT_TAGLINE,
    text: "Put your notes and sketches on one board and bring your team in. Start with one idea, then connect the next.",
    hint: "Your personal workbook starts private. You choose what to share.",
    picture: "welcome",
    target: '[data-onboarding="new-board"]',
  },
  {
    title: "Keep your work easy to find",
    text: "Folders organize workbooks. Workbooks hold boards and can share access with a team. Use search and favorites to get back to an idea.",
    hint: "A board shared directly appears in Shared with me.",
    picture: "organize",
    target: '[data-onboarding="organize"]',
  },
  {
    title: "Build together",
    text: "Use Share on a board or workbook to invite people. Choose whether they can view, comment, edit, or manage it.",
    hint: "Pick your marker color in account settings. Your avatar and live cursor use it.",
    picture: "collaborate",
  },
  {
    title: "Let a conversation become a board",
    text: "Open Connected apps in the Studio navigation. Describe a workflow to your assistant and it can map it out with editable notes and attached arrows.",
    hint: "Choose its boards and permissions. Disconnect it whenever you like.",
    picture: "assistant",
    target: '[data-onboarding="connections"]',
  },
];
const boardSteps: Step[] = [
  {
    title: "Start with a sticky",
    text: "Drag the sticky icon onto the canvas, or select it and click to place a note. Your last color is remembered. Double-click a note to write.",
    hint: "Templates give you a board that is already laid out. Open them from the toolbar, or press N to start with a sticky note.",
    picture: "notes",
    target: ".canvas-tool-rail",
  },
  {
    title: "Keep the flow moving",
    text: "Select a note or shape and use a plus handle to add a connected step. Drag a connector between objects; it stays attached when they move.",
    hint: "Use the shape picker for a decision or another shape.",
    picture: "connect",
    target: ".canvas-tool-rail",
  },
  {
    title: "Make room for your ideas",
    text: "Drag blank canvas with either mouse button to move around. Hold Shift and left-drag to select an area. Use the zoom controls or fit the board to see the bigger picture.",
    hint: "Undo is available after edits. Frames group work for presenting.",
    picture: "organize",
    target: ".canvas-bottom-right",
  },
  {
    title: "Bring people into the conversation",
    text: "Share the board, leave a comment, or open Workshop for a timer, brainstorming, and voting. Present walks through your frames.",
    hint: "History is in the More menu. Preview an earlier version there before you restore it.",
    picture: "collaborate",
    target: ".header-actions",
  },
];
const readerSteps: Step[] = [
  {
    title: "Welcome to this shared board",
    text: "Explore the ideas using pan, zoom, and fit. Your current board role controls whether you can comment or edit.",
    hint: "Sharing a board does not open its other workbooks to you.",
    picture: "collaborate",
    target: ".canvas-bottom-right",
  },
  {
    title: "Find your way around",
    text: "Open Comments to join a discussion if your role allows it. Back to studio shows the boards shared with you.",
    hint: "You can reopen this guide from board help.",
    picture: "organize",
    target: ".header-actions",
  },
];
const adminSteps: Step[] = [
  {
    title: "Set the welcome you want",
    text: "Registration starts with invitations. The owner can choose closed registration or verified public signup with optional approval, and set the security policy.",
    hint: "A newly verified account has no board access until it is admitted or accepts an invitation.",
    picture: "security",
    target: ".identity-nav",
  },
  {
    title: "Invite people with a clear role",
    text: "Members can create private work. Guests join selected boards. Administrators manage the installation; give board access separately through Share.",
    hint: "Copy a private invitation link or send it through your configured email service.",
    picture: "collaborate",
    target: ".identity-nav",
  },
  {
    title: "Keep the installation healthy",
    text: "Check sender delivery, provider callbacks, usage limits, and audit history. The system page links to backup and recovery procedures.",
    hint: "Keep a working recovery method before changing sign-in providers or strong factors.",
    picture: "security",
    target: ".identity-nav",
  },
];

export function OnboardingHost({
  bootstrap,
  refresh,
}: {
  bootstrap: AuthBootstrap;
  refresh: () => Promise<unknown>;
}) {
  const route = useAppLocation();
  const [open, setOpen] = useState(false);
  const [journey, setJourney] = useState<Journey>("home");
  const preferenceKey = `canvas-tour:${bootstrap.cacheNamespace}:${bootstrap.user?.id}`;
  const [seen, setSeen] = useState(() => {
    try {
      return (
        (bootstrap.account?.onboarding ?? 0) |
        Number(localStorage.getItem(preferenceKey) ?? 0)
      );
    } catch {
      return bootstrap.account?.onboarding ?? 0;
    }
  });
  const [step, setStep] = useState(0);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [spot, setSpot] = useState<DOMRect>();
  const [reader, setReader] = useState(false);
  const dialog = useRef<HTMLElement>(null);
  const start = (value: Journey) => {
    setReader(
      ["viewer", "commenter"].includes(
        document
          .querySelector("[data-board-role]")
          ?.getAttribute("data-board-role") ?? "viewer",
      ),
    );
    setJourney(value);
    setStep(0);
    setError("");
    setOpen(true);
  };
  const activeJourney = (): Journey =>
    route.pathname.startsWith("/boards/")
      ? "board"
      : route.pathname.startsWith("/settings/") &&
          ["owner", "admin"].includes(bootstrap.account?.role ?? "")
        ? "admin"
        : "home";
  useEffect(() => {
    const manual = () => start(activeJourney());
    window.addEventListener("canvas-open-tour", manual);
    return () => window.removeEventListener("canvas-open-tour", manual);
  }, [route.pathname, bootstrap.account?.role]);
  useEffect(() => {
    const next = activeJourney();
    if (
      seen & bits[next] ||
      route.pathname === "/settings/account" ||
      route.pathname === "/settings/connections"
    )
      return;
    let observer: MutationObserver | undefined;
    const ready = () => {
      const target =
        next === "board"
          ? document.querySelector(".canvas-bottom-right")
          : next === "home"
            ? document.querySelector(".workspace-main")
            : document.querySelector(".identity-content h1");
      if (!target || document.querySelector('[role="dialog"]')) return false;
      if (next === "board")
        setReader(
          ["viewer", "commenter"].includes(
            document
              .querySelector("[data-board-role]")
              ?.getAttribute("data-board-role") ?? "viewer",
          ),
        );
      start(next);
      observer?.disconnect();
      return true;
    };
    if (!ready()) {
      observer = new MutationObserver(ready);
      observer.observe(document.getElementById("root")!, {
        childList: true,
        subtree: true,
      });
    }
    return () => observer?.disconnect();
  }, [route.pathname, seen]);
  const steps =
    journey === "home"
      ? bootstrap.account?.role === "guest"
        ? [
            {
              ...homeSteps[0],
              title: "Your shared space",
              text: "Boards shared with you appear here. Open an invitation to join a board, then use search and favorites to keep it within reach.",
              hint: "Only boards shared with you appear in your studio.",
              picture: "collaborate" as const,
            },
            ...homeSteps.slice(2),
          ]
        : homeSteps
      : journey === "admin"
        ? adminSteps
        : reader
          ? readerSteps
          : boardSteps;
  const current = steps[Math.min(step, steps.length - 1)];
  const finish = async (status: "completed" | "skipped") => {
    const updated = seen | bits[journey];
    setSeen(updated);
    setOpen(false);
    try {
      localStorage.setItem(preferenceKey, String(updated));
    } catch {
      /* Storage can be disabled. */
    }
    // Closing the optional tour is immediate, including while offline.
    try {
      await api("/api/v1/account/onboarding", { journey, status });
      await refresh();
    } catch {
      /* The device preference keeps the guide dismissed until the next successful save. */
    }
  };
  useDialogFocus(dialog, open, () => {
    void finish("skipped");
  });
  useEffect(() => {
    if (!open) {
      setSpot(undefined);
      return;
    }
    const update = () => {
      const rect = current.target
        ? document.querySelector(current.target)?.getBoundingClientRect()
        : undefined;
      setSpot(
        rect &&
          rect.width > 0 &&
          rect.height > 0 &&
          rect.right > 0 &&
          rect.bottom > 0
          ? rect
          : undefined,
      );
    };
    update();
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [open, current]);
  if (!open) return null;
  return (
    <div className="onboarding-backdrop">
      {spot && (
        <div
          className="onboarding-spotlight"
          aria-hidden="true"
          style={
            {
              left: spot.left - 6,
              top: spot.top - 6,
              width: spot.width + 12,
              height: spot.height + 12,
            } as CSSProperties
          }
        />
      )}
      <section
        className="onboarding-card"
        ref={dialog}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby="tour-title"
        aria-describedby="tour-text"
      >
        <div className="onboarding-top">
          <span>
            {journey === "admin"
              ? "Your administration guide"
              : journey === "board"
                ? "A quick look around"
                : `Welcome${bootstrap.user?.name ? `, ${bootstrap.user.name.split(" ")[0]}` : ""}`}
          </span>
          <button
            type="button"
            disabled={busy}
            onClick={() => void finish("skipped")}
          >
            Skip tour <UiIcon name="close" />
          </button>
        </div>
        <div className="onboarding-picture">
          <OnboardingArt kind={current.picture} />
        </div>
        <div
          className="onboarding-copy"
          aria-live="polite"
          aria-atomic="true"
          key={`${journey}:${step}`}
        >
          <h2 id="tour-title">{current.title === PRODUCT_TAGLINE ? <MarkerTagline /> : current.title}</h2>
          <p id="tour-text">{current.text}</p>
          <div className="onboarding-tip">
            <UiIcon name={current.picture === "security" ? "lock" : "help"} />
            <span>{current.hint}</span>
          </div>
        </div>
        {error && (
          <p className="onboarding-error" role="alert">
            {error}
            <button onClick={() => setOpen(false)}>Close guide</button>
          </p>
        )}
        <footer className="onboarding-footer">
          <div
            className="onboarding-progress"
            aria-label={`Step ${step + 1} of ${steps.length}`}
          >
            {steps.map((item, index) => (
              <span
                key={item.title}
                className={
                  index === step ? "current" : index < step ? "complete" : ""
                }
              />
            ))}
            <small>
              {step + 1} / {steps.length}
            </small>
          </div>
          <div>
            <button
              className="onboarding-back"
              disabled={busy || step === 0}
              onClick={() => setStep((value) => value - 1)}
            >
              Back
            </button>
            <button
              className="onboarding-next"
              disabled={busy}
              onClick={() =>
                step < steps.length - 1
                  ? setStep((value) => value + 1)
                  : void finish("completed")
              }
            >
              {busy
                ? "Saving…"
                : step === steps.length - 1
                  ? "Let’s get started"
                  : "Next"}{" "}
              <UiIcon name="arrow" />
            </button>
          </div>
        </footer>
      </section>
    </div>
  );
}
