import { useEffect, useRef, useState } from "react";
import { api, authSnapshot } from "../auth-client";
import { Field, Feedback, useAction } from "../auth-ui";
import { UiIcon } from "../UiIcon";
import type { Release } from "../updates/release";
import "./updates.css";
type History = {
  id: string;
  kind: "update" | "rebuild" | "source";
  version: string;
  status: string;
  created_at: number;
  updated_at: number;
  message: string | null;
  checkpoint: string | null;
  delayed: boolean;
  rollbackVersion: string | null;
};
type Status = {
  deploymentMode?: "cloudflare" | "manual-node";
  current: Release;
  available: Release | null;
  connected: boolean;
  managedConnection: boolean;
  runnerReady: boolean;
  automaticSecurity: boolean;
  checkedAt: number | null;
  checkError: string | null;
  updateAvailable: boolean;
  incompatibility: string | null;
  history: History[];
};
const labels: Record<string, string> = {
  queued: "Waiting for Cloudflare",
  building: "Preparing release",
  deploying: "Applying update",
  verifying: "Checking the new version",
  succeeded: "Installed",
  failed: "Needs attention",
  uncertain: "Deployment needs verification",
};
export function UpdatesPanel() {
  const [data, setData] = useState<Status>();
  const [error, setError] = useState("");
  const [hook, setHook] = useState("");
  const [connecting, setConnecting] = useState(false);
  const [cancelledBuild, setCancelledBuild] = useState(false);
  const [stoppedDeployment, setStoppedDeployment] = useState(false);
  const [confirmation, setConfirmation] = useState<{
    version: string;
    rollback: boolean;
  }>();
  const live = useRef(true);
  const owner = authSnapshot()?.account?.role === "owner";
  async function load() {
    const result = await api<Status>("/api/v1/admin/updates");
    if (live.current) {
      setData(result);
      setError("");
    }
  }
  const action = useAction(load);
  useEffect(() => {
    live.current = true;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        await load();
      } catch (e) {
        if (live.current) setError((e as Error).message);
      }
      if (live.current) timer = setTimeout(() => void poll(), 10000);
    }
    void poll();
    return () => {
      live.current = false;
      clearTimeout(timer);
    };
  }, []);
  const active = data?.history.find(
    (row) => !["succeeded", "failed"].includes(row.status),
  );
  useEffect(() => {
    setStoppedDeployment(false);
    setCancelledBuild(false);
  }, [active?.id, active?.status]);
  if (data?.deploymentMode === "manual-node")
    return (
      <div className="updates-panel">
        <header className="updates-heading">
          <span className="identity-tag">CARE FOR YOUR STUDIO</span>
          <h1>Studio updates</h1>
          <p>
            Version {data.current.version} · Build{" "}
            {data.current.commit.slice(0, 7)}
          </p>
        </header>
        <Feedback error={error} />
        <section className="identity-section">
          <h2>Update through your hosting dashboard</h2>
          <p>
            Upload the new Open Whiteboard Node package to the same app. Keep your
            database and setup settings. Stop the previous server before
            starting its replacement; people on open boards will briefly
            reconnect.
          </p>
          <p>
            Back up the database before upgrading. Startup checks the saved
            schema and applies supported migrations.
          </p>
          <a
            href="https://github.com/sportwhiz/huddle-loom/blob/main/docs/godaddy-nodejs-installation.md#updates"
            target="_blank"
            rel="noopener noreferrer"
          >
            Node.js update guide
          </a>
        </section>
      </div>
    );
  return (
    <div className="updates-panel">
      <header className="updates-heading">
        <span className="identity-tag">CARE FOR YOUR STUDIO</span>
        <h1>Studio updates</h1>
        <p>New features, fixes, and control over when they arrive.</p>
      </header>
      <Feedback error={error} />
      {action.feedback}
      {!data && !error && <p role="status">Checking your installation…</p>}
      {data && (
        <>
          <section className="identity-section updates-release">
            <div className="updates-release-title">
              <UiIcon name="history" />
              <div>
                <small>YOUR OPEN WHITEBOARD</small>
                <h2>Version {data.current.version}</h2>
                <p>
                  {data.current.commit === "development"
                    ? "Local development build"
                    : `Build ${data.current.commit.slice(0, 7)}`}
                </p>
              </div>
            </div>
            <div className="identity-actions">
              <span className="identity-tag">
                {data.connected && data.runnerReady
                  ? "Updates connected"
                  : "Deployment connection needed"}
              </span>
              {owner && (
                <button
                  disabled={action.busy || !!active}
                  onClick={() =>
                    void action.run(() =>
                      api("/api/v1/admin/updates/check", {}),
                    )
                  }
                >
                  Check for updates
                </button>
              )}
            </div>
            <small>
              {data.checkedAt
                ? `Last checked ${new Date(data.checkedAt).toLocaleString()}`
                : "Published releases have not been checked yet."}
            </small>
          </section>
          {data.checkError && <Feedback error={data.checkError} />}
          {active ? (
            <section
              className="identity-section updates-progress"
              aria-live="polite"
            >
              <h2>{labels[active.status]}</h2>
              <p>Version {active.version}</p>
              <ol>
                {["queued", "building", "deploying", "verifying"].map(
                  (phase, index) => (
                    <li
                      key={phase}
                      aria-current={
                        phase === active.status ? "step" : undefined
                      }
                    >
                      <span>{index + 1}</span>
                      {labels[phase]}
                    </li>
                  ),
                )}
              </ol>
              {active.message && <p>{active.message}</p>}
              {active.kind === "source" &&
                !data.runnerReady &&
                (active.message || active.delayed) && (
                  <div className="updates-recovery">
                    <h3>Finish the first deployment</h3>
                    <p>
                      Retry the failed build at the same Git revision in
                      Cloudflare build history. Your checkpoint is retained.
                    </p>
                    <p>
                      If Cloudflare interrupted the build, cancel it and wait
                      until it has stopped. Temporarily set the production
                      deployment command to{" "}
                      <code>pnpm run deploy -- --recover-source</code>, retry
                      that original build, then restore{" "}
                      <code>pnpm run deploy</code>.
                    </p>
                  </div>
                )}
              {active.delayed && (
                <p>
                  This is taking longer than expected. Check the build in
                  Cloudflare before retrying; it may still be running.
                </p>
              )}
              <a
                href="https://dash.cloudflare.com/"
                target="_blank"
                rel="noreferrer"
              >
                Open Cloudflare build history ↗
              </a>
              {owner && ["verifying", "uncertain"].includes(active.status) && (
                <button
                  disabled={action.busy}
                  onClick={() =>
                    void action.run(() =>
                      api("/api/v1/admin/updates/verify", {}),
                    )
                  }
                >
                  Recheck deployment
                </button>
              )}
              {owner &&
                !(active.kind === "source" && !data.runnerReady) &&
                (active.status === "uncertain" ||
                  (active.delayed &&
                    ["deploying", "verifying"].includes(active.status))) && (
                  <div className="updates-recovery">
                    <h3>Retry this deployment</h3>
                    <p>
                      Check Cloudflare first. If its build is still running,
                      cancel it and wait for it to stop. Retrying keeps the same
                      version and resumes pending migrations.
                    </p>
                    {active.kind === "source" && (
                      <p>
                        Rebuild the same Git revision that failed. A different
                        source revision cannot take over this recovery.
                      </p>
                    )}
                    <label className="identity-check">
                      <input
                        type="checkbox"
                        checked={stoppedDeployment}
                        onChange={(event) =>
                          setStoppedDeployment(event.target.checked)
                        }
                      />
                      I confirmed the previous build has stopped in Cloudflare
                    </label>
                    <button
                      disabled={action.busy || !stoppedDeployment}
                      onClick={() =>
                        void action.run(async () => {
                          await api("/api/v1/admin/updates/retry-deployment", {
                            id: active.id,
                            cancelledBuild: true,
                          });
                          setStoppedDeployment(false);
                        }, "Deployment retry requested.")
                      }
                    >
                      Retry the same deployment
                    </button>
                    <p>
                      Your catalog checkpoint is retained. This retry does not
                      restore older data.
                    </p>
                  </div>
                )}
              {owner &&
                !(active.kind === "source" && !data.runnerReady) &&
                active.delayed &&
                ["queued", "building"].includes(active.status) && (
                  <div>
                    <label className="identity-check">
                      <input
                        type="checkbox"
                        checked={cancelledBuild}
                        onChange={(event) =>
                          setCancelledBuild(event.target.checked)
                        }
                      />
                      I cancelled the old build in Cloudflare
                    </label>
                    <button
                      disabled={action.busy || !cancelledBuild}
                      onClick={() =>
                        void action.run(async () => {
                          await api("/api/v1/admin/updates/retry-preparation", {
                            id: active.id,
                            cancelledBuild: true,
                          });
                          setCancelledBuild(false);
                        })
                      }
                    >
                      Clear stalled preparation
                    </button>
                    <p>
                      This releases the preparation lock. An older runner cannot
                      proceed to deployment.
                    </p>
                  </div>
                )}
            </section>
          ) : data.updateAvailable && data.available ? (
            <section className="identity-section updates-available">
              <span className="identity-tag">
                {data.available.security
                  ? "Includes security fixes"
                  : "READY WHEN YOU ARE"}
              </span>
              <h2>Version {data.available.version} is available</h2>
              <p className="updates-notes">
                {data.available.notes ||
                  "See the release notes for this update."}
              </p>
              {data.incompatibility && <p>{data.incompatibility}</p>}
              {owner && (
                <button
                  className="identity-primary"
                  disabled={
                    action.busy ||
                    !data.connected ||
                    !data.runnerReady ||
                    !!data.incompatibility
                  }
                  onClick={() =>
                    setConfirmation({
                      version: data.available!.version,
                      rollback: false,
                    })
                  }
                >
                  Update now
                </button>
              )}
            </section>
          ) : !data.checkError && data.checkedAt ? (
            data.available ? (
              <section className="identity-section">
                <h2>You’re up to date</h2>
                <p>
                  Your Studio has the latest published release or a newer
                  development build.
                </p>
              </section>
            ) : (
              <section className="identity-section" role="status">
                <h2>No stable release yet</h2>
                <p>
                  Release checking is working. Published previews are kept
                  separate from stable updates; your Studio stays on its current
                  version.
                </p>
                <a
                  href="https://github.com/sportwhiz/huddle-loom/releases"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  View published releases
                </a>
              </section>
            )
          ) : null}
          {confirmation && (
            <section
              className="identity-section updates-confirm"
              aria-label="Confirm software update"
            >
              <h2>
                {confirmation.rollback ? "Return to" : "Install"} version{" "}
                {confirmation.version}?
              </h2>
              <p>
                Your accounts, boards, uploads and settings stay in place. Open
                boards may briefly reconnect. The deployment checks the new
                version before marking it installed.
              </p>
              {confirmation.rollback && (
                <p>
                  This restores compatible application code. It does not undo
                  edits to your boards.
                </p>
              )}
              <div className="identity-actions">
                <button
                  className="identity-primary"
                  disabled={action.busy || !!active}
                  onClick={() =>
                    void action.run(async () => {
                      await api("/api/v1/admin/updates/install", confirmation);
                      setConfirmation(undefined);
                    })
                  }
                >
                  {confirmation.rollback
                    ? "Restore this version"
                    : "Install update"}
                </button>
                <button
                  disabled={action.busy}
                  onClick={() => setConfirmation(undefined)}
                >
                  Cancel
                </button>
              </div>
            </section>
          )}
          {owner && (
            <section className="identity-section">
              <h2>Your update preferences</h2>
              <label className="identity-check">
                <input
                  type="checkbox"
                  checked={data.automaticSecurity}
                  disabled={action.busy || !data.connected || !data.runnerReady}
                  onChange={(event) =>
                    void action.run(() =>
                      api("/api/v1/admin/updates/policy", {
                        automaticSecurity: event.target.checked,
                      }),
                    )
                  }
                />
                Install compatible security patches automatically
              </label>
              <p>
                Only patch releases marked as security updates, with the same
                database and board format. Feature releases stay yours to
                approve.
              </p>
            </section>
          )}
          {owner && (
            <section className="identity-section">
              <div className="identity-row">
                <div>
                  <h2>Deployment connection</h2>
                  <p>
                    {data.connected
                      ? "Cloudflare builds updates in your hosting account."
                      : "Checking releases works without a deployment connection. Connect once to install future updates here."}
                  </p>
                </div>
                <button
                  disabled={action.busy || !!active}
                  onClick={() => setConnecting(!connecting)}
                >
                  {connecting
                    ? "Close"
                    : data.connected
                      ? "Manage"
                      : "Connect updates"}
                </button>
              </div>
              {!data.runnerReady && (
                <p>
                  The update runner must be deployed once using{" "}
                  <code>pnpm run deploy</code> as your production deploy
                  command. Preview deployments cannot update production.
                </p>
              )}
              {connecting && (
                <>
                  <p>
                    New installations try to connect automatically. If your
                    build permissions do not allow this, open your Worker in
                    Cloudflare → Settings → Builds → Deploy Hooks. Create
                    “Open Whiteboard updates” for the production branch, then paste
                    its URL below.
                  </p>
                  <p>
                    This authorizes builds for this Worker. You do not need to
                    use GitHub to sign in to Open Whiteboard.
                  </p>
                  <form
                    onSubmit={(event) => {
                      event.preventDefault();
                      void action.run(async () => {
                        await api("/api/v1/admin/updates/connection", { hook });
                        setHook("");
                        setConnecting(false);
                      });
                    }}
                  >
                    <Field
                      label="Cloudflare deployment hook"
                      name="deployment-hook"
                      type="password"
                      autoComplete="off"
                      value={hook}
                      onChange={setHook}
                      hint="Stored encrypted and never shown again."
                    />
                    <button
                      className="identity-primary"
                      disabled={action.busy || !!active}
                    >
                      Save connection
                    </button>
                  </form>
                  {data.connected && !data.managedConnection && (
                    <button
                      className="identity-danger"
                      disabled={action.busy || !!active}
                      onClick={() =>
                        void action.run(() =>
                          api("/api/v1/admin/updates/connection", {
                            disconnect: true,
                          }),
                        )
                      }
                    >
                      Disconnect updates
                    </button>
                  )}
                  {data.managedConnection && (
                    <p>
                      This connection was installed by deployment. Remove the
                      SOFTWARE_UPDATE_HOOK secret in Cloudflare to disconnect
                      it.
                    </p>
                  )}
                </>
              )}
            </section>
          )}
          <section className="identity-section">
            <h2>Deployment history</h2>
            {!data.history.length ? (
              <p>Your first update will appear here.</p>
            ) : (
              data.history.map((row) => (
                <div className="identity-row" key={row.id}>
                  <div>
                    <strong>
                      {row.kind === "source"
                        ? "Source deployment"
                        : row.kind === "rebuild"
                          ? "Rebuild"
                          : "Version"}{" "}
                      {row.version}{" "}
                      <span className="identity-tag">{labels[row.status]}</span>
                    </strong>
                    <small>{new Date(row.created_at).toLocaleString()}</small>
                    {row.message && <p>{row.message}</p>}
                    {row.checkpoint && (
                      <details>
                        <summary>Catalog recovery checkpoint</summary>
                        <code className="updates-checkpoint">
                          {row.checkpoint}
                        </code>
                        <p>
                          This checkpoint covers the catalog database. Board
                          state and uploads have separate storage. Restoring
                          data requires the recovery procedure.
                        </p>
                      </details>
                    )}
                  </div>
                  {owner && row.rollbackVersion && (
                    <button
                      disabled={!!active || action.busy}
                      onClick={() =>
                        setConfirmation({
                          version: row.rollbackVersion!,
                          rollback: true,
                        })
                      }
                    >
                      Return to {row.rollbackVersion}
                    </button>
                  )}
                </div>
              ))
            )}
          </section>
        </>
      )}
    </div>
  );
}
