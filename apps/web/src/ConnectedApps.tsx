import { api, apiFetch } from "./auth-client";
import { openTour } from "./onboarding-events";
import { UiIcon } from "./UiIcon";
import { BrandMark } from "./BrandMark";
import { ThemedImage } from "./ThemedImage";
import { PRODUCT_WORDMARK } from "./product";
import { useEffect, useRef, useState } from "react";
import { ThemeMenu } from "./theme";
import "./connected-apps.css";
import "./studio-connections.css";
import { useAction } from "./auth-ui";
import { useDialogFocus } from "./useDialogFocus";

type Connection = {
  id: string;
  clientId: string;
  name: string;
  scopes: string[];
  createdAt: string;
  refreshExpiresAt: string | null;
  lastUsedAt: string | null;
  resourceMode: 'all' | 'selected';
  resources: {type:'board'|'workbook';id:string}[];
  status: 'active' | 'confirmation_required' | 'expired' | 'revoked';
};
type Check = { title: string; ok: boolean; detail: string };
const PERMISSIONS: Record<string, { title: string; description: string }> = {
  "boards:read": {
    title: "Read boards",
    description: "Find boards and read their notes, shapes and connections.",
  },
  "boards:write": {
    title: "Edit boards",
    description: "Compose workflows, workshops, diagrams, tables and planning boards.",
  },
  "collaboration:write": {
    title: "Collaborate",
    description: "Add comments and manage sessions within your board role.",
  },
  "boards:export": {
    title: "Export boards",
    description: "Download editable board archives.",
  },
};
const GUIDES = {
  chatgpt: {
    title: "ChatGPT",
    url: "https://developers.openai.com/plugins/deploy/connect-chatgpt",
    steps: [
      "Open ChatGPT settings, choose Security and login, and enable Developer mode. Availability depends on your account and workspace policy.",
      "Open ChatGPT Plugins, select the plus button, and name the connection Open Whiteboard. Choose a public endpoint and paste the server URL from step 2.",
      "Complete sign-in to Open Whiteboard and review the permissions requested by ChatGPT.",
      "Start a new conversation and add the Open Whiteboard connection from the tools menu. Try the workflow prompt below.",
    ],
  },
  claude: {
    title: "Claude",
    url: "https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp",
    steps: [
      "Open Customize → Connectors in Claude, select +, then Add custom connector. Team and Enterprise owners may need to add it in Organization settings first.",
      "Name the connector Open Whiteboard and paste the server URL from step 2. If your administrator provided a client ID and secret, enter them in the optional client settings. Otherwise, your installation must allow automatic client registration.",
      "Select Connect, sign in to Open Whiteboard, and review the requested permissions.",
      "In a new conversation, use + → Connectors to enable Open Whiteboard, then try the workflow prompt below.",
    ],
  },
  other: {
    title: "Other MCP clients",
    url: "https://modelcontextprotocol.io/docs/tools/inspector",
    steps: [
      "Add a remote MCP server using the Streamable HTTP transport.",
      "Paste the server URL from step 2. Choose OAuth authorization with automatic discovery and PKCE.",
      "Sign in to Open Whiteboard in the browser and approve the requested permissions. Static API keys are not used.",
      "Ask the client to list your boards, then create a test workflow. Use a client that supports both reading and writing tools.",
    ],
  },
};

export function ConnectedApps() {
  const [connections, setConnections] = useState<Connection[] | null>(null);
  const [guide, setGuide] = useState<keyof typeof GUIDES>("chatgpt");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [loading, setLoading] = useState(false);
  const [checks, setChecks] = useState<Check[] | null>(null);
  const [checking, setChecking] = useState(false);
  const [revoking, setRevoking] = useState("");
  const [editing, setEditing] = useState<Connection | null>(null);
  const [confirm, setConfirm] = useState<Connection | null>(null);
  const confirmRef = useRef<HTMLDivElement>(null);
  const refreshRef = useRef<HTMLButtonElement>(null);
  const loadEpoch = useRef(0);
  const revokeBusy = useRef(false);
  const returnTo = new URLSearchParams(location.search).get("returnTo");
  const back = returnTo?.match(/^\/boards\/[^/?#]+$/u) ? returnTo : "/";
  const endpoint = `${location.origin}/mcp`;
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(location.hostname);
  const prompt =
    "Create a new board called Customer support workflow. Use editable sticky notes for Receive request, Triage, Resolve and Follow up. Add a decision for whether more information is needed, with a loop back to the customer when it is. Connect every step with attached arrows and label the branches. Use responsibility lanes for customer and support steps. Read the authoring guide, automatically lay out the graph, inspect the result and fix layout issues, then give me a link to the board.";
  const load = async () => {
    if (revokeBusy.current) return;
    const epoch = ++loadEpoch.current;
    setLoading(true);
    setError("");
    try {
      const response = await apiFetch("/api/v1/connections", {
        signal: AbortSignal.timeout(10000),
      });
      const result = (await response.json()) as {
        connections?: Connection[];
        error?: string;
      };
      if (!response.ok || !result.connections)
        throw new Error(result.error ?? "Connected apps could not be loaded.");
      if (epoch === loadEpoch.current) setConnections(result.connections);
    } catch (error) {
      if (epoch !== loadEpoch.current) return;
      setError(
        error instanceof Error
          ? error.message
          : "Could not load connected apps.",
      );
    } finally {
      if (epoch === loadEpoch.current) setLoading(false);
    }
  };
  useEffect(() => {
    document.title = "Connected apps · Open Whiteboard";
    void load();
    const refresh = () => {
      if (document.visibilityState === "visible") void load();
    };
    window.addEventListener("focus", refresh);
    return () => {
      window.removeEventListener("focus", refresh);
      ++loadEpoch.current;
    };
  }, []);
  useEffect(() => {
    if (!confirm) return;
    const previous = document.activeElement as HTMLElement | null;
    const first = confirmRef.current?.querySelector<HTMLButtonElement>(
      "button:not(:disabled)",
    );
    (first ?? confirmRef.current)?.focus();
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        if (!revoking) setConfirm(null);
      }
      if (event.key === "Tab") {
        const buttons = Array.from(
          confirmRef.current?.querySelectorAll<HTMLButtonElement>(
            "button:not(:disabled)",
          ) ?? [],
        );
        const first = buttons[0],
          last = buttons.at(-1);
        if (!first) {
          event.preventDefault();
          return;
        }
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first?.focus();
        }
      }
    };
    window.addEventListener("keydown", key);
    return () => {
      window.removeEventListener("keydown", key);
      (previous?.isConnected ? previous : refreshRef.current)?.focus();
    };
  }, [confirm, revoking]);
  const copy = async (text: string, message: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setNotice(message);
    } catch {
      setError(
        "Copy is unavailable in this browser. Select the text and copy it manually.",
      );
    }
  };
  const revoke = async (connection: Connection) => {
    if (revokeBusy.current) return;
    revokeBusy.current = true;
    ++loadEpoch.current;
    setLoading(false);
    setRevoking(connection.id);
    setError("");
    try {
      const response = await apiFetch(
        `/api/v1/connections/${encodeURIComponent(connection.id)}`,
        { method: "DELETE", signal: AbortSignal.timeout(10000) },
      );
      const result = (await response.json()) as { error?: string };
      if (!response.ok)
        throw new Error(result.error ?? "The connection could not be revoked.");
      setConnections(
        (items) =>
          items?.map((item) => item.id === connection.id ? {...item,status:"revoked" as const} : item) ?? [],
      );
      setConfirm(null);
      setNotice(`${connection.name} disconnected.`);
    } catch (error) {
      setError(
        error instanceof Error ? error.message : "Could not disconnect app.",
      );
    } finally {
      revokeBusy.current = false;
      setRevoking("");
    }
  };
  const checkSetup = async () => {
    setChecking(true);
    setChecks(null);
    const results: Check[] = [];
    results.push({
      title: "HTTPS endpoint",
      ok: location.protocol === "https:",
      detail: local
        ? "This is a local server. Use your deployed HTTPS address in ChatGPT or Claude."
        : location.protocol === "https:"
          ? "This address uses HTTPS."
          : "Remote clients require an HTTPS address.",
    });
    for (const [title, path, validate] of [
      [
        "MCP discovery",
        "/.well-known/oauth-protected-resource",
        (data: Record<string, unknown>) =>
          data.resource === endpoint &&
          Array.isArray(data.authorization_servers),
      ],
      [
        "OAuth discovery",
        "/.well-known/oauth-authorization-server",
        (data: Record<string, unknown>) =>
          Array.isArray(data.code_challenge_methods_supported) &&
          data.code_challenge_methods_supported.includes("S256") &&
          typeof data.registration_endpoint === "string",
      ],
    ] as const) {
      try {
        const response = await apiFetch(path, {
          signal: AbortSignal.timeout(10000),
        });
        const data = (await response.json()) as Record<string, unknown>;
        const ok = response.ok && validate(data);
        results.push({
          title,
          ok,
          detail: ok
            ? "Discovery metadata is available to this browser."
            : "The endpoint returned unexpected metadata. Check routing and deployment.",
        });
      } catch {
        results.push({
          title,
          ok: false,
          detail:
            "Discovery returned a sign-in page, an error, or timed out. Check Cloudflare Access routing.",
        });
      }
    }
    setChecks(results);
    setChecking(false);
  };
  const selected = GUIDES[guide];
  // A refresh can temporarily leave several active grants for one client. Show
  const apps = connections ?? [];
  return (
    <main className="connections-page">
      <header
        className="connections-topbar"
        {...(confirm || editing ? { inert: "" } : {})}
      >
        <a href={back} className="connections-back">
          <UiIcon name="back" /> {back === "/" ? "Back to studio" : "Back to board"}
        </a>
        <a href="/" className="connections-brand" aria-label="Open Whiteboard home"><BrandMark /><span className="brand-wordmark">{PRODUCT_WORDMARK}</span></a>
        <button className="connections-tour" type="button" onClick={openTour}><UiIcon name="help" /> Quick tour</button>
        <ThemeMenu />
      </header>
      <div className="connections-content" {...(confirm || editing ? { inert: "" } : {})}>
        <div className="connections-heading">
          <div>
          <span className="settings-eyebrow">YOUR STUDIO, CONNECTED</span>
          <h1>Connected apps</h1>
          <p>Describe a process to your assistant.<br />It draws the board, and you can edit every part of it.</p>
          </div>
          <ThemedImage className="connections-illustration" light="/brand/assistant.webp" dark="/brand/assistant-dark.webp" width="1774" height="887" alt="" />
        </div>
        {error ? (
          <div className="connection-message error" role="alert">
            <span>{error}</span>
            <button
              type="button"
              aria-label="Dismiss error"
              onClick={() => setError("")}
            >
              <UiIcon name="close" />
            </button>
          </div>
        ) : null}
        {notice ? (
          <div className="connection-message" role="status">
            <span>{notice}</span>
            <button
              type="button"
              aria-label="Dismiss message"
              onClick={() => setNotice("")}
            >
              <UiIcon name="close" />
            </button>
          </div>
        ) : null}
        <div className="connections-grid">
          <section className="connection-setup-card">
            <div className="connection-section-heading">
              <div>
                <h2>Connect your assistant</h2>
                <p>
                  MCP lets your assistant work with Open Whiteboard tools. Your boards
                  stay editable here.
                </p>
              </div>
              <span className="connection-protocol">MCP</span>
            </div>
            <section className="connection-thread-step">
            <span className="connection-step-number" aria-hidden="true">01</span><h3>Choose your assistant</h3>
            <div
              className="connection-client-tabs"
              role="group"
              aria-label="Setup instructions"
            >
              {Object.entries(GUIDES).map(([key, value]) => (
                <button
                  type="button"
                  key={key}
                  aria-pressed={guide === key}
                  onClick={() => setGuide(key as keyof typeof GUIDES)}
                >
                  {value.title}
                </button>
              ))}
            </div>
            </section>
            <section className="connection-thread-step">
            <span className="connection-step-number" aria-hidden="true">02</span><h3>Copy your server URL</h3>
            <label className="connection-endpoint">
              <span>Server URL</span>
              <div>
                <input
                  readOnly
                  value={endpoint}
                  aria-label="MCP server URL"
                  onFocus={(event) => event.currentTarget.select()}
                />
                <button
                  type="button"
                  onClick={() => void copy(endpoint, "Server URL copied.")}
                >
                  Copy
                </button>
              </div>
            </label>
            {local ? (
              <p className="connection-local-note">
                You’re using a local preview. Connect your deployed Open Whiteboard URL
                to a remote assistant.
              </p>
            ) : null}
            </section>
            <section className="connection-thread-step">
            <span className="connection-step-number" aria-hidden="true">03</span><h3>Connect and choose access</h3>
            <ol className="connection-steps">
              {selected.steps.map((step, index) => (
                <li key={step}>
                  <span>{index + 1}</span>
                  <p>{step}</p>
                </li>
              ))}
            </ol>
            <a
              className="connection-guide-link"
              href={selected.url}
              target="_blank"
              rel="noreferrer"
            >
              Read the {selected.title} guide ↗
            </a>
            </section>
            <div className="connection-test-prompt">
              <div>
                <h3>Try a workflow</h3>
                <button
                  type="button"
                  onClick={() => void copy(prompt, "Workflow prompt copied.")}
                >
                  Copy prompt
                </button>
              </div>
              <p>{prompt}</p>
              <small>
                After connecting, ask your assistant to build this. Open its
                board link and check that notes and arrows can be moved and
                edited.
              </small>
            </div>
          </section>
          <aside className="connection-sidebar">
            <section className="connection-permissions">
              <h2>You stay in control</h2>
              <p>
                Each app requests permissions when you connect. Your board and
                workbook roles still apply.
              </p>
              {Object.entries(PERMISSIONS).map(([scope, value]) => (
                <div key={scope}>
                  <strong>{value.title}</strong>
                  <p>{value.description}</p>
                </div>
              ))}
              <p className="connection-fineprint">
                Open Whiteboard uses browser sign-in and OAuth. Your assistant never
                needs your account password.
              </p>
            </section>
            <section className="connection-checks">
              <div className="connection-section-heading">
                <h2>Connection checks</h2>
                <button
                  type="button"
                  disabled={checking}
                  onClick={() => void checkSetup()}
                >
                  {checking ? "Checking…" : "Check setup"}
                </button>
              </div>
              <p>Check HTTPS and discovery from this browser.</p>
              {checks?.map((check) => (
                <div className="setup-check" key={check.title}>
                  <span className={check.ok ? "check-ok" : "check-fix"}>
                    {check.ok ? "✓" : "!"}
                  </span>
                  <div>
                    <strong>{check.title}</strong>
                    <p>{check.detail}</p>
                  </div>
                </div>
              ))}
              <small>
                These checks cannot verify whether an assistant can reach the
                server from its own network.
              </small>
            </section>
          </aside>
        </div>
        <section className="connected-client-list">
          <div className="connection-section-heading">
            <div>
              <h2>Your connected apps</h2>
              <p>
                Disconnecting an app revokes all of its current access and
                refresh tokens.
              </p>
            </div>
            <button
              type="button"
              ref={refreshRef}
              disabled={loading}
              onClick={() => void load()}
            >
              {loading ? "Refreshing…" : "Refresh"}
            </button>
          </div>
          {connections === null ? (
            <p role="status">
              {loading
                ? "Loading connections…"
                : "Connections are unavailable. Use Refresh to try again."}
            </p>
          ) : apps.length ? (
            apps.map((app) => (
              <article className="connected-client" key={app.id}>
                <span className="client-monogram" aria-hidden="true">
                  {app.name.slice(0, 1).toUpperCase()}
                </span>
                <div className="connected-client-details">
                  <h3>{app.name}</h3>
                  <p>
                    {app.status === 'confirmation_required' ? 'Review required · permissions changed' : app.status === 'revoked' ? 'Disconnected' : app.status === 'expired' ? 'Expired · reconnect from your assistant' : `Connected ${new Date(app.createdAt).toLocaleDateString()}`}
                  </p>
                  <p>
                    {app.resourceMode === 'all' ? 'All boards you can access, including future boards' : `${app.resources.length} selected ${app.resources.length === 1 ? 'board or workbook' : 'boards and workbooks'}`}
                    {app.lastUsedAt ? ` · Last used ${new Date(app.lastUsedAt).toLocaleString()}` : ' · Not used yet'}
                    {app.status === 'active' && app.refreshExpiresAt ? ` · Renews until ${new Date(app.refreshExpiresAt).toLocaleDateString()}` : ''}
                  </p>
                  <div className="connection-scope-tags">
                    {app.scopes.map((scope) => (
                      <span key={scope} title={PERMISSIONS[scope]?.description}>
                        {PERMISSIONS[scope]?.title ?? scope}
                      </span>
                    ))}
                  </div>
                </div>
                {['active','confirmation_required'].includes(app.status) && <button className="connection-manage" type="button" onClick={() => setEditing(app)}>{app.status === 'confirmation_required' ? 'Review access' : 'Manage access'}</button>}
                <button
                  className="disconnect-button"
                  type="button"
                  disabled={Boolean(revoking) || app.status === "revoked"}
                  onClick={() => {
                    setError("");
                    setConfirm(app);
                  }}
                >
                  Disconnect
                </button>
              </article>
            ))
          ) : (
            <div className="connections-empty">
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                aria-hidden="true"
              >
                <path d="M8 8V4M16 8V4M6 8h12v3a6 6 0 0 1-12 0V8ZM12 17v4" />
              </svg>
              <strong>No apps connected yet</strong>
              <p>
                Follow the setup steps above. Your assistant will appear here
                after you authorize it.
              </p>
            </div>
          )}
        </section>
        <details className="connection-troubleshooting">
          <summary>Having trouble connecting?</summary>
          <div>
            <h3>A sign-in page appears instead of the connection</h3>
            <p>
              Cloudflare Access protects your browser session. Remote assistants
              also need to reach MCP discovery, registration, token exchange and
              the MCP endpoint. The interactive authorization page stays
              protected by Access; the Worker checks OAuth tokens on protocol
              requests.
            </p>
            <p>
              Ask the deployment owner to review the route split in{" "}
              <a
                href="https://github.com/sportwhiz/huddle-loom/blob/main/docs/operations.md"
                target="_blank"
                rel="noreferrer"
              >
                the deployment guide
              </a>
              . Open Whiteboard cannot change Cloudflare policies from this page.
            </p>
            <h3>The app connects but cannot edit</h3>
            <p>
              Check that its permissions include Edit boards, and that your
              account has editor or owner access to the target board. Reconnect
              in your assistant to request additional permissions.
            </p>
            <h3>Tools changed after an update</h3>
            <p>
              Refresh the connection in your assistant and start a new
              conversation. The workflow tools create native notes and bound
              arrows using retry-safe operations.
            </p>
            <h3>The connection disappeared</h3>
            <p>
              Expired or revoked authorizations are removed from this list.
              Reconnect in the assistant to authorize a new session.
            </p>
          </div>
        </details>
      </div>
      {confirm ? (
        <div
          className="connection-dialog-backdrop"
          onClick={(event) => {
            if (event.target === event.currentTarget && !revoking)
              setConfirm(null);
          }}
        >
          <div
            ref={confirmRef}
            className="connection-confirm"
            tabIndex={-1}
            role="dialog"
            aria-modal="true"
            aria-labelledby="disconnect-title"
          >
            <h2 id="disconnect-title">Disconnect {confirm.name}?</h2>
            <p>
              This app will lose access to your boards. You can connect it again
              from your assistant.
            </p>
            {error ? (
              <p className="connection-message error" role="alert">
                {error}
              </p>
            ) : null}
            <div>
              <button
                type="button"
                disabled={Boolean(revoking)}
                onClick={() => setConfirm(null)}
              >
                Keep connected
              </button>
              <button
                type="button"
                disabled={Boolean(revoking)}
                onClick={() => void revoke(confirm)}
              >
                {revoking ? "Disconnecting…" : "Disconnect app"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </main>
  );
}

function ConnectionPermissions({connection,onClose,onSaved}:{connection:Connection;onClose:()=>void;onSaved:()=>void}) {
  const dialog=useRef<HTMLElement>(null);
  const action=useAction(async()=>{});
  const [scopes,setScopes]=useState(connection.scopes);
  const [mode,setMode]=useState(connection.resourceMode);
  const [selection,setSelection]=useState(connection.resources.map(item=>`${item.type}:${item.id}`));
  const [resources,setResources]=useState<{type:'board'|'workbook';id:string;title:string}[]>([]);
  const [loadError,setLoadError]=useState('');
  const [ready,setReady]=useState(false);
  useDialogFocus(dialog,true,()=>{if(!action.busy)onClose();});
  useEffect(()=>{
    let live=true;
    void api<{workbooks:{id:string;title:string}[];boards:{id:string;workbookId:string;title:string}[]}>('/api/v1/catalog').then(catalog=>{
      if(!live)return;
      const allowed=(type:'board'|'workbook',id:string,parent?:string)=>connection.resourceMode==='all' || connection.resources.some(item=>(item.type===type && item.id===id)||(item.type==='workbook' && item.id===parent));
      setResources([
        ...catalog.workbooks.filter(item=>item.id!=='workbook:shared' && allowed('workbook',item.id)).map(item=>({...item,type:'workbook' as const})),
        ...catalog.boards.filter(item=>allowed('board',item.id,item.workbookId)).map(item=>({...item,type:'board' as const})),
      ]);setReady(true);
    }).catch(error=>{if(live)setLoadError(error.message);});
    return()=>{live=false;};
  },[connection]);
  const chosen=resources.filter(item=>selection.includes(`${item.type}:${item.id}`));
  return <div className="identity-dialog-backdrop"><section ref={dialog} tabIndex={-1} className="identity-dialog connection-access-dialog" role="dialog" aria-modal="true" aria-labelledby="connection-access-title">
    <span className="identity-eyebrow">APP PERMISSIONS</span><h2 id="connection-access-title">{connection.name}</h2>
    <p>Choose what this authorization can do. To add permissions beyond its original access, reconnect from your assistant.</p>
    {action.feedback}{loadError && <p role="alert">{loadError}</p>}
    <form onSubmit={event=>{event.preventDefault();void action.run(async()=>{await api(`/api/v1/connections/${encodeURIComponent(connection.id)}/permissions`,{scopes,resourceMode:mode,resources:chosen.map(({type,id})=>({type,id}))});onSaved();});}}>
      <fieldset><legend>Permissions</legend>{connection.scopes.map(scope=><label className="connection-permission-option" key={scope}><input type="checkbox" checked={scopes.includes(scope)} onChange={event=>setScopes(event.target.checked?[...scopes,scope]:scopes.filter(item=>item!==scope))}/><span><strong>{PERMISSIONS[scope]?.title ?? scope}</strong><small>{PERMISSIONS[scope]?.description}</small></span></label>)}</fieldset>
      <fieldset><legend>Boards and workbooks</legend>{connection.resourceMode==='all' && <label className="connection-permission-option"><input type="radio" name="resource-mode" checked={mode==='all'} onChange={()=>setMode('all')}/><span>All boards I can access, including future boards</span></label>}
        <label className="connection-permission-option"><input type="radio" name="resource-mode" checked={mode==='selected'} onChange={()=>setMode('selected')}/><span>Selected boards and workbooks</span></label>
        {mode==='selected' && <div className="connection-resource-list">{!ready && !loadError ? <p role="status">Loading your boards…</p> : resources.length ? resources.map(item=>{const key=`${item.type}:${item.id}`;return <label className="connection-permission-option" key={key}><input type="checkbox" checked={selection.includes(key)} onChange={event=>setSelection(event.target.checked?[...selection,key]:selection.filter(value=>value!==key))}/><span><strong>{item.title}</strong><small>{item.type==='workbook'?'Workbook · includes future boards':'This board'}</small></span></label>;}) : <p>No accessible boards remain. Disconnect this authorization and reconnect after a board is shared with you.</p>}</div>}
      </fieldset>
      <p className="identity-hint">Your board role still limits what this app can do. Removing a permission takes effect immediately.</p>
      <div className="identity-actions"><button type="button" disabled={action.busy} onClick={onClose}>Cancel</button><button className="identity-primary" disabled={action.busy || !ready || !scopes.length || (mode==='selected' && !chosen.length)}>{action.busy?'Saving…':connection.status==='confirmation_required'?'Confirm access':'Save permissions'}</button></div>
    </form>
  </section></div>;
}
