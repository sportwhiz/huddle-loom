export type GuestSession = {
  boardId: string;
  linkId: string;
  sessionId: string;
  expiresAt: string;
  csrf: string;
  user: { id: string; name: string; color: string };
  role: string;
  title: string;
};
let current: GuestSession | undefined;
let ended: string | undefined;
export function setGuestSession(value?: GuestSession) {
  current = value;
  ended = undefined;
}
export function guestEndedReason() {
  return guestSession() ? ended : undefined;
}
export function guestSession() {
  return current &&
    typeof location !== "undefined" &&
    location.pathname?.startsWith("/guest/")
    ? current
    : undefined;
}
export function guestBoardRequest(pathname: string) {
  const guest = guestSession();
  const prefix = guest && `/api/v1/boards/${encodeURIComponent(guest.boardId)}`;
  return prefix && (pathname === prefix || pathname.startsWith(`${prefix}/`))
    ? guest
    : undefined;
}
export function guestAccessEnded(
  message = "The board owner changed this link, or your guest access expired.",
) {
  if (ended) return;
  ended = message;
  window.dispatchEvent(
    new CustomEvent("huddle-guest-ended", { detail: message }),
  );
}
