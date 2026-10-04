import type { WorkshopTimer } from "./room-collaboration";

export function remainingTimerSeconds(timer: WorkshopTimer | null | undefined, now = Date.now()) {
  if (!timer || timer.status === "ended") return 0;
  const milliseconds = timer.status === "running" && timer.endsAt
    ? Date.parse(timer.endsAt) - now
    : timer.remainingMs;
  return Number.isFinite(milliseconds) ? Math.max(0, Math.ceil(milliseconds / 1000)) : 0;
}

export function formatTimer(seconds: number) {
  return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

export function timerSoundEnabled() {
  try { return localStorage.getItem("whiteboard-timer-sound") !== "off"; }
  catch { return true; }
}
