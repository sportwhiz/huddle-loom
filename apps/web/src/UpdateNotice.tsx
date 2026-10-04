import { useCallback, useEffect, useId, useRef, useState } from "react";
import { apiFetch, type AuthBootstrap } from "./auth-client";
import { navigateTo, useAppLocation } from "./app-navigation";
import { UiIcon } from "./UiIcon";
import { useDialogFocus } from "./useDialogFocus";
import { NOTICE_SNOOZE_MS, noticePreferenceKey, parseNotice, snoozedUntil, type UpdateNotice } from "./update-notice-state";
import "./update-notice.css";

export function UpdateNoticeHost({ bootstrap }: { bootstrap: AuthBootstrap }) {
  const route = useAppLocation();
  const [notice, setNotice] = useState<UpdateNotice | null>(null);
  const [open, setOpen] = useState(false);
  const [postponed, setPostponed] = useState(0);
  const lastPrompt = useRef<{ id: string; until: number }>();
  const dialog = useRef<HTMLElement>(null);
  const titleId = useId();
  const descriptionId = useId();
  const userId = bootstrap.user?.id ?? "";
  const preferenceKey = noticePreferenceKey(bootstrap.cacheNamespace ?? location.origin, userId);
  const administrator = ["owner", "admin"].includes(bootstrap.account?.role ?? "");
  const updatesPage = route.pathname === "/settings/updates";
  const postpone = useCallback(() => {
    if (notice) {
      const until = Date.now() + NOTICE_SNOOZE_MS;
      lastPrompt.current = { id: notice.id, until };
      setPostponed(until);
      try { localStorage.setItem(preferenceKey, JSON.stringify({ id: notice.id, until })); } catch { /* Keep the in-memory preference when browser storage is unavailable. */ }
    }
    setOpen(false);
  }, [notice, preferenceKey]);
  useDialogFocus(dialog, open && !updatesPage, postpone);

  useEffect(() => {
    if (!userId) return;
    let live = true, busy = false, lastCheck = 0;
    const abort = new AbortController();
    const check = async () => {
      if (busy || document.visibilityState !== "visible" || Date.now() - lastCheck < 300000) return;
      busy = true;
      lastCheck = Date.now();
      try {
        const response = await apiFetch("/api/v1/updates/notice", { signal: abort.signal });
        if (!response.ok) return;
        const result = await response.json() as { notice: unknown };
        const next = parseNotice(result.notice);
        if (live) setNotice(next);
      } catch { /* Release discovery must not interrupt the board or sign-in. */ }
      finally { busy = false; }
    };
    void check();
    const timer = setInterval(() => void check(), 300000);
    const visible = () => void check();
    document.addEventListener("visibilitychange", visible);
    return () => { live = false; abort.abort(); clearInterval(timer); document.removeEventListener("visibilitychange", visible); };
  }, [userId, preferenceKey]);

  useEffect(() => {
    setOpen(false);
    let stored = 0;
    if (notice) {
      try { stored = snoozedUntil(localStorage.getItem(preferenceKey), notice.id); } catch { /* Browser storage is optional. */ }
      if (lastPrompt.current?.id === notice.id) stored = Math.max(stored, lastPrompt.current.until);
    }
    setPostponed(stored);
    const changed = (event: StorageEvent) => {
      if (!notice || event.key !== preferenceKey) return;
      const until = snoozedUntil(event.newValue, notice.id);
      setPostponed(until);
      if (until) setOpen(false);
    };
    window.addEventListener("storage", changed);
    return () => window.removeEventListener("storage", changed);
  }, [notice?.id, preferenceKey]);

  useEffect(() => {
    if (updatesPage || !notice || notice.inProgress) { setOpen(false); return; }
    if (open) return;
    // Wait for a quiet moment. Do not compete with onboarding, another dialog,
    // active text editing, or a canvas gesture for keyboard focus.
    let quietSince = Date.now(), pointerDown = false;
    const activity = () => { quietSince = Date.now(); };
    const down = () => { pointerDown = true; activity(); };
    const up = () => { pointerDown = false; activity(); };
    const maybeOpen = () => {
      const active = document.activeElement;
      if (document.visibilityState !== "visible" || pointerDown ||
          Date.now() - quietSince < 2000 || Date.now() < postponed ||
          (lastPrompt.current?.id === notice.id && Date.now() < lastPrompt.current.until) ||
          !(bootstrap.account?.onboarding ?? 0) || document.querySelector('[role="dialog"]') ||
          active?.matches('input, textarea, select, [contenteditable="true"]') || active?.closest('[contenteditable="true"]')) return;
      lastPrompt.current = { id: notice.id, until: Date.now() + NOTICE_SNOOZE_MS };
      setOpen(true);
    };
    const timer = setInterval(maybeOpen, 1000);
    window.addEventListener("pointerdown", down);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
    window.addEventListener("blur", up);
    window.addEventListener("keydown", activity);
    return () => {
      clearInterval(timer);
      window.removeEventListener("pointerdown", down);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      window.removeEventListener("blur", up);
      window.removeEventListener("keydown", activity);
    };
  }, [notice?.id, notice?.inProgress, updatesPage, postponed, bootstrap.account?.onboarding, open]);

  if (!notice || updatesPage) return null;
  return <>
    <button className={`update-notice-pill ${notice.security ? "security" : ""}`} type="button"
      onClick={() => setOpen(true)} aria-haspopup="dialog">
      <UiIcon name={notice.security ? "lock" : "download"} />
      <span>{notice.inProgress ? "Update in progress" : notice.security ? "Security update" : "Important update"}</span>
      <span className="update-notice-version">{notice.version}</span>
    </button>
    {open && <div className="update-notice-backdrop">
      <section ref={dialog} className="update-notice-dialog" role="dialog" aria-modal="true"
        aria-labelledby={titleId} aria-describedby={descriptionId} tabIndex={-1}>
        <header><span className="update-notice-eyebrow">CARE FOR YOUR STUDIO</span>
          <button className="update-notice-close" type="button" aria-label="Remind me tomorrow" onClick={postpone}><UiIcon name="close" /></button></header>
        <div className="update-notice-symbol"><UiIcon name={notice.security ? "lock" : "download"} /></div>
        <p className="update-notice-kicker">Huddle Loom {notice.version}</p>
        <h2 id={titleId}>{notice.inProgress ? "Your Studio is updating" : notice.security ? "A security update is ready" : "An important update is ready"}</h2>
        <p id={descriptionId}>{notice.inProgress ? "Your administrator has started an update. You can keep working while it deploys." :
          administrator ? bootstrap.account?.role === "owner" ? "Review what’s changing and choose when to install it." : "Review what’s changing with your Studio owner, who can install the update." :
            "Your Studio administrator can arrange this update. You can keep working while they review it."}</p>
        {notice.notes && <div className="update-notice-notes"><strong>What’s changing</strong><p>{notice.notes}</p></div>}
        {notice.guidedUpgrade && <p className="update-notice-guidance">This release needs a guided upgrade. Your Studio owner can review the requirements in Updates.</p>}
        {administrator && notice.deploymentMode === "manual-node" && <p className="update-notice-guidance">For Node.js hosting, your owner installs updates through the hosting dashboard.</p>}
        <footer>{administrator ? <>
          <button className="update-notice-secondary" type="button" onClick={postpone}>Remind me tomorrow</button>
          <a className="update-notice-primary" href="/settings/updates" onClick={event => { event.preventDefault(); postpone(); navigateTo("/settings/updates"); }}>Review update <span aria-hidden="true">→</span></a>
        </> : <button className="update-notice-primary" type="button" onClick={postpone}>Got it</button>}</footer>
      </section>
    </div>}
  </>;
}
