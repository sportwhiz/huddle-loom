import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { createPortal } from "react-dom";
import { api, type AuthBootstrap } from "./auth-client";
import { useAppLocation } from "./app-navigation";
import { useDialogFocus } from "./useDialogFocus";
import { UiIcon } from "./UiIcon";
import { placeTour, type TourRect } from "./tour-layout";
import { tourBits, tourSteps, type Journey, type TourStep } from "./tour-steps";
import "./onboarding.css";

function visibleTarget(current: TourStep): HTMLElement | undefined {
  const targets = Array.from(
    document.querySelectorAll<HTMLElement>(current.target),
  );
  const element = targets.find((element) => {
    const rect = element.getBoundingClientRect();
    return (
      rect.width > 0 &&
      rect.height > 0 &&
      (!current.heading ||
        element.querySelector("h2")?.textContent?.trim() === current.heading)
    );
  });
  // Long settings panels are introduced at their heading; highlighting the whole
  // scrollable form would hide its contents under the coachmark on small screens.
  if (current.child)
    return element?.querySelector<HTMLElement>(current.child) ?? undefined;
  return current.heading
    ? (element?.querySelector<HTMLElement>("h2") ?? element)
    : element;
}
function pageJourney(path: string, role: string): Journey | undefined {
  if (
    path.startsWith("/boards/") ||
    (role === "visitor" && path.startsWith("/guest/"))
  )
    return "board";
  if (path === "/settings/connections") return "connections";
  if (path === "/settings/account") return "account";
  if (
    path.startsWith("/settings/") &&
    (role === "owner" ||
      (role === "admin" &&
        [
          "people",
          "invitations",
          "usage",
          "activity",
          "updates",
          "system",
        ].includes(path.split("/").at(-1) ?? "")))
  )
    return "admin";
  if (path === "/") return "home";
}
export function OnboardingHost({
  bootstrap,
  refresh,
  localOnly = false,
}: {
  bootstrap: AuthBootstrap;
  refresh: () => Promise<unknown>;
  localOnly?: boolean;
}) {
  const route = useAppLocation();
  const role = localOnly ? "visitor" : (bootstrap.account?.role ?? "guest");
  const activeJourney = pageJourney(route.pathname, role);
  const preferenceKey = `huddle-tour:v2:${encodeURIComponent(bootstrap.cacheNamespace ?? "")}:${encodeURIComponent(bootstrap.user?.id ?? "")}`;
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
  const [open, setOpen] = useState(false);
  const [journey, setJourney] = useState<Journey>("home");
  const [reader, setReader] = useState(false);
  const [step, setStep] = useState(0);
  const [spot, setSpot] = useState<TourRect>();
  const [missing, setMissing] = useState(false);
  const [viewport, setViewport] = useState({
    width: innerWidth,
    height: innerHeight,
  });
  const [size, setSize] = useState({ width: 360, height: 330 });
  const dialog = useRef<HTMLElement>(null);
  const target = useRef<HTMLElement>();
  const openedRoute = useRef("");
  const exploreTarget = useRef<HTMLElement>();
  const revealedNavigation = useRef(false);
  const identityKey = useRef(preferenceKey);
  const start = (next: Journey) => {
    setReader(
      ["viewer", "commenter"].includes(
        document
          .querySelector("[data-board-role]")
          ?.getAttribute("data-board-role") ?? "viewer",
      ),
    );
    setJourney(next);
    setStep(0);
    setSpot(undefined);
    setMissing(false);
    openedRoute.current = route.pathname;
    setOpen(true);
  };
  const steps = useMemo(
    () =>
      tourSteps(
        journey,
        role,
        reader,
        route.pathname,
        bootstrap.hostingPlatform,
      ),
    [journey, role, reader, route.pathname, bootstrap.hostingPlatform],
  );
  const current = steps[Math.min(step, steps.length - 1)];
  const finish = async (status: "completed" | "skipped") => {
    const updated = seen | tourBits[journey];
    setSeen(updated);
    setOpen(false);
    try {
      localStorage.setItem(preferenceKey, String(updated));
    } catch {
      /* Device storage is optional. */
    }
    if (localOnly) return;
    try {
      await api("/api/v1/account/onboarding", { journey, status });
      await refresh();
    } catch {
      /* Device dismissal works while offline. */
    }
  };
  useDialogFocus(dialog, open, () => void finish("skipped"));
  useEffect(() => {
    if (identityKey.current === preferenceKey) return;
    identityKey.current = preferenceKey;
    setOpen(false);
    try {
      setSeen(
        (bootstrap.account?.onboarding ?? 0) |
          Number(localStorage.getItem(preferenceKey) ?? 0),
      );
    } catch {
      setSeen(bootstrap.account?.onboarding ?? 0);
    }
  }, [preferenceKey]);
  useEffect(() => {
    if (open || !exploreTarget.current) return;
    const element = exploreTarget.current;
    exploreTarget.current = undefined;
    const frame = requestAnimationFrame(() => {
      if (!element.isConnected) return;
      const control = element.matches(
        "button, a[href], input, select, textarea, [tabindex]",
      )
        ? element
        : (element.querySelector<HTMLElement>(
            "button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled)",
          ) ?? element);
      if (control.tabIndex < 0 && !control.hasAttribute("tabindex")) {
        control.setAttribute("tabindex", "-1");
        control.addEventListener(
          "blur",
          () => control.removeAttribute("tabindex"),
          { once: true },
        );
      }
      control.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [open]);
  useEffect(() => {
    let frame = 0;
    const manual = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (activeJourney && !document.querySelector('[role="dialog"]'))
          start(activeJourney);
      });
    };
    window.addEventListener("canvas-open-tour", manual);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("canvas-open-tour", manual);
    };
  }, [activeJourney, route.pathname]);
  useEffect(() => {
    if (!activeJourney || open || seen & tourBits[activeJourney]) return;
    const readySelector =
      activeJourney === "board"
        ? ".canvas-bottom-right"
        : activeJourney === "home"
          ? ".workspace-main"
          : activeJourney === "connections"
            ? ".connection-setup-card"
            : ".identity-content h1";
    const ready = () => {
      if (
        !document.querySelector(readySelector) ||
        document.querySelector('[role="dialog"]') ||
        document.querySelector(
          'input:focus, textarea:focus, [contenteditable="true"]:focus',
        )
      )
        return;
      start(activeJourney);
    };
    const timer = window.setTimeout(ready, 900);
    const observer = new MutationObserver(() => {
      clearTimeout(timer);
      /* Lazy pages settle before a guide opens. */ schedule();
    });
    let delayed = timer;
    const schedule = () => {
      clearTimeout(delayed);
      delayed = window.setTimeout(ready, 900);
    };
    const root = document.getElementById("root");
    if (root) observer.observe(root, { childList: true, subtree: true });
    return () => {
      clearTimeout(timer);
      clearTimeout(delayed);
      observer.disconnect();
    };
  }, [activeJourney, route.pathname, seen, open]);
  useEffect(() => {
    if (open && openedRoute.current !== route.pathname) void finish("skipped");
  }, [route.pathname]);
  useEffect(() => {
    if (!open) return;
    const toggle = document.querySelector<HTMLButtonElement>(
      ".studio-menu-toggle",
    );
    if (
      current.reveal &&
      toggle &&
      getComputedStyle(toggle).display !== "none" &&
      toggle.getAttribute("aria-expanded") === "false"
    ) {
      toggle.click();
      revealedNavigation.current = true;
    }
    if (
      !current.reveal &&
      revealedNavigation.current &&
      toggle?.getAttribute("aria-expanded") === "true"
    ) {
      toggle.click();
      revealedNavigation.current = false;
    }
    let mounted = true;
    let pending = 0;
    let attempts = 0;
    const update = () => {
      if (!mounted) return;
      const element = visibleTarget(current);
      target.current = element;
      const rect = element?.getBoundingClientRect();
      setViewport((previous) =>
        previous.width === innerWidth && previous.height === innerHeight
          ? previous
          : { width: innerWidth, height: innerHeight },
      );
      if (
        rect &&
        rect.bottom > 0 &&
        rect.right > 0 &&
        rect.left < innerWidth &&
        rect.top < innerHeight
      ) {
        setMissing(false);
        const next = {
          left: Math.max(8, rect.left - 6),
          top: Math.max(8, rect.top - 6),
          right: Math.min(innerWidth - 8, rect.right + 6),
          bottom: Math.min(innerHeight - 8, rect.bottom + 6),
          width:
            Math.min(innerWidth - 8, rect.right + 6) -
            Math.max(8, rect.left - 6),
          height:
            Math.min(innerHeight - 8, rect.bottom + 6) -
            Math.max(8, rect.top - 6),
        };
        setSpot((previous) =>
          previous &&
          Object.keys(next).every(
            (key) =>
              previous[key as keyof TourRect] === next[key as keyof TourRect],
          )
            ? previous
            : next,
        );
      } else {
        setSpot(undefined);
        if (++attempts > 10) setMissing(true);
      }
    };
    const locate = () => {
      const element = visibleTarget(current);
      if (element)
        element.scrollIntoView({
          block: innerWidth < 600 ? "start" : "center",
          inline: "nearest",
          behavior: "instant",
        });
      update();
    };
    pending = requestAnimationFrame(locate);
    const retries = window.setInterval(update, 180);
    const resize = new ResizeObserver(update);
    const element = visibleTarget(current);
    if (element) resize.observe(element);
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      mounted = false;
      cancelAnimationFrame(pending);
      clearInterval(retries);
      resize.disconnect();
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [open, current]);
  useEffect(() => {
    if (!open) return;
    return () => {
      const toggle = document.querySelector<HTMLButtonElement>(
        ".studio-menu-toggle",
      );
      if (
        revealedNavigation.current &&
        toggle?.getAttribute("aria-expanded") === "true"
      )
        toggle.click();
      revealedNavigation.current = false;
    };
  }, [open]);
  useEffect(() => {
    if (!open || !dialog.current) return;
    const update = () => {
      const rect = dialog.current?.getBoundingClientRect();
      if (rect)
        setSize((previous) =>
          previous.width === rect.width && previous.height === rect.height
            ? previous
            : { width: rect.width, height: rect.height },
        );
    };
    const observer = new ResizeObserver(update);
    observer.observe(dialog.current);
    update();
    return () => observer.disconnect();
  }, [open]);
  useEffect(() => {
    if (open)
      dialog.current
        ?.querySelector<HTMLButtonElement>("button")
        ?.focus({ preventScroll: true });
  }, [step]);
  if (!open) return null;
  const placement = placeTour(spot, viewport, {
    width: 360,
    height: size.height,
  });
  const labels: Record<Journey, string> = {
    home: "Your Studio",
    board: "Your whiteboard",
    admin: "Studio administration",
    account: "Your account",
    connections: "Connected apps",
  };
  return createPortal(
    <div className="onboarding-backdrop">
      <svg
        className="onboarding-shade"
        width="100%"
        height="100%"
        aria-hidden="true"
      >
        <defs>
          <mask id="huddle-tour-cutout">
            <rect width="100%" height="100%" fill="white" />
            {spot && (
              <rect
                x={spot.left}
                y={spot.top}
                width={spot.width}
                height={spot.height}
                rx="12"
                fill="black"
              />
            )}
          </mask>
        </defs>
        <rect
          width="100%"
          height="100%"
          fill="currentColor"
          mask="url(#huddle-tour-cutout)"
        />
      </svg>
      {spot && (
        <div
          className="onboarding-spotlight"
          aria-hidden="true"
          style={{
            left: spot.left,
            top: spot.top,
            width: spot.width,
            height: spot.height,
          }}
        />
      )}
      {spot && placement.side !== "none" && (
        <div
          className={`onboarding-arrow ${placement.side}`}
          aria-hidden="true"
          style={{
            left:
              placement.side === "right"
                ? placement.left - 6
                : placement.side === "left"
                  ? placement.left + placement.width - 6
                  : placement.left + placement.arrow - 6,
            top:
              placement.side === "bottom"
                ? placement.top - 6
                : placement.side === "top"
                  ? placement.top +
                    Math.min(size.height, placement.maxHeight) -
                    6
                  : placement.top + placement.arrow - 6,
          }}
        />
      )}
      <section
        ref={dialog}
        className="onboarding-card"
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby="tour-title"
        aria-describedby="tour-text"
        data-tour-side={placement.side}
        data-tour-target={current.target}
        style={
          {
            left: placement.left,
            top: placement.top,
            width: placement.width,
            maxHeight: placement.maxHeight,
            "--tour-arrow": `${placement.arrow}px`,
          } as CSSProperties
        }
      >
        <header className="onboarding-top">
          <span>
            <UiIcon name={current.icon ?? "help"} />
            {labels[journey]}
          </span>
          <button
            type="button"
            onClick={() => void finish("skipped")}
            aria-label="Skip tour"
            title="Skip tour"
          >
            <UiIcon name="close" />
          </button>
        </header>
        <div className="onboarding-copy" aria-live="polite" aria-atomic="true">
          <span className="onboarding-step-label">
            STEP {step + 1} OF {steps.length}
          </span>
          <h2 id="tour-title">{current.title}</h2>
          <p id="tour-text">{current.text}</p>
          <div className="onboarding-tip">
            <span className="onboarding-thread" aria-hidden="true" />
            <span>{current.hint}</span>
          </div>
          {missing && (
            <p className="onboarding-missing" role="status">
              This control is unavailable in your current view. You can continue
              the guide or explore it later.
            </p>
          )}
        </div>
        <footer className="onboarding-footer">
          <button
            type="button"
            className="onboarding-back"
            disabled={step === 0}
            onClick={() => setStep((value) => value - 1)}
          >
            Back
          </button>
          <div
            className="onboarding-progress"
            aria-label={`Step ${step + 1} of ${steps.length}`}
          >
            {steps.map((_, index) => (
              <span
                key={index}
                className={
                  index === step ? "current" : index < step ? "complete" : ""
                }
              />
            ))}
          </div>
          <button
            type="button"
            className="onboarding-next"
            onClick={() =>
              step < steps.length - 1
                ? (setSpot(undefined),
                  setMissing(false),
                  setStep((value) => value + 1))
                : void finish("completed")
            }
          >
            {step === steps.length - 1 ? "Finish tour" : "Next"}
            <UiIcon name="arrow" />
          </button>
        </footer>
        <button
          className="onboarding-explore"
          type="button"
          onClick={() => {
            exploreTarget.current = visibleTarget(current);
            if (current.reveal) revealedNavigation.current = false;
            void finish("skipped");
          }}
        >
          Leave the guide and explore
        </button>
      </section>
    </div>,
    document.body,
  );
}
