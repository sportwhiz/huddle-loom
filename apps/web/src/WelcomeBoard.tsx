import { useId, useRef, useState, type CSSProperties, type PointerEvent } from "react";
import { UiIcon } from "./UiIcon";
import { MarkerTagline } from "./MarkerTagline";
import "./welcome-board.css";

type Note = { id: number; x: number; y: number; color: string; title: string; text: string; rotation: number };
const initialNotes: Note[] = [
  { id: 1, x: 110, y: 164, color: "butter", title: "The idea", text: "A small thought.\nA big question.\nStart anywhere.", rotation: -4 },
  { id: 2, x: 557, y: 278, color: "clay", title: "What if…", text: "Put it on a note.\nSee where it leads.", rotation: 3 },
  { id: 3, x: 300, y: 517, color: "sage", title: "Next step", text: "Make a connection.\nTry something new.", rotation: -3 },
];
const width = 900, height = 800, noteWidth = 218, noteHeight = 200;
const clamp = (value: number, max: number) => Math.max(24, Math.min(value, max));

// A small, local-only practice area. It deliberately loads without the editor,
// networking, storage or access to any of the user's actual boards.
export function WelcomeBoard() {
  const [notes, setNotes] = useState(initialNotes);
  const [editing, setEditing] = useState<number | null>(null);
  const editingRef = useRef<number | null>(null);
  const [draft, setDraft] = useState("");
  const [selected, setSelected] = useState<number | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const surface = useRef<HTMLDivElement>(null);
  const noteButtons = useRef(new Map<number, HTMLButtonElement>());
  const drag = useRef<{ id: number; pointer: number; startX: number; startY: number; x: number; y: number; moved: boolean } | null>(null);
  const arrow = useId().replaceAll(":", "");
  const instruction = useId();
  const update = (id: number, x: number, y: number) => setNotes(current => current.map(note => note.id === id ? { ...note, x: clamp(x, width - noteWidth - 24), y: clamp(y, height - noteHeight - 24) } : note));
  const edit = (note: Note) => { editingRef.current = note.id; setEditing(note.id); setDraft(note.text); setSelected(note.id); };
  const finish = (save = true, restoreFocus = true) => {
    const id = editingRef.current;
    if (id === null) return;
    // Clear before focus changes: the textarea's blur must not save a cancelled edit.
    editingRef.current = null;
    if (save) setNotes(current => current.map(note => note.id === id ? { ...note, text: draft.slice(0, 140) } : note));
    const button = noteButtons.current.get(id);
    setEditing(null);
    if (restoreFocus) button?.focus();
  };
  const start = (event: PointerEvent<HTMLButtonElement>, note: Note) => {
    if (!event.isPrimary || event.button !== 0) return;
    setSelected(note.id);
    drag.current = { id: note.id, pointer: event.pointerId, startX: event.clientX, startY: event.clientY, x: note.x, y: note.y, moved: false };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const move = (event: PointerEvent<HTMLButtonElement>) => {
    const current = drag.current, rect = surface.current?.getBoundingClientRect();
    if (!current || current.pointer !== event.pointerId || !rect) return;
    const dx = event.clientX - current.startX, dy = event.clientY - current.startY;
    if (Math.hypot(dx, dy) > 3) current.moved = true;
    if (current.moved) update(current.id, current.x + dx * width / rect.width, current.y + dy * height / rect.height);
  };
  const stop = (event: PointerEvent<HTMLButtonElement>, cancel = false) => {
    const current = drag.current;
    if (!current || current.pointer !== event.pointerId) return;
    if (cancel) update(current.id, current.x, current.y);
    else if (current.moved) setAnnouncement("Note moved. Its connectors moved with it.");
    drag.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };
  const add = () => {
    if (notes.length >= 6) return;
    const id = Math.max(...notes.map(note => note.id)) + 1;
    const note = { id, x: 330 + (id - 4) * 35, y: 220 + (id - 4) * 40, title: "Your idea", text: "", color: ["butter", "sage", "clay"][id % 3], rotation: 1 };
    setNotes(current => [...current, note]);
    edit(note);
    setAnnouncement("New practice note added. Type your idea.");
  };
  const connector = (from: Note, to: Note, downward = false) => {
    if (downward) {
      const sx = from.x + noteWidth / 2, sy = from.y + noteHeight + 18;
      const ex = to.x + noteWidth + 18, ey = to.y + noteHeight / 2;
      return `M ${sx} ${sy} C ${sx} ${sy + 100} ${ex + 100} ${ey} ${ex} ${ey}`;
    }
    const sx = from.x + noteWidth + 18, sy = from.y + noteHeight / 2;
    const ex = to.x - 18, ey = to.y + noteHeight / 2;
    return `M ${sx} ${sy} C ${sx + 90} ${sy + 80} ${ex - 90} ${ey + 20} ${ex} ${ey}`;
  };
  return (
    <aside className="welcome-board" aria-label="Practice whiteboard">
      <div className="welcome-board-surface" ref={surface}>
        <MarkerTagline className="welcome-board-caption" />
        <svg className="welcome-board-connections" viewBox={`0 0 ${width} ${height}`} aria-hidden="true">
          <defs><marker id={arrow} markerWidth="12" markerHeight="12" refX="9" refY="6" orient="auto" markerUnits="userSpaceOnUse"><path d="m3 2 6 4-6 4" /></marker></defs>
          {[[0, 1], [1, 2]].map(([a, b]) => <path key={a} d={connector(notes[a], notes[b], a === 1)} markerEnd={`url(#${arrow})`} />)}
        </svg>
        <p className="welcome-board-annotation" aria-hidden="true">One note.<br />Then a connection.</p>
        {notes.map(note => (
          <div key={note.id} className={`practice-note practice-note-${note.color}${selected === note.id ? " selected" : ""}`} style={{ left: `${note.x / width * 100}%`, top: `${note.y / height * 100}%`, "--note-rotation": `${note.rotation}deg` } as CSSProperties}>
            <button
              type="button"
              className="practice-note-move"
              ref={element => { if (element) noteButtons.current.set(note.id, element); else noteButtons.current.delete(note.id); }}
              aria-label={`Practice note: ${note.title}`}
              aria-describedby={instruction}
              onPointerDown={event => start(event, note)}
              onPointerMove={move}
              onPointerUp={event => stop(event)}
              onPointerCancel={event => stop(event, true)}
              onLostPointerCapture={() => { drag.current = null; }}
              onFocus={() => setSelected(note.id)}
              onDoubleClick={() => edit(note)}
              onClick={event => { if (event.detail === 0) edit(note); }}
              onKeyDown={event => {
                const offset = event.shiftKey ? 30 : 10;
                const changes: Record<string, [number, number]> = { ArrowLeft: [-offset, 0], ArrowRight: [offset, 0], ArrowUp: [0, -offset], ArrowDown: [0, offset] };
                const delta = changes[event.key];
                if (!delta) return;
                event.preventDefault();
                update(note.id, note.x + delta[0], note.y + delta[1]);
                setAnnouncement(`${note.title} moved.`);
              }}
            ><strong>{note.title}</strong><span>{note.text || "Double-click to write"}</span></button>
            {editing === note.id && <textarea autoFocus aria-label={`Edit ${note.title}`} maxLength={140} value={draft} onChange={event => setDraft(event.target.value)} onBlur={() => finish(true, false)} onKeyDown={event => { if (event.key === "Escape") { event.preventDefault(); finish(false); } else if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); finish(); } }} />}
            {selected === note.id && editing !== note.id && <button className="practice-note-edit" type="button" aria-label={`Edit ${note.title}`} onClick={() => edit(note)}><UiIcon name="pen" /></button>}
          </div>
        ))}
      </div>
      <div className="welcome-board-bottom">
        <div><p id={instruction}>Drag a note. Double-click to write.<span className="sr-only"> With a keyboard, use arrow keys to move a note and Enter to edit.</span></p><small>Practice board · Changes aren’t saved</small></div>
        <div className="welcome-board-tools" aria-label="Practice board tools">
          <button type="button" disabled={notes.length >= 6} onClick={add} aria-label="Add a practice note" title={notes.length >= 6 ? "Practice board is full. Reset to start again." : "Add a practice note"}><UiIcon name="sticky" /><span>Add note</span></button>
          <button type="button" onClick={() => { editingRef.current = null; setEditing(null); setNotes(initialNotes); setSelected(null); setAnnouncement("Practice board reset."); }} aria-label="Reset practice board" title="Reset practice board"><UiIcon name="undo" /></button>
        </div>
      </div>
      <span className="sr-only" role="status">{announcement}</span>
    </aside>
  );
}
