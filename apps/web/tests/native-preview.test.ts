import * as Y from 'yjs';
import { describe, expect, it } from 'vitest';
import { createHeadlessBoard } from '../src/blocksuite/headless-board';
import { captureNativeSnapshot, fromBase64, toBase64, type NativeBoardSnapshot } from '../src/blocksuite/runtime/snapshot';
import { applyNativeOperations } from '../src/native-operations.server';
import { readNativePreview } from '../src/native-preview.server';
import { BOARD_PREVIEW_LIMIT, BOARD_PREVIEW_TEXT_LIMIT } from '../src/board-preview';

function fixture() {
  const board = createHeadlessBoard([], 'preview', { includeFrames: false });
  const snapshot = captureNativeSnapshot(board.workspace);
  board.workspace.dispose();
  return snapshot;
}

function edit(snapshot: NativeBoardSnapshot, update: (blocks: Y.Map<Y.Map<unknown>>) => void) {
  const doc = new Y.Doc();
  try {
    Y.applyUpdate(doc, fromBase64(snapshot.docs['board:home']));
    update(doc.getMap('blocks'));
    return { ...snapshot, docs: { ...snapshot.docs, 'board:home': toBase64(Y.encodeStateAsUpdate(doc)) } };
  } finally { doc.destroy(); }
}

function surface(blocks: Y.Map<Y.Map<unknown>>) {
  const block = [...blocks.values()].find(b => b.get('sys:flavour') === 'affine:surface')!;
  return (block.get('prop:elements') as Y.Map<unknown>).get('value') as Y.Map<Y.Map<unknown>>;
}

describe('bounded native board previews', () => {
  it('retains geometry, colors, captions and connector ports without returning document or table bodies', () => {
    const first = applyNativeOperations(fixture(), [
      { type: 'create_frame', ref: 'frame', title: 'Process', x: -100, y: -100, width: 1300, height: 1000 },
      { type: 'create_note', ref: 'note', text: 'Start', color: 'yellow', x: 0, y: 0 },
      { type: 'create_shape', ref: 'shape', text: 'Approved?', shape: 'diamond', x: 350, y: 0, width: 240, height: 160 },
      { type: 'create_connector', ref: 'arrow', sourceRef: 'note', targetRef: 'shape', sourceAnchor: 'right', targetAnchor: 'left' },
      { type: 'create_document', ref: 'doc', title: 'Research', x: 0, y: 350, width: 500, height: 200, blocks: [{ type: 'paragraph', text: 'private document body'.repeat(500) }] },
      { type: 'create_table', title: 'Backlog', x: 600, y: 350, columns: [{ key: 'task', name: 'Task', type: 'text' }], rows: [{ task: 'private table cell'.repeat(100) }] },
    ]);
    const preview = readNativePreview(first.snapshot);
    expect(preview.elements.find(e => e.id === first.refs.note)).toMatchObject({ type: 'note', text: 'Start', xywh: '[0,0,208,208]' });
    expect(preview.elements.find(e => e.id === first.refs.doc)?.text).toBe('Research');
    expect(preview.elements.some(e => e.text === 'Backlog')).toBe(true);
    expect(preview.notes.find(e => e.id === first.refs.note)).toMatchObject({ color: '#fde68a', collapsed: true });
    expect(preview.shapes.find(e => e.id === first.refs.shape)?.shape).toBe('diamond');
    expect(preview.connectors[0]).toMatchObject({ source: { id: first.refs.note, position: [1, .5] }, target: { id: first.refs.shape, position: [0, .5] } });
    const encoded = JSON.stringify(preview);
    expect(encoded).not.toMatch(/private|blocks|surfaceElements|sourceId|cells|columns/u);
    expect(encoded.length).toBeLessThan(3000);
  });

  it('bounds object count, connector count and snippets before serialization even on a large board', () => {
    const snapshot = edit(fixture(), blocks => {
      const elements = surface(blocks);
      for (let i = 0; i < BOARD_PREVIEW_LIMIT + 50; i++) {
        elements.set(`shape-${i}`, new Y.Map<unknown>(Object.entries({ id: `shape-${i}`, type: 'shape', xywh: `[${i * 250},0,200,200]`, text: new Y.Text('Caption'.repeat(1000)), fillColor: '#ceecff', shapeType: 'rect' })));
        elements.set(`arrow-${i}`, new Y.Map<unknown>(Object.entries({ id: `arrow-${i}`, type: 'connector', source: { id: `shape-${i}`, position: [1, .5] }, target: { position: [100, 200] }, text: 'Arrow label'.repeat(1000) })));
      }
    });
    const preview = readNativePreview(snapshot);
    expect(preview.elements).toHaveLength(BOARD_PREVIEW_LIMIT);
    expect(preview.shapes).toHaveLength(BOARD_PREVIEW_LIMIT);
    expect(preview.connectors).toHaveLength(BOARD_PREVIEW_LIMIT);
    expect(preview.elements.every(e => e.text?.length === BOARD_PREVIEW_TEXT_LIMIT)).toBe(true);
    expect(preview.connectors[0].target).toEqual({ position: [100, 200] });
    expect(JSON.stringify(preview).length).toBeLessThan(250_000);
  });

  it('ignores invalid geometry and bounds imported metadata without leaking arbitrary properties', () => {
    const snapshot = edit(fixture(), blocks => {
      const elements = surface(blocks);
      const put = (id: string, extra: Record<string, unknown>) => elements.set(id, new Y.Map<unknown>(Object.entries({ id, type: 'shape', xywh: '[0,0,100,100]', ...extra })));
      put('negative', { xywh: '[0,0,-100,100]' });
      put('malformed', { xywh: '[broken' });
      put('overflow', { xywh: '[1.7e308,0,1.7e308,100]' });
      put('x'.repeat(161), {});
      put('safe', { fillColor: { light: '#123456', dark: 'private'.repeat(1000) }, shapeType: 'rectangle'.repeat(1000), text: 'A'.repeat(1000), secret: 'hidden' });
    });
    const preview = readNativePreview(snapshot);
    expect(preview.elements.map(e => e.id)).toEqual(['safe']);
    expect(preview.shapes[0]).toMatchObject({ id: 'safe', color: '#123456' });
    expect(preview.shapes[0].shape?.length).toBe(BOARD_PREVIEW_TEXT_LIMIT);
    expect(JSON.stringify(preview)).not.toMatch(/private|secret|hidden/u);
  });
});
