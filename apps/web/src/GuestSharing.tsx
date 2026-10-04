import { useEffect, useState, type FormEvent } from "react";
import { api } from "./auth-client";
import { UiIcon } from "./UiIcon";
import "./guest-sharing.css";
type GuestLink = {
  available: boolean;
  id: string;
  role: string;
  passwordProtected: boolean;
  expiresAt: string | null;
  revokedAt: string | null;
  url: string | null;
  createdAt: string;
};
export function GuestSharing({ boardId }: { boardId: string }) {
  const endpoint = `/api/v1/boards/${encodeURIComponent(boardId)}/guest-links`;
  const [links, setLinks] = useState<GuestLink[]>(),
    [error, setError] = useState("");
  const [busy, setBusy] = useState(false),
    [creating, setCreating] = useState(false),
    [editing, setEditing] = useState<string>();
  const [role, setRole] = useState("viewer"),
    [days, setDays] = useState(7),
    [password, setPassword] = useState("");
  const [passwordMode, setPasswordMode] = useState("keep"),
    [copied, setCopied] = useState(""),
    [visibleLink, setVisibleLink] = useState("");
  const load = async () =>
    setLinks((await api<{ links: GuestLink[] }>(endpoint)).links);
  useEffect(() => {
    void load().catch((failure) => setError(failure.message));
  }, [endpoint]);
  const active =
    links?.filter(
      (link) =>
        link.available &&
        (!link.expiresAt || Date.parse(link.expiresAt) > Date.now()),
    ) ?? [];
  const start = (link?: GuestLink) => {
    setError("");
    setPassword("");
    setRole(link?.role ?? "viewer");
    setDays(7);
    setPasswordMode(link?.passwordProtected ? "keep" : "none");
    setEditing(link?.id);
    setCreating(!link);
  };
  const copy = async (link: GuestLink) => {
    setCopied("");
    setVisibleLink(link.url ?? "");
    setError("");
    try {
      await navigator.clipboard.writeText(link.url!);
      setCopied(link.id);
    } catch {
      setError("Select and copy the guest link below.");
    }
  };
  const save = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const payload = {
        role,
        expiresInDays: days,
        ...(passwordMode === "set"
          ? { password }
          : passwordMode === "none"
            ? { password: null }
            : {}),
      };
      const result = await api<{ id: string; url: string }>(
        editing ? `${endpoint}/${editing}` : endpoint,
        payload,
        editing ? "PATCH" : "POST",
      );
      setCreating(false);
      setEditing(undefined);
      setPassword("");
      if (result.url) {
        setVisibleLink(result.url);
        try {
          await navigator.clipboard.writeText(result.url);
          setCopied(result.id);
        } catch {
          setError("Guest link created. Select and copy the link below.");
        }
      }
      await load();
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : "Could not save guest sharing.",
      );
    } finally {
      setBusy(false);
    }
  };
  const turnOff = async (id: string) => {
    setBusy(true);
    setError("");
    try {
      await api(`${endpoint}/${id}`, undefined, "DELETE");
      await load();
      setCopied("");
      setVisibleLink("");
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : "Could not turn off this link.",
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="guest-sharing" aria-labelledby="guest-sharing-title">
      <header>
        <div>
          <h3 id="guest-sharing-title">
            <UiIcon name="share" /> Anyone with the link
          </h3>
          <p>Invite guests to this board without accounts.</p>
        </div>
        {!creating && !editing && (
          <button
            type="button"
            className="guest-create"
            disabled={busy || !links}
            onClick={() => start()}
          >
            Create guest link
          </button>
        )}
      </header>
      {error && (
        <p role="alert" className="guest-sharing-error">
          {error}
          {!links && (
            <button
              type="button"
              onClick={() => {
                setError("");
                void load().catch((failure) => setError(failure.message));
              }}
            >
              Try again
            </button>
          )}
        </p>
      )}
      {!links && !error && <p>Loading guest access…</p>}
      {links && !active.length && !creating && (
        <p className="guest-sharing-off">
          <span /> Off · Only people with board access can open it.
        </p>
      )}
      {active.map((link) => (
        <article className="guest-link-row" key={link.id}>
          <div>
            <strong>
              {link.role === "editor"
                ? "Can edit"
                : link.role === "commenter"
                  ? "Can comment"
                  : "Can view"}
            </strong>
            <small>
              {link.passwordProtected ? "Password protected · " : ""}
              {link.expiresAt
                ? `Expires ${new Date(link.expiresAt).toLocaleDateString()}`
                : "No expiry"}
            </small>
          </div>
          <div className="guest-link-actions">
            <button
              type="button"
              disabled={busy}
              onClick={() => void copy(link)}
            >
              {copied === link.id ? "Copied" : "Copy link"}
            </button>
            <button type="button" disabled={busy} onClick={() => start(link)}>
              Settings
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => void turnOff(link.id)}
            >
              Turn off
            </button>
          </div>
          {visibleLink === link.url && (
            <label className="guest-copy-link">
              <span>Guest link</span>
              <input
                readOnly
                value={link.url ?? ""}
                onFocus={(event) => event.target.select()}
              />
            </label>
          )}
        </article>
      ))}
      {visibleLink && !active.some((link) => link.url === visibleLink) && (
        <label className="guest-copy-link">
          <span>Guest link</span>
          <input
            readOnly
            value={visibleLink}
            onFocus={(event) => event.target.select()}
          />
        </label>
      )}
      {(creating || editing) && (
        <form
          className="guest-link-form"
          onSubmit={(event) => void save(event)}
        >
          <div className="guest-options">
            <label>
              <span>Guest permissions</span>
              <select
                value={role}
                onChange={(event) => setRole(event.target.value)}
              >
                <option value="viewer">Can view</option>
                <option value="commenter">Can comment</option>
                <option value="editor">Can edit</option>
              </select>
            </label>
            <label>
              <span>{editing ? "Renew access for" : "Link expires after"}</span>
              <select
                value={days}
                onChange={(event) => setDays(Number(event.target.value))}
              >
                <option value={1}>1 day</option>
                <option value={7}>7 days</option>
                <option value={30}>30 days</option>
                <option value={90}>90 days</option>
                <option value={0}>Never</option>
              </select>
            </label>
          </div>
          <label>
            <span>Board password</span>
            <select
              value={passwordMode}
              onChange={(event) => setPasswordMode(event.target.value)}
            >
              {editing && (
                <option value="keep">Keep current password setting</option>
              )}
              <option value="none">No password</option>
              <option value="set">
                {editing ? "Set a new password" : "Require a password"}
              </option>
            </select>
          </label>
          {passwordMode === "set" && (
            <label>
              <span>Password</span>
              <input
                type="password"
                autoComplete="new-password"
                required
                minLength={8}
                maxLength={128}
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                placeholder="At least 8 characters"
              />
            </label>
          )}
          <p className="guest-sharing-note">
            Anyone you send this link to can{" "}
            {role === "editor"
              ? "edit the board"
              : role === "commenter"
                ? "view and comment"
                : "view the board"}
            {passwordMode === "set" ? " with its password" : ""}. They can
            forward it to others.{" "}
            {editing
              ? "Saving changes ends current guest sessions; guests can join again with the updated settings."
              : "You can turn it off at any time."}
          </p>
          <div className="guest-form-actions">
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                setCreating(false);
                setEditing(undefined);
                setPassword("");
              }}
            >
              Cancel
            </button>
            <button type="submit" className="guest-save" disabled={busy}>
              {busy
                ? "Saving…"
                : editing
                  ? "Save guest settings"
                  : "Create & copy guest link"}
            </button>
          </div>
        </form>
      )}
    </section>
  );
}
