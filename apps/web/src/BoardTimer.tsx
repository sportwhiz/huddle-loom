import { useEffect, useRef, useState } from "react";
import { apiFetch } from "./auth-client";
import { formatTimer, remainingTimerSeconds, timerSoundEnabled } from "./board-timer";
import type { WorkshopTimer } from "./room-collaboration";
import { UiIcon } from "./UiIcon";

/** The countdown and completion signal belong to the board, not its optional panel. */
export function BoardTimer({ boardId, timer, canControl, online, onOpen }: {
  boardId: string;
  timer: WorkshopTimer | null;
  canControl: boolean;
  online: boolean;
  onOpen: () => void;
}) {
  const [now, setNow] = useState(Date.now);
  const [finished, setFinished] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const pendingRef = useRef(false);
  const previous = useRef(timer);
  const sounded = useRef("");
  const audio = useRef<AudioContext | null>(null);
  const seconds = remainingTimerSeconds(timer, Math.max(now, Date.now()));

  useEffect(() => {
    if (timer?.status !== "running") return;
    const update = () => setNow(Date.now());
    update();
    const interval = window.setInterval(update, 1000);
    document.addEventListener("visibilitychange", update);
    return () => { window.clearInterval(interval); document.removeEventListener("visibilitychange", update); };
  }, [timer?.status, timer?.endsAt]);

  useEffect(() => {
    // Browsers require a gesture before audio. Prepare once during board use;
    // a remote participant's timer still has a visual completion notice.
    const prepare = () => {
      // Prepare even while muted: enabling sound may be the last gesture before expiry.
      try {
        const Audio = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
        if (Audio && !audio.current) audio.current = new Audio();
        if (audio.current?.state === "suspended") void audio.current.resume().catch(() => undefined);
      } catch { /* Audio is optional. */ }
    };
    window.addEventListener("pointerdown", prepare);
    window.addEventListener("keydown", prepare);
    return () => {
      window.removeEventListener("pointerdown", prepare);
      window.removeEventListener("keydown", prepare);
      if (audio.current) void audio.current.close().catch(() => undefined);
      audio.current = null;
    };
  }, []);

  useEffect(() => {
    const before = previous.current;
    previous.current = timer;
    if (!timer || timer.startedAt !== before?.startedAt) { setFinished(null); setError(""); }
    if (timer?.status === "running" && seconds > 0) {
      setFinished(null);
      // Adding time after expiry gives the same session a new finish line.
      if (sounded.current === timer.startedAt) sounded.current = "";
    }
    const elapsed = timer?.status === "running" && seconds === 0;
    const serverEnded = timer?.status === "ended" && before?.status === "running" && before.endsAt && Date.parse(before.endsAt) <= Date.now() + 500;
    if (!timer || !(elapsed || serverEnded) || sounded.current === timer.startedAt) return;
    sounded.current = timer.startedAt;
    setFinished(timer.startedAt);
    const context = audio.current;
    if (!timerSoundEnabled() || !context || context.state !== "running") return;
    try {
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      oscillator.frequency.value = 740;
      gain.gain.setValueAtTime(0.055, context.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, context.currentTime + 0.4);
      oscillator.connect(gain); gain.connect(context.destination);
      oscillator.start(); oscillator.stop(context.currentTime + 0.4);
      oscillator.addEventListener("ended", () => { oscillator.disconnect(); gain.disconnect(); }, { once: true });
    } catch { /* The visible completion notice remains available. */ }
  }, [timer, seconds]);

  const control = async () => {
    if (!timer || !canControl || !online || pendingRef.current) return;
    pendingRef.current = true; setPending(true); setError("");
    try {
      const response = await apiFetch(`/api/v1/boards/${encodeURIComponent(boardId)}/collaboration/commands`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: timer.status === "paused" ? "resume_timer" : "pause_timer", operationId: crypto.randomUUID() }),
      });
      if (!response.ok) {
        const failure = await response.json().catch(() => ({})) as { error?: string };
        throw new Error(failure.error ?? "Could not update the timer. Try again.");
      }
    } catch (failure) { setError(failure instanceof Error ? failure.message : "Could not update the timer."); }
    finally { pendingRef.current = false; setPending(false); }
  };

  const completed = Boolean(timer && finished === timer.startedAt);
  if (!timer || ((timer.status === "ended" || (timer.status === "running" && seconds === 0)) && !completed)) return null;
  return <aside className={`board-timer ${completed ? "complete" : ""}`} aria-label="Board timer">
    <div className="board-timer-controls">
      <button className="board-timer-open" type="button" onClick={onOpen} aria-label="Open timer" title={timer.label}>
        <UiIcon name="clock" />
        <span><strong role="timer" aria-live="off">{completed ? "Time’s up" : formatTimer(seconds)}</strong><small>{!online ? "Offline" : completed ? "Session finished" : timer.status === "paused" ? "Paused" : "Session timer"}</small></span>
      </button>
      {completed ? <button type="button" className="board-timer-action" aria-label="Dismiss finished timer" onClick={() => setFinished(null)}><UiIcon name="close" /></button> : canControl ? <button type="button" className="board-timer-action" aria-label={timer.status === "paused" ? "Resume timer" : "Pause timer"} title={timer.status === "paused" ? "Resume" : "Pause"} disabled={pending || !online || seconds === 0} onClick={() => void control()}><UiIcon name={timer.status === "paused" ? "play" : "pause"} /></button> : null}
    </div>
    {completed && <span className="sr-only" role="status">The session timer has finished.</span>}
    {error && <p role="alert">{error}</p>}
  </aside>;
}
