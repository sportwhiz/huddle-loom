import { describe, expect, it } from "vitest";
import { formatTimer, remainingTimerSeconds } from "./board-timer";
import type { WorkshopTimer } from "./room-collaboration";

const start = Date.parse("2026-10-03T12:00:00Z");
const timer: WorkshopTimer = { status: "running", label: "Review", startedBy: "owner", startedAt: new Date(start).toISOString(), endsAt: new Date(start + 60_000).toISOString(), remainingMs: 60_000 };

describe("board timer clock", () => {
  it("reconstructs the countdown from the server deadline after reload or backgrounding", () => {
    expect(remainingTimerSeconds(timer, start + 21_001)).toBe(39);
    expect(remainingTimerSeconds(timer, start + 65_000)).toBe(0);
  });
  it("keeps a paused timer still regardless of elapsed wall time", () => {
    expect(remainingTimerSeconds({ ...timer, status: "paused", endsAt: null, remainingMs: 12_400 }, start + 600_000)).toBe(13);
  });
  it("does not revive an ended or missing timer using a stale remaining value", () => {
    expect(remainingTimerSeconds({ ...timer, status: "ended" }, start)).toBe(0);
    expect(remainingTimerSeconds(null, start)).toBe(0);
  });
  it("does not show invalid or negative countdowns", () => {
    expect(remainingTimerSeconds({ ...timer, endsAt: "invalid" }, start)).toBe(0);
    expect(remainingTimerSeconds({ ...timer, status: "paused", remainingMs: -1 }, start)).toBe(0);
  });
  it("formats a duration longer than an hour without wrapping the minutes", () => {
    expect(formatTimer(0)).toBe("00:00");
    expect(formatTimer(61)).toBe("01:01");
    expect(formatTimer(7200)).toBe("120:00");
  });
});
