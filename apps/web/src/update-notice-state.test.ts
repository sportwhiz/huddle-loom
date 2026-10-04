import { describe, expect, it } from "vitest";
import { NOTICE_SNOOZE_MS, noticePreferenceKey, parseNotice, snoozedUntil } from "./update-notice-state";

const notice = { id: `1.2.3:${"a".repeat(40)}`, version: "1.2.3", security: true, notes: "Fixes a security issue.", inProgress: false, guidedUpgrade: false, deploymentMode: "cloudflare" };
describe("priority update notices", () => {
  it("accepts public notices and rejects malformed or oversized responses", () => {
    expect(parseNotice(null)).toBeNull();
    expect(parseNotice(notice)).toEqual(notice);
    for (const item of [{}, { ...notice, version: "other" }, { ...notice, id: "1.2.4:" + "a".repeat(40) }, { ...notice, notes: "x".repeat(2001) }, { ...notice, inProgress: "yes" }, { ...notice, deploymentMode: "other" }])
      expect(() => parseNotice(item)).toThrow();
  });
  it("scopes dismissal to an installation and account", () => {
    expect(noticePreferenceKey("studio-one", "user")).not.toBe(noticePreferenceKey("studio-two", "user"));
    expect(noticePreferenceKey("studio", "one")).not.toBe(noticePreferenceKey("studio", "two"));
    expect(noticePreferenceKey("a:b", "c")).not.toBe(noticePreferenceKey("a", "b:c"));
  });
  it("reminds after a day and immediately allows a different release", () => {
    const now = 1000, until = now + NOTICE_SNOOZE_MS;
    const stored = JSON.stringify({ id: notice.id, until });
    expect(snoozedUntil(stored, notice.id, now)).toBe(until);
    expect(snoozedUntil(stored, notice.id, until)).toBe(0);
    expect(snoozedUntil(stored, "new-release", now)).toBe(0);
    expect(snoozedUntil(JSON.stringify({ id: notice.id, until: until + 1 }), notice.id, now)).toBe(0);
    expect(snoozedUntil("bad json", notice.id, now)).toBe(0);
  });
});
