import { apiFetch } from "./auth-client";
import { UiIcon, type UiIconName } from "./UiIcon";
import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';

import type { PublicCollaborationState } from './room-collaboration';
import { avatarInk } from './avatar-color';
import { remainingTimerSeconds, timerSoundEnabled } from './board-timer';

type SemanticBoard = { notes: { id: string; text: string }[]; frames: { id: string; title: string }[] };
type PanelTab = 'comments' | 'workshop' | 'present' | 'activity' | 'people';

const PANEL_COPY: Record<PanelTab, { title: string; description: string }> = {
  comments: { title: 'Comments', description: 'Discuss ideas and pin feedback to the canvas.' },
  workshop: { title: 'Workshop', description: 'Run a timer, collect ideas, and vote as a group.' },
  present: { title: 'Present', description: 'Lead everyone through the story on your board.' },
  activity: { title: 'Activity', description: 'Review checkpoints and recent collaboration.' },
  people: { title: 'People', description: 'See who is here and follow their view.' },
};

export function CollaborationPanel({ boardId, state, tab, timerRequest = 0, onTimerRequestHandled, onClose }: {
  boardId: string;
  state: PublicCollaborationState;
  tab: PanelTab;
  timerRequest?: number;
  onTimerRequestHandled: () => void;
  onClose: () => void;
}) {
  const [error, setError] = useState('');
  const [workshopView, setWorkshopView] = useState<'overview' | 'timer' | 'brainstorm' | 'voting' | 'signals'>('overview');
  const [pending, setPending] = useState(false);
  const pendingRef = useRef(false);
  const [commentFilter, setCommentFilter] = useState<'open' | 'resolved' | 'all'>('open');
  const [comment, setComment] = useState('');
  const [replies, setReplies] = useState<Record<string, string>>({});
  const [editingReply, setEditingReply] = useState<{ threadId: string; replyId: string; body: string } | null>(null);
  const [draft, setDraft] = useState('');
  const [commentAnchor, setCommentAnchor] = useState<{ x: number; y: number; objectId: string | null } | null>(null);
  const [placingComment, setPlacingComment] = useState(false);
  const [mutedThreads, setMutedThreads] = useState<string[]>([]);
  const [semantic, setSemantic] = useState<SemanticBoard>({ notes: [], frames: [] });
  const [now, setNow] = useState(Date.now());
  const [timerMinutes, setTimerMinutes] = useState(5);
  const [timerSound, setTimerSound] = useState(timerSoundEnabled);
  const [brainstormTitle, setBrainstormTitle] = useState('Silent brainstorm');
  const [brainstormInstructions, setBrainstormInstructions] = useState('Write one idea per sticky note.');
  const [brainstormMinutes, setBrainstormMinutes] = useState(5);
  const [draftColor, setDraftColor] = useState<'yellow' | 'orange' | 'green' | 'blue' | 'purple'>('yellow');
  const [voteLimit, setVoteLimit] = useState(3);
  const [voteCap, setVoteCap] = useState(1);
  const [voteMinutes, setVoteMinutes] = useState(5);
  const [voteAnonymous, setVoteAnonymous] = useState(true);
  const [voteTargets, setVoteTargets] = useState<string[]>([]);
  const [checkpointLabel, setCheckpointLabel] = useState('');
  const endpoint = `/api/v1/boards/${encodeURIComponent(boardId)}`;
  const command = async (action: string, values: Record<string, unknown> = {}) => {
    if (pendingRef.current) return null;
    pendingRef.current = true; setPending(true); setError('');
    try {
      const response = await apiFetch(`${endpoint}/collaboration/commands`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, operationId: crypto.randomUUID(), ...values }) });
      const result = await response.json().catch(() => ({})) as { error?: string };
      if (!response.ok) throw new Error(result.error ?? `Request failed (${response.status})`);
      return result;
    } catch (error) { setError(error instanceof Error ? error.message : 'The action could not be completed. Try again.'); return null; }
    finally { pendingRef.current = false; setPending(false); }
  };
  const timerSeconds = remainingTimerSeconds(state.timer, Math.max(now, Date.now()));

  useEffect(() => {
    if (!timerRequest) return;
    setWorkshopView('timer');
    onTimerRequestHandled();
  }, [timerRequest, onTimerRequestHandled]);

  useEffect(() => {
    if (tab !== 'workshop' && tab !== 'present') return;
    void apiFetch(`${endpoint}/semantic`).then(response => response.json()).then((result: { board?: SemanticBoard }) => setSemantic(result.board ?? { notes: [], frames: [] })).catch(() => undefined);
  }, [boardId, tab, workshopView]);
  useEffect(() => {
    if (tab !== 'comments') return;
    void apiFetch(`${endpoint}/comment-preferences`).then(response => response.json()).then((value: { mutedThreadIds?: string[] }) => setMutedThreads(value.mutedThreadIds ?? [])).catch(() => undefined);
  }, [boardId, tab]);
  useEffect(() => { const timer = window.setInterval(() => setNow(Date.now()), 1000); return () => window.clearInterval(timer); }, []);
  useEffect(() => { if (!voteTargets.length && semantic.notes.length) setVoteTargets(semantic.notes.slice(0, 12).map(note => note.id)); }, [semantic.notes.length]);
  useEffect(() => {
    const positioned = (event: Event) => {
      setCommentAnchor((event as CustomEvent<{ x: number; y: number; objectId: string | null }>).detail);
      setPlacingComment(false);
    };
    window.addEventListener('whiteboard-comment-position', positioned);
    return () => window.removeEventListener('whiteboard-comment-position', positioned);
  }, []);
  useEffect(() => {
    if (tab !== 'comments') return;
    const threadId = new URLSearchParams(location.search).get('thread');
    if (threadId && state.comments.some(thread => thread.id === threadId && thread.resolvedAt)) setCommentFilter('all');
    if (threadId) window.setTimeout(() => document.getElementById(threadId)?.scrollIntoView({ block: 'center' }), 50);
  }, [tab, state.comments.length]);

  const panelCopy = tab === 'workshop' && workshopView !== 'overview'
    ? {
        timer: { title: 'Timer', description: 'Set a pace for your session.' },
        brainstorm: { title: 'Private brainstorming', description: 'Write privately, then reveal ideas together.' },
        voting: { title: 'Voting', description: 'Choose the ideas to take forward.' },
        signals: { title: 'Reactions', description: 'React to an idea or raise your hand.' },
      }[workshopView]
    : PANEL_COPY[tab];
  const runningVote = state.voteRounds.find(round => round.status === 'running');
  const latestVote = state.voteRounds[0];
  const brainstorm = state.brainstorm;
  const isPresenter = state.presentation?.presenterId === state.currentUserId || state.capabilities.manage;
  const raised = useMemo(() => Object.entries(state.raisedHands).sort((a, b) => a[1].localeCompare(b[1])), [state.raisedHands]);

  const mentionsFor = (text: string) => state.participants.filter(person => text.toLocaleLowerCase().includes(`@${person.name}`.toLocaleLowerCase())).map(person => person.id);
  const addComment = async (event: FormEvent) => { event.preventDefault(); if (!comment.trim()) return; const anchor = commentAnchor ?? { x: 120, y: 120, objectId: null }; const result = await command('add_comment', { body: comment, mentions: mentionsFor(comment), ...anchor }); if (!result) return; setComment(''); setCommentAnchor(null); };
  const saveDraft = async (event: FormEvent) => { event.preventDefault(); if (!draft.trim()) return; const result = await command('save_draft', { text: draft, color: draftColor }); if (!result) return; setDraft(''); };

  return (
    <aside className="collaboration-panel" aria-label="Collaboration tools">
      <header className="panel-heading"><div><h2>{panelCopy.title}</h2><p>{panelCopy.description}</p></div><button className="panel-close" type="button" aria-label="Close panel" onClick={onClose}><UiIcon name="close" /></button></header>
      {error ? <p className="panel-error" role="alert">{error}</p> : null}

      <fieldset className="panel-controls" disabled={pending}>
      {tab === 'comments' ? <div className="panel-scroll">
        <div className="comment-filters" aria-label="Filter comments">{(['open', 'resolved', 'all'] as const).map(filter => <button type="button" key={filter} aria-pressed={commentFilter === filter} onClick={() => setCommentFilter(filter)}>{filter === 'open' ? 'Open' : filter === 'resolved' ? 'Resolved' : 'All'} <span>{state.comments.filter(thread => filter === 'all' || Boolean(thread.resolvedAt) === (filter === 'resolved')).length}</span></button>)}</div>
        {state.capabilities.comment ? <form className="comment-composer" onSubmit={event => void addComment(event)}><textarea value={comment} onChange={event => setComment(event.target.value)} aria-label="Comment" placeholder="Add a comment… Use @Name to mention someone." /><div className="button-row"><button type="button" className={placingComment ? 'active' : ''} onClick={() => { setPlacingComment(true); window.dispatchEvent(new Event('whiteboard-place-comment')); }}>{placingComment ? 'Click the canvas…' : commentAnchor ? 'Change anchor' : 'Place on canvas'}</button><button type="submit" disabled={!comment.trim()}>Comment</button></div>{commentAnchor ? <small>Anchored at {Math.round(commentAnchor.x)}, {Math.round(commentAnchor.y)}{commentAnchor.objectId ? ' on selected object' : ''}</small> : null}</form> : <p className="panel-empty">Your role can read comments.</p>}
        <div className="comment-list">{state.comments.filter(thread => commentFilter === 'all' || Boolean(thread.resolvedAt) === (commentFilter === 'resolved')).map(thread => <article id={thread.id} className={`comment-thread ${thread.resolvedAt ? 'resolved' : ''}`} key={thread.id}>
          <button className="comment-pin" type="button" onClick={() => { history.replaceState(null, '', `${location.pathname}?thread=${encodeURIComponent(thread.id)}`); window.dispatchEvent(new CustomEvent('whiteboard-focus-anchor', { detail: thread.anchor })); }}>{thread.anchor.objectId ? 'Object' : 'Canvas'} · {thread.resolvedAt ? 'Resolved' : 'Open'} · Show</button>
          {thread.replies.map(item => <div className="comment-reply" key={item.id}><span style={{ background: item.author.color, color: avatarInk(item.author.color) }}>{item.author.name.slice(0, 1)}</span><div><strong>{item.author.name}{item.author.id.startsWith('guest:') ? ' · guest' : ''}</strong>{editingReply?.replyId === item.id ? <form className="inline-reply" onSubmit={event => { event.preventDefault(); void command('edit_reply', { threadId: thread.id, replyId: item.id, body: editingReply.body }).then(result => { if (result) setEditingReply(null); }); }}><input autoFocus value={editingReply.body} onChange={event => setEditingReply({ ...editingReply, body: event.target.value })} /><button type="submit">Save</button><button type="button" onClick={() => setEditingReply(null)}>Cancel</button></form> : <p>{item.deletedAt ? 'Reply deleted' : item.body}</p>}<small>{new Date(item.createdAt).toLocaleString()}</small>{!item.deletedAt && item.author.id === state.currentUserId ? <div className="reply-actions"><button type="button" onClick={() => setEditingReply({ threadId: thread.id, replyId: item.id, body: item.body })}>Edit</button><button type="button" onClick={() => void command('delete_reply', { threadId: thread.id, replyId: item.id })}>Delete</button></div> : null}</div></div>)}
          {state.capabilities.comment && !thread.resolvedAt ? <form className="inline-reply" onSubmit={event => { event.preventDefault(); const reply = replies[thread.id] ?? ''; if (!reply.trim()) return; void command('reply_comment', { threadId: thread.id, body: reply, mentions: mentionsFor(reply) }).then(result => { if (result) setReplies(values => ({ ...values, [thread.id]: '' })); }); }}><input value={replies[thread.id] ?? ''} onChange={event => setReplies(values => ({ ...values, [thread.id]: event.target.value }))} aria-label="Reply" placeholder="Reply or @mention" /><button type="submit" disabled={!replies[thread.id]?.trim()}>Send</button></form> : null}
          <div className="thread-actions">{state.capabilities.comment ? <button className="text-action" type="button" onClick={() => void command(thread.resolvedAt ? 'reopen_comment' : 'resolve_comment', { threadId: thread.id })}>{thread.resolvedAt ? 'Reopen' : 'Resolve'}</button> : null}<button className="text-action" type="button" onClick={() => { const muted = mutedThreads.includes(thread.id); void command(muted ? 'unmute_thread' : 'mute_thread', { threadId: thread.id }).then(result => { if (result) setMutedThreads(items => muted ? items.filter(id => id !== thread.id) : [...items, thread.id]); }); }}>{mutedThreads.includes(thread.id) ? 'Unmute replies' : 'Mute replies'}</button></div>
        </article>)}</div>
        {!state.comments.some(thread => commentFilter === 'all' || Boolean(thread.resolvedAt) === (commentFilter === 'resolved')) ? <div className="panel-empty-state"><span><UiIcon name="comment" /></span><strong>{commentFilter === 'resolved' ? 'No resolved comments' : 'No open comments'}</strong><p>{commentFilter === 'resolved' ? 'Resolved conversations will appear here.' : 'Pin feedback to the canvas or start a conversation.'}</p></div> : null}
      </div> : null}

      {tab === 'workshop' ? <div className="panel-scroll workshop-panel" data-view={workshopView}>
        {workshopView === 'overview' ? <div className="facilitation-cards">

          {[
            { id: 'timer' as const, title: 'Timer', description: 'Set a pace and keep a session on track.', icon: 'clock' as const, status: state.timer && state.timer.status !== 'ended' ? `${String(Math.floor(timerSeconds / 60)).padStart(2, '0')}:${String(timerSeconds % 60).padStart(2, '0')} · ${state.timer.status}` : undefined },
            { id: 'brainstorm' as const, title: 'Private brainstorming', description: 'Collect individual ideas, then reveal together.', icon: 'notes' as const, status: brainstorm && ['running', 'closed'].includes(brainstorm.status) ? `${brainstorm.submittedCount} ideas submitted` : undefined },
            { id: 'voting' as const, title: 'Voting', description: 'Find the ideas your group wants to explore.', icon: 'vote' as const, status: runningVote ? 'Voting is open' : undefined },
            { id: 'signals' as const, title: 'Reactions', description: 'React in the moment or raise your hand.', icon: 'hand' as const },
          ].map(tool => <button type="button" key={tool.id} className="facilitation-card" onClick={() => setWorkshopView(tool.id)}><span className="facilitation-icon"><FacilitationIcon name={tool.icon} /></span><span><strong>{tool.title}</strong><small>{tool.description}</small>{tool.status ? <em>{tool.status}</em> : null}</span><UiIcon name="chevron" className="facilitation-chevron" /></button>)}
        </div> : <button className="facilitation-back" type="button" onClick={() => setWorkshopView('overview')}><UiIcon name="back" />All tools</button>}

        <section className="facilitation-detail timer-detail"><h3>Timer</h3>{state.timer && state.timer.status !== 'ended' ? <><div className="big-timer">{String(Math.floor(timerSeconds / 60)).padStart(2, '0')}:{String(timerSeconds % 60).padStart(2, '0')}</div><p>{state.timer.label} · {state.timer.status}</p>{state.capabilities.facilitate ? <div className="button-row"><button type="button" onClick={() => void command(state.timer?.status === 'paused' ? 'resume_timer' : 'pause_timer')}>{state.timer.status === 'paused' ? 'Resume' : 'Pause'}</button><button type="button" onClick={() => void command('extend_timer', { durationSeconds: 60 })}>+1 min</button><button type="button" onClick={() => void command('stop_timer')}>Stop</button></div> : null}</> : state.capabilities.facilitate ? <form className="workshop-settings" onSubmit={event => { event.preventDefault(); void command('start_timer', { label: 'Session timer', durationSeconds: timerMinutes * 60 }); }}><div className="timer-preview" aria-label="Timer duration">{String(Math.floor(timerMinutes)).padStart(2, '0')}:00</div><div className="timer-presets" aria-label="Quick timer duration">{[3, 5, 10, 15].map(minutes => <button type="button" key={minutes} aria-pressed={timerMinutes === minutes} onClick={() => setTimerMinutes(minutes)}>{minutes} min</button>)}</div><label><span>Duration in minutes</span><input type="number" min={1} max={240} value={timerMinutes} onChange={event => setTimerMinutes(Number(event.target.value))} /></label><button type="submit">Start timer</button></form> : <p>No timer is running.</p>}<label className="privacy-toggle"><input type="checkbox" checked={timerSound} onChange={event => { setTimerSound(event.target.checked); try { localStorage.setItem('whiteboard-timer-sound', event.target.checked ? 'on' : 'off'); } catch { /* Storage is optional. */ } }} /><span>Play a sound when time ends</span></label></section>

        <section className="facilitation-detail brainstorm-detail"><h3>Private brainstorming</h3>{brainstorm && ['running', 'closed'].includes(brainstorm.status) ? <><p><strong>{brainstorm.title}</strong><br />{brainstorm.instructions}</p><p>{brainstorm.submittedCount} submitted · {brainstorm.participantCount} participating</p>{brainstorm.status === 'running' ? <form className="comment-composer" onSubmit={event => void saveDraft(event)}><textarea value={draft} onChange={event => setDraft(event.target.value)} placeholder="Only you can see this idea until reveal" /><label><span>Sticky color</span><select value={draftColor} onChange={event => setDraftColor(event.target.value as typeof draftColor)}><option value="yellow">Yellow</option><option value="orange">Orange</option><option value="green">Green</option><option value="blue">Blue</option><option value="purple">Purple</option></select></label><button type="submit">Save private note</button></form> : null}<div className="draft-list">{brainstorm.myDrafts.map(item => <article key={item.id} className={`draft-${item.color}`}><p>{item.text}</p><button type="button" onClick={() => void command(item.submittedAt ? 'withdraw_draft' : 'submit_draft', { draftId: item.id })}>{item.submittedAt ? 'Withdraw' : 'Submit'}</button><button type="button" onClick={() => void command('delete_draft', { draftId: item.id })}>Delete</button></article>)}</div>{state.capabilities.facilitate ? <div className="button-row"><button type="button" onClick={() => void command('close_brainstorm')}>Close collection</button><button type="button" onClick={() => void command('reveal_brainstorm', { x: 100, y: 100 })}>Reveal submitted ideas</button><button type="button" onClick={() => void command('cancel_brainstorm')}>Cancel</button></div> : null}</> : state.capabilities.facilitate ? <form className="workshop-settings" onSubmit={event => { event.preventDefault(); void command('start_brainstorm', { title: brainstormTitle, instructions: brainstormInstructions, durationSeconds: brainstormMinutes * 60 }); }}><label><span>Title</span><input value={brainstormTitle} onChange={event => setBrainstormTitle(event.target.value)} /></label><label><span>Instructions</span><textarea value={brainstormInstructions} onChange={event => setBrainstormInstructions(event.target.value)} /></label><label><span>Minutes</span><input type="number" min={0} max={120} value={brainstormMinutes} onChange={event => setBrainstormMinutes(Number(event.target.value))} /></label><button type="submit">Start private brainstorm</button></form> : <p>No private brainstorm is active.</p>}</section>

        <section className="facilitation-detail voting-detail"><h3>Voting</h3>{runningVote ? <><p>{runningVote.title} · choose up to {runningVote.votesPerUser}</p><div className="vote-targets">{runningVote.targets.map(target => { const note = semantic.notes.find(item => item.id === target); const count = runningVote.myVotes.filter(item => item === target).length; return <div className="vote-choice" key={target}><span>{note?.text ?? target}</span><button type="button" disabled={count === 0} onClick={() => { const index = runningVote.myVotes.indexOf(target); const next = [...runningVote.myVotes]; next.splice(index, 1); void command('cast_vote', { roundId: runningVote.id, targets: next }); }}>−</button><b>{count}</b><button type="button" disabled={runningVote.myVotes.length >= runningVote.votesPerUser || count >= runningVote.maxPerTarget} onClick={() => void command('cast_vote', { roundId: runningVote.id, targets: [...runningVote.myVotes, target] })}>+</button></div>})}</div><button type="button" onClick={() => void command('cast_vote', { roundId: runningVote.id, targets: [] })}>Abstain / clear my votes</button>{state.capabilities.facilitate ? <button type="button" onClick={() => void command('end_vote', { roundId: runningVote.id })}>End and reveal</button> : null}</> : <>{latestVote?.status === 'ended' ? <div className="vote-history"><p>Results: {latestVote.title}</p>{latestVote.targets.map(target => <div className="vote-result" key={target}><span>{semantic.notes.find(note => note.id === target)?.text ?? target}</span><b>{latestVote.results?.[target] ?? 0}</b></div>)}</div> : null}{state.capabilities.facilitate && semantic.notes.length ? <form className="workshop-settings" onSubmit={event => { event.preventDefault(); void command('start_vote', { title: 'Vote on ideas', targets: voteTargets, votesPerUser: voteLimit, maxPerTarget: voteCap, anonymous: voteAnonymous, durationSeconds: voteMinutes * 60 }); }}><div className="eligible-notes">{semantic.notes.slice(0, 30).map(note => <label key={note.id}><input type="checkbox" checked={voteTargets.includes(note.id)} onChange={event => setVoteTargets(items => event.target.checked ? [...items, note.id] : items.filter(id => id !== note.id))} /><span>{note.text}</span></label>)}</div><div className="workshop-grid"><label><span>Votes/person</span><input type="number" min={1} max={20} value={voteLimit} onChange={event => setVoteLimit(Number(event.target.value))} /></label><label><span>Per item</span><input type="number" min={1} max={20} value={voteCap} onChange={event => setVoteCap(Number(event.target.value))} /></label><label><span>Minutes</span><input type="number" min={0} max={60} value={voteMinutes} onChange={event => setVoteMinutes(Number(event.target.value))} /></label></div><label className="privacy-toggle"><input type="checkbox" checked={voteAnonymous} onChange={event => setVoteAnonymous(event.target.checked)} /><span>Anonymous results</span></label><button type="submit" disabled={!voteTargets.length}>Start new vote</button></form> : <p>Add notes before starting a vote.</p>}</>}</section>

        <section className="facilitation-detail signals-detail"><h3>Reactions</h3><div className="reaction-row">{['👍', '❤️', '🎉', '👏', '💡', '❓'].map(emoji => <button type="button" key={emoji} aria-label={`React ${emoji}`} onClick={() => void command('reaction', { emoji })}>{emoji}</button>)}</div><button type="button" onClick={() => void command(state.raisedHands[state.currentUserId] ? 'lower_hand' : 'raise_hand')}>{state.raisedHands[state.currentUserId] ? 'Lower my hand' : 'Raise my hand'}</button>{raised.length ? <ol className="hands-list">{raised.map(([userId]) => { const person = state.participants.find(item => item.id === userId); return <li key={userId}>{person?.name ?? 'Participant'}{state.capabilities.facilitate ? <button type="button" onClick={() => void command('lower_hand', { userId })}>Acknowledge</button> : null}</li>; })}</ol> : null}</section>
      </div> : null}

      {tab === 'present' ? <div className="panel-scroll presentation-panel"><section><h3>Presentation order</h3><ol className="presentation-frame-list">{semantic.frames.map((frame, index) => <li key={frame.id} className={state.presentation?.status === 'running' && state.presentation.frameIds[state.presentation.frameIndex] === frame.id ? 'current' : ''}><span className="presentation-frame-number">{index + 1}</span><span>{frame.title || `Frame ${index + 1}`}</span></li>)}</ol>{state.presentation?.status === 'running' ? <><p>Frame {state.presentation.frameIndex + 1} of {state.presentation.frameIds.length}</p>{isPresenter ? <div className="button-row"><button type="button" onClick={() => void command('presentation_frame', { frameIndex: Math.max(0, state.presentation!.frameIndex - 1) })}>Previous</button><button className="primary-panel-action" type="button" onClick={() => void command('presentation_frame', { frameIndex: Math.min(state.presentation!.frameIds.length - 1, state.presentation!.frameIndex + 1) })}>Next</button><button type="button" onClick={() => void command('end_presentation')}>End</button></div> : <p>You are following the presenter. Move the canvas to stop following.</p>}{state.capabilities.facilitate && state.participants.length > 1 ? <label><span>Hand off to</span><select defaultValue="" onChange={event => { if (event.target.value) void command('handoff_presentation', { userId: event.target.value }); }}><option value="" disabled>Choose participant</option>{state.participants.filter(person => person.id !== state.currentUserId).map(person => <option value={person.id} key={person.connectionId}>{person.name}</option>)}</select></label> : null}</> : state.capabilities.facilitate && semantic.frames.length ? <button className="primary-panel-action" type="button" onClick={() => void command('start_presentation', { frameIds: semantic.frames.map(frame => frame.id) })}>Present {semantic.frames.length} {semantic.frames.length === 1 ? 'frame' : 'frames'}</button> : <p>Add frames to your board to create a guided presentation.</p>}<div className="button-row"><button type="button" onClick={() => void document.documentElement.requestFullscreen?.()}>Enter full screen</button>{state.capabilities.facilitate ? <button type="button" onClick={() => window.dispatchEvent(new CustomEvent('whiteboard-bring-everyone'))}>Bring everyone to me</button> : null}</div></section><section className="shortcut-card"><span className="keycap">⇧ L</span><div><h3>Laser pointer</h3><p>Hold Shift + L while pointing to highlight details for everyone.</p></div></section></div> : null}

      {tab === 'activity' ? <div className="panel-scroll"><div className="checkpoint-composer">{state.capabilities.edit ? <form className="inline-reply" onSubmit={event => { event.preventDefault(); if (!checkpointLabel.trim()) return; void command('create_checkpoint', { label: checkpointLabel }).then(result => { if (result) setCheckpointLabel(''); }); }}><input value={checkpointLabel} onChange={event => setCheckpointLabel(event.target.value)} aria-label="Checkpoint name" placeholder="Checkpoint name" /><button type="submit">Save checkpoint</button></form> : null}</div>{state.checkpoints.map(item => <article className="activity-row" key={item.id}><b>{item.label}</b><span>Revision {item.revision} · {new Date(item.createdAt).toLocaleString()}</span></article>)}{state.activity.map(item => <article className="activity-row" key={item.id}><b>{item.summary}</b><span>{new Date(item.createdAt).toLocaleString()}</span></article>)}{!state.activity.length && !state.checkpoints.length ? <p className="panel-empty">Activity will appear as people collaborate.</p> : null}</div> : null}

      {tab === 'people' ? <div className="panel-scroll"><div className="panel-section-label"><span className="online-dot" />{state.participants.length} online now</div>{state.participants.map(person => <article className="participant-row" key={person.connectionId}><span style={{ background: person.color, color: avatarInk(person.color) }}>{person.name.slice(0, 1)}</span><div><strong>{person.name}</strong><small>{person.guest ? 'Guest · ' : ''}{person.role}{person.id === state.presentation?.presenterId ? ' · presenting' : ''}</small></div>{person.id !== state.currentUserId ? <button type="button" onClick={() => window.dispatchEvent(new CustomEvent('whiteboard-follow', { detail: { userId: person.id } }))}>Follow</button> : <small className="you-label">You</small>}</article>)}{!state.participants.length ? <p className="panel-empty">No one else is here right now.</p> : null}</div> : null}
      </fieldset>
      {pending ? <div className="panel-action-status" role="status">Updating…</div> : null}
    </aside>
  );
}

export type { PanelTab };

function FacilitationIcon({ name }: { name: UiIconName }) {
  return <UiIcon name={name} />;
}
