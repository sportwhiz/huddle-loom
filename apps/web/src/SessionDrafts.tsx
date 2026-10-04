import { useEffect, useRef, useState } from "react";
import { bootstrapAuth, subscribeAuth } from "./auth-client";
import {
  draftIdentity,
  downloadDrafts,
  registerDraftDecision,
  removeDrafts,
  requireDraftOwner,
  type DraftDecision,
} from "./session-drafts";
import { listAccountDrafts } from "./blocksuite/pending-board";
import { useDialogFocus } from "./useDialogFocus";
import "./auth.css";
export function SessionDrafts() {
  const [decision, setDecision] = useState<DraftDecision>();
  const [available, setAvailable] = useState<DraftDecision>();
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const dialog = useRef<HTMLElement>(null);
  const close = () => {
    if (busy) return;
    decision?.resolve(false);
    setDecision(undefined);
    setError("");
  };
  useDialogFocus(dialog, Boolean(decision), close);
  useEffect(
    () =>
      registerDraftDecision((request) => {
        setError("");
        setDecision(request);
      }),
    [],
  );
  useEffect(() => {
    let live = true,
      generation = 0;
    const load = () => {
      const currentGeneration = ++generation;
      void bootstrapAuth()
        .then(async (value) => {
          if (!live || currentGeneration !== generation) return;
          const identity = draftIdentity(value);
          if (!identity) {
            if (live) setAvailable(undefined);
            return;
          }
          const drafts = await listAccountDrafts(
            identity.namespace,
            identity.userId,
          );
          // The current epoch replays normally after board permissions are checked. Older
          // epochs and legacy drafts require an explicit recovery download.
          const current = `${encodeURIComponent(identity.namespace)}:${encodeURIComponent(identity.userId)}:${value.account?.authVersion}:`;
          const older = drafts.filter(
            (draft) => !draft.key.startsWith(current),
          );
          if (live && currentGeneration === generation)
            setAvailable(
              older.length
                ? { identity, drafts: older, resolve: () => {} }
                : undefined,
            );
        })
        .catch(() => {});
    };
    load();
    const unsubscribe = subscribeAuth(() => {
      setAvailable(undefined);
      setDecision((previous) => {
        previous?.resolve(false);
        return undefined;
      });
      load();
    });
    return () => {
      live = false;
      unsubscribe();
    };
  }, []);
  const finish = async (download: boolean) => {
    if (!decision || busy) return;
    setBusy(true);
    setError("");
    try {
      requireDraftOwner(decision.identity);
      if (download) await downloadDrafts(decision.identity, decision.drafts);
      requireDraftOwner(decision.identity);
      // A download is an extra recovery copy. Keep the account-scoped original so
      // it can resume syncing after sign-in; only the explicit discard clears it.
      if (!download) await removeDrafts(decision.drafts);
      decision.resolve(true);
      setDecision(undefined);
      setAvailable(undefined);
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : "Recovery could not be saved. Your local copy is still here.",
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      {available && !decision && (
        <div className="session-draft-notice" role="status">
          <span>Older unsynced changes are saved on this device.</span>
          <button
            onClick={() => {
              setDecision(available);
              setError("");
            }}
          >
            Review recovery
          </button>
          <button
            onClick={() => setAvailable(undefined)}
            aria-label="Dismiss recovery reminder"
          >
            ×
          </button>
        </div>
      )}
      {decision && (
        <div className="identity-dialog-backdrop">
          <section
            ref={dialog}
            tabIndex={-1}
            className="identity-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="draft-title"
          >
            <h2 id="draft-title">Keep your unsaved work</h2>
            <p>
              {decision.drafts.length}{" "}
              {decision.drafts.length === 1 ? "board has" : "boards have"}{" "}
              changes saved only on this device. Download a recovery copy before
              continuing, or return to the board to let it finish saving.
            </p>
            <p className="identity-hint">
              The download includes local board changes and their cached images.
              Keep it private, like a board export.
            </p>
            {error && (
              <p role="alert" className="identity-error">
                {error}
              </p>
            )}
            <div className="identity-actions">
              <button disabled={busy} onClick={close}>
                Keep working
              </button>
              <button
                disabled={busy}
                className="identity-primary"
                onClick={() => void finish(true)}
              >
                {busy ? "Preparing…" : "Download and continue"}
              </button>
            </div>
            <button
              disabled={busy}
              className="identity-link"
              onClick={() => void finish(false)}
            >
              Discard these local changes and continue
            </button>
          </section>
        </div>
      )}
    </>
  );
}
