import { apiFetch } from "./auth-client";
import { useEffect, useId, useRef, useState } from 'react';
import { UiIcon } from './UiIcon';
import { avatarInk } from './avatar-color';
import { BOARD_PREVIEW_LIMIT, type PreviewColor as Color, type PreviewElement as Element, type PreviewEndpoint as Endpoint, type PreviewBoard } from './board-preview';

function box(element: Element) {
  try {
    const values: unknown = JSON.parse(element.xywh ?? 'null');
    if (!Array.isArray(values) || values.length !== 4 || !values.every(v => typeof v === 'number' && Number.isFinite(v)) || values[2] <= 0 || values[3] <= 0) return null;
    return { ...element, x: values[0] as number, y: values[1] as number, w: values[2] as number, h: values[3] as number };
  } catch { return null; }
}
function color(value: Color | undefined, fallback: string) {
  const result = typeof value === 'string' ? value : value?.light;
  return result && /^#[0-9a-f]{3,8}$/iu.test(result) ? result : fallback;
}

/** Fetch only visible cards. Previews depict saved native content, rather than sample boards. */
export function BoardPreview({ board }: { board: { id: string; updatedAt: string } }) {
  const ref = useRef<HTMLDivElement>(null);
  const markerId = useId();
  const [content, setContent] = useState<PreviewBoard | null>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'unavailable'>('loading');
  useEffect(() => {
    const abort = new AbortController();
    let requested = false;
    setContent(null); setStatus('loading');
    const load = async () => {
      if (requested) return;
      requested = true;
      try {
        const response = await apiFetch(`/api/v1/boards/${encodeURIComponent(board.id)}/preview`, { signal: abort.signal });
        if (!response.ok) throw new Error('Preview unavailable');
        const data = await response.json() as { board: PreviewBoard };
        if (![data.board?.elements, data.board?.notes, data.board?.shapes, data.board?.connectors].every(Array.isArray)) throw new Error('Preview unavailable');
        if (!abort.signal.aborted) { setContent(data.board); setStatus('ready'); }
      } catch { if (!abort.signal.aborted) setStatus('unavailable'); }
    };
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) { observer.disconnect(); void load(); }
    }, { rootMargin: '120px' });
    if (ref.current) observer.observe(ref.current);
    return () => { abort.abort(); observer.disconnect(); };
  }, [board.id, board.updatedAt]);
  const boxes = content?.elements.slice(0, BOARD_PREVIEW_LIMIT).map(box).filter(e => e !== null) ?? [];
  const bounds = boxes.length ? {
    x: Math.min(...boxes.map(b => b.x)), y: Math.min(...boxes.map(b => b.y)),
    right: Math.max(...boxes.map(b => b.x + b.w)), bottom: Math.max(...boxes.map(b => b.y + b.h)),
  } : null;
  const padding = bounds ? Math.max(bounds.right - bounds.x, bounds.bottom - bounds.y) * .08 : 0;
  const byId = new Map(boxes.map(b => [b.id, b]));
  const endpoint = (value: Endpoint | undefined) => {
    const target = value?.id ? byId.get(value.id) : undefined;
    if (!target) return !value?.id && value?.position ? { x: value.position[0], y: value.position[1] } : null;
    const [px, py] = value?.position ?? [.5, .5];
    if (!Number.isFinite(px) || !Number.isFinite(py)) return null;
    return { x: target.x + target.w * px, y: target.y + target.h * py };
  };
  return <div ref={ref} className="board-preview native-board-preview" aria-hidden="true">
    {bounds ? <svg viewBox={`${bounds.x - padding} ${bounds.y - padding} ${bounds.right - bounds.x + padding * 2} ${bounds.bottom - bounds.y + padding * 2}`}>
      <defs><marker id={markerId} markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto" markerUnits="strokeWidth"><path d="m1 1 5 2.5L1 6" fill="none" stroke="var(--text-secondary)" /></marker></defs>
      {boxes.filter(b => b.type === 'frame').map(b => <rect key={b.id} x={b.x} y={b.y} width={b.w} height={b.h} fill="none" stroke="var(--border)" strokeWidth="1" vectorEffect="non-scaling-stroke" />)}
      {content?.connectors.slice(0, BOARD_PREVIEW_LIMIT).map(c => { const from = endpoint(c.source), to = endpoint(c.target); return from && to ? <path key={c.id} d={`M${from.x},${from.y} L${to.x},${to.y}`} fill="none" stroke="var(--text-secondary)" strokeWidth=".8" vectorEffect="non-scaling-stroke" markerEnd={`url(#${markerId})`} /> : null; })}
      {boxes.filter(b => b.type !== 'frame').map(b => {
        const note = content?.notes.find(n => n.id === b.id);
        const shape = content?.shapes.find(s => s.id === b.id);
        const fill = note?.collapsed ? color(note.color, '#ffed8e') : color(shape?.color, 'var(--surface)');
        const ink = b.type !== 'text' && fill.startsWith('#') ? avatarInk(fill) : 'var(--text)';
        return <g key={b.id}>
          {b.type !== 'text' ? shape?.shape === 'diamond' ? <path d={`M${b.x + b.w / 2},${b.y} L${b.x + b.w},${b.y + b.h / 2} L${b.x + b.w / 2},${b.y + b.h} L${b.x},${b.y + b.h / 2} Z`} fill={fill} stroke="var(--text-secondary)" strokeWidth=".6" vectorEffect="non-scaling-stroke" /> : shape?.shape === 'ellipse' ? <ellipse cx={b.x + b.w / 2} cy={b.y + b.h / 2} rx={b.w / 2} ry={b.h / 2} fill={fill} stroke="var(--text-secondary)" strokeWidth=".6" vectorEffect="non-scaling-stroke" /> : <rect x={b.x} y={b.y} width={b.w} height={b.h} rx={shape ? 3 : 0} fill={fill} stroke={note?.collapsed ? 'none' : 'var(--border)'} strokeWidth=".6" vectorEffect="non-scaling-stroke" /> : null}
          {b.text ? <text x={b.x + b.w * .1} y={b.y + b.h * .3} fontSize={Math.min(20, b.w / 12)} fill={ink}>{b.text.split('\n')[0].slice(0, 16)}{b.text.split('\n')[0].length > 16 ? '…' : ''}</text> : null}
        </g>;
      })}
    </svg> : <div className="preview-placeholder"><UiIcon name="frame" /><span>{status === 'loading' ? 'Loading preview…' : status === 'unavailable' ? 'Open board to view' : 'Empty board'}</span></div>}
  </div>;
}
