import { EmailSetup } from "./EmailSetup";
import { PRODUCT_NAME } from "./product";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { api, returnPath, type AuthBootstrap } from "./auth-client";
import { UiIcon } from "./UiIcon";
import {
  AuthFrame,
  Feedback,
  Field,
  passkeyAction,
  StepUp,
  Submit,
} from "./auth-ui";

type Enrollment = { totpURI: string; backupCodes: string[] };
export function FactorEnrollment({
  onComplete,
  hasPassword,
}: {
  onComplete: () => Promise<unknown>;
  hasPassword?: boolean;
}) {
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [enrollment, setEnrollment] = useState<Enrollment | null>(null);
  const [qr, setQr] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const [stage, setStage] = useState<"scan" | "recovery" | "verify">("scan");
  const [passwordMethod, setPasswordMethod] = useState<boolean | undefined>(
    hasPassword,
  );
  const [checkingMethod, setCheckingMethod] = useState(
    hasPassword === undefined,
  );
  const stageHeading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    stageHeading.current?.focus();
  }, [stage, Boolean(enrollment)]);
  useEffect(() => {
    if (hasPassword !== undefined) return;
    let live = true;
    void api<Array<{ providerId: string }>>("/api/auth/list-accounts")
      .then((methods) => {
        if (live)
          setPasswordMethod(
            methods.some((method) => method.providerId === "credential"),
          );
      })
      // Recovery sessions may not read account methods. Keep an optional
      // password field when the server cannot tell us which method is used.
      .catch(() => {})
      .finally(() => {
        if (live) setCheckingMethod(false);
      });
    return () => {
      live = false;
    };
  }, [hasPassword]);
  useEffect(() => {
    if (!enrollment) return;
    let live = true;
    void import("qrcode")
      .then((module) =>
        module.toDataURL(enrollment.totpURI, { width: 220, margin: 2 }),
      )
      .then((value) => {
        if (live) setQr(value);
      })
      .catch(() => {
        if (live)
          setError(
            "The QR code could not load. You can use the setup key below.",
          );
      });
    return () => {
      live = false;
    };
  }, [enrollment]);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    if (enrollment && stage === "scan") {
      setStage("recovery");
      return;
    }
    if (enrollment && stage === "recovery") {
      if (saved) setStage("verify");
      return;
    }
    setBusy(true);
    setError("");
    try {
      if (!enrollment) {
        setEnrollment(
          await api(
            "/api/auth/two-factor/enable",
            password ? { password } : {},
          ),
        );
        setSaved(false);
        setStage("scan");
      } else {
        if (!saved)
          throw new Error("Save your recovery codes before continuing.");
        await api("/api/auth/two-factor/verify-totp", { code });
        setEnrollment(null);
        setQr("");
        await onComplete();
      }
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : "Enrollment could not be completed.",
      );
    } finally {
      setBusy(false);
      setPassword("");
      setCode("");
    }
  };
  const download = () => {
    if (!enrollment) return;
    const url = URL.createObjectURL(
      new Blob(
        [
          `Open Whiteboard recovery codes\nEach code works once. Store this file privately.\n\n${enrollment.backupCodes.join("\n")}`,
        ],
        { type: "text/plain" },
      ),
    );
    const link = document.createElement("a");
    link.href = url;
    link.download = "open-whiteboard-recovery-codes.txt";
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    setSaved(true);
  };
  return (
    <>
      <Feedback error={error} />
      <form className="identity-factor" onSubmit={submit}>
        {!enrollment ? (
          <>
            <h2
              className="identity-factor-heading"
              ref={stageHeading}
              tabIndex={-1}
            >
              Connect an authenticator
            </h2>
            <p>
              Use your authenticator app to generate a six-digit sign-in code.
            </p>
            {checkingMethod ? (
              <p role="status">Checking your sign-in method…</p>
            ) : (
              passwordMethod !== false && (
                <Field
                  label="Current password"
                  name="enroll-password"
                  type="password"
                  autoComplete="current-password"
                  value={password}
                  onChange={setPassword}
                  required={passwordMethod === true}
                  hint={
                    passwordMethod === true
                      ? "Confirm your Open Whiteboard password to continue."
                      : "If you sign in with a provider or passkey and have no Open Whiteboard password, leave this blank."
                  }
                />
              )
            )}
            <Submit busy={busy || checkingMethod}>Get setup code</Submit>
          </>
        ) : (
          <>
            <ol
              className="identity-factor-steps"
              aria-label="Authenticator setup"
            >
              <li aria-current={stage === "scan" ? "step" : undefined}>
                1. Scan
              </li>
              <li aria-current={stage === "recovery" ? "step" : undefined}>
                2. Save
              </li>
              <li aria-current={stage === "verify" ? "step" : undefined}>
                3. Verify
              </li>
            </ol>
            {stage === "scan" && (
              <>
                <h2
                  className="identity-factor-heading"
                  ref={stageHeading}
                  tabIndex={-1}
                >
                  Scan with your app
                </h2>
                <p>
                  Add a new account in your authenticator and scan this QR code.
                </p>
                {qr ? (
                  <img
                    className="identity-qr"
                    src={qr}
                    alt="Authenticator setup QR code"
                  />
                ) : (
                  <p role="status">Preparing your QR code…</p>
                )}
                <details>
                  <summary>Enter a setup key instead</summary>
                  <p className="identity-secret">
                    {new URL(enrollment.totpURI).searchParams.get("secret")}
                  </p>
                </details>
                <Submit busy={busy}>Continue</Submit>
              </>
            )}
            {stage === "verify" && (
              <>
                <h2
                  className="identity-factor-heading"
                  ref={stageHeading}
                  tabIndex={-1}
                >
                  Confirm it’s connected
                </h2>
                <p>
                  Enter the current code for Open Whiteboard from your authenticator
                  app.
                </p>
                <Field
                  label="Six-digit code"
                  name="enroll-code"
                  autoComplete="one-time-code"
                  inputMode="numeric"
                  value={code}
                  onChange={setCode}
                />
                <Submit busy={busy}>Verify authenticator</Submit>
              </>
            )}
            {stage === "recovery" && (
              <>
                <h2
                  className="identity-factor-heading"
                  ref={stageHeading}
                  tabIndex={-1}
                >
                  Keep a way back in
                </h2>
                <p>
                  Save these recovery codes somewhere private. Each works once
                  if you lose access to your authenticator.
                </p>
                <div className="identity-codes">
                  {enrollment.backupCodes.map((item) => (
                    <code key={item}>{item}</code>
                  ))}
                </div>
                <button
                  className="identity-secondary"
                  type="button"
                  onClick={download}
                >
                  Download recovery codes
                </button>
                <label className="identity-check">
                  <input
                    type="checkbox"
                    checked={saved}
                    onChange={(event) => setSaved(event.target.checked)}
                  />
                  I have saved these codes somewhere private.
                </label>
                <button
                  className="identity-primary"
                  type="submit"
                  disabled={busy || !saved}
                >
                  I’ve saved my codes
                </button>
              </>
            )}
            {stage !== "scan" && (
              <button
                className="identity-link"
                type="button"
                disabled={busy}
                onClick={() => {
                  setStage(stage === "verify" ? "recovery" : "scan");
                  setError("");
                }}
              >
                Back
              </button>
            )}
          </>
        )}
      </form>
    </>
  );
}

type View = "sign-in" | "sign-up" | "reset" | "magic" | "challenge";
type Confirmation = {
  requiresPassword: boolean;
  purpose: "approve-email-change" | "verify-new-address" | "verify-address";
};
export function AuthPage({
  bootstrap,
  refresh,
}: {
  bootstrap: AuthBootstrap;
  refresh: () => Promise<AuthBootstrap>;
}) {
  const [view, setView] = useState<View>(
    bootstrap.setup && bootstrap.unlocked && !bootstrap.setupReserved
      ? "sign-up"
      : "sign-in",
  );
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [secret, setSecret] = useState("");
  const [code, setCode] = useState("");
  const [backup, setBackup] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [confirmation, setConfirmation] = useState<Confirmation>();
  const [resendAt, setResendAt] = useState(0);
  const [now, setNow] = useState(Date.now());
  const [localRecovery, setLocalRecovery] = useState(false);
  const [recoveryKey, setRecoveryKey] = useState("");
  const [savedRecovery, setSavedRecovery] = useState(false);
  const [workspaceName, setWorkspaceName] = useState(
    (bootstrap.setup && bootstrap.title === "Canvas"
      ? PRODUCT_NAME
      : bootstrap.title) ?? PRODUCT_NAME,
  );
  const [stepUp, setStepUp] = useState(false);
  const [enrollmentMethod, setEnrollmentMethod] = useState<
    "authenticator" | null
  >(null);
  const query = new URLSearchParams(
    `${location.search.slice(1)}&${location.hash.slice(1)}`,
  );
  const proof = query.get("token");
  const localInvite = query.get("localInvite");
  const proofPage = ["/verify", "/magic", "/recover"].includes(
    location.pathname,
  );
  const operatorRecovery = location.pathname === "/operator-recovery";
  const ownership = location.pathname === "/account/owner-transfer";
  const invitation =
    location.pathname === "/invite" ||
    query.has("invite") ||
    query.has("membership") ||
    query.has("invitation");
  const account = bootstrap.account;
  const setup = bootstrap.setup;
  useEffect(() => {
    if (localInvite && !account) setView("sign-up");
  }, [localInvite, Boolean(account)]);
  const unlocked = Boolean(bootstrap.unlocked);
  useEffect(() => {
    if (
      bootstrap.setup &&
      bootstrap.unlocked &&
      !bootstrap.setupReserved &&
      !bootstrap.user
    )
      setView("sign-up");
  }, [bootstrap.setup, bootstrap.unlocked, bootstrap.setupReserved]);
  const challenge =
    view === "challenge" ||
    Boolean(
      account?.verified &&
        !proofPage &&
        (account.needsMfa || (ownership && account.assurance !== "strong")) &&
        account.twoFactorEnabled,
    );
  const enroll = Boolean(
    account?.verified &&
      !proofPage &&
      (setup ||
        account.needsMfa ||
        (ownership && account.assurance !== "strong")) &&
      !account.twoFactorEnabled &&
      account.assurance !== "strong",
  );
  const setupSteps = ["Welcome", "Your account", "Protect it", "Your studio"];
  const progress = setup
    ? {
        current: !unlocked
          ? 0
          : !account?.verified
            ? 1
            : account.assurance !== "strong"
              ? 2
              : 3,
        steps: setupSteps,
      }
    : undefined;
  const work = async (task: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await task();
    } catch (failure) {
      if (
        failure instanceof Error &&
        "code" in failure &&
        failure.code === "STEP_UP_REQUIRED"
      )
        setStepUp(true);
      else
        setError(
          failure instanceof Error
            ? failure.message
            : "This action could not be completed.",
        );
    } finally {
      setBusy(false);
      setPassword("");
      setCode("");
    }
  };
  useEffect(() => {
    if (!invitation && !ownership) return;
    const kind = ownership
      ? "ownership"
      : query.has("membership")
        ? "membership"
        : query.has("invitation")
          ? "invitation"
          : "invite";
    const value = ownership ? proof : query.get(kind);
    if (!value) return;
    let live = true;
    void api("/api/v1/auth/intent", { kind, value }).catch((failure) => {
      if (live && failure.code !== "INVALID_INVITATION")
        setError(
          "This invitation could not be remembered. Keep this tab open while signing in.",
        );
    });
    return () => {
      live = false;
    };
  }, []);
  useEffect(() => {
    if (location.pathname !== "/verify" || !proof) return;
    let live = true;
    void api<Confirmation>("/api/v1/auth/confirmation-info", { token: proof })
      .then((value) => {
        if (live) setConfirmation(value);
      })
      .catch((failure) => {
        if (live) setError(failure.message);
      });
    return () => {
      live = false;
    };
  }, [proof]);
  useEffect(() => {
    if (resendAt <= Date.now()) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [resendAt]);
  useEffect(() => {
    if (
      location.pathname === "/login" &&
      account?.verified &&
      account.status === "active" &&
      !setup &&
      !account.needsMfa &&
      !account.recoveryRequired
    )
      location.replace(bootstrap.returnTo ?? returnPath());
  }, [account, bootstrap.returnTo, setup]);
  const complete = async () => {
    const next = await refresh();
    if (
      !setup &&
      !invitation &&
      !ownership &&
      location.pathname === "/login" &&
      !next.account?.needsMfa &&
      !next.account?.recoveryRequired
    )
      location.replace(next.returnTo ?? returnPath());
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    void work(async () => {
      if (setup && !unlocked) {
        await api("/api/v1/setup/unlock", { secret });
        setSecret("");
        await refresh();
        return;
      }
      if (localRecovery) {
        const result = await api<{ recoveryCode: string }>(
          "/api/auth/recover/local",
          { username: email, code, newPassword: password },
        );
        setSavedRecovery(false);
        setRecoveryKey(result.recoveryCode);
        setLocalRecovery(false);
        await refresh();
        return;
      }
      if (operatorRecovery) {
        if (!proof)
          throw new Error(
            "Open the complete recovery link provided by your operator.",
          );
        await api("/api/auth/operator-recovery", { token: proof });
        history.replaceState(null, "", "/login");
        await refresh();
        return;
      }
      if (proofPage) {
        if (!proof) throw new Error("Open the complete link from your email.");
        const kind = location.pathname;
        if (kind === "/recover")
          await api("/api/auth/reset-password", {
            token: proof,
            newPassword: password,
          });
        else
          await api(`/api/v1/auth/${kind === "/magic" ? "magic" : "verify"}`, {
            token: proof,
            ...(confirmation?.requiresPassword
              ? { newPassword: password }
              : {}),
          });
        history.replaceState(null, "", "/login");
        setNotice(
          kind === "/recover"
            ? "Password updated. Sign in again to continue."
            : confirmation?.purpose === "approve-email-change"
              ? "Now open the message sent to your new address to finish the change."
              : kind === "/magic"
                ? "Sign-in confirmed."
                : "Email confirmed. Sign in to continue.",
        );
        await complete();
        return;
      }
      if (challenge) {
        await api(
          `/api/auth/two-factor/verify-${backup ? "backup-code" : "totp"}`,
          { code },
        );
        await complete();
        setView("sign-in");
        return;
      }
      if (
        view === "sign-up" &&
        (setup || localInvite) &&
        bootstrap.localAccounts
      ) {
        const result = await api<{ recoveryCode: string }>(
          "/api/auth/setup/local",
          {
            name,
            username: email,
            password,
            ...(localInvite ? { invitation: localInvite } : {}),
          },
        );
        setRecoveryKey(result.recoveryCode);
        await refresh();
        return;
      }
      if (view === "sign-up") {
        await api("/api/auth/sign-up/email", { name, email, password });
        setNotice(
          "Check your inbox to confirm your address and choose your password. Then return here to sign in.",
        );
        setView("sign-in");
        return;
      }
      if (view === "reset") {
        await api("/api/auth/request-password-reset", {
          email,
          redirectTo: `${location.origin}/recover`,
        });
        setNotice("If the account is eligible, a reset message will arrive.");
        setResendAt(Date.now() + 60_000);
        return;
      }
      if (view === "magic") {
        await api("/api/auth/sign-in/magic-link", {
          email,
          callbackURL: `${location.origin}/login`,
        });
        setNotice("If the account is eligible, a sign-in message will arrive.");
        setResendAt(Date.now() + 60_000);
        return;
      }
      const result = await api<{ twoFactorRedirect?: boolean }>(
        bootstrap.localAccounts && !email.includes("@")
          ? "/api/auth/sign-in/local"
          : "/api/auth/sign-in/email",
        bootstrap.localAccounts && !email.includes("@")
          ? { username: email, password }
          : { email, password },
      );
      if (result.twoFactorRedirect) setView("challenge");
      else await complete();
    });
  };
  const signOut = () =>
    work(async () => {
      await api("/api/auth/sign-out", {});
      await refresh();
    });
  if (recoveryKey && !savedRecovery)
    return (
      <AuthFrame
        title="Keep your recovery key"
        illustration="security"
        description="Save this key in your password manager. It lets you recover your account without email if you lose your password or device."
      >
        <p className="identity-recovery-key">
          <code style={{ overflowWrap: "anywhere" }}>{recoveryKey}</code>
        </p>
        <button
          className="identity-secondary"
          onClick={() =>
            void navigator.clipboard
              .writeText(recoveryKey)
              .then(() => setNotice("Recovery key copied."))
              .catch(() => setNotice("Select the key above and copy it."))
          }
        >
          Copy recovery key
        </button>
        <Feedback notice={notice} />
        <button
          className="identity-primary"
          onClick={() => {
            setSavedRecovery(true);
            setRecoveryKey("");
            setNotice("");
          }}
        >
          I’ve saved my recovery key
        </button>
      </AuthFrame>
    );
  if (localRecovery)
    return (
      <AuthFrame
        title="Recover your account"
        illustration="security"
        description="Use the recovery key you saved when you created your account. You’ll set up a new security factor before returning to your boards."
      >
        <Feedback error={error} />
        <form onSubmit={submit}>
          <Field
            label="Username"
            name="recovery-username"
            autoComplete="username"
            value={email}
            onChange={setEmail}
          />
          <Field
            label="Recovery key"
            name="recovery-key"
            type="password"
            autoComplete="off"
            value={code}
            onChange={setCode}
          />
          <Field
            label="Choose a new password"
            name="recovery-password"
            type="password"
            autoComplete="new-password"
            value={password}
            onChange={setPassword}
            hint="Use 15–128 characters. Choose a unique phrase."
          />
          <Submit busy={busy}>Recover account</Submit>
        </form>
        <button
          className="identity-link"
          onClick={() => setLocalRecovery(false)}
        >
          Return to sign in
        </button>
      </AuthFrame>
    );
  if (account?.recoveryRequired)
    return (
      <AuthFrame
        title="Restore secure access"
        illustration="security"
        description="Set up a replacement factor, then confirm it to finish recovery."
      >
        <FactorEnrollment onComplete={refresh} />
        <div className="identity-divider">or</div>
        <button
          className="identity-secondary"
          disabled={busy}
          onClick={() =>
            void work(async () => {
              await passkeyAction("add", "Replacement passkey");
              await passkeyAction("sign-in");
              await refresh();
            })
          }
        >
          Set up a replacement passkey
        </button>
        {account.assurance === "strong" && (
          <button
            className="identity-primary"
            disabled={busy}
            onClick={() =>
              void work(async () => {
                await api("/api/v1/account/recovery-complete", {});
                location.replace("/login");
              })
            }
          >
            Finish recovery and sign out
          </button>
        )}
        <Feedback error={error} />
      </AuthFrame>
    );
  if (proofPage && !proof)
    return (
      <AuthFrame
        title="Open the complete email link"
        description="This link is missing its confirmation token. Open the link from your email, or request a new message."
      >
        <a href="/login">Return to sign in</a>
      </AuthFrame>
    );
  if (operatorRecovery)
    return (
      <AuthFrame
        title="Recover installation access"
        description="This private link starts recovery for the installation owner. You’ll need to add a replacement passkey before opening any boards."
      >
        <Feedback error={error} notice={notice} />
        <form onSubmit={submit}>
          <Submit busy={busy}>Start owner recovery</Submit>
        </form>
        <a className="identity-link" href="/login">
          Return to sign in
        </a>
      </AuthFrame>
    );
  if (account && !account.verified && !proofPage)
    return (
      <AuthFrame
        title="Check your inbox"
        icon="mail"
        progress={progress}
        description="Confirm your email address to keep going. The message opens a confirmation screen before making any change."
      >
        <Feedback error={error} notice={notice} />
        <button
          className="identity-primary"
          disabled={busy || resendAt > now}
          onClick={() =>
            void work(async () => {
              await api("/api/auth/send-verification-email", {
                email: bootstrap.user?.email,
                callbackURL: `${location.origin}/login`,
              });
              setResendAt(Date.now() + 60_000);
              setNotice(
                "If another verification message is needed, it will arrive shortly.",
              );
            })
          }
        >
          {resendAt > now
            ? `Resend in ${Math.ceil((resendAt - now) / 1000)}s`
            : "Resend verification"}
        </button>
        <button className="identity-link" onClick={() => void work(refresh)}>
          I’ve confirmed my email
        </button>
        <button className="identity-link" onClick={() => void signOut()}>
          Use a different account
        </button>
      </AuthFrame>
    );
  if (setup && !unlocked && bootstrap.setupCredentialConfigured === false)
    return (
      <AuthFrame
        title="Finish connecting your studio"
        progress={progress}
        description="Choose a private setup passphrase in your hosting dashboard. Then return here to create your administrator account."
      >
        <ol className="identity-setup-help">
          <li>
            {bootstrap.hostingPlatform === "godaddy"
              ? "Open this app in GoDaddy Node.js Hosting. Select Preview or Publish for the address you are using."
              : bootstrap.hostingPlatform === "node"
                ? "Open this app’s environment settings in your hosting dashboard."
                : "Open this app in the Cloudflare dashboard. For a preview, select its environment first."}
          </li>
          <li>
            Under{" "}
            <strong>
              {bootstrap.hostingPlatform === "godaddy"
                ? "Settings → Secrets"
                : bootstrap.hostingPlatform === "node"
                  ? "Environment variables"
                  : "Settings → Runtime variables and secrets"}
            </strong>
            , add a Secret named <code>SETUP_PASSWORD</code>.
          </li>
          <li>
            Choose a unique phrase of at least 16 characters, then save and
            restart or deploy the app.
          </li>
        </ol>
        <p>
          This passphrase proves you control the hosting account. Your everyday
          sign-in password is created next.
        </p>
        <Feedback error={error} />
        <button
          className="identity-primary"
          disabled={busy}
          onClick={() => void work(refresh)}
        >
          I’ve saved it — check again
        </button>
      </AuthFrame>
    );
  if (setup && !unlocked)
    return (
      <AuthFrame
        title="Welcome to your own studio"
        progress={progress}
        description={
          bootstrap.setupPassword
            ? "Enter the private setup passphrase you saved in your hosting dashboard. Next, you’ll create your administrator account."
            : "You’ll be the first owner. Use your setup key to get started."
        }
        footer="This step is only for the first owner of this installation."
      >
        <Feedback error={error} />
        <form onSubmit={submit}>
          <Field
            label={bootstrap.setupPassword ? "Setup passphrase" : "Setup key"}
            name="bootstrap-secret"
            type="password"
            autoComplete="off"
            value={secret}
            onChange={setSecret}
            hint={
              bootstrap.setupPassword
                ? "This is the SETUP_PASSWORD setting from deployment, not your account password."
                : undefined
            }
          />
          <Submit busy={busy}>Continue</Submit>
        </form>
        {!bootstrap.setupPassword && (
          <details className="identity-setup-help">
            <summary>Where do I find my setup key?</summary>
            <p>
              In Cloudflare, open your Worker’s{" "}
              <strong>Settings → Variables and Secrets</strong>. Use the value
              you saved as <code>AUTH_BOOTSTRAP_SECRET</code>.
            </p>
          </details>
        )}
      </AuthFrame>
    );
  if (ownership && account?.verified && account.assurance === "strong")
    return (
      <AuthFrame
        title="Accept installation ownership"
        description="You will manage sign-in, security, invitations, limits, and recovery. The current owner becomes an administrator."
      >
        <Feedback error={error} />
        <p>
          Signed in as <strong>{bootstrap.user?.email}</strong>
        </p>
        <button
          className="identity-primary"
          disabled={busy}
          onClick={() =>
            void work(async () => {
              await api("/api/v1/account/owner-transfer/accept", {
                token: proof,
              });
              location.replace("/settings/system");
            })
          }
        >
          Accept ownership
        </button>
        <button className="identity-link" onClick={() => location.assign("/")}>
          Keep my current role
        </button>
        {stepUp && (
          <StepUp
            onComplete={() => {
              setStepUp(false);
              void refresh();
            }}
            onCancel={() => setStepUp(false)}
          />
        )}
      </AuthFrame>
    );
  if (localInvite && account?.verified && !account.needsMfa)
    return (
      <AuthFrame
        title="Welcome to your Studio"
        description="Your account is ready. Shared boards will appear when their owners give you access."
      >
        <a className="identity-primary" href="/">
          Open Studio
        </a>
      </AuthFrame>
    );
  if (invitation && account?.verified && !account.needsMfa)
    return (
      <AuthFrame
        title="Join your shared space"
        icon="people"
        illustration="collaborate"
        description="Accept to receive the access selected by the person who invited you."
      >
        <Feedback error={error} notice={notice} />
        <div className="identity-account-summary">
          <UiIcon name="people" />
          <div>
            <small>Joining as</small>
            <strong>{bootstrap.user?.email}</strong>
          </div>
        </div>
        <button
          className="identity-primary"
          disabled={busy}
          onClick={() =>
            void work(async () => {
              const membership = query.get("membership");
              const byId = query.get("invitation");
              const result = await api<{ boardId?: string }>(
                membership
                  ? "/api/v1/membership/accept"
                  : byId
                    ? `/api/v1/invitations/${encodeURIComponent(byId)}/accept`
                    : "/api/v1/invitations/accept",
                { token: membership ?? query.get("invite") },
              );
              location.replace(
                result.boardId
                  ? `/boards/${encodeURIComponent(result.boardId)}`
                  : "/",
              );
            })
          }
        >
          Accept invitation
        </button>
        <button className="identity-link" onClick={() => void signOut()}>
          Use a different account
        </button>
      </AuthFrame>
    );
  if (
    account &&
    !setup &&
    !account.needsMfa &&
    !ownership &&
    account.status !== "active"
  )
    return (
      <AuthFrame
        icon="clock"
        illustration="collaborate"
        title={
          account.status === "pending_approval"
            ? "Your request is with an administrator"
            : "Your account is ready for an invitation"
        }
        description={
          account.status === "pending_approval"
            ? "Your email is confirmed. An administrator will review your request before you can open boards."
            : "Open the invitation sent to your address to join this installation."
        }
      >
        <Feedback error={error} />
        <button
          className="identity-secondary"
          onClick={() => void work(refresh)}
        >
          Check access
        </button>
        <a href="/settings/account">Account and security</a>
        <button className="identity-link" onClick={() => void signOut()}>
          Sign out
        </button>
      </AuthFrame>
    );
  if (setup && account?.assurance === "strong" && account.setupUser)
    return (
      <AuthFrame
        title="Your studio is ready"
        illustration="organize"
        progress={progress}
        description="Review your starting settings. You can adjust them later in administration."
      >
        <Feedback error={error} />
        <Field
          label="Studio name"
          name="workspace-name"
          value={workspaceName}
          onChange={setWorkspaceName}
        />
        <details className="identity-setup-help">
          <summary>Email invitations (optional)</summary>
          <p>
            You can start now and invite people with a private link. Connect
            email here or later in Administration.
          </p>
          <EmailSetup onReady={() => void refresh()} />
        </details>
        <ul className="identity-review">
          <li>
            <UiIcon name="lock" />
            <div>
              <strong>Your account is protected</strong>
              <small>Your identity and security method are verified.</small>
            </div>
          </li>
          <li>
            <UiIcon name="people" />
            <div>
              <strong>
                {bootstrap.setupReview?.registration === "public"
                  ? "Verified public signup is enabled."
                  : bootstrap.setupReview?.registration === "closed"
                    ? "Registration is closed."
                    : "New people join by invitation."}
              </strong>
              <small>You can manage who joins in Administration.</small>
            </div>
          </li>
          <li>
            <UiIcon name="folder" />
            <div>
              <strong>Your personal work starts private</strong>
              <small>
                Share individual boards or whole workbooks when you’re ready.
              </small>
            </div>
          </li>
          <li>
            <UiIcon name="settings" />
            <div>
              <strong>Room to get started</strong>
              <small>
                Storage, member limits, and other settings are available in
                Administration.
              </small>
            </div>
          </li>
        </ul>
        <button
          className="identity-primary"
          disabled={busy || !workspaceName.trim()}
          onClick={() =>
            void work(async () => {
              await api("/api/v1/setup/complete", { title: workspaceName });
              location.replace("/");
            })
          }
        >
          Open my studio
        </button>
      </AuthFrame>
    );
  if (enroll)
    return (
      <AuthFrame
        title="Protect your account"
        illustration="security"
        progress={progress}
        description={
          ownership
            ? "Installation ownership requires a working strong sign-in method."
            : "Add a passkey or authenticator to keep your studio safe. This is required for owners and administrators."
        }
      >
        {enrollmentMethod === "authenticator" ? (
          <>
            <FactorEnrollment onComplete={refresh} />
            <button
              className="identity-link"
              onClick={() => setEnrollmentMethod(null)}
            >
              Choose a different method
            </button>
          </>
        ) : (
          <div className="identity-methods">
            <button
              className="identity-method"
              disabled={busy}
              onClick={() =>
                void work(async () => {
                  await passkeyAction("add", "My passkey");
                  await passkeyAction("sign-in");
                  await complete();
                })
              }
            >
              <UiIcon name="key" />
              <span>
                <strong>Set up a passkey</strong>
                <small>
                  Use your device’s fingerprint, face recognition, screen lock,
                  or a security key.
                </small>
                <span className="identity-recommended">Recommended</span>
              </span>
            </button>
            <button
              className="identity-method"
              disabled={busy}
              onClick={() => setEnrollmentMethod("authenticator")}
            >
              <UiIcon name="lock" />
              <span>
                <strong>Use an authenticator app</strong>
                <small>
                  Get a six-digit code from your app when you sign in. Includes
                  recovery codes.
                </small>
              </span>
            </button>
            <button
              className="identity-link"
              disabled={busy}
              onClick={() =>
                void work(async () => {
                  await passkeyAction("sign-in");
                  await complete();
                })
              }
            >
              Use an existing passkey
            </button>
          </div>
        )}
        <Feedback error={error} />
      </AuthFrame>
    );
  const title = proofPage
    ? location.pathname === "/recover"
      ? "Choose a new password"
      : confirmation?.purpose === "approve-email-change"
        ? "Confirm your email change"
        : "Confirm your email link"
    : challenge
      ? "Confirm it’s you"
      : view === "sign-up"
        ? setup
          ? "Create your owner account"
          : "Create your account"
        : view === "reset"
          ? "Reset your password"
          : view === "magic"
            ? "Sign in by email"
            : setup
              ? "Create your owner account"
              : invitation
                ? "Sign in to join"
                : "Welcome back";
  const canRegister = localInvite
    ? true
    : setup
      ? !bootstrap.setupReserved && (bootstrap.localAccounts || bootstrap.email)
      : bootstrap.email && bootstrap.registration !== "closed";
  const emailForm =
    proofPage ||
    challenge ||
    Boolean(bootstrap.email || bootstrap.localAccounts);
  return (
    <AuthFrame
      title={title}
      progress={progress}
      icon={challenge ? "lock" : invitation ? "people" : "key"}
      illustration={
        challenge ? "security" : invitation ? "collaborate" : "notes"
      }
      description={
        challenge
          ? "Use your authenticator or passkey to continue."
          : proofPage
            ? "This action happens only when you confirm it."
            : setup && bootstrap.setupReserved
              ? "An owner account has already started setup. Sign in to that account to resume."
              : setup
                ? "Choose how you’ll sign in. This account will own the studio and manage who can join."
                : view === "sign-up"
                  ? localInvite
                    ? "Choose a username and password for this Studio. No email is needed."
                    : "Create an account to join this studio."
                  : view === "reset"
                    ? "We’ll send you a link to choose a new password."
                    : view === "magic"
                      ? "Get a one-time sign-in link in your inbox."
                      : invitation
                        ? localInvite
                          ? "Choose a username and password for this Studio. No email is needed."
                          : "Use the email address that received the invitation."
                        : "Open your boards and pick up where you left off."
      }
      footer={
        setup
          ? "Setup saves your progress. You can return to finish it."
          : undefined
      }
    >
      <Feedback error={error} notice={notice} />
      {location.pathname === "/verify" && !confirmation && !error && (
        <p role="status">Checking your confirmation link…</p>
      )}
      {emailForm && (
        <form onSubmit={submit}>
          {proofPage ? (
            (location.pathname === "/recover" ||
              confirmation?.requiresPassword) && (
              <Field
                label="Choose your password"
                name="new-password"
                type="password"
                autoComplete="new-password"
                value={password}
                onChange={setPassword}
                hint="Use 15–128 characters. Choose a unique phrase."
              />
            )
          ) : challenge ? (
            <Field
              label={backup ? "Recovery code" : "Authenticator code"}
              name="mfa-code"
              autoComplete="one-time-code"
              inputMode={backup ? "text" : "numeric"}
              value={code}
              onChange={setCode}
            />
          ) : (
            <>
              {view === "sign-up" && (
                <Field
                  label="Your name"
                  name="signup-name"
                  autoComplete="name"
                  value={name}
                  onChange={setName}
                />
              )}
              <Field
                label={
                  bootstrap.localAccounts &&
                  (setup || localInvite) &&
                  view === "sign-up"
                    ? "Choose a username"
                    : bootstrap.localAccounts && view === "sign-in"
                      ? "Username or email address"
                      : "Email address"
                }
                name="login-email"
                type={
                  bootstrap.localAccounts &&
                  (view === "sign-in" ||
                    ((setup || localInvite) && view === "sign-up"))
                    ? "text"
                    : "email"
                }
                autoComplete="username"
                value={email}
                onChange={setEmail}
              />
              {["sign-in", "sign-up"].includes(view) && (
                <Field
                  label="Password"
                  name="login-password"
                  type="password"
                  autoComplete={
                    view === "sign-up" ? "new-password" : "current-password"
                  }
                  value={password}
                  onChange={setPassword}
                  hint={
                    view === "sign-up"
                      ? "Use 15–128 characters. Choose a unique phrase."
                      : undefined
                  }
                />
              )}
            </>
          )}
          <Submit
            busy={
              busy ||
              (location.pathname === "/verify" && !confirmation) ||
              (["reset", "magic"].includes(view) && resendAt > now)
            }
          >
            {proofPage
              ? "Confirm and continue"
              : challenge
                ? "Verify code"
                : view === "sign-up"
                  ? "Create account"
                  : view === "reset"
                    ? "Send reset link"
                    : view === "magic"
                      ? "Send sign-in link"
                      : "Sign in"}
          </Submit>
        </form>
      )}
      {!proofPage && (
        <>
          {(challenge ||
            (view === "sign-in" && (!setup || bootstrap.setupReserved))) && (
            <button
              className="identity-secondary"
              disabled={busy}
              onClick={() =>
                void work(async () => {
                  await passkeyAction("sign-in");
                  await complete();
                })
              }
            >
              {challenge ? "Use a passkey" : "Sign in with a passkey"}
            </button>
          )}
          {challenge ? (
            <button
              className="identity-link"
              onClick={() => setBackup(!backup)}
            >
              {backup ? "Use authenticator" : "Use a recovery code"}
            </button>
          ) : (
            <>
              {((bootstrap.providers?.length ?? 0) > 0 || bootstrap.access) &&
                (emailForm || !setup || bootstrap.setupReserved) && (
                  <div className="identity-divider">or continue with</div>
                )}
              {bootstrap.providers?.map((provider) => (
                <button
                  className={`${!emailForm && setup && !bootstrap.setupReserved && bootstrap.providers?.length === 1 ? "identity-primary" : "identity-secondary"} identity-provider`}
                  disabled={busy}
                  key={provider}
                  onClick={() =>
                    void work(async () => {
                      const result = await api<{ url?: string }>(
                        "/api/auth/sign-in/social",
                        {
                          provider,
                          providerId: provider,
                          callbackURL: location.href,
                          disableRedirect: true,
                        },
                      );
                      if (!result.url)
                        throw new Error(
                          "The provider did not return a sign-in address.",
                        );
                      location.assign(result.url);
                    })
                  }
                >
                  Continue with{" "}
                  {provider === "github"
                    ? "GitHub"
                    : provider === "google"
                      ? "Google"
                      : provider.replace("oidc-", "")}
                </button>
              ))}
              {bootstrap.access && (
                <button
                  className="identity-secondary"
                  disabled={busy}
                  onClick={() =>
                    void work(async () => {
                      await api("/api/auth/sign-in/access", {});
                      await complete();
                    })
                  }
                >
                  Cloudflare Access
                </button>
              )}
              {(bootstrap.email || bootstrap.localAccounts) && (
                <div className="identity-inline-links">
                  {view !== "sign-in" ? (
                    <button
                      className="identity-link"
                      onClick={() => {
                        setView("sign-in");
                        setError("");
                        setNotice("");
                      }}
                    >
                      Back to sign in
                    </button>
                  ) : (
                    <>
                      <button
                        className="identity-link"
                        onClick={() =>
                          bootstrap.localAccounts && !email.includes("@")
                            ? setLocalRecovery(true)
                            : setView("reset")
                        }
                      >
                        Forgot password?
                      </button>
                      {canRegister && (
                        <button
                          className="identity-link"
                          onClick={() => setView("sign-up")}
                        >
                          Create account
                        </button>
                      )}
                    </>
                  )}
                  {bootstrap.magicLink && (
                    <button
                      className="identity-link"
                      onClick={() => setView("magic")}
                    >
                      Email me a sign-in link
                    </button>
                  )}
                </div>
              )}
              {!bootstrap.localAccounts &&
                !bootstrap.email &&
                !bootstrap.providers?.length &&
                !bootstrap.access && (
                  <p>
                    The operator needs to configure an email sender or sign-in
                    provider before new accounts can be created.{" "}
                    <a href="/docs/security-operations.html">
                      Open the installation guide
                    </a>
                    .
                  </p>
                )}
            </>
          )}
        </>
      )}
    </AuthFrame>
  );
}
