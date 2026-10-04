import { useId, useRef, useState, type FormEvent, type ReactNode } from "react";
import { UiIcon, type UiIconName } from "./UiIcon";
import { OnboardingArt, type OnboardingArtKind } from "./OnboardingArt";
import { WelcomeBoard } from "./WelcomeBoard";
import { BrandMark } from "./BrandMark";
import { PRODUCT_NAME, PRODUCT_WORDMARK } from "./product";
import { ThemeMenu } from "./theme";
import { api, ApiError, bootstrapAuth } from "./auth-client";
import { useDialogFocus } from "./useDialogFocus";
import "./auth.css";

export function Brand() {
  return (
    <a className="identity-brand" href="/" aria-label={`${PRODUCT_NAME} home`}>
      <BrandMark />
      <strong className="brand-wordmark">{PRODUCT_WORDMARK}</strong>
    </a>
  );
}
export function AuthFrame({ title, description, children, footer, progress, icon, illustration }: {
  title: string;
  description?: string;
  children: ReactNode;
  footer?: ReactNode;
  progress?: { current: number; steps: string[] };
  icon?: UiIconName;
  illustration?: OnboardingArtKind;
}) {
  return (
    <main className="identity-page">
      <div className="identity-panel">
        <header className="identity-header"><Brand /></header>
        <div className="identity-form-column">
          <section className="identity-card" aria-labelledby="identity-title">
            {progress && <p className="identity-eyebrow">Step {progress.current + 1} of {progress.steps.length}</p>}
            {icon && <span className="identity-context-icon"><UiIcon name={icon} /></span>}
            <h1 id="identity-title">{title}</h1>
            {description && <p className="identity-description">{description}</p>}
            {children}
          </section>
          {progress && <ol className="identity-setup-steps" aria-label="Installation setup">
            {progress.steps.map((label, index) => <li key={label} className={index === progress.current ? "current" : index < progress.current ? "complete" : ""} aria-current={index === progress.current ? "step" : undefined}>
              <span className="identity-step-number">{index < progress.current ? <UiIcon name="check" /> : String(index + 1).padStart(2, "0")}</span>
              <strong>{label}</strong>
            </li>)}
          </ol>}
        </div>
        {footer && <footer className="identity-footer">{footer}</footer>}
      </div>
      {illustration && illustration !== "notes" ? <aside className="identity-context-art" aria-label="Studio illustration"><OnboardingArt kind={illustration} /></aside> : <WelcomeBoard />}
      <div className="identity-appearance"><ThemeMenu /></div>
    </main>
  );
}
export function Field({
  label,
  name,
  type = "text",
  autoComplete,
  value,
  onChange,
  hint,
  required = true,
  autoFocus = false,
  step,
  inputMode,
}: {
  label: string;
  name: string;
  type?: string;
  autoComplete?: string;
  value: string;
  onChange: (value: string) => void;
  hint?: string;
  required?: boolean;
  autoFocus?: boolean;
  step?: number | string;
  inputMode?: "text" | "numeric";
}) {
  const [visible, setVisible] = useState(false);
  const fieldId = useId();
  const password = type === "password";
  return (
    <label className="identity-field">
      <span id={`${fieldId}-label`}>{label}</span>
      <div className={password ? "identity-password" : ""}>
        <input
          name={name}
          aria-labelledby={`${fieldId}-label`}
          type={password && visible ? "text" : type}
          autoComplete={autoComplete}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          required={required}
          autoFocus={autoFocus}
          step={step}
          inputMode={inputMode}
          aria-describedby={hint ? `${fieldId}-hint` : undefined}
        />
        {password && (
          <button
            type="button"
            aria-label={visible ? "Hide password" : "Show password"}
            onClick={() => setVisible(!visible)}
          >
            {visible ? "Hide" : "Show"}
          </button>
        )}
      </div>
      {hint && <small id={`${fieldId}-hint`}>{hint}</small>}
    </label>
  );
}
export function Feedback({
  error,
  notice,
}: {
  error?: string;
  notice?: string;
}) {
  return (
    <>
      {error && (
        <p className="identity-message error" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className="identity-message" role="status">
          {notice}
        </p>
      )}
    </>
  );
}
export function Submit({
  busy,
  children,
}: {
  busy: boolean;
  children: ReactNode;
}) {
  return (
    <button className="identity-primary" disabled={busy} type="submit">
      {busy ? "Please wait…" : children}
    </button>
  );
}
export async function passkeyAction(kind: "sign-in" | "add", name?: string) {
  const auth = await bootstrapAuth();
  const [{ createAuthClient }, { passkeyClient }] = await Promise.all([
    import("better-auth/client"),
    import("@better-auth/passkey/client"),
  ]);
  const client = createAuthClient({
    baseURL: location.origin,
    plugins: [passkeyClient()],
    fetchOptions: { headers: { "X-Canvas-CSRF": auth.csrf ?? "" } },
  });
  const result =
    kind === "sign-in"
      ? await client.signIn.passkey()
      : await client.passkey.addPasskey({ name });
  if (result.error)
    throw new Error(
      result.error.message ??
        "The passkey operation was canceled or could not be completed.",
    );
  return result.data;
}
export function StepUp({
  onComplete,
  onCancel,
}: {
  onComplete: () => void;
  onCancel: () => void;
}) {
  const dialog = useRef<HTMLElement>(null);
  useDialogFocus(dialog, true, () => {
    if (!busy) onCancel();
  });
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      if (password) await api("/api/v1/account/step-up", { password });
      if (code) await api("/api/auth/two-factor/verify-totp", { code });
      if (!password && !code)
        throw new Error(
          "Enter a password or authenticator code, or use a passkey.",
        );
      const updated = await bootstrapAuth(true);
      if (updated.account?.needsMfa) {
        setError("Confirm your authenticator code or use a passkey to finish.");
        return;
      }
      onComplete();
    } catch (failure) {
      setError(
        failure instanceof Error ? failure.message : "Confirmation failed.",
      );
    } finally {
      setPassword("");
      setCode("");
      setBusy(false);
    }
  };
  return (
    <div className="identity-dialog-backdrop">
      <section
        ref={dialog}
        tabIndex={-1}
        className="identity-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="step-up-title"
      >
        <h2 id="step-up-title">Confirm it’s you</h2>
        <p>Use your authenticator or passkey for a protected change.</p>
        <Feedback error={error} />
        <form onSubmit={submit}>
          <Field
            label="Password"
            name="confirm-password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={setPassword}
            required={false}
          />
          <Field
            label="Authenticator code"
            name="confirm-code"
            autoComplete="one-time-code"
            value={code}
            onChange={setCode}
            required={false}
          />
          <Submit busy={busy}>Confirm identity</Submit>
        </form>
        <button
          className="identity-secondary"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            void passkeyAction("sign-in")
              .then(() => bootstrapAuth(true))
              .then(onComplete)
              .catch((failure) => setError(failure.message))
              .finally(() => setBusy(false));
          }}
        >
          Use a passkey
        </button>
        <button className="identity-link" disabled={busy} onClick={onCancel}>
          Cancel
        </button>
      </section>
    </div>
  );
}
export function useAction(refresh: () => Promise<unknown>) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [retry, setRetry] = useState<(() => Promise<unknown>) | null>(null);
  const run = async (
    task: () => Promise<unknown>,
    success = "Changes saved.",
  ) => {
    if (busy) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await task();
      await refresh();
      setNotice(success);
    } catch (failure) {
      if (failure instanceof ApiError && failure.code === "STEP_UP_REQUIRED")
        setRetry(() => () => run(task, success));
      else
        setError(
          failure instanceof Error
            ? failure.message
            : "This action could not be completed.",
        );
    } finally {
      setBusy(false);
    }
  };
  return {
    busy,
    error,
    notice,
    run,
    feedback: (
      <>
        <Feedback error={error} notice={notice} />
        {retry && (
          <StepUp
            onComplete={() => {
              const action = retry;
              setRetry(null);
              void action();
            }}
            onCancel={() => setRetry(null)}
          />
        )}
      </>
    ),
  };
}
