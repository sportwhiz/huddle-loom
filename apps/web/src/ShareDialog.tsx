import { apiFetch } from "./auth-client";
import { UiIcon } from "./UiIcon";
import { useDialogFocus } from "./useDialogFocus";
import { useEffect, useRef, useState, type FormEvent } from 'react';

import type { Capabilities, Collaborator, PendingInvitation, Role } from './collaboration-types';
import { avatarInk } from './avatar-color';
import { GuestSharing } from './GuestSharing';

type ShareState = {
  capabilities: Capabilities;
  private?: boolean;
  collaborators: Collaborator[];
  invitations: PendingInvitation[];
};

async function api(path: string, init?: RequestInit) {
  const response = await apiFetch(path, init);
  const body = await response.json().catch(() => ({})) as { error?: string };
  if (!response.ok) throw new Error(body.error ?? `Request failed (${response.status})`);
  return body;
}

export function ShareDialog({ boardId, workbookId, onClose }: { boardId?: string; workbookId?: string; onClose: () => void }) {
  const [state, setState] = useState<ShareState | null>(null);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<Exclude<Role, 'owner'>>('editor');
  const [days, setDays] = useState(7);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState('');
  const [createdLink, setCreatedLink] = useState('');
  const [transferTarget, setTransferTarget] = useState<Collaborator | null>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const transferRef = useRef<HTMLDivElement>(null);
  useDialogFocus(dialogRef, !transferTarget, onClose);
  useDialogFocus(transferRef, Boolean(transferTarget), () => setTransferTarget(null));
  const resourceKind = boardId ? 'board' : 'workbook';
  const resourceId = boardId ?? workbookId ?? '';
  const endpoint = `/api/v1/${resourceKind}s/${encodeURIComponent(resourceId)}`;

  const load = () => api(`${endpoint}/share`).then(value => setState(value as ShareState));
  const copyLink = async (link: string, id: string) => {
    setError(''); setCopied('');
    try { await navigator.clipboard.writeText(link); setCopied(id); return true; }
    catch { setError('Could not copy the link. Select and copy it below.'); return false; }
  };

  useEffect(() => {
    void load().catch(value => setError(value instanceof Error ? value.message : 'Could not load sharing'));
  }, [resourceId]);

  const invite = async (event: FormEvent) => {
    event.preventDefault(); setBusy(true); setError('');
    try {
      const created = await api(`${endpoint}/share`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, role, expiresInDays: days }) }) as { token: string; id: string };
      const link = `${location.origin}/#invite=${encodeURIComponent(created.token)}`;
      setCreatedLink(link); setEmail('');
      const didCopy = await copyLink(link, created.id);
      try { await load(); }
      catch { setError(`Invitation created${didCopy ? ' and copied' : ''}. Could not refresh the access list.${didCopy ? '' : ' Select and copy the link below.'}`); }
    } catch (value) { setError(value instanceof Error ? value.message : 'Invitation failed'); }
    finally { setBusy(false); }
  };

  const changeRole = async (userId: string, nextRole: string) => {
    setBusy(true); setError('');
    try { await api(`${endpoint}/collaborators/${encodeURIComponent(userId)}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ role: nextRole }) }); await load(); }
    catch (value) { setError(value instanceof Error ? value.message : 'Role update failed'); }
    finally { setBusy(false); }
  };

  const remove = async (userId: string) => {
    setBusy(true); setError('');
    try { await api(`${endpoint}/collaborators/${encodeURIComponent(userId)}`, { method: 'DELETE' }); await load(); }
    catch (value) { setError(value instanceof Error ? value.message : 'Removal failed'); }
    finally { setBusy(false); }
  };

  const transfer = async () => {
    if (!transferTarget) return;
    setBusy(true); setError('');
    try {
      await api(`${endpoint}/ownership`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ userId: transferTarget.id }) });
      onClose();
      location.reload();
    } catch (value) { setError(value instanceof Error ? value.message : 'Ownership transfer failed'); }
    finally { setBusy(false); }
  };

  const setPrivate = async (privateBoard: boolean) => {
    setBusy(true); setError('');
    try {
      await api(`${endpoint}/catalog`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ private: privateBoard }) });
      await load();
    } catch (value) { setError(value instanceof Error ? value.message : 'Privacy update failed'); }
    finally { setBusy(false); }
  };
  const renew = async (userId: string) => {
    setBusy(true); setError('');
    try {
      await api(`${endpoint}/collaborators/${encodeURIComponent(userId)}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ expiresInDays: 30 }) });
      await load();
    } catch (value) { setError(value instanceof Error ? value.message : 'Renewal failed'); }
    finally { setBusy(false); }
  };
  const revoke = async (id: string) => {
    setBusy(true); setError('');
    try { await api(`${endpoint}/invitations/${encodeURIComponent(id)}`, { method: 'DELETE' }); await load(); }
    catch (value) { setError(value instanceof Error ? value.message : 'Could not revoke the invitation'); }
    finally { setBusy(false); }
  };

  return (
    <div className="modal-backdrop share-backdrop" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
      <section ref={dialogRef} tabIndex={-1} className="share-dialog" role="dialog" aria-modal="true" aria-labelledby="share-title">
        <header>
          <div><h2 id="share-title">Share this {resourceKind}</h2><p>Invite people to collaborate on this {resourceKind}.</p></div>
          <button ref={closeRef} type="button" aria-label="Close sharing" onClick={onClose}><UiIcon name="close" /></button>
        </header>
        {error ? <p className="dialog-error" role="alert">{error}</p> : null}
        {boardId ? <><div className="share-actions">
          <button type="button" onClick={() => { setCreatedLink(location.href); void copyLink(location.href, 'board-link'); }}>{copied === 'board-link' ? 'Board link copied' : <><UiIcon name="share" />Copy board link</>}</button>
          {state?.capabilities.share ? <label className="privacy-toggle"><input type="checkbox" checked={state.private} disabled={busy} onChange={event => void setPrivate(event.target.checked)} /><span>Private board</span></label> : null}
        </div>
        <p className="share-link-hint">Copying a board link does not grant access.</p>
        {state?.private ? <p className="share-note">Workbook access is off. Invite people directly or enable a guest link below.</p> : <p className="share-note">Workbook access is inherited. People marked “via workbook” must be managed from the workbook.</p>}</> : <p className="share-note">Workbook access applies to every board in it, except boards marked private.</p>}
        {boardId && state?.capabilities.share ? <GuestSharing boardId={boardId} /> : null}
        {state?.capabilities.share ? (
          <form className="invite-form" onSubmit={invite}>
            <label><span>Email or Studio username</span><input type="text" required value={email} onChange={event => setEmail(event.target.value)} placeholder="Email or username" /></label>
            <label><span>Role</span><select value={role} onChange={event => setRole(event.target.value as Exclude<Role, 'owner'>)}><option value="editor">Editor</option><option value="commenter">Commenter</option><option value="viewer">Viewer</option></select></label>
            <label><span>Expires</span><select value={days} onChange={event => setDays(Number(event.target.value))}><option value={1}>1 day</option><option value={7}>7 days</option><option value={30}>30 days</option><option value={90}>90 days</option></select></label>
            <button type="submit" disabled={busy || !email.trim()}>{busy ? 'Working…' : 'Create invitation & copy link'}</button>
          </form>
        ) : <p className="share-note">You can see who has access. The board owner manages invitations and roles.</p>}

        {createdLink ? <label className="share-copy-fallback"><span>{createdLink.includes('#invite=') ? 'Invitation link' : 'Board link'}</span><input readOnly value={createdLink} onFocus={event => event.target.select()} /></label> : null}
        <section className="share-list" aria-labelledby="access-heading">
          <h3 id="access-heading">People with access</h3>
          {state?.collaborators.map(person => (
            <div className="share-person" key={person.id}>
              <span className="person-avatar" style={{ background: person.color, color: avatarInk(person.color) }}>{person.name.slice(0, 1).toUpperCase()}</span>
              <div><strong>{person.name}</strong><small>{person.email}{person.source === 'workbook' ? ' · via workbook' : ''}{person.expiresAt ? ` · expires ${new Date(person.expiresAt).toLocaleDateString()}` : ''}</small></div>
              {state.capabilities.share && person.role !== 'owner' && person.source !== 'workbook' ? <select aria-label={`Role for ${person.name}`} disabled={busy} value={person.role} onChange={event => void changeRole(person.id, event.target.value)}><option value="editor">Editor</option><option value="commenter">Commenter</option><option value="viewer">Viewer</option></select> : <span className="role-pill">{person.role}</span>}
              {state.capabilities.share && person.role !== 'owner' && person.source !== 'workbook' ? <div className="person-actions">{person.expiresAt ? <button type="button" disabled={busy} onClick={() => void renew(person.id)}>Renew</button> : null}<button type="button" disabled={busy} onClick={() => setTransferTarget(person)}>Transfer ownership</button><button className="icon-danger" disabled={busy} type="button" aria-label={`Remove ${person.name}`} onClick={() => void remove(person.id)}><UiIcon name="close" /></button></div> : null}
            </div>
          ))}
          {!state ? <p>Loading access…</p> : null}
        </section>

        {state?.capabilities.share && state.invitations.length ? (
          <section className="share-list" aria-labelledby="pending-heading">
            <h3 id="pending-heading">Invitations</h3>
            {state.invitations.map(invitation => (
              <div className="share-person" key={invitation.id}>
                <span className="person-avatar pending-avatar"><UiIcon name="mail" /></span>
                <div><strong>{invitation.email}</strong><small>{invitation.status} · {invitation.role} · expires {new Date(invitation.expiresAt).toLocaleDateString()}</small></div>
                {copied === invitation.id ? <span className="copied-label">Link copied</span> : null}
                {invitation.status === 'pending' ? <button type="button" disabled={busy} onClick={() => void revoke(invitation.id)}>Revoke</button> : null}
              </div>
            ))}
          </section>
        ) : null}
        {transferTarget ? <div ref={transferRef} tabIndex={-1} className="transfer-confirm" role="alertdialog" aria-modal="true" aria-labelledby="transfer-title"><h3 id="transfer-title">Transfer ownership to {transferTarget.name}?</h3><p>You will become an editor. The new owner can change access and delete the {resourceKind}.</p><div className="button-row"><button type="button" onClick={() => setTransferTarget(null)}>Cancel</button><button className="danger-button" disabled={busy} type="button" onClick={() => void transfer()}>Transfer ownership</button></div></div> : null}
      </section>
    </div>
  );
}
