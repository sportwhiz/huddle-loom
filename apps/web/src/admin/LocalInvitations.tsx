import { useEffect, useState, type FormEvent } from "react";
import { api } from "../auth-client";
import { Field, Feedback, StepUp, Submit } from "../auth-ui";
type Invite = {
  id: string;
  label: string;
  role: string;
  expires_at: number;
  accepted_by: string | null;
  revoked_at: number | null;
};
export function LocalInvitations() {
  const [label, setLabel] = useState(""),
    [role, setRole] = useState("member"),
    [link, setLink] = useState("");
  const [rows, setRows] = useState<Invite[]>([]),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [stepUp, setStepUp] = useState(false);
  const refresh = async () =>
    setRows(
      (await api<{ invitations: Invite[] }>("/api/v1/admin/local-invitations"))
        .invitations,
    );
  useEffect(() => {
    void refresh().catch((failure) => setError(failure.message));
  }, []);
  async function run(task: () => Promise<void>) {
    setBusy(true);
    setError("");
    try {
      await task();
      await refresh();
    } catch (failure) {
      setError(
        failure instanceof Error ? failure.message : "Please try again.",
      );
      if ((failure as { code?: string }).code === "STEP_UP_REQUIRED")
        setStepUp(true);
    } finally {
      setBusy(false);
    }
  }
  function create(event: FormEvent) {
    event.preventDefault();
    void run(async () => {
      const value = await api<{ token: string }>(
        "/api/v1/admin/local-invitations",
        { label, role },
      );
      setLink(
        `${location.origin}/invite#localInvite=${encodeURIComponent(value.token)}`,
      );
      setLabel("");
    });
  }
  return (
    <section className="identity-section">
      <h2>Invite without email</h2>
      <p>
        Share a private, single-use link. They’ll choose their own username and
        password. Links expire after seven days; board access is shared
        separately.
      </p>
      <form onSubmit={create}>
        <div className="identity-form-grid">
          <Field
            label="Who is it for?"
            name="local-invite-label"
            value={label}
            onChange={setLabel}
            hint="A name to help you recognize this invitation."
          />
          <label className="identity-field">
            <span>Studio role</span>
            <select
              value={role}
              onChange={(event) => setRole(event.target.value)}
            >
              <option value="member">Member</option>
              <option value="guest">Guest</option>
            </select>
          </label>
        </div>
        <Submit busy={busy}>Create private invitation</Submit>
      </form>
      {link && (
        <>
          <Field
            label="Private invitation link"
            name="local-invite-link"
            value={link}
            onChange={() => {}}
          />
          <button
            type="button"
            onClick={() =>
              void navigator.clipboard
                .writeText(link)
                .catch(() => setError("Select the link above and copy it."))
            }
          >
            Copy invitation
          </button>
          <p>
            Send this only to the intended person. Anyone holding the link can
            use it once.
          </p>
        </>
      )}
      <Feedback error={error} />
      {rows.map((row) => (
        <div className="identity-row" key={row.id}>
          <div>
            <strong>{row.label}</strong>
            <small>
              {row.role} ·{" "}
              {row.accepted_by
                ? "Accepted"
                : row.revoked_at
                  ? "Revoked"
                  : row.expires_at < Date.now()
                    ? "Expired"
                    : `Expires ${new Date(row.expires_at).toLocaleDateString()}`}
            </small>
          </div>
          {!row.accepted_by &&
            !row.revoked_at &&
            row.expires_at > Date.now() && (
              <button
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    await api(
                      `/api/v1/admin/local-invitations/${row.id}/revoke`,
                      {},
                    );
                    setLink("");
                  })
                }
              >
                Revoke
              </button>
            )}
        </div>
      ))}
      {stepUp && (
        <StepUp
          onComplete={() => {
            setStepUp(false);
            setError("");
          }}
          onCancel={() => setStepUp(false)}
        />
      )}
    </section>
  );
}
