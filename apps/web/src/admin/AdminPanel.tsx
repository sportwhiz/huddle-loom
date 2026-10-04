import { LocalInvitations } from "./LocalInvitations";
import { EmailSetup } from "../EmailSetup";
import { securityEventLabel } from "../security-event-label";
import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import { api, authSnapshot } from "../auth-client";
import { Feedback, Field, useAction } from "../auth-ui";
import { download } from "../Settings";

type Person = {
  id: string;
  email: string;
  name: string;
  status: string;
  role: string | null;
  verified: number;
  localUsername?: string;
  twoFactorEnabled: number;
  createdAt: string;
};
type Invite = {
  id: string;
  email: string;
  role: string;
  expires_at: string;
  accepted_at: string | null;
  revoked_at: string | null;
};
type Provider = {
  id: string;
  configuration: { clientId?: string; discoveryUrl?: string };
  enabled: boolean;
  testedAt: number | null;
  callbackVerifiedAt: number | null;
  managedByDeployment: boolean;
};
type Client = {
  id: string;
  name: string;
  redirectUris: string[];
  authMethod: string;
  trusted: boolean;
  revokedAt: string | null;
};
type Event = {
  id: string;
  actor_id: string | null;
  target_id: string | null;
  action: string;
  outcome: string;
  metadata: string;
  created_at: string;
};
type Job = {
  id: string;
  kind: string;
  status: string;
  attempts: number;
  next_attempt_at: number;
  last_error: string | null;
};
type PageData = {
  people?: Person[];
  invitations?: Invite[];
  clients?: Client[];
  events?: Event[];
  next?: string | null;
  settings?: Record<string, string | number>;
  limits?: Record<string, string | number>;
  providers?: {
    providers: Provider[];
    callbacks: Record<string, string>;
    allowedOidcOrigins: string[];
  };
  mailReady?: boolean;
  usage?: {
    accounts: { role: string; count: number }[];
    boards: number;
    referencedStorageBytes: number;
    mailToday: number;
  };
  jobs?: Job[];
  receipts?: {
    id: string;
    created_at: number;
    queue_status: string;
    delivery_status: string | null;
    event_at: number | null;
  }[];
  migrations?: { name: string; applied_at: string }[];
  rehearsals?: { kind: string; completed_at: string; evidence: string }[];
  origin?: string;
  authentication?: string;
  accessIntegration?: string;
  emailReady?: boolean;
  recoveryGuide?: string;
};
const endpoints: Record<string, string> = {
  people: "people",
  invitations: "invitations",
  "sign-in": "settings",
  clients: "clients",
  usage: "usage",
  activity: "activity",
  system: "system",
};
const titles: Record<string, string> = {
  people: "People",
  invitations: "Invitations",
  "sign-in": "Sign-in settings",
  clients: "App clients",
  usage: "Usage and limits",
  activity: "Security activity",
  system: "System",
};
const descriptions: Record<string, string> = {
  people:
    "Manage admission to this installation. Board owners control content sharing.",
  invitations:
    "Invite people, copy a private acceptance link, and track its status.",
  "sign-in":
    "Choose registration policy and configure trusted sign-in providers.",
  clients: "Register trusted MCP clients and manage client credentials.",
  usage: "Set practical limits and see what your installation is using.",
  activity: "Review changes to accounts, permissions, and security settings.",
  system:
    "Check configuration, email jobs, migrations, and recovery readiness.",
};
export function AdminPanel({ section }: { section: string }) {
  const [data, setData] = useState<PageData>();
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("current");
  const generation = useRef(0);
  const [cursor, setCursor] = useState("");
  const [error, setError] = useState("");
  const [person, setPerson] = useState<Person>();
  const [inviteOpen, setInviteOpen] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [bulkReason, setBulkReason] = useState("");
  const [link, setLink] = useState("");
  const [secret, setSecret] = useState("");
  const load = async () => {
    const requestGeneration = ++generation.current;
    const path = endpoints[section];
    if (!path) throw new Error("Unknown administration section.");
    const result = await api<PageData>(
      `/api/v1/admin/${path}?q=${encodeURIComponent(query)}&after=${encodeURIComponent(cursor)}&status=${encodeURIComponent(status)}`,
    );
    if (requestGeneration === generation.current) setData(result);
  };
  const action = useAction(load);
  useEffect(() => {
    setError("");
    let live = true;
    const timer = setTimeout(
      () =>
        void load().catch((failure) => {
          if (live) setError(failure.message);
        }),
      query ? 200 : 0,
    );
    return () => {
      live = false;
      clearTimeout(timer);
      generation.current++;
    };
  }, [section, cursor, query, status]);
  const owner = authSnapshot()?.account?.role === "owner";
  const bulk = (kind: string) =>
    void action.run(async () => {
      if (!bulkReason.trim())
        throw new Error("Add a reason for this bulk action.");
      const result = await api<{
        results: { id: string; ok: boolean; error?: string }[];
      }>("/api/v1/admin/people/bulk", {
        ids: selected,
        action: kind,
        reason: bulkReason,
      });
      const failed = result.results.filter((row) => !row.ok);
      setSelected([]);
      if (failed.length)
        throw new Error(
          `${failed.length} actions failed: ${failed.map((row) => row.error).join("; ")}`,
        );
    });
  return (
    <>
      <h1>{titles[section] ?? "Administration"}</h1>
      <p>{descriptions[section]}</p>
      <Feedback error={error} />
      {action.feedback}
      {!data && !error ? <p role="status">Loading…</p> : null}
      {error && (
        <button
          onClick={() => {
            setError("");
            void load().catch((failure) => setError(failure.message));
          }}
        >
          Try again
        </button>
      )}
      {link && (
        <section className="identity-section">
          <h2>Private invitation link</h2>
          <p>
            Share this only with the intended recipient. It expires at the time
            shown with the invitation.
          </p>
          <pre>{link}</pre>
          <div className="identity-actions">
            <button onClick={() => void navigator.clipboard.writeText(link)}>
              Copy link
            </button>
            <button onClick={() => setLink("")}>Done</button>
          </div>
        </section>
      )}
      {secret && (
        <section className="identity-section">
          <h2>Save this client secret</h2>
          <p>
            This is shown once. Put it in the client’s secure configuration.
            Secret rotation disconnects existing grants.
          </p>
          <pre className="identity-secret">{secret}</pre>
          <button onClick={() => void navigator.clipboard.writeText(secret)}>
            Copy secret
          </button>
          <button onClick={() => setSecret("")}>I’ve saved it</button>
        </section>
      )}
      {data && section === "people" && (
        <>
          {!authSnapshot()?.email && <LocalInvitations />}
          <div className="identity-toolbar">
            <input
              aria-label="Search people"
              placeholder="Search name, username or email"
              value={query}
              onChange={(event) => {
                setCursor("");
                setQuery(event.target.value);
              }}
            />
            <select
              aria-label="Account status"
              value={status}
              onChange={(event) => {
                setStatus(event.target.value);
                setCursor("");
                setSelected([]);
              }}
            >
              <option value="current">Current accounts</option>
              <option value="pending_approval">Awaiting approval</option>
              <option value="pending_verification">
                Awaiting verification
              </option>
              <option value="active">Active</option>
              <option value="suspended">Suspended</option>
              <option value="deleted">Deleted</option>
            </select>
            <button
              className="identity-primary"
              disabled={!authSnapshot()?.email}
              onClick={() => setInviteOpen(!inviteOpen)}
            >
              {inviteOpen ? "Close form" : "Invite people"}
            </button>
          </div>
          {inviteOpen && (
            <InvitationForm
              owner={owner}
              action={action}
              onCreated={(value) => {
                setLink(value);
                setInviteOpen(false);
              }}
            />
          )}
          {person && (
            <PersonEditor
              person={person}
              owner={owner}
              action={action}
              onClose={() => setPerson(undefined)}
            />
          )}{" "}
          {selected.length > 0 && (
            <section className="identity-section">
              <strong>{selected.length} people selected</strong>
              <Field
                label="Reason for bulk action"
                name="bulk-reason"
                value={bulkReason}
                onChange={setBulkReason}
              />
              <div className="identity-actions">
                <button disabled={action.busy} onClick={() => bulk("approve")}>
                  Approve selected
                </button>
                <button disabled={action.busy} onClick={() => bulk("secure")}>
                  Secure selected accounts
                </button>
                <button
                  className="identity-danger"
                  disabled={action.busy}
                  onClick={() => bulk("suspend")}
                >
                  Suspend selected
                </button>
                <button onClick={() => setSelected([])}>Clear selection</button>
              </div>
            </section>
          )}
          <section className="identity-section">
            {data.people?.length ? (
              data.people.map((item) => (
                <div className="identity-row" key={item.id}>
                  <div className="identity-actions">
                    {item.status !== "deleted" &&
                      item.role !== "owner" &&
                      item.id !== authSnapshot()?.user?.id && (
                        <input
                          style={{ width: 16, minHeight: 16 }}
                          type="checkbox"
                          aria-label={`Select ${item.name}`}
                          checked={selected.includes(item.id)}
                          onChange={(event) =>
                            setSelected(
                              event.target.checked
                                ? [...selected, item.id]
                                : selected.filter((id) => id !== item.id),
                            )
                          }
                        />
                      )}
                    <div>
                      <strong>
                        {item.name}
                        <span className="identity-tag">
                          {item.status.replaceAll("_", " ")}
                        </span>
                      </strong>
                      <small>
                        {item.status === "deleted"
                          ? "Sign-in removed. Shared contributions retain their attribution."
                          : `${item.email} · ${item.role ?? "not admitted"} · ${item.localUsername ? "Studio account" : item.verified ? "verified" : "email pending"}`}
                      </small>
                    </div>
                  </div>
                  {item.status === "deleted" ? (
                    <span className="identity-tag">Archived identity</span>
                  ) : item.role !== "owner" &&
                    item.id !== authSnapshot()?.user?.id ? (
                    <button onClick={() => setPerson(item)}>Manage</button>
                  ) : (
                    <span className="identity-tag">
                      {item.role === "owner"
                        ? "Protected owner"
                        : "Your account"}
                    </span>
                  )}
                </div>
              ))
            ) : (
              <Empty>No people match this search.</Empty>
            )}
          </section>
        </>
      )}
      {data && section === "invitations" && (
        <>
          <LocalInvitations />
          <h2>Email invitations</h2>
          {!authSnapshot()?.email && <p>Connect email in System to invite people by email. Private links above are ready to use.</p>}
          <div className="identity-toolbar">
            <input
              aria-label="Search invitations"
              placeholder="Search email address"
              value={query}
              onChange={(event) => {
                setCursor("");
                setQuery(event.target.value);
              }}
            />
            <button
              className="identity-primary"
              disabled={!authSnapshot()?.email}
              onClick={() => setInviteOpen(!inviteOpen)}
            >
              {inviteOpen ? "Close form" : "Invite by email"}
            </button>
          </div>
          {inviteOpen && (
            <InvitationForm
              owner={owner}
              action={action}
              onCreated={(value) => {
                setLink(value);
                setInviteOpen(false);
              }}
            />
          )}
          <section className="identity-section">
            {data.invitations?.length ? (
              data.invitations.map((item) => (
                <div className="identity-row" key={item.id}>
                  <div>
                    <strong>{item.email}</strong>
                    <small>
                      {item.role} ·{" "}
                      {item.accepted_at
                        ? "accepted"
                        : item.revoked_at
                          ? "revoked"
                          : Date.parse(item.expires_at) <= Date.now()
                            ? "expired"
                            : `pending · expires ${new Date(item.expires_at).toLocaleDateString()}`}
                    </small>
                  </div>
                  {!item.accepted_at && !item.revoked_at && (
                    <div className="identity-actions">
                      <button
                        disabled={action.busy}
                        onClick={() =>
                          void action.run(async () => {
                            const result = await api<{ link: string }>(
                              `/api/v1/admin/invitations/${encodeURIComponent(item.id)}/resend`,
                              { sendEmail: Boolean(authSnapshot()?.email) },
                            );
                            setLink(result.link);
                          }, "Invitation renewed. Previous links no longer work.")
                        }
                      >
                        Renew and copy
                      </button>
                      <button
                        className="identity-danger"
                        disabled={action.busy}
                        onClick={() =>
                          void action.run(
                            () =>
                              api(
                                `/api/v1/admin/invitations/${encodeURIComponent(item.id)}/revoke`,
                                {},
                              ),
                            "Invitation revoked.",
                          )
                        }
                      >
                        Revoke
                      </button>
                    </div>
                  )}
                </div>
              ))
            ) : (
              <Empty>No email invitations yet.</Empty>
            )}
          </section>
        </>
      )}
      {data && section === "sign-in" && data.settings && (
        <>
          <PolicyForm settings={data.settings} action={action} />
          <ProviderSettings inventory={data.providers} action={action} />
          <OwnershipTransfer action={action} onCreated={setLink} />
        </>
      )}
      {data && section === "clients" && (
        <>
          <ClientForm action={action} onSecret={setSecret} />
          <section className="identity-section">
            {data.clients?.length ? (
              data.clients.map((client) => (
                <div className="identity-row" key={client.id}>
                  <div>
                    <strong>
                      {client.name}
                      <span className="identity-tag">
                        {client.revokedAt
                          ? "revoked"
                          : client.trusted
                            ? "operator reviewed"
                            : "unreviewed"}
                      </span>
                    </strong>
                    <small>
                      {client.id} ·{" "}
                      {client.authMethod === "none"
                        ? "Public client · PKCE"
                        : "Confidential client"}
                    </small>
                    <details>
                      <summary>Redirect addresses</summary>
                      {client.redirectUris.map((uri) => (
                        <p key={uri}>{uri}</p>
                      ))}
                    </details>
                  </div>
                  {!client.revokedAt && (
                    <div className="identity-actions">
                      {client.authMethod === "client_secret_basic" && (
                        <button
                          disabled={action.busy}
                          onClick={() =>
                            void action.run(async () => {
                              const result = await api<{
                                clientSecret: string;
                              }>(
                                `/api/v1/admin/clients/${encodeURIComponent(client.id)}/rotate-secret`,
                                {},
                              );
                              setSecret(result.clientSecret);
                            })
                          }
                        >
                          Rotate secret
                        </button>
                      )}
                      <button
                        disabled={action.busy}
                        onClick={() =>
                          void action.run(() =>
                            api(
                              `/api/v1/admin/clients/${encodeURIComponent(client.id)}/trust`,
                              { trusted: !client.trusted },
                            ),
                          )
                        }
                      >
                        {client.trusted
                          ? "Remove trust badge"
                          : "Mark reviewed"}
                      </button>
                      <button
                        className="identity-danger"
                        disabled={action.busy}
                        onClick={() =>
                          void action.run(
                            () =>
                              api(
                                `/api/v1/admin/clients/${encodeURIComponent(client.id)}/revoke`,
                                {},
                              ),
                            "Client and its grants revoked.",
                          )
                        }
                      >
                        Revoke
                      </button>
                    </div>
                  )}
                </div>
              ))
            ) : (
              <Empty>
                No clients registered. Connecting an MCP app can register a
                public client automatically.
              </Empty>
            )}
          </section>
        </>
      )}
      {data && section === "usage" && data.usage && (
        <>
          <div className="identity-stats">
            {[
              ["Boards", data.usage.boards],
              [
                "Referenced storage",
                formatBytes(data.usage.referencedStorageBytes),
              ],
              ["Email queued today", data.usage.mailToday],
            ].map(([label, value]) => (
              <section className="identity-section" key={label}>
                <h2>{label}</h2>
                <div className="identity-stat">{value}</div>
              </section>
            ))}
          </div>
          <section className="identity-section">
            <h2>Accounts</h2>
            {data.usage.accounts.map((item) => (
              <div className="identity-row" key={item.role}>
                <strong>
                  {(
                    {
                      owner: "Owner",
                      admin: "Administrators",
                      member: "Members",
                      guest: "Guests",
                    } as Record<string, string>
                  )[item.role] ?? item.role}
                </strong>
                <span>{item.count}</span>
              </div>
            ))}
          </section>
          {owner && data.limits ? (
            <LimitsForm settings={data.limits} action={action} />
          ) : (
            <section className="identity-section">
              <h2>Configured limits</h2>
              {Object.entries(data.limits ?? {})
                .filter(([key]) => key.endsWith("_limit"))
                .map(([key, value]) => (
                  <div className="identity-row" key={key}>
                    <strong>{key.replaceAll("_", " ")}</strong>
                    <span>
                      {key.includes("storage")
                        ? formatBytes(Number(value))
                        : value}
                    </span>
                  </div>
                ))}
            </section>
          )}
        </>
      )}
      {data && section === "activity" && (
        <>
          <div className="identity-toolbar">
            <input
              aria-label="Filter security activity"
              placeholder="Filter by action"
              value={query}
              onChange={(event) => {
                setCursor("");
                setQuery(event.target.value);
              }}
            />
            <button
              disabled={action.busy}
              onClick={() =>
                void action.run(async () => {
                  download(
                    "canvas-security-audit.json",
                    JSON.stringify(
                      await api("/api/v1/admin/activity?export=true"),
                      null,
                      2,
                    ),
                  );
                }, "Audit export downloaded.")
              }
            >
              Export latest 1,000 events
            </button>
          </div>
          <section className="identity-section">
            {data.events?.length ? (
              data.events.map((event) => (
                <div className="identity-row" key={event.id}>
                  <div>
                    <strong>{securityEventLabel(event.action)}</strong>
                    <small>
                      {new Date(event.created_at).toLocaleString()} ·{" "}
                      {event.outcome}
                    </small>
                    <details>
                      <summary>Event details</summary>
                      <p>
                        Actor: {event.actor_id ?? "Unauthenticated request"}
                      </p>
                      <p>Target: {event.target_id ?? "Installation"}</p>
                      <pre>{event.metadata}</pre>
                    </details>
                  </div>
                </div>
              ))
            ) : (
              <Empty>No security events match this filter.</Empty>
            )}
          </section>
        </>
      )}
      {data && section === "system" && (
        <>
          {authSnapshot()?.account?.role === "owner" && <EmailSetup />}
          <section className="identity-section">
            <h2>Installation</h2>
            <Status label="Canonical origin" value={data.origin} />
            <Status label="Authentication" value={data.authentication} />
            <Status label="Access integration" value={data.accessIntegration} />
            <Status
              label="Email sender configured"
              value={data.emailReady ? "Yes" : "No"}
            />
            <button
              disabled={!data.emailReady || !authSnapshot()?.account?.emailVerified || action.busy}
              onClick={() =>
                void action.run(
                  () => api("/api/v1/admin/mail/test", {}),
                  "A delivery test was queued to your verified address.",
                )
              }
            >
              Send delivery test
            </button>
            <p>
              Provider acceptance is recorded separately from delivery. Verify
              your inbox and sender DNS.
            </p>
            <a href={data.recoveryGuide}>
              Backup, restore, and emergency recovery guide
            </a>
          </section>
          <section className="identity-section">
            <h2>Recent email delivery</h2>
            {data.receipts?.length ? (
              data.receipts.map((receipt) => (
                <div className="identity-row" key={receipt.id}>
                  <div>
                    <strong>
                      {receipt.delivery_status ?? receipt.queue_status}
                    </strong>
                    <small>
                      {new Date(receipt.created_at).toLocaleString()}
                    </small>
                  </div>
                  <span className="identity-tag">
                    {receipt.delivery_status
                      ? "Provider receipt"
                      : "Queue status"}
                  </span>
                </div>
              ))
            ) : (
              <Empty>No email has been queued yet.</Empty>
            )}
          </section>
          <section className="identity-section">
            <h2>Background jobs</h2>
            {data.jobs?.length ? (
              data.jobs.map((job) => (
                <div className="identity-row" key={job.id}>
                  <div>
                    <strong>
                      {job.kind} · {job.status}
                    </strong>
                    <small>
                      {job.attempts} attempts · next{" "}
                      {new Date(job.next_attempt_at).toLocaleString()}
                    </small>
                    {job.last_error && <small>{job.last_error}</small>}
                  </div>
                  {job.status === "failed" && (
                    <button
                      disabled={action.busy}
                      onClick={() =>
                        void action.run(
                          () => api("/api/v1/admin/jobs/retry", { id: job.id }),
                          "Retry queued.",
                        )
                      }
                    >
                      Retry
                    </button>
                  )}
                </div>
              ))
            ) : (
              <Empty>No pending or failed jobs.</Empty>
            )}
          </section>
          <section className="identity-section">
            <h2>Database migrations</h2>
            {data.migrations?.map((migration) => (
              <Status
                label={migration.name}
                value={new Date(migration.applied_at).toLocaleDateString()}
                key={migration.name}
              />
            ))}
          </section>
          <section className="identity-section">
            <h2>Recovery rehearsals</h2>
            {data.rehearsals?.length ? (
              data.rehearsals.map((item) => (
                <Status
                  label={item.kind}
                  value={new Date(item.completed_at).toLocaleString()}
                  key={item.kind}
                />
              ))
            ) : (
              <p>
                No successful recovery rehearsal has been recorded. Follow the
                operator guide before opening public registration.
              </p>
            )}
          </section>
        </>
      )}
      {data?.next && (
        <div className="identity-actions">
          <button onClick={() => setCursor(data.next!)}>Next page</button>
          <button onClick={() => setCursor("")}>First page</button>
        </div>
      )}
    </>
  );
}
type Action = ReturnType<typeof useAction>;
function InvitationForm({
  owner,
  action,
  onCreated,
}: {
  owner: boolean;
  action: Action;
  onCreated: (link: string) => void;
}) {
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("member");
  const [send, setSend] = useState(Boolean(authSnapshot()?.email));
  return (
    <section className="identity-section">
      <h2>Invite a person</h2>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void action.run(async () => {
            const result = await api<{ link: string }>(
              "/api/v1/admin/invitations",
              { email, role, sendEmail: send },
            );
            onCreated(result.link);
          }, "Invitation created.");
        }}
      >
        <div className="identity-form-grid">
          <Field
            label="Email address"
            name="invitation-email"
            type="email"
            autoFocus
            value={email}
            onChange={setEmail}
          />
          <label className="identity-field">
            <span>Installation role</span>
            <select
              value={role}
              onChange={(event) => setRole(event.target.value)}
            >
              <option value="member">Member</option>
              <option value="guest">Guest</option>
              {owner && <option value="admin">Administrator</option>}
            </select>
            <small>Board access is granted separately by content owners.</small>
          </label>
        </div>
        <label className="identity-check">
          <input
            type="checkbox"
            checked={send}
            disabled={!authSnapshot()?.email}
            onChange={(event) => setSend(event.target.checked)}
          />
          Email the link to the recipient
        </label>
        <button className="identity-primary" disabled={action.busy}>
          Create invitation
        </button>
      </form>
    </section>
  );
}
function PersonEditor({
  person,
  owner,
  action,
  onClose,
}: {
  person: Person;
  owner: boolean;
  action: Action;
  onClose: () => void;
}) {
  const [reason, setReason] = useState("");
  const [role, setRole] = useState(person.role ?? "member");
  const [confirm, setConfirm] = useState("");
  const [target, setTarget] = useState("");
  const [resources, setResources] =
    useState<{ type: string; id: string; title: string }[]>();
  const [transferIds, setTransferIds] = useState<string[]>([]);
  const [nextResources, setNextResources] = useState<string | null>(null);
  const endpoint = `/api/v1/admin/people/${encodeURIComponent(person.id)}`;
  const change = (kind: string, body: unknown = { reason }) =>
    void action.run(() => api(`${endpoint}/${kind}`, body));
  return (
    <section className="identity-section">
      <div className="identity-toolbar">
        <h2>{person.name}</h2>
        <button onClick={onClose}>Close</button>
      </div>
      <p>
        {person.email} · {person.status}
      </p>
      <Field
        label="Reason for administrative action"
        name="person-reason"
        value={reason}
        onChange={setReason}
      />
      <div className="identity-actions">
        {person.status === "pending_approval" && (
          <button
            disabled={!person.verified || action.busy}
            onClick={() => change("approve")}
          >
            Approve account
          </button>
        )}
        {person.status === "suspended" ? (
          <button disabled={action.busy} onClick={() => change("restore")}>
            Restore account
          </button>
        ) : (
          <button
            className="identity-danger"
            disabled={!reason.trim() || action.busy}
            onClick={() => change("suspend")}
          >
            Suspend account
          </button>
        )}
        <button disabled={action.busy} onClick={() => change("secure")}>
          Revoke sessions and app grants
        </button>
      </div>
      {person.role && (
        <form
          className="identity-toolbar"
          onSubmit={(event) => {
            event.preventDefault();
            change("role", { role, reason });
          }}
        >
          <select
            aria-label="New installation role"
            value={role}
            onChange={(event) => setRole(event.target.value)}
          >
            <option value="member">Member</option>
            <option value="guest">Guest</option>
            {owner && <option value="admin">Administrator</option>}
          </select>
          <button disabled={action.busy}>Change role</button>
        </form>
      )}
      <details>
        <summary>Recover or transfer owned content</summary>
        <p>
          This reveals owned resource titles for the stated recovery reason. It
          does not open the boards.
        </p>
        <button
          disabled={!reason.trim() || action.busy}
          onClick={() =>
            void action.run(async () => {
              const result = await api<{
                resources: { type: string; id: string; title: string }[];
                next: string | null;
              }>(`${endpoint}/content`, { reason });
              setResources(result.resources);
              setTransferIds([]);
              setNextResources(result.next);
            }, "Owned resource inventory loaded and audited.")
          }
        >
          Load owned resources
        </button>
        {resources && (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void action.run(
                () =>
                  api(`${endpoint}/transfer-content`, {
                    targetId: target,
                    reason,
                    resources: resources
                      .filter((item) => transferIds.includes(item.id))
                      .map(({ type, id }) => ({ type, id })),
                  }),
                "Selected content transferred.",
              );
            }}
          >
            {resources.map((item) => (
              <label key={item.id} className="identity-check">
                <input
                  type="checkbox"
                  checked={transferIds.includes(item.id)}
                  onChange={(event) =>
                    setTransferIds(
                      event.target.checked
                        ? [...transferIds, item.id]
                        : transferIds.filter((id) => id !== item.id),
                    )
                  }
                />
                {item.title} · {item.type}
              </label>
            ))}
            {nextResources && (
              <button
                type="button"
                disabled={action.busy}
                onClick={() =>
                  void action.run(async () => {
                    const result = await api<{
                      resources: NonNullable<typeof resources>;
                      next: string | null;
                    }>(`${endpoint}/content`, { reason, after: nextResources });
                    setResources((items) => [
                      ...(items ?? []),
                      ...result.resources,
                    ]);
                    setNextResources(result.next);
                  })
                }
              >
                Load more resources
              </button>
            )}
            <RecipientPicker
              value={target}
              onChange={setTarget}
              exclude={person.id}
            />
            {transferIds.length > 200 && (
              <p role="alert">Choose at most 200 resources per transfer.</p>
            )}
            <button
              disabled={
                !target ||
                !transferIds.length ||
                transferIds.length > 200 ||
                action.busy
              }
            >
              Transfer selected content
            </button>
          </form>
        )}
      </details>
      <details>
        <summary>Delete account</summary>
        <p>
          Owned content must be transferred or deleted first. This permanently
          removes sign-in methods and keeps anonymized attribution on shared
          work.
        </p>
        <Field
          label="Type the account ID to confirm"
          name="person-delete-confirm"
          hint={person.id}
          value={confirm}
          onChange={setConfirm}
        />
        <button
          className="identity-danger"
          disabled={confirm !== person.id || action.busy}
          onClick={() => change("delete", { confirm })}
        >
          Delete account
        </button>
      </details>
    </section>
  );
}
function PolicyForm({
  settings,
  action,
}: {
  settings: Record<string, string | number>;
  action: Action;
}) {
  const [form, setForm] = useState<Record<string, string | number>>({ reauthentication_seconds: 1800, ...settings });
  return (
    <section className="identity-section">
      <h2>Registration and security</h2>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void action.run(() =>
            api(
              "/api/v1/admin/settings",
              Object.fromEntries(
                [
                  "title",
                  "registration",
                  "approval_required",
                  "mfa_required",
                  "magic_link",
                  "dynamic_registration",
                  "reauthentication_seconds",
                  "session_idle_seconds",
                  "session_absolute_seconds",
                ].map((key) => [key, form[key]]),
              ),
              "PATCH",
            ),
          );
        }}
      >
        <Field
          label="Installation name"
          name="installation-title"
          value={String(form.title)}
          onChange={(value) => setForm({ ...form, title: value })}
        />
        <label className="identity-field">
          <span>Registration</span>
          <select
            value={form.registration}
            onChange={(event) =>
              setForm({ ...form, registration: event.target.value })
            }
          >
            <option value="closed">Closed</option>
            <option value="invite">Invitation only</option>
            <option value="public">Public, verified email required</option>
          </select>
        </label>
        {[
          ["approval_required", "Approve new public registrations"],
          ["mfa_required", "Require a second factor for everyone"],
          ["magic_link", "Allow email sign-in links"],
          [
            "dynamic_registration",
            "Allow MCP apps to register public OAuth clients",
          ],
        ].map(([key, label]) => (
          <label key={key} className="identity-check">
            <input
              type="checkbox"
              checked={Boolean(form[key])}
              onChange={(event) =>
                setForm({ ...form, [key]: event.target.checked ? 1 : 0 })
              }
            />
            {label}
          </label>
        ))}
        <label className="identity-field">
          <span>Ask again for protected changes after</span>
          <select
            aria-describedby="verification-window-help"
            value={String(form.reauthentication_seconds)}
            onChange={(event) => setForm({ ...form, reauthentication_seconds: Number(event.target.value) })}
          >
            {![300, 900, 1800, 3600, 14400, 43200].includes(Number(form.reauthentication_seconds)) && (
              <option value={String(form.reauthentication_seconds)}>{Number(form.reauthentication_seconds) / 60} minutes (custom)</option>
            )}
            {[[300, "5 minutes"], [900, "15 minutes"], [1800, "30 minutes (recommended)"], [3600, "1 hour"], [14400, "4 hours"], [43200, "12 hours"]].map(([seconds, label]) => (
              <option key={seconds} value={seconds}>{label}</option>
            ))}
          </select>
          <small id="verification-window-help">A successful password, authenticator or passkey check starts this window. Required second factors still apply. Security settings, account changes and connected app approvals share the window on this device. New sign-ins still require verification.</small>
        </label>
        <div className="identity-form-grid">
          {[
            ["session_idle_seconds", "Sign out after inactivity"],
            ["session_absolute_seconds", "Require a new sign-in after"],
          ].map(([key, label]) => (
            <label className="identity-field" key={key}>
              <span>{label}</span>
              <select
                value={String(form[key])}
                onChange={(event) =>
                  setForm({ ...form, [key]: Number(event.target.value) })
                }
              >
                {![3600, 86400, 604800, 1209600, 2592000, 7776000].includes(
                  Number(form[key]),
                ) && (
                  <option value={String(form[key])}>
                    {Number(form[key]) / 3600} hours (custom)
                  </option>
                )}
                {[3600, 86400, 604800, 1209600, 2592000, 7776000].map(
                  (seconds) => (
                    <option key={seconds} value={seconds}>
                      {seconds < 86400
                        ? "1 hour"
                        : `${seconds / 86400} ${seconds === 86400 ? "day" : "days"}`}
                    </option>
                  ),
                )}
              </select>
            </label>
          ))}
        </div>
        <p>
          Owners and administrators always need a second factor. Requiring MFA
          pauses existing app grants until their users confirm them.
        </p>
        <button className="identity-primary" disabled={action.busy}>
          Save policy
        </button>
      </form>
    </section>
  );
}
function ProviderSettings({
  inventory,
  action,
}: {
  inventory: PageData["providers"];
  action: Action;
}) {
  const [id, setId] = useState("github");
  const [clientId, setClientId] = useState("");
  const [secret, setSecret] = useState("");
  const [discovery, setDiscovery] = useState("");
  const [enabled, setEnabled] = useState(false);
  const [open, setOpen] = useState(false);
  return (
    <section className="identity-section">
      <h2>Sign-in providers</h2>
      {inventory?.providers.map((provider) => (
        <div className="identity-row" key={provider.id}>
          <div>
            <strong>{provider.id}</strong>
            <small>
              {provider.enabled ? "Enabled" : "Disabled"} ·{" "}
              {provider.managedByDeployment
                ? "Managed by deployment"
                : provider.callbackVerifiedAt
                  ? "Sign-in callback verified"
                  : provider.testedAt
                    ? "Configuration validated; sign-in still needs verification"
                    : "Not validated"}
            </small>
          </div>
          <button
            disabled={provider.managedByDeployment}
            onClick={() => {
              setId(provider.id);
              setClientId(provider.configuration.clientId ?? "");
              setDiscovery(provider.configuration.discoveryUrl ?? "");
              setEnabled(provider.enabled);
              setSecret("");
              setOpen(true);
            }}
          >
            Configure
          </button>
        </div>
      ))}
      <button onClick={() => setOpen(!open)}>
        {open ? "Close provider form" : "Configure a provider"}
      </button>
      {open && (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void action.run(async () => {
              await api(
                `/api/v1/admin/providers/${encodeURIComponent(id)}`,
                {
                  clientId,
                  clientSecret: secret,
                  discoveryUrl: discovery,
                  enabled,
                },
                "PUT",
              );
              setSecret("");
              setOpen(false);
            }, "Provider configuration validated. Complete a real sign-in to verify its callback.");
          }}
        >
          <Field
            label="Provider ID"
            name="provider-id"
            hint="Use github, google, or oidc-your-provider."
            value={id}
            onChange={setId}
          />
          <Field
            label="Client ID"
            name="provider-client-id"
            value={clientId}
            onChange={setClientId}
          />
          <Field
            label="Client secret"
            name="provider-secret"
            type="password"
            autoComplete="off"
            value={secret}
            onChange={setSecret}
            required={false}
            hint="Required for a new provider. Leave blank to keep its existing secret."
          />
          {id.startsWith("oidc-") && (
            <Field
              label="OpenID discovery URL"
              name="provider-discovery"
              type="url"
              hint={`The operator must allow this origin. Allowed: ${inventory?.allowedOidcOrigins.join(", ") || "none"}`}
              value={discovery}
              onChange={setDiscovery}
            />
          )}
          <label className="identity-check">
            <input
              type="checkbox"
              checked={enabled}
              onChange={(event) => setEnabled(event.target.checked)}
            />
            Enable after configuration validation
          </label>
          <p>Register this callback with the provider:</p>
          <pre>{`${location.origin}/api/auth/callback/${id}`}</pre>
          <button className="identity-primary" disabled={action.busy}>
            Validate and save
          </button>
        </form>
      )}
    </section>
  );
}
function LimitsForm({
  settings,
  action,
}: {
  settings: Record<string, string | number>;
  action: Action;
}) {
  const [form, setForm] = useState({ ...settings });
  const keys = [
    "member_limit",
    "guest_limit",
    "board_limit",
    "storage_limit",
    "user_board_limit",
    "user_storage_limit",
    "mail_limit",
  ];
  const labels: Record<string, string> = {
    member_limit: "Members",
    guest_limit: "Guests",
    board_limit: "Boards",
    storage_limit: "Total asset storage (GiB)",
    user_board_limit: "Boards per person",
    user_storage_limit: "Asset storage per person (GiB)",
    mail_limit: "Email messages per day",
  };
  return (
    <section className="identity-section">
      <h2>Configured limits</h2>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void action.run(() =>
            api(
              "/api/v1/admin/settings",
              Object.fromEntries(keys.map((key) => [key, form[key]])),
              "PATCH",
            ),
          );
        }}
      >
        <div className="identity-form-grid">
          {keys.map((key) => (
            <Field
              key={key}
              label={labels[key]}
              name={key}
              type="number"
              step={key.includes("storage") ? "any" : 1}
              value={String(
                Number(form[key]) / (key.includes("storage") ? 1073741824 : 1),
              )}
              onChange={(value) =>
                setForm({
                  ...form,
                  [key]: Math.round(
                    Number(value) * (key.includes("storage") ? 1073741824 : 1),
                  ),
                })
              }
            />
          ))}
        </div>
        <p>
          Lowering a limit preserves existing content. New writes stop until
          usage is within the limit.
        </p>
        <button className="identity-primary" disabled={action.busy}>
          Save limits
        </button>
      </form>
    </section>
  );
}
function ClientForm({
  action,
  onSecret,
}: {
  action: Action;
  onSecret: (secret: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [redirects, setRedirects] = useState("");
  const [method, setMethod] = useState("none");
  return (
    <section className="identity-section">
      <div className="identity-toolbar">
        <h2>Register a trusted client</h2>
        <button onClick={() => setOpen(!open)}>
          {open ? "Close" : "Register client"}
        </button>
      </div>
      {open && (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void action.run(async () => {
              const result = await api<{
                id: string;
                clientSecret: string | null;
              }>("/api/v1/admin/clients", {
                name,
                redirectUris: redirects
                  .split("\n")
                  .map((value) => value.trim())
                  .filter(Boolean),
                authMethod: method,
              });
              onSecret(result.clientSecret ?? "");
              setOpen(false);
            }, "Client registered. Find its client ID in the list.");
          }}
        >
          <Field
            label="Client name"
            name="client-name"
            value={name}
            onChange={setName}
          />
          <label className="identity-field">
            <span>Exact redirect addresses, one per line</span>
            <textarea
              required
              rows={3}
              value={redirects}
              onChange={(event) => setRedirects(event.target.value)}
            />
          </label>
          <label className="identity-field">
            <span>Client authentication</span>
            <select
              value={method}
              onChange={(event) => setMethod(event.target.value)}
            >
              <option value="none">Public client · PKCE</option>
              <option value="client_secret_basic">
                Confidential client · HTTP Basic
              </option>
            </select>
          </label>
          <button className="identity-primary" disabled={action.busy}>
            Register client
          </button>
        </form>
      )}
    </section>
  );
}
type Transfer = {
  id: string;
  targetId: string;
  targetName: string;
  expiresAt: number;
};
function RecipientPicker({
  value,
  onChange,
  exclude,
  ownership = false,
}: {
  value: string;
  onChange: (id: string) => void;
  exclude?: string;
  ownership?: boolean;
}) {
  const [query, setQuery] = useState("");
  const [people, setPeople] = useState<
    { id: string; name: string; email: string }[]
  >([]);
  const [error, setError] = useState("");
  useEffect(() => {
    let live = true;
    const timer = setTimeout(() => {
      void api<{ people: typeof people }>(
        `/api/v1/admin/recipients?q=${encodeURIComponent(query)}&exclude=${encodeURIComponent(exclude ?? "")}&kind=${ownership ? "ownership" : "content"}`,
      )
        .then((result) => {
          if (live) {
            setPeople(result.people);
            setError("");
          }
        })
        .catch((failure) => {
          if (live) setError(failure.message);
        });
    }, 200);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [query, exclude, ownership]);
  return (
    <fieldset className="identity-section">
      <legend>Choose a recipient</legend>
      <Field
        label="Find by name or email"
        name="recipient-search"
        value={query}
        onChange={(text) => {
          setQuery(text);
          onChange("");
        }}
      />
      <label className="identity-field">
        <span>Recipient</span>
        <select
          required
          value={value}
          onChange={(event) => onChange(event.target.value)}
        >
          <option value="">Select a verified active account</option>
          {people.map((person) => (
            <option key={person.id} value={person.id}>
              {person.name} · {person.email}
            </option>
          ))}
        </select>
      </label>
      {!people.length && !error && (
        <p className="identity-hint">
          {ownership
            ? "No matching members with MFA enrolled. The recipient must add a passkey or authenticator first."
            : "No matching active members. Try a different name or email."}
        </p>
      )}
      {error && (
        <p role="alert" className="identity-error">
          {error}
        </p>
      )}
    </fieldset>
  );
}
function OwnershipTransfer({
  action,
  onCreated,
}: {
  action: Action;
  onCreated: (link: string) => void;
}) {
  const [target, setTarget] = useState("");
  const [pending, setPending] = useState<Transfer[]>([]);
  const [error, setError] = useState("");
  const load = async () => {
    const value = await api<{ transfers: Transfer[] }>(
      "/api/v1/admin/owner-transfer",
    );
    setPending(value.transfers);
  };
  useEffect(() => {
    void load().catch((failure) => setError(failure.message));
  }, []);
  return (
    <section className="identity-section">
      <h2>Installation ownership</h2>
      <p>
        Transfer responsibility to a verified active member with MFA enrolled.
        They must accept within 30 minutes. Board ownership stays with its
        current owners.
      </p>
      {error && (
        <p role="alert" className="identity-error">
          {error}
        </p>
      )}
      {pending.map((transfer) => (
        <div className="identity-row" key={transfer.id}>
          <div>
            <strong>Waiting for {transfer.targetName}</strong>
            <small>
              Expires {new Date(transfer.expiresAt).toLocaleString()}
            </small>
          </div>
          <button
            disabled={action.busy}
            onClick={() =>
              void action.run(async () => {
                await api("/api/v1/admin/owner-transfer/cancel", {
                  id: transfer.id,
                });
                onCreated("");
                await load();
              }, "Ownership transfer canceled.")
            }
          >
            Cancel transfer
          </button>
        </div>
      ))}
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void action.run(async () => {
            const result = await api<{ link: string }>(
              "/api/v1/admin/owner-transfer",
              { targetId: target },
            );
            onCreated(result.link);
            await load();
          }, "Ownership transfer requested. The recipient must accept.");
        }}
      >
        <RecipientPicker value={target} onChange={setTarget} ownership />
        <button disabled={!target || action.busy}>
          {pending.length
            ? "Replace pending transfer"
            : "Request ownership transfer"}
        </button>
      </form>
    </section>
  );
}

function Empty({ children }: { children: ReactNode }) {
  return <p className="identity-empty">{children}</p>;
}
function Status({ label, value }: { label: string; value?: ReactNode }) {
  return (
    <div className="identity-row">
      <strong>{label}</strong>
      <span>{value ?? "Unavailable"}</span>
    </div>
  );
}
function formatBytes(bytes: number) {
  return bytes >= 1024 ** 3
    ? `${(bytes / 1024 ** 3).toFixed(1)} GiB`
    : bytes >= 1024 ** 2
      ? `${(bytes / 1024 ** 2).toFixed(1)} MiB`
      : bytes >= 1024
        ? `${(bytes / 1024).toFixed(1)} KiB`
        : `${bytes} bytes`;
}
