import { UiIcon } from "./UiIcon";
import { useEffect, useRef, useSyncExternalStore } from "react";
export type ThemePreference = "light" | "dark" | "system";
const KEY = "whiteboard-appearance";
const media = window.matchMedia("(prefers-color-scheme: dark)");
let preference: ThemePreference = "system";
try {
  const stored = localStorage.getItem(KEY);
  if (stored === "light" || stored === "dark") preference = stored;
} catch {
  /* Storage is optional. */
}
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};
export function useResolvedTheme() {
  return useSyncExternalStore(subscribe, resolvedTheme);
}
export function resolvedTheme() {
  return preference === "system"
    ? media.matches
      ? "dark"
      : "light"
    : preference;
}
function apply() {
  document.documentElement.dataset.theme = resolvedTheme();
  document.documentElement.style.colorScheme = resolvedTheme();
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute(
      "content",
      resolvedTheme() === "dark" ? "#20242b" : "#f5f4ef",
    );
  listeners.forEach((listener) => listener());
}
export function setThemePreference(next: ThemePreference) {
  preference = next;
  try {
    localStorage.setItem(KEY, next);
  } catch {
    /* Storage is optional. */
  }
  apply();
}
media.addEventListener("change", () => {
  if (preference === "system") apply();
});
window.addEventListener("storage", (event) => {
  if (event.key !== KEY) return;
  preference =
    event.newValue === "light" || event.newValue === "dark"
      ? event.newValue
      : "system";
  apply();
});
apply();
export function ThemeMenu() {
  const value = useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    () => preference + ":" + resolvedTheme(),
  );
  const ref = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    const close = (event: PointerEvent) => {
      if (!ref.current?.contains(event.target as Node) && ref.current)
        ref.current.open = false;
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape" && ref.current?.open) {
        ref.current.open = false;
        ref.current.querySelector("summary")?.focus();
      }
    };
    document.addEventListener("pointerdown", close);
    window.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("pointerdown", close);
      window.removeEventListener("keydown", key);
    };
  }, []);
  return (
    <details className="theme-menu" ref={ref}>
      <summary aria-label="Appearance" title="Appearance">
        <UiIcon name={resolvedTheme() === "dark" ? "moon" : "sun"} />
      </summary>
      <div className="appearance-popover" aria-label="Appearance options">
        <strong>Appearance</strong>
        {(["light", "dark", "system"] as ThemePreference[]).map((option) => (
          <button
            key={option}
            type="button"
            aria-label={
              option === "light"
                ? "Light appearance"
                : option === "dark"
                  ? "Dark appearance"
                  : "Use system appearance"
            }
            aria-pressed={value.startsWith(option + ":")}
            onClick={() => { setThemePreference(option); if (ref.current) ref.current.open = false; ref.current?.querySelector("summary")?.focus(); }}
          >
            <UiIcon name={option === "light" ? "sun" : option === "dark" ? "moon" : "system"} />
            <span>
              {option === "light"
                ? "Light"
                : option === "dark"
                  ? "Dark"
                  : "Use system setting"}
            </span>
            <span aria-hidden="true">
              {value.startsWith(option + ":") ? <UiIcon name="check" /> : null}
            </span>
          </button>
        ))}
      </div>
    </details>
  );
}
