import { UpdatesPanel } from "./admin/UpdatesPanel";
import { ThreadColorField } from "./ThreadColorField";
import { securityEventLabel } from "./security-event-label";
import { openTour } from "./onboarding-events";
import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { UiIcon, type UiIconName } from "./UiIcon";
import { ThemeMenu } from "./theme";
import {
  api,
  authSnapshot,
  bootstrapAuth,
  returnPath,
  type AuthBootstrap,
} from "./auth-client";
import {
  Brand,
  Field,
  Feedback,
  passkeyAction,
  StepUp,
  useAction,
} from "./auth-ui";
import { FactorEnrollment } from "./AuthPage";
import { AdminPanel } from "./admin/AdminPanel";
import "./auth.css";

type Security = {
  user: { id: string; name: string; email: string; color: string };
  role: string | null;
  status: string;
  verified: boolean;
  localUsername?: string;
  emailVerified?: boolean;
  twoFactorEnabled: boolean;
  recoveryRequired: boolean;
  methods: { id: string; providerId: string }[];
  passkeys: {
    id: string;
    name: string;
    deviceType: string;
    backedUp: boolean;
    createdAt: string;
  }[];
  sessions: {
    id: string;
    createdAt: string;
    updatedAt: string;
    expiresAt: string;
    userAgent: string | null;
    current: boolean;
  }[];
  events: { id: string; action: string; outcome: string; created_at: string }[];
};
const routes: {
  path: string;
  label: string;
  icon: UiIconName;
  admin?: boolean;
  owner?: boolean;
}[] = [
  { path: "/settings/account", label: "Account and security", icon: "lock" },
  { path: "/settings/connections", label: "Connected apps", icon: "apps" },
  { path: "/settings/people", label: "People", icon: "people", admin: true },
  {
    path: "/settings/invitations",
    label: "Invitations",
    icon: "share",
    admin: true,
  },
  {
    path: "/settings/sign-in",
    label: "Sign-in settings",
    icon: "lock",
    owner: true,
  },
  {
    path: "/settings/clients",
    label: "App clients",
    icon: "apps",
    owner: true,
  },
  {
    path: "/settings/usage",
    label: "Usage and limits",
    icon: "activity",
    admin: true,
  },
  {
    path: "/settings/activity",
    label: "Security activity",
    icon: "history",
    admin: true,
  },
  { path: "/settings/updates", label: "Updates", icon: "history", admin: true },
  { path: "/settings/system", label: "System", icon: "settings", admin: true },
];
export function Settings({ section }: { section: string }) {
  const [confirming, setConfirming] = useState(
    new URLSearchParams(location.search).get("stepUp") === "true",
  );
  const role = authSnapshot()?.account?.role;
  const available = routes.filter(
    (route) =>
      (!route.admin || ["owner", "admin"].includes(role ?? "")) &&
      (!route.owner || role === "owner"),
  );
  const active = available.find(
    (route) => route.path === `/settings/${section}`,
  );
  return (
    <main className="identity-settings">
      {confirming && (
        <StepUp
          onComplete={() => location.replace(returnPath())}
          onCancel={() => {
            setConfirming(false);
            const url = new URL(location.href);
            url.searchParams.delete("stepUp");
            history.replaceState(null, "", url);
          }}
        />
      )}
      <header className="identity-header">
        <Brand />
        <div className="identity-actions">
          <button onClick={() => openTour()}>Quick tour</button>
          <a className="identity-back-link" href="/">
            Back to boards
          </a>
          <ThemeMenu />
        </div>
      </header>
      <div className="identity-layout">
        <nav className="identity-nav" aria-label="Settings">
          {available.map((route, index) => (
            <div key={route.path}>
              {index === 2 && (
                <div className="identity-nav-label">Administration</div>
              )}
              <a
                href={route.path}
                aria-current={active?.path === route.path ? "page" : undefined}
              >
                <UiIcon name={route.icon} />
                {route.label}
              </a>
            </div>
          ))}
        </nav>
        <section className="identity-content">
          <label className="identity-mobile-nav">
            Settings section
            <select
              aria-label="Settings section"
              value={active?.path ?? ""}
              onChange={(event) => location.assign(event.target.value)}
            >
              {available.map((route) => (
                <option value={route.path} key={route.path}>
                  {route.label}
                </option>
              ))}
            </select>
          </label>
          {!active ? (
            <>
              <h1>Settings unavailable</h1>
              <p>This section requires a different installation role.</p>
              <a href="/settings/account">Open your account</a>
            </>
          ) : section === "updates" ? (
            <UpdatesPanel />
          ) : section === "account" ? (
            <AccountPanel />
          ) : (
            <AdminPanel key={section} section={section} />
          )}
        </section>
      </div>
    </main>
  );
}
function Row({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children?: ReactNode;
}) {
  return (
    <div className="identity-row">
      <div>
        <strong>{title}</strong>
        {description && <small>{description}</small>}
      </div>
      <div className="identity-actions">{children}</div>
    </div>
  );
}
function AccountPanel() {
  const [data, setData] = useState<Security>();
  const [loadError, setLoadError] = useState("");
  const [edit, setEdit] = useState<
    | "profile"
    | "email"
    | "password"
    | "authenticator"
    | "codes"
    | "delete"
    | null
  >(null);
  const [name, setName] = useState("");
  const [color, setColor] = useState("#4262ff");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [codes, setCodes] = useState<string[]>();
  const [localRecoveryKey, setLocalRecoveryKey] = useState("");
  const refresh = async () => {
    const value = await api<Security>("/api/v1/account/security");
    setData(value);
    setName(value.user.name);
    setColor(value.user.color);
    await bootstrapAuth(true);
  };
  const action = useAction(refresh);
  useEffect(() => {
    void refresh().catch((failure) => setLoadError(failure.message));
  }, []);
  if (loadError)
    return (
      <>
        <h1>Account and security</h1>
        <Feedback error={loadError} />
        <button
          onClick={() => {
            setLoadError("");
            void refresh().catch((failure) => setLoadError(failure.message));
          }}
        >
          Try again
        </button>
      </>
    );
  if (!data) return <p role="status">Opening account settings…</p>;
  const hasPassword = data.methods.some(
    (method) => method.providerId === "credential",
  );
  const save = (event: FormEvent) => {
    event.preventDefault();
    void action.run(
      async () => {
        if (edit === "profile")
          await api("/api/v1/account/profile", { name, color }, "PATCH");
        if (edit === "email")
          await api("/api/auth/change-email", {
            newEmail: email,
            callbackURL: `${location.origin}/login`,
          });
        if (edit === "password")
          await api(
            hasPassword
              ? "/api/auth/change-password"
              : "/api/v1/account/password",
            hasPassword
              ? {
                  currentPassword: password,
                  newPassword,
                  revokeOtherSessions: true,
                }
              : { newPassword },
          );
        if (edit === "codes") {
          const result = await api<{ backupCodes: string[] }>(
            "/api/auth/two-factor/generate-backup-codes",
            password ? { password } : {},
          );
          setCodes(result.backupCodes);
        }
        if (edit === "delete") {
          await api("/api/v1/account/delete", { confirm });
          location.replace("/login");
        }
        if (edit !== "codes") setEdit(null);
        setPassword("");
        setNewPassword("");
      },
      edit === "email"
        ? "Check your current and new inboxes to confirm this change."
        : edit === "password"
          ? "Password updated. Sign in again if prompted, then reconnect your apps."
          : edit === "codes"
            ? "New recovery codes are shown once below."
            : "Changes saved.",
    );
  };
  return (
    <>
      <h1>Account and security</h1>
      <p>Choose how you sign in and control where you stay signed in.</p>
      {action.feedback}
      <section className="identity-section">
        <Row
          title={data.user.name}
          description={`${data.user.email} · ${data.localUsername ? "Studio account" : data.verified ? "verified" : "verification pending"}`}
        >
          <button
            disabled={action.busy}
            onClick={() => setEdit(edit === "profile" ? null : "profile")}
          >
            Edit profile
          </button>
        </Row>
        <Row
          title="Email address"
          description={
            data.localUsername && !data.emailVerified
              ? "Add and verify an address for email invitations and password recovery once Studio email is connected."
              : "Your current address stays in use until the new one is confirmed."
          }
        >
          <button
            disabled={action.busy || !authSnapshot()?.email}
            onClick={() => setEdit(edit === "email" ? null : "email")}
          >
            {data.localUsername && !data.emailVerified
              ? "Add email"
              : "Change email"}
          </button>
        </Row>
        <Row
          title="Password"
          description={
            hasPassword
              ? "Changing your password signs out existing sessions and disconnects apps."
              : "Add a password as another sign-in method. You’ll sign in again afterward."
          }
        >
          <button
            disabled={action.busy}
            onClick={() => setEdit(edit === "password" ? null : "password")}
          >
            {hasPassword ? "Change password" : "Add password"}
          </button>
        </Row>
        {data.localUsername && (
          <>
            <Row
              title="Account recovery key"
              description="Recover your username account without email. Replacing the key immediately invalidates the old one; save the new key in your password manager."
            >
              <button
                disabled={action.busy}
                onClick={() =>
                  void action.run(async () => {
                    const result = await api<{ recoveryCode: string }>(
                      "/api/v1/account/local-recovery-key",
                      {},
                    );
                    setLocalRecoveryKey(result.recoveryCode);
                  })
                }
              >
                Replace recovery key
              </button>
            </Row>
            {localRecoveryKey && (
              <div className="identity-recovery-key">
                <code style={{ overflowWrap: "anywhere" }}>
                  {localRecoveryKey}
                </code>
                <button onClick={() => setLocalRecoveryKey("")}>
                  I’ve saved my key
                </button>
              </div>
            )}
          </>
        )}
        <Row
          title="Passkeys"
          description="Use your device’s screen lock. A passkey can satisfy your second factor."
        >
          <button
            disabled={action.busy}
            onClick={() =>
              void action.run(() =>
                passkeyAction(
                  "add",
                  `Passkey ${new Date().toLocaleDateString()}`,
                ),
              )
            }
          >
            Add passkey
          </button>
        </Row>
        {data.passkeys.map((key) => (
          <Row
            key={key.id}
            title={key.name || "Passkey"}
            description={`${key.backedUp ? "Synced passkey" : "Device passkey"} · added ${new Date(key.createdAt).toLocaleDateString()}`}
          >
            <PasskeyName id={key.id} name={key.name} action={action} />
            <button
              disabled={action.busy}
              className="identity-danger"
              onClick={() =>
                void action.run(() =>
                  api("/api/auth/passkey/delete-passkey", { id: key.id }),
                )
              }
            >
              Remove
            </button>
          </Row>
        ))}
        <Row
          title="Authenticator"
          description={
            data.twoFactorEnabled
              ? "Two-factor authentication is enabled."
              : "Use a six-digit code from an authenticator app."
          }
        >
          <button
            disabled={action.busy}
            onClick={() =>
              setEdit(edit === "authenticator" ? null : "authenticator")
            }
          >
            {data.twoFactorEnabled ? "Manage" : "Set up"}
          </button>
        </Row>
        <Row
          title="Recovery codes"
          description="Shown once when generated. Each code works once and starts restricted factor recovery."
        >
          <button
            disabled={!data.twoFactorEnabled || action.busy}
            onClick={() => {
              setCodes(undefined);
              setEdit(edit === "codes" ? null : "codes");
            }}
          >
            Replace codes
          </button>
        </Row>
      </section>
      {edit && (
        <section className="identity-section">
          <h2>
            {edit === "profile"
              ? "Your profile"
              : edit === "email"
                ? "Change your email address"
                : edit === "password"
                  ? "Set a new password"
                  : edit === "codes"
                    ? "Replace recovery codes"
                    : edit === "delete"
                      ? "Delete this account"
                      : "Authenticator settings"}
          </h2>
          {edit === "authenticator" ? (
            data.twoFactorEnabled ? (
              <>
                <p>
                  Keep a working passkey before disabling an authenticator
                  required by your role or the installation policy.
                </p>
                <Field
                  label="Current password"
                  name="disable-mfa-password"
                  type="password"
                  autoComplete="current-password"
                  value={password}
                  onChange={setPassword}
                  required={false}
                />
                <button
                  className="identity-danger"
                  disabled={action.busy}
                  onClick={() =>
                    void action.run(() =>
                      api(
                        "/api/auth/two-factor/disable",
                        password ? { password } : {},
                      ),
                    )
                  }
                >
                  Disable authenticator
                </button>
              </>
            ) : (
              <FactorEnrollment
                onComplete={refresh}
                hasPassword={hasPassword}
              />
            )
          ) : (
            <form onSubmit={save}>
              {edit === "profile" && (
                <>
                  <Field
                    label="Display name"
                    name="profile-name"
                    autoComplete="name"
                    value={name}
                    onChange={setName}
                  />
                  <ThreadColorField value={color} onChange={setColor} />
                </>
              )}
              {edit === "email" && (
                <Field
                  label="New email address"
                  name="new-email"
                  type="email"
                  autoComplete="email"
                  value={email}
                  onChange={setEmail}
                />
              )}{" "}
              {(edit === "password" || edit === "codes") && hasPassword && (
                <Field
                  label="Current password"
                  name="current-password"
                  type="password"
                  autoComplete="current-password"
                  value={password}
                  onChange={setPassword}
                />
              )}{" "}
              {edit === "password" && (
                <Field
                  label="New password"
                  name="new-password"
                  type="password"
                  autoComplete="new-password"
                  hint="Use 15–128 characters. Avoid common or compromised passwords."
                  value={newPassword}
                  onChange={setNewPassword}
                />
              )}{" "}
              {edit === "delete" && (
                <>
                  <p>
                    Transfer or delete owned content first. Shared boards retain
                    their history with a deleted-account attribution.
                    Installation ownership must be transferred separately.
                  </p>
                  <Field
                    label={
                      data.localUsername
                        ? "Type your username"
                        : "Type your email address"
                    }
                    name="delete-confirmation"
                    autoComplete="off"
                    value={confirm}
                    onChange={setConfirm}
                  />
                </>
              )}
              {edit === "codes" && codes ? (
                <>
                  <div className="identity-codes">
                    {codes.map((code) => (
                      <code key={code}>{code}</code>
                    ))}
                  </div>
                  <button
                    type="button"
                    onClick={() =>
                      download(
                        "huddle-loom-recovery-codes.txt",
                        codes.join("\n"),
                        "text/plain",
                      )
                    }
                  >
                    Download codes
                  </button>
                </>
              ) : (
                <button
                  className={
                    edit === "delete" ? "identity-danger" : "identity-primary"
                  }
                  disabled={action.busy}
                  type="submit"
                >
                  {edit === "email"
                    ? "Send confirmation"
                    : edit === "codes"
                      ? "Generate replacement codes"
                      : edit === "delete"
                        ? "Delete account"
                        : "Save"}
                </button>
              )}
            </form>
          )}
          <button
            className="identity-link"
            onClick={() => {
              setEdit(null);
              setPassword("");
              setNewPassword("");
              setCodes(undefined);
            }}
          >
            Close
          </button>
        </section>
      )}
      <section className="identity-section">
        <h2>Sign-in providers</h2>
        {data.methods
          .filter((method) => method.providerId !== "credential")
          .map((method) => (
            <Row key={method.id} title={method.providerId}>
              <button
                className="identity-danger"
                disabled={action.busy}
                onClick={() =>
                  void action.run(() =>
                    api("/api/auth/unlink-account", {
                      accountId: method.id,
                    }),
                  )
                }
              >
                Unlink
              </button>
            </Row>
          ))}
        {authSnapshot()
          ?.providers?.filter(
            (provider) =>
              !data.methods.some((method) => method.providerId === provider),
          )
          .map((provider) => (
            <button
              key={provider}
              disabled={action.busy}
              onClick={() =>
                void action.run(async () => {
                  const value = await api<{ url: string }>(
                    "/api/auth/link-social",
                    {
                      provider,
                      providerId: provider,
                      callbackURL: `${location.origin}/settings/account`,
                      disableRedirect: true,
                    },
                  );
                  location.assign(value.url);
                })
              }
            >
              Link {provider}
            </button>
          ))}
        {data.methods.every((method) => method.providerId === "credential") &&
          !authSnapshot()?.providers?.length && (
            <p>No external providers are configured.</p>
          )}
      </section>
      <section className="identity-section">
        <h2>Devices and sessions</h2>
        <p>Device descriptions come from the browser and may be incomplete.</p>
        {data.sessions.map((session) => (
          <Row
            key={session.id}
            title={
              session.current ? "This session" : deviceLabel(session.userAgent)
            }
            description={`Last active ${new Date(session.updatedAt).toLocaleString()} · expires ${new Date(session.expiresAt).toLocaleDateString()}`}
          >
            <button
              className="identity-danger"
              disabled={action.busy}
              onClick={() =>
                void action.run(async () => {
                  await api(
                    `/api/v1/account/sessions/${encodeURIComponent(session.id)}`,
                    undefined,
                    "DELETE",
                  );
                  if (session.current) location.replace("/login");
                })
              }
            >
              Sign out
            </button>
          </Row>
        ))}
        <div className="identity-actions">
          <button
            className="identity-danger"
            disabled={action.busy}
            onClick={() =>
              void action.run(async () => {
                await api("/api/v1/account/logout-all", {});
                location.replace("/login");
              })
            }
          >
            Sign out all devices
          </button>
          <button
            className="identity-danger"
            disabled={action.busy}
            onClick={() =>
              void action.run(async () => {
                await api("/api/v1/account/secure", {});
                location.replace("/login");
              })
            }
          >
            Secure account and disconnect apps
          </button>
        </div>
      </section>
      <section className="identity-section">
        <h2>Recent security activity</h2>
        {data.events.length ? (
          data.events.map((event) => (
            <Row
              key={event.id}
              title={securityEventLabel(event.action)}
              description={`${new Date(event.created_at).toLocaleString()} · ${event.outcome}`}
            />
          ))
        ) : (
          <p>No recent security activity.</p>
        )}
      </section>
      <section className="identity-section">
        <h2>Your data</h2>
        <div className="identity-actions">
          <button
            disabled={action.busy}
            onClick={() =>
              void action.run(async () => {
                const value = await api("/api/v1/account/export");
                download("canvas-account.json", JSON.stringify(value, null, 2));
              }, "Account export downloaded.")
            }
          >
            Export account information
          </button>
          <button
            className="identity-danger"
            disabled={action.busy}
            onClick={() => setEdit("delete")}
          >
            Delete account
          </button>
        </div>
      </section>
    </>
  );
}
function PasskeyName({
  id,
  name,
  action,
}: {
  id: string;
  name: string;
  action: ReturnType<typeof useAction>;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(name || "Passkey");
  return editing ? (
    <form
      className="identity-actions"
      onSubmit={(event) => {
        event.preventDefault();
        void action.run(async () => {
          await api("/api/auth/passkey/update-passkey", { id, name: value });
          setEditing(false);
        });
      }}
    >
      <input
        aria-label="Passkey name"
        value={value}
        onChange={(event) => setValue(event.target.value)}
        maxLength={80}
      />
      <button disabled={action.busy} type="submit">
        Save
      </button>
      <button type="button" onClick={() => setEditing(false)}>
        Cancel
      </button>
    </form>
  ) : (
    <button onClick={() => setEditing(true)}>Rename</button>
  );
}
function deviceLabel(value: string | null) {
  return value?.includes("Firefox")
    ? "Firefox"
    : value?.includes("Edg/")
      ? "Microsoft Edge"
      : value?.includes("Chrome")
        ? "Chrome"
        : value?.includes("Safari")
          ? "Safari"
          : "Browser session";
}
export function download(
  name: string,
  value: string,
  type = "application/json",
) {
  const url = URL.createObjectURL(new Blob([value], { type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
