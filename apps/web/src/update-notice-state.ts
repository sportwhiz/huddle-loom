export type UpdateNotice = {
  id: string;
  version: string;
  security: boolean;
  notes: string;
  inProgress: boolean;
  guidedUpgrade: boolean;
  deploymentMode: "cloudflare" | "manual-node";
};
export const NOTICE_SNOOZE_MS = 86400000;
export function parseNotice(value: unknown): UpdateNotice | null {
  if (value === null) return null;
  if (!value || typeof value !== "object") throw new Error("Invalid update notice.");
  const item = value as UpdateNotice;
  if (!/^\d{1,5}\.\d{1,5}\.\d{1,5}$/.test(item.version) ||
      !new RegExp(`^${item.version.replaceAll(".", "\\.")}:[a-f0-9]{40}$`).test(item.id) ||
      typeof item.security !== "boolean" || typeof item.inProgress !== "boolean" ||
      typeof item.guidedUpgrade !== "boolean" || typeof item.notes !== "string" ||
      item.notes.length > 2000 || !["cloudflare", "manual-node"].includes(item.deploymentMode))
    throw new Error("Invalid update notice.");
  return item;
}
export function noticePreferenceKey(namespace: string, userId: string) {
  return `huddle-update-notice:${encodeURIComponent(namespace)}:${encodeURIComponent(userId)}`;
}
export function snoozedUntil(value: string | null, id: string, now = Date.now()) {
  try {
    const stored = JSON.parse(value ?? "null");
    return stored?.id === id && Number.isFinite(stored.until) &&
      stored.until > now && stored.until <= now + NOTICE_SNOOZE_MS
      ? stored.until as number : 0;
  } catch { return 0; }
}
