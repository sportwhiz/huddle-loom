import * as Y from 'yjs';
import { generateKeyBetween } from 'fractional-indexing';
import { describe, expect, it } from 'vitest';
import { createHeadlessBoard } from '../src/blocksuite/headless-board';
import { captureNativeSnapshot, toBase64 } from '../src/blocksuite/runtime/snapshot';
import {
  applyNativeOperations,
  readNativeBoard,
  repairNativeSnapshot,
  type NativeOperation,
} from '../src/native-operations.server';
import {
  composeWorkflow,
  workflowSchema,
  composeBoard,
  compositionSchema,
  composeEntities,
  entitySchema,
  composeSequence,
  sequenceSchema,
} from '../src/board-composer';
import { nativeBlockText } from '../src/blocksuite/native-block-text';
import { inspectNativeBoard, reuseFrameForLayout } from '../src/mcp-authoring.server';
import { nativeOperationSchema } from '../src/native-operation-schema';
const fixture = () => {
  const board = createHeadlessBoard([], 'authoring', { includeFrames: false });
  const snapshot = captureNativeSnapshot(board.workspace);
  board.workspace.dispose();
  return snapshot;
};
const build = (operations: NativeOperation[]) => {
  const result = applyNativeOperations(fixture(), operations);
  return { ...result, board: readNativeBoard(result.snapshot) };
};
describe('editable native authoring', () => {
  it('rejects blank required text at each authoring boundary without stripping formatting', () => {
    for (const text of ['', ' ', '\t\n', '\u00a0']) {
      expect(nativeOperationSchema.safeParse({ type: 'create_note', text, x: 0, y: 0 }).success).toBe(false);
      expect(workflowSchema.safeParse({ nodes: [{ ref: 'a', label: text }], edges: [] }).success).toBe(false);
      expect(workflowSchema.safeParse({ nodes: [{ ref: 'a', label: 'Step', lane: text }], edges: [] }).success).toBe(false);
      expect(compositionSchema.safeParse({ title: 'Ideas', groups: ['Team'], items: [{ title: text, group: 'Team' }] }).success).toBe(false);
      expect(compositionSchema.safeParse({ title: text, groups: ['Team'], items: [] }).success).toBe(false);
    }
    const formatted = '  First line\n\tSecond line  ';
    expect(nativeOperationSchema.parse({ type: 'create_note', text: formatted, x: 0, y: 0 })).toHaveProperty('text', formatted);
    expect(nativeOperationSchema.safeParse({ type: 'update_text', id: 'note', text: '' }).success).toBe(true);
  });
  it('edits image captions and table titles using semantic IDs and table references without changing cells', () => {
    const first = build([
      { type: 'create_image', ref: 'image', sourceId: 'a'.repeat(43), caption: 'Original caption', x: 0, y: 0, width: 200, height: 200 },
      { type: 'create_table', ref: 'table', title: 'Original table', x: 400, y: 0, columns: [{ key: 'name', name: 'Name', type: 'text' }], rows: [{ name: 'Keep this row' }] },
    ]);
    const imageId = first.board.images[0].id;
    const tableId = first.board.tables[0].id;
    const updated = applyNativeOperations(first.snapshot, [
      { type: 'update_text', id: imageId, text: 'New caption ✓' },
      { type: 'update_text', id: tableId, text: 'New table title' },
    ]);
    const board = readNativeBoard(updated.snapshot);
    expect(board.images[0].text).toBe('New caption ✓');
    expect(board.tables[0].title).toBe('New table title');
    expect(board.tables[0].rows).toEqual(first.board.tables[0].rows);
    const cleared = readNativeBoard(applyNativeOperations(updated.snapshot, [
      { type: 'update_text', id: imageId, text: '' },
      { type: 'update_text', id: first.refs.table, text: '' },
    ]).snapshot);
    expect(cleared.images[0].text).toBe('');
    expect(cleared.tables[0].title).toBe('');
    expect(cleared.tables[0].rows).toEqual(first.board.tables[0].rows);
    expect(() => applyNativeOperations(first.snapshot, [{ type: 'update_note_text', id: first.refs.table, text: 'Not a sticky' }])).toThrow(/individually/u);
  });
  it('keeps image captions and table titles protected by native locks', () => {
    const first = build([
      { type: 'create_image', ref: 'image', sourceId: 'a'.repeat(43), caption: 'Protected', x: 0, y: 0, width: 200, height: 200 },
      { type: 'create_table', ref: 'table', title: 'Protected table', x: 400, y: 0, columns: [{ key: 'name', name: 'Name', type: 'text' }], rows: [] },
    ]);
    const doc = new Y.Doc();
    Y.applyUpdate(doc, Buffer.from(first.snapshot.docs['board:home'], 'base64'));
    const blocks = doc.getMap<Y.Map<unknown>>('blocks');
    for (const id of [first.refs.image, first.refs.table]) blocks.get(id)!.set('prop:lockedBySelf', true);
    const locked = { snapshot: { ...first.snapshot, docs: { ...first.snapshot.docs, 'board:home': toBase64(Y.encodeStateAsUpdate(doc)) } } };
    doc.destroy();
    for (const id of [first.refs.image, first.refs.table, first.board.tables[0].id]) {
      expect(() => applyNativeOperations(locked.snapshot, [{ type: 'update_text', id, text: 'Must fail' }])).toThrow(/locked/u);
    }
    expect(readNativeBoard(locked.snapshot).images[0].text).toBe('Protected');
    expect(readNativeBoard(locked.snapshot).tables[0].title).toBe('Protected table');
  });
  it('reads every document paragraph and edits a selected child without touching its siblings', () => {
    const first = build([
      {
        type: 'create_document',
        title: 'Research',
        x: 0,
        y: 0,
        width: 500,
        height: 350,
        blocks: [
          { type: 'paragraph', text: 'Interview quote' },
          { type: 'check', text: 'Follow up', checked: true },
          { type: 'code', text: 'const x = 1', language: 'javascript' },
        ],
      },
    ]);
    expect(first.board.notes[0].text).toBe(
      'Research\nInterview quote\nFollow up\nconst x = 1',
    );
    const child = first.board.notes[0].content.find(
      (c) => c.text === 'Interview quote',
    )!;
    const changed = applyNativeOperations(first.snapshot, [
      { type: 'update_text', id: child.id, text: 'Exact new evidence' },
    ]);
    expect(readNativeBoard(changed.snapshot).notes[0].text).toContain(
      'Research\nExact new evidence\nFollow up\nconst x = 1',
    );
    expect(() =>
      applyNativeOperations(first.snapshot, [
        { type: 'update_text', id: first.createdIds[0], text: 'Flatten' },
      ]),
    ).toThrow(/individually/u);
  });
  it('creates, connects, edits, moves and deletes native surface objects preserving unrelated content', () => {
    const first = build([
      {
        type: 'create_shape',
        ref: 'shape',
        text: 'Decision',
        shape: 'diamond',
        x: 0,
        y: 0,
        width: 240,
        height: 160,
      },
      {
        type: 'create_text',
        ref: 'label',
        text: 'Evidence',
        x: 400,
        y: 0,
        width: 240,
        height: 80,
      },
      {
        type: 'create_connector',
        ref: 'arrow',
        sourceRef: 'shape',
        targetRef: 'label',
        label: 'Yes',
      },
    ]);
    const changed = applyNativeOperations(first.snapshot, [
      { type: 'update_text', id: first.refs.shape, text: 'Approved?' },
      { type: 'move_element', id: first.refs.shape, x: 100, y: 200 },
      {
        type: 'update_connector',
        id: first.refs.arrow,
        label: 'Confirmed',
        sourceAnchor: 'right',
        targetAnchor: 'left',
      },
    ]);
    const board = readNativeBoard(changed.snapshot);
    expect(board.shapes[0]).toMatchObject({
      id: first.refs.shape,
      text: 'Approved?',
      xywh: '[100,200,240,160]',
    });
    expect(board.connectors[0].label).toBe('Confirmed');
    const deleted = applyNativeOperations(changed.snapshot, [
      { type: 'delete_element', id: first.refs.shape },
    ]);
    expect(deleted.deletedIds).toEqual(
      expect.arrayContaining([first.refs.shape, first.refs.arrow]),
    );
    expect(readNativeBoard(deleted.snapshot).connectors).toHaveLength(0);
    expect(readNativeBoard(deleted.snapshot).texts[0].id).toBe(
      first.refs.label,
    );
  });
  it('edits manually drawn arrows while preserving unattached canvas endpoints', () => {
    const first = build([
      { type: 'create_note', ref: 'from', text: 'Start', x: 0, y: 0 },
      { type: 'create_note', ref: 'to', text: 'End', x: 400, y: 0 },
      { type: 'create_connector', ref: 'arrow', sourceRef: 'from', targetRef: 'to' },
    ]);
    const doc = new Y.Doc();
    Y.applyUpdate(doc, Uint8Array.from(atob(first.snapshot.docs['board:home']), c => c.charCodeAt(0)));
    const surface = [...doc.getMap<Y.Map<unknown>>('blocks').values()].find(b => b.get('sys:flavour') === 'affine:surface')!;
    const elements = (surface.get('prop:elements') as Y.Map<unknown>).get('value') as Y.Map<Y.Map<unknown>>;
    elements.get(first.refs.arrow)!.set('source', { position: [40, 60] });
    elements.get(first.refs.arrow)!.set('target', { position: [340, 160] });
    const manual = { ...first.snapshot, docs: { ...first.snapshot.docs, 'board:home': btoa(String.fromCharCode(...Y.encodeStateAsUpdate(doc))) } };
    doc.destroy();
    const changed = applyNativeOperations(manual, [
      { type: 'update_text', id: first.refs.arrow, text: 'Manual flow' },
      { type: 'update_connector', id: first.refs.arrow, label: 'Revised flow', style: 'orthogonal' },
    ]);
    expect(readNativeBoard(changed.snapshot).connectors[0]).toMatchObject({
      label: 'Revised flow', source: { position: [40, 60] }, target: { position: [340, 160] }, style: 1,
    });
    expect(() => applyNativeOperations(manual, [{ type: 'update_connector', id: first.refs.arrow, sourceAnchor: 'right' }])).toThrow(/attached endpoint/u);
    const attached = applyNativeOperations(changed.snapshot, [{ type: 'update_connector', id: first.refs.arrow, sourceRef: first.refs.from }]);
    expect(readNativeBoard(attached.snapshot).connectors[0].source).toEqual({ id: first.refs.from });
  });
  it('keeps shape text readable on explicit fills across both appearances', () => {
    const first = build([
      { type: 'create_shape', ref: 'light', text: 'Light fill', shape: 'rect', fill: '#abcdef', x: 0, y: 0, width: 240, height: 160 },
      { type: 'create_shape', ref: 'dark', text: 'Dark fill', shape: 'rect', fill: '#102030', x: 400, y: 0, width: 240, height: 160 },
      { type: 'create_shape', ref: 'theme', text: 'Theme fill', shape: 'rect', x: 800, y: 0, width: 240, height: 160 },
    ]);
    const color = (board: typeof first.board, id: string) => board.surfaceElements.find(element => element.id === id)?.color;
    expect(color(first.board, first.refs.light)).toBe('#000000');
    expect(color(first.board, first.refs.dark)).toBe('#ffffff');
    expect(color(first.board, first.refs.theme)).toEqual({ light: '#23304a', dark: '#eef2fb' });
    const changed = readNativeBoard(applyNativeOperations(first.snapshot, [
      { type: 'style_element', id: first.refs.light, fill: '#102030' },
      { type: 'style_element', id: first.refs.dark, fill: '#ffffff' },
    ]).snapshot);
    expect(color(changed, first.refs.light)).toBe('#ffffff');
    expect(color(changed, first.refs.dark)).toBe('#000000');
  });
  it('honors a locked paragraph when updating its sticky container', () => {
    const first = build([{ type: 'create_note', text: 'Protected', x: 0, y: 0 }]);
    const child = first.board.notes[0].content[0].id;
    const doc = new Y.Doc();
    Y.applyUpdate(doc, Uint8Array.from(atob(first.snapshot.docs['board:home']), c => c.charCodeAt(0)));
    doc.getMap<Y.Map<unknown>>('blocks').get(child)!.set('prop:lockedBySelf', true);
    const locked = { ...first.snapshot, docs: { ...first.snapshot.docs, 'board:home': btoa(String.fromCharCode(...Y.encodeStateAsUpdate(doc))) } };
    doc.destroy();
    expect(() => applyNativeOperations(locked, [{ type: 'update_note_text', id: first.createdIds[0], text: 'Bypass' }])).toThrow(/locked/u);
    expect(readNativeBoard(locked).notes[0].text).toBe('Protected');
  });
  it('moves and assigns frame membership atomically in one command', () => {
    const first = build([
      { type: 'create_frame', ref: 'frame', title: 'Destination', x: 300, y: 300, width: 600, height: 400 },
      { type: 'create_note', ref: 'note', text: 'Step', x: 0, y: 0 },
    ]);
    const changed = applyNativeOperations(first.snapshot, [{ type: 'move_element', id: first.refs.note, x: 340, y: 360, frameRef: first.refs.frame }]);
    expect(readNativeBoard(changed.snapshot).notes[0]).toMatchObject({ xywh: '[340,360,208,208]', frameIds: [first.refs.frame] });
    expect(() => applyNativeOperations(first.snapshot, [{ type: 'move_element', id: first.refs.note, x: 340, y: 360, frameRef: 'missing' }])).toThrow(/not found/u);
    expect(readNativeBoard(first.snapshot).notes[0].xywh).toBe('[0,0,208,208]');
  });
  it('preserves the label distance through route and text refinement', () => {
    const first = build([
      { type: 'create_note', ref: 'a', text: 'Start', x: 0, y: 0 },
      { type: 'create_note', ref: 'b', text: 'End', x: 400, y: 0 },
      { type: 'create_connector', ref: 'edge', sourceRef: 'a', targetRef: 'b', label: 'Retry', labelPosition: .65 },
    ]);
    const route = applyNativeOperations(first.snapshot, [{ type: 'update_connector', id: first.refs.edge, style: 'curve' }]);
    const changed = applyNativeOperations(route.snapshot, [{ type: 'update_text', id: first.refs.edge, text: 'Retry later' }]);
    expect(readNativeBoard(changed.snapshot).surfaceElements.find(e => e.id === first.refs.edge)?.labelOffset).toEqual({ distance: .65, anchor: 'center' });
  });
  it('creates and refines relative connector anchors while rejecting invalid ratios', () => {
    const first = build([
      { type: 'create_frame', ref: 'frame', title: 'Flow', x: 0, y: 0, width: 1000, height: 600 },
      { type: 'create_shape', ref: 'shape', text: 'Service', x: 100, y: 60, width: 240, height: 100 },
      { type: 'create_connector', ref: 'edge', sourceRef: 'shape', targetRef: 'frame', sourceAnchor: [1, .25], targetAnchor: [.8, .9], label: 'Bound' },
    ]);
    expect(first.board.connectors[0]).toMatchObject({ source: { position: [1, .25] }, target: { position: [.8, .9] } });
    const changed = applyNativeOperations(first.snapshot, [{ type: 'update_connector', id: first.refs.edge, sourceAnchor: [.5, 1], targetAnchor: [.7, .9] }]);
    expect(readNativeBoard(changed.snapshot).connectors[0]).toMatchObject({ source: { position: [.5, 1] }, target: { position: [.7, .9] } });
    expect(() => applyNativeOperations(first.snapshot, [{ type: 'update_connector', id: first.refs.edge, targetAnchor: [1.1, .5] }])).toThrow();
    expect(readNativeBoard(first.snapshot).connectors[0].target).toEqual({ id: first.refs.frame, position: [.8, .9] });
  });
  it('refits a reused frame without moving unrelated members', () => {
    const first = build([
      { type: 'create_frame', ref: 'frame', title: 'Shared', x: 0, y: 0, width: 800, height: 600 },
      { type: 'create_note', ref: 'selected', frameRef: 'frame', text: 'Arrange', x: 20, y: 40 },
      { type: 'create_note', ref: 'unrelated', frameRef: 'frame', text: 'Keep here', x: 500, y: 80 },
      { type: 'create_shape', ref: 'shape', frameRef: 'frame', text: 'Keep shape', x: 500, y: 340, width: 200, height: 100 },
    ]);
    const outline = { type: 'create_frame' as const, title: 'Shared', x: 1000, y: 700, width: 500, height: 400 };
    const ops = reuseFrameForLayout(first.board, first.refs.frame, outline, [first.refs.selected]);
    const changed = applyNativeOperations(first.snapshot, [...ops, { type: 'move_element', id: first.refs.selected, x: 1040, y: 760 }]);
    const board = readNativeBoard(changed.snapshot);
    expect(board.notes.find(n => n.id === first.refs.unrelated)?.xywh).toBe('[500,80,208,208]');
    expect(board.shapes.find(n => n.id === first.refs.shape)?.xywh).toBe('[500,340,200,100]');
    expect(board.frames[0].xywh).toBe('[500,80,1000,1020]');
    expect(inspectNativeBoard(board).issues).toEqual([]);
    expect(() => reuseFrameForLayout(first.board, first.refs.frame, { ...outline, x: 30_000 }, [first.refs.selected])).toThrow(/Choose a closer layout origin/u);
  });
  it('moves labels with frame endpoints and preserves unrelated connector geometry', () => {
    const first = build([
      { type: 'create_frame', ref: 'frame', title: 'Flow', x: 0, y: 0, width: 1000, height: 400 },
      { type: 'create_note', ref: 'a', frameRef: 'frame', text: 'Start', x: 60, y: 100 },
      { type: 'create_note', ref: 'b', frameRef: 'frame', text: 'End', x: 500, y: 100 },
      { type: 'create_note', ref: 'outside', text: 'Outside', x: 1500, y: 100 },
      { type: 'create_connector', ref: 'internal', sourceRef: 'a', targetRef: 'b', label: 'Retry', labelPosition: .65 },
      { type: 'create_connector', ref: 'external', sourceRef: 'a', targetRef: 'outside', label: 'Hand off', labelPosition: .65 },
      { type: 'create_connector', ref: 'unrelated', sourceRef: 'outside', targetRef: 'outside', label: 'Stay here' },
    ]);
    const labelBounds = (board: typeof first.board, ref: string) => board.surfaceElements.find(e => e.id === first.refs[ref])!.labelXYWH as number[];
    const outlineOnly = applyNativeOperations(first.snapshot, [{ type: 'move_element', id: first.refs.frame, x: 200, y: 300, moveContents: false }]);
    expect(labelBounds(readNativeBoard(outlineOnly.snapshot), 'internal')).toEqual(labelBounds(first.board, 'internal'));
    const moved = applyNativeOperations(first.snapshot, [{ type: 'move_element', id: first.refs.frame, x: 200, y: 300 }]);
    const board = readNativeBoard(moved.snapshot);
    const internalBefore = labelBounds(first.board, 'internal');
    expect(labelBounds(board, 'internal')).toEqual([internalBefore[0] + 200, internalBefore[1] + 300, ...internalBefore.slice(2)]);
    const externalBefore = labelBounds(first.board, 'external');
    expect(labelBounds(board, 'external')[0]).toBeCloseTo(externalBefore[0] + 200 * .35);
    expect(labelBounds(board, 'external')[1]).toBeCloseTo(externalBefore[1] + 300 * .35);
    expect(labelBounds(board, 'unrelated')).toEqual(labelBounds(first.board, 'unrelated'));
    expect(moved.updatedIds).toContain(first.refs.internal);
    expect(board.surfaceElements.find(e => e.id === first.refs.internal)?.labelOffset).toEqual({ distance: .65, anchor: 'center' });
    const resized = applyNativeOperations(moved.snapshot, [{ type: 'resize_element', id: first.refs.a, width: 400, height: 400 }]);
    expect(labelBounds(readNativeBoard(resized.snapshot), 'internal')[0]).toBeCloseTo(labelBounds(board, 'internal')[0] + 96 * .35);
  });
  it('creates an editable typed table and updates one native cell with stable row identity', () => {
    const first = build([
      {
        type: 'create_frame',
        ref: 'criteria',
        title: 'Criteria',
        x: 0,
        y: 0,
        width: 1000,
        height: 500,
      },
      {
        type: 'create_table',
        ref: 'table',
        frameRef: 'criteria',
        title: 'Decision',
        x: 0,
        y: 0,
        columns: [
          { key: 'option', name: 'Option', type: 'text' },
          { key: 'score', name: 'Score', type: 'number' },
          { key: 'selected', name: 'Selected', type: 'checkbox' },
        ],
        rows: [
          { option: 'A', score: 2, selected: false },
          { option: 'B', score: 3, selected: true },
        ],
      },
    ]);
    const table = first.board.tables[0];
    expect(table.containerId).toBe(first.refs.table);
    expect(table.frameIds).toEqual([first.refs.criteria]);
    expect(
      first.board.elements.find((e) => e.id === table.id)?.frameIds,
    ).toEqual([first.refs.criteria]);
    expect(JSON.parse(table.xywh)[2]).toBeGreaterThan(0);
    expect(first.board.elements.find(e => e.id === table.id)).toHaveProperty('containerId', table.containerId);
    expect(table.rows[0].values).toEqual({
      option: 'A',
      score: 2,
      selected: false,
    });
    const next = applyNativeOperations(first.snapshot, [
      {
        type: 'update_table_cell',
        id: first.refs.table,
        rowId: table.rows[0].id,
        columnKey: 'score',
        value: 5,
      },
    ]);
    expect(readNativeBoard(next.snapshot).tables[0].rows[0]).toEqual({
      id: table.rows[0].id,
      values: { option: 'A', score: 5, selected: false },
    });
    const cleared = applyNativeOperations(next.snapshot, [
      {
        type: 'update_table_cell',
        id: table.id,
        rowId: table.rows[0].id,
        columnKey: 'option',
        value: null,
      },
    ]);
    expect(readNativeBoard(cleared.snapshot).tables[0].rows[0].values).toEqual({
      option: '',
      score: 5,
      selected: false,
    });
    const doc = new Y.Doc();
    Y.applyUpdate(
      doc,
      Uint8Array.from(atob(first.snapshot.docs['board:home']), (c) =>
        c.charCodeAt(0),
      ),
    );
    doc
      .getMap<Y.Map<unknown>>('blocks')
      .get(table.rows[0].id)!
      .set('prop:lockedBySelf', true);
    const locked = {
      ...first.snapshot,
      docs: {
        ...first.snapshot.docs,
        'board:home': btoa(String.fromCharCode(...Y.encodeStateAsUpdate(doc))),
      },
    };
    doc.destroy();
    expect(() =>
      applyNativeOperations(locked, [
        {
          type: 'update_table_cell',
          id: table.id,
          rowId: table.rows[0].id,
          columnKey: 'score',
          value: 4,
        },
      ]),
    ).toThrow(/locked/u);
    expect(() =>
      applyNativeOperations(first.snapshot, [
        {
          type: 'update_table_cell',
          id: table.id,
          rowId: table.rows[0].id,
          columnKey: 'score',
          value: 'bad',
        },
      ]),
    ).toThrow(/Invalid number/u);
  });
  it('removes deleted table rows from both native rows and semantic cells', () => {
    const first = build([
      {
        type: 'create_table',
        title: 'Tasks',
        x: 0,
        y: 0,
        columns: [{ key: 'task', name: 'Task', type: 'text' }],
        rows: [{ task: 'Keep' }, { task: 'Remove' }],
      },
    ]);
    const next = applyNativeOperations(first.snapshot, [
      { type: 'delete_element', id: first.board.tables[0].rows[1].id },
    ]);
    expect(
      readNativeBoard(next.snapshot).tables[0].rows.map(
        (row) => row.values.task,
      ),
    ).toEqual(['Keep']);
  });
  it('finds nested document evidence and database cells in the editor', () => {
    expect(
      nativeBlockText({
        id: 'note',
        props: {},
        children: [
          {
            id: 'db',
            props: {
              title: 'Decision',
              cells: { row: { owner: { value: 'Alex' } } },
            },
            children: [
              { id: 'row', props: { text: 'Operational simplicity' } },
            ],
          },
        ],
      }),
    ).toBe('Decision\nAlex\nOperational simplicity');
  });
  it('rejects duplicate references, invalid operations and bad cells atomically', () => {
    const source = fixture();
    const before = JSON.stringify(source);
    expect(() =>
      applyNativeOperations(source, [
        { type: 'create_note', ref: 'duplicate', text: 'First', x: 0, y: 0 },
        { type: 'create_note', ref: 'duplicate', text: 'Second', x: 400, y: 0 },
      ]),
    ).toThrow(/Duplicate/u);
    expect(() =>
      applyNativeOperations(source, [
        { type: 'unsupported', id: 'anything' } as unknown as NativeOperation,
      ]),
    ).toThrow();
    expect(() =>
      applyNativeOperations(source, [
        {
          type: 'create_table',
          title: '',
          x: 0,
          y: 0,
          columns: [
            { key: 'name', name: 'Name', type: 'text' },
            { key: 'number', name: 'Number', type: 'number' },
          ],
          rows: [{ name: 'Invalid cell', number: 'string' }],
        },
      ]),
    ).toThrow(/Invalid number/u);
    expect(JSON.stringify(source)).toBe(before);
  });
  it('uses valid fractional layer keys for large diagrams', () => {
    const first = build(
      Array.from({ length: 60 }, (_, i) => ({
        type: 'create_shape' as const,
        text: `Node ${i}`,
        x: i * 300,
        y: 0,
        width: 200,
        height: 120,
      })),
    );
    for (const element of first.board.surfaceElements)
      expect(() =>
        generateKeyBetween(String(element.index), null),
      ).not.toThrow();
  });
  it('honors locked document ancestors when editing child blocks', () => {
    const first = build([
      {
        type: 'create_document',
        title: 'Locked',
        x: 0,
        y: 0,
        width: 500,
        height: 300,
        blocks: [{ type: 'paragraph', text: 'Protected' }],
      },
    ]);
    const doc = new Y.Doc();
    Y.applyUpdate(
      doc,
      Uint8Array.from(atob(first.snapshot.docs['board:home']), (c) =>
        c.charCodeAt(0),
      ),
    );
    doc
      .getMap<Y.Map<unknown>>('blocks')
      .get(first.createdIds[0])!
      .set('prop:lockedBySelf', true);
    const locked = {
      ...first.snapshot,
      docs: {
        ...first.snapshot.docs,
        'board:home': btoa(String.fromCharCode(...Y.encodeStateAsUpdate(doc))),
      },
    };
    doc.destroy();
    const child = first.board.notes[0].content.find(
      (c) => c.text === 'Protected',
    )!;
    expect(() =>
      applyNativeOperations(locked, [
        { type: 'update_text', id: child.id, text: 'Bypass' },
      ]),
    ).toThrow(/locked/u);
    expect(readNativeBoard(locked).notes[0].text).toContain('Protected');
  });
  it('deletes a frame without deleting its notes and clears membership', () => {
    const first = build([
      {
        type: 'create_frame',
        ref: 'f',
        title: 'Theme',
        x: 0,
        y: 0,
        width: 600,
        height: 400,
      },
      {
        type: 'create_note',
        ref: 'n',
        frameRef: 'f',
        text: 'Keep',
        x: 50,
        y: 70,
      },
    ]);
    const next = applyNativeOperations(first.snapshot, [
      { type: 'delete_element', id: first.refs.f },
    ]);
    expect(readNativeBoard(next.snapshot).notes[0]).toMatchObject({
      id: first.refs.n,
      text: 'Keep',
      frameIds: [],
    });
  });
  it('protects locked source frame membership during detach, transfer, move and deletion', () => {
    const first = build([
      { type: 'create_frame', ref: 'locked', title: 'Protected', x: 0, y: 0, width: 600, height: 400 },
      { type: 'create_frame', ref: 'open', title: 'Destination', x: 800, y: 0, width: 600, height: 400 },
      { type: 'create_note', ref: 'member', text: 'Keep here', x: 40, y: 60, frameRef: 'locked' },
      { type: 'create_note', ref: 'other', text: 'Unrelated', x: 1000, y: 500 },
    ]);
    const doc = new Y.Doc();
    Y.applyUpdate(doc, Uint8Array.from(atob(first.snapshot.docs['board:home']), c => c.charCodeAt(0)));
    doc.getMap<Y.Map<unknown>>('blocks').get(first.refs.locked)!.set('prop:lockedBySelf', true);
    const locked = { ...first.snapshot, docs: { ...first.snapshot.docs, 'board:home': toBase64(Y.encodeStateAsUpdate(doc)) } };
    doc.destroy();
    const baseline = readNativeBoard(locked);
    const attempts: NativeOperation[] = [
      { type: 'set_frame', id: first.refs.member, frameRef: null },
      { type: 'set_frame', id: first.refs.member, frameRef: first.refs.open },
      { type: 'move_element', id: first.refs.member, x: 840, y: 60, frameRef: first.refs.open },
      { type: 'move_element', id: first.refs.member, x: 840, y: 60, frameRef: null },
      { type: 'delete_element', id: first.refs.member },
      { type: 'create_note', text: 'New member', x: 300, y: 60, frameRef: first.refs.locked },
    ];
    for (const operation of attempts) {
      expect(() => applyNativeOperations(locked, [
        { type: 'update_text', id: first.refs.other, text: 'Must roll back' }, operation,
      ])).toThrow(/Frame is locked/u);
      expect(readNativeBoard(locked)).toEqual(baseline);
    }
    const unaffected = applyNativeOperations(locked, [{ type: 'move_element', id: first.refs.other, x: 840, y: 60, frameRef: first.refs.open }]);
    const board = readNativeBoard(unaffected.snapshot);
    expect(board.notes.find(n => n.id === first.refs.other)?.frameIds).toEqual([first.refs.open]);
    expect(board.frames.find(f => f.id === first.refs.locked)?.childIds).toEqual([first.refs.member]);
  });
  it('moves frame members together and repairs invalid legacy layer keys', () => {
    const first = build([
      {
        type: 'create_frame',
        ref: 'f',
        title: 'Move together',
        x: 0,
        y: 0,
        width: 600,
        height: 400,
      },
      {
        type: 'create_note',
        ref: 'n',
        frameRef: 'f',
        text: 'Member',
        x: 50,
        y: 70,
      },
      {
        type: 'create_shape',
        ref: 's',
        frameRef: 'f',
        text: 'Shape',
        width: 240,
        height: 144,
        x: 300,
        y: 70,
      },
    ]);
    const moved = applyNativeOperations(first.snapshot, [
      { type: 'move_element', id: first.refs.f, x: 200, y: 300 },
    ]);
    const board = readNativeBoard(moved.snapshot);
    expect(JSON.parse(board.notes[0].xywh).slice(0, 2)).toEqual([250, 370]);
    expect(JSON.parse(board.shapes[0].xywh).slice(0, 2)).toEqual([500, 370]);
    const doc = new Y.Doc();
    Y.applyUpdate(
      doc,
      Uint8Array.from(atob(moved.snapshot.docs['board:home']), (c) =>
        c.charCodeAt(0),
      ),
    );
    const blocks = doc.getMap<Y.Map<unknown>>('blocks');
    blocks.get(first.refs.f)!.set('prop:index', 'a10');
    blocks.get(first.refs.f)!.set('prop:presentationIndex', 'a10');
    const broken = {
      ...moved.snapshot,
      docs: {
        ...moved.snapshot.docs,
        'board:home': btoa(String.fromCharCode(...Y.encodeStateAsUpdate(doc))),
      },
    };
    doc.destroy();
    const repaired = repairNativeSnapshot(broken);
    expect(repaired.changed).toBe(true);
    expect(repairNativeSnapshot(repaired.snapshot).changed).toBe(false);
    expect(readNativeBoard(repaired.snapshot).notes).toEqual(board.notes);
    const frame = readNativeBoard(repaired.snapshot).blocks.find(
      (block) => block['sys:id'] === first.refs.f,
    )!;
    expect(() =>
      generateKeyBetween(String(frame['prop:presentationIndex']), null),
    ).not.toThrow();
  });
});
describe('composition and layout', () => {
  it('rejects duplicate workshop item references before generating operations', () => {
    expect(() => composeBoard(compositionSchema.parse({ title: 'Retro', groups: ['Keep'], items: [
      { ref: 'idea', title: 'One', group: 'Keep' },
      { ref: 'idea', title: 'Two', group: 'Keep' },
    ] }))).toThrow(/reference must be unique/u);
    expect(() => composeBoard(compositionSchema.parse({ title: 'Retro', groups: ['Keep'], items: [
      { id: 'note:existing', title: 'Original', group: 'Keep' },
      { ref: 'note:existing', title: 'New item', group: 'Keep' },
    ] }))).toThrow(/must not match existing item IDs/u);
  });
  it('rejects origins that leave insufficient room for the complete diagram', () => {
    expect(() => compositionSchema.parse({ title: '', groups: ['Ideas'], items: [] })).toThrow();
    const workflow = { nodes: [{ ref: 'a', label: 'A' }], edges: [] };
    for (const origin of [{ x: 1_000_000 }, { y: 1_000_000 }])
      expect(() => composeWorkflow(workflowSchema.parse({ ...workflow, ...origin }))).toThrow(/coordinate bounds/u);
    expect(() => workflowSchema.parse({ ...workflow, x: -1_000_001 })).toThrow();
    const edge = composeWorkflow(workflowSchema.parse({ ...workflow, x: 999_400, y: 999_600 }));
    expect(() => build(edge.operations)).not.toThrow();
    expect(() => build(composeWorkflow(workflowSchema.parse({ ...workflow, x: -1_000_000, y: -1_000_000 })).operations)).not.toThrow();
    expect(() => composeBoard(compositionSchema.parse({ title: 'Retro', groups: ['Keep'], items: [], x: 1_000_000 }))).toThrow(/coordinate bounds/u);
    expect(() => composeSequence(sequenceSchema.parse({ participants: [{ ref: 'a', name: 'A' }, { ref: 'b', name: 'B' }], messages: [{ from: 'a', to: 'b', label: 'Request' }], y: 1_000_000 }))).toThrow(/coordinate bounds/u);
    expect(() => composeEntities(entitySchema.parse({ entities: [{ ref: 'a', name: 'A', attributes: [] }], relationships: [], x: 1_000_000 }))).toThrow(/coordinate bounds/u);
  });
  it('rejects layouts exceeding native frame dimensions before emitting a batch', () => {
    const nodes = Array.from({ length: 30 }, (_, i) => ({ ref: `n${i}`, label: `Step ${i}` }));
    const edges = nodes.slice(1).map((node, i) => ({ sourceRef: nodes[i].ref, targetRef: node.ref }));
    expect(() => composeWorkflow(workflowSchema.parse({ nodes, edges, columnGap: 800 }))).toThrow(/exceeds 20000/u);
    expect(() => composeWorkflow(workflowSchema.parse({ nodes, edges, direction: 'vertical', rowGap: 1200 }))).toThrow(/exceeds 20000/u);
    expect(() => composeWorkflow(workflowSchema.parse({ nodes, edges }))).not.toThrow();
  });
  it('leaves enough space when relaying out custom sized nodes', () => {
    const result = composeWorkflow(
      workflowSchema.parse({
        nodes: [
          { ref: 'a', label: 'A' },
          { ref: 'b', label: 'B' },
        ],
        edges: [{ sourceRef: 'a', targetRef: 'b' }],
      }),
      { width: 700, height: 420 },
    );
    const notes = result.operations.filter((op) => op.type === 'create_note');
    expect(notes[1].x - notes[0].x).toBeGreaterThanOrEqual(820);
    expect(result.layout.width).toBeGreaterThanOrEqual(notes[1].x + 700 - 100);
  });
  it('automatically lays out branches, merges, cycles and disconnected nodes without collisions', () => {
    const input = workflowSchema.parse({
      nodes: ['start', 'review', 'yes', 'no', 'merge', 'island'].map((ref) => ({
        ref,
        label: ref,
      })),
      edges: [
        { sourceRef: 'start', targetRef: 'review' },
        { sourceRef: 'review', targetRef: 'yes' },
        { sourceRef: 'review', targetRef: 'no' },
        { sourceRef: 'yes', targetRef: 'merge' },
        { sourceRef: 'no', targetRef: 'merge' },
        { sourceRef: 'no', targetRef: 'review' },
      ],
    });
    const result = composeWorkflow(input);
    const first = build(result.operations);
    expect(
      new Set(
        Object.values(result.layout.positions).map(
          (p) => `${p.column}:${p.row}`,
        ),
      ).size,
    ).toBe(6);
    expect(first.board.connectors).toHaveLength(6);
    expect(inspectNativeBoard(first.board).issues).toEqual([]);
    expect(composeWorkflow(input)).toEqual(result);
  });
  it('honors manual positions and rejects collisions and nonexistent endpoints', () => {
    const base = {
      nodes: [
        { ref: 'a', label: 'A', column: 1, row: 2 },
        { ref: 'b', label: 'B', column: 3, row: 0 },
      ],
      edges: [{ sourceRef: 'a', targetRef: 'b' }],
    };
    expect(
      composeWorkflow(workflowSchema.parse(base)).layout.positions,
    ).toEqual({ a: { column: 1, row: 2 }, b: { column: 3, row: 0 } });
    expect(() =>
      composeWorkflow(
        workflowSchema.parse({
          ...base,
          nodes: base.nodes.map((n) => ({ ...n, column: 0, row: 0 })),
        }),
      ),
    ).toThrow(/same manual/u);
    expect(() =>
      composeWorkflow(
        workflowSchema.parse({
          ...base,
          edges: [{ sourceRef: 'a', targetRef: 'missing' }],
        }),
      ),
    ).toThrow(/endpoints/u);
  });
  it('renders lane labels and formal decision nodes without overlaps or reserved ref collisions', () => {
    const result = composeWorkflow(
      workflowSchema.parse({
        notation: 'flowchart',
        nodes: [
          {
            ref: '__workflow',
            label: 'Request',
            lane: 'Customer',
            kind: 'start',
          },
          {
            ref: 'review',
            label: 'Eligible?',
            lane: 'Support',
            kind: 'decision',
          },
          { ref: 'pay', label: 'Refund', lane: 'Finance', kind: 'end' },
        ],
        edges: [
          { sourceRef: '__workflow', targetRef: 'review' },
          { sourceRef: 'review', targetRef: 'pay', label: 'Yes' },
        ],
      }),
    );
    const first = build(result.operations);
    expect(first.board.shapes.find((s) => s.text === 'Eligible?')?.shape).toBe(
      'diamond',
    );
    expect(first.board.texts).toHaveLength(3);
    expect(inspectNativeBoard(first.board).issues).toEqual([]);
  });
  it('composes a 12-card sprint board with readable owner and estimate content', () => {
    const first = build(
      composeBoard(
        compositionSchema.parse({
          title: 'Sprint planning',
          groups: ['Sprint 1', 'Sprint 2'],
          itemStyle: 'card',
          items: Array.from({ length: 12 }, (_, i) => ({
            title: `Task ${i + 1}`,
            group: i < 6 ? 'Sprint 1' : 'Sprint 2',
            owner: 'Sam',
            estimate: 3,
          })),
        }),
      ),
    );
    expect(first.board.notes).toHaveLength(12);
    expect(
      first.board.notes.every((n) =>
        n.text.includes('Owner: Sam  ·  Estimate: 3'),
      ),
    ).toBe(true);
    expect(inspectNativeBoard(first.board).issues).toEqual([]);
  });
  it('composes native story maps, prioritization matrices and themed brainstorms', () => {
    for (const layout of [
      'story_map',
      'matrix',
      'columns',
      'comparison',
    ] as const) {
      const first = build(
        composeBoard(
          compositionSchema.parse({
            title: layout,
            layout,
            groups: ['A', 'B'],
            rows: ['Release 1', 'Release 2'],
            items: [{ title: 'Story', group: 'B', row: 'Release 2' }],
          }),
        ),
      );
      expect(first.board.notes[0].text).toBe('Story');
      expect(first.board.notes[0].frameIds).toHaveLength(1);
      expect(inspectNativeBoard(first.board).issues).toEqual([]);
    }
  });
  it('creates entity attributes and chronological sequence messages as native objects', () => {
    const entity = build(
      composeEntities(
        entitySchema.parse({
          entities: [
            { ref: 'users', name: 'Users', attributes: ['id PK', 'email'] },
            {
              ref: 'orders',
              name: 'Orders',
              attributes: ['id PK', 'user_id FK'],
            },
          ],
          relationships: [
            { sourceRef: 'users', targetRef: 'orders', label: '1 to many' },
          ],
        }),
      ),
    );
    expect(entity.board.shapes[0].text).toContain('id PK');
    expect(entity.board.connectors[0].label).toBe('1 to many');
    expect(inspectNativeBoard(entity.board).issues).toEqual([]);
    const seq = build(
      composeSequence(
        sequenceSchema.parse({
          participants: [
            { ref: 'client', name: 'Client' },
            { ref: 'api', name: 'API' },
          ],
          messages: [
            { from: 'client', to: 'api', label: 'Request' },
            { from: 'api', to: 'api', label: 'Validate' },
            { from: 'api', to: 'client', label: 'Response', response: true },
          ],
        }),
      ),
    );
    expect(
      seq.board.connectors.filter((c) => c.label).map((c) => c.label),
    ).toEqual(['1. Request', '2. Validate', '3. Response']);
    const self = seq.board.connectors.find((c) => c.label === '2. Validate')!;
    expect((self.source as { id: string }).id).not.toBe(
      (self.target as { id: string }).id,
    );
    expect(seq.board.frames).toHaveLength(1);
    expect(inspectNativeBoard(seq.board).issues).toEqual([]);
  });
  it.each([
    ['client', 'api', 'observer'],
    ['client', 'client:api', 'client:observer'],
  ])('keeps complete lifelines distinct with participant refs %s, %s and %s', (a, b, c) => {
    const sequence = build(composeSequence(sequenceSchema.parse({
      participants: [a, b, c].map(ref => ({ ref, name: ref })),
      messages: [{ from: a, to: b, label: 'Request' }],
    })));
    const shapes = new Map([...sequence.board.shapes, ...sequence.board.frames].map(shape => [shape.id, JSON.parse(shape.xywh) as number[]]));
    const endpoint = (end: unknown) => {
      const attached = end as { id: string; position?: number[] };
      const [x, y, width, height] = shapes.get(attached.id)!;
      const [rx, ry] = attached.position ?? [.5, .5];
      return [x + width * rx, y + height * ry];
    };
    for (const ref of [a, b, c]) {
      const header = sequence.refs[ref];
      const lifeline = sequence.board.connectors.find(connector => !connector.label && (connector.source as { id: string }).id === header)!;
      expect(lifeline).toBeDefined();
      const start = endpoint(lifeline.source);
      const target = endpoint(lifeline.target);
      expect(start[0]).toBeCloseTo(target[0]);
    }
    for (const line of sequence.board.connectors.filter(connector => !connector.label)) {
      const start = endpoint(line.source);
      const target = endpoint(line.target);
      expect(start[0]).toBeCloseTo(target[0]);
      expect(target[1]).toBeGreaterThan(start[1]);
    }
    expect(inspectNativeBoard(sequence.board).issues).toEqual([]);
  });
  it('reorganizes sixty existing notes with stable IDs within one batch', () => {
    const first = build(Array.from({ length: 60 }, (_, i) => ({ type: 'create_note', text: `Idea ${i}`, x: i * 300, y: 0 })));
    const operations = composeBoard(compositionSchema.parse({
      title: 'Sorted ideas', groups: ['Theme'], items: first.board.notes.map(note => ({ id: note.id, title: note.text, group: 'Theme' })),
    }));
    expect(operations.length).toBe(62);
    const changed = applyNativeOperations(first.snapshot, operations);
    const board = readNativeBoard(changed.snapshot);
    expect(board.notes.map(note => note.id)).toEqual(first.board.notes.map(note => note.id));
    expect(board.notes.every(note => note.frameIds.length === 1)).toBe(true);
    expect(inspectNativeBoard(board).issues).toEqual([]);
  });
  it('highlights reused shapes, text, images, notes and cards without changing their styling', () => {
    const first = build([
      { type: 'create_note', ref: 'note', text: 'Idea', color: 'purple', x: 0, y: 0 },
      { type: 'create_shape', ref: 'shape', text: 'Alternative', shape: 'diamond', fill: '#abcdef', stroke: '#123456', x: 400, y: 0, width: 240, height: 160 },
      { type: 'create_text', ref: 'text', text: 'Evidence', x: 800, y: 0, width: 240, height: 80 },
      { type: 'create_image', ref: 'image', sourceId: 'a'.repeat(43), caption: 'Screenshot', x: 1200, y: 0, width: 160, height: 160 },
      { type: 'create_card', ref: 'card', title: 'Task', priority: 'High', x: 1600, y: 0, width: 360, height: 240 },
    ]);
    const input = compositionSchema.parse({
      title: 'Selected alternatives', groups: ['Review'], itemStyle: 'card',
      items: Object.entries(first.refs).map(([title, id]) => ({ id, title, group: 'Review', highlight: true })),
    });
    const changed = applyNativeOperations(first.snapshot, composeBoard(input));
    const board = readNativeBoard(changed.snapshot);
    expect(board.notes.map(note => note.id)).toEqual(first.board.notes.map(note => note.id));
    expect(board.notes[0].color).toEqual(first.board.notes[0].color);
    expect(board.notes[1].text).toEqual(first.board.notes[1].text);
    expect(board.shapes[0]).toMatchObject({ id: first.refs.shape, color: '#abcdef' });
    expect(board.surfaceElements.find(element => element.id === first.refs.shape)?.strokeColor).toBe('#123456');
    expect(board.images[0]).toMatchObject({ id: first.refs.image, sourceId: 'a'.repeat(43) });
    expect(board.texts.find(text => text.id === first.refs.text)?.text).toBe('Evidence');
    const markers = board.texts.filter(text => text.text === 'Selected');
    expect(markers).toHaveLength(5);
    expect(markers.every(text => text.frameIds.length === 1)).toBe(true);
    expect(inspectNativeBoard(board).issues).toEqual([]);
    expect(() => composeBoard(compositionSchema.parse({
      title: 'Oversized highlights', groups: ['Review'],
      items: Array.from({ length: 60 }, (_, i) => ({ id: `existing:${i}`, title: `Item ${i}`, group: 'Review', highlight: true })),
    }))).toThrow(/exceeds 100 operations/u);
  });
  it('supports twenty-five messages across ten participants within one batch', () => {
    const participants = Array.from({ length: 10 }, (_, i) => ({ ref: `p${i}`, name: `Service ${i}` }));
    const messages = Array.from({ length: 25 }, (_, i) => ({ from: participants[i % 10].ref, to: participants[(i + 1) % 10].ref, label: `Message ${i}` }));
    const operations = composeSequence(sequenceSchema.parse({ participants, messages }));
    expect(operations.length).toBe(96);
    const sequence = build(operations);
    expect(sequence.board.connectors.filter(c => c.label)).toHaveLength(25);
    expect(sequence.board.connectors.filter(c => !c.label)).toHaveLength(10);
    expect(inspectNativeBoard(sequence.board).issues).toEqual([]);
  });
  it('reports overlaps and frame overflow instead of falsely promising visual quality', () => {
    const first = build([
      {
        type: 'create_frame',
        ref: 'f',
        title: 'Small',
        x: 0,
        y: 0,
        width: 100,
        height: 100,
      },
      { type: 'create_note', text: 'One', frameRef: 'f', x: 50, y: 50 },
      { type: 'create_note', text: 'Two', x: 60, y: 60 },
    ]);
    expect(inspectNativeBoard(first.board).issues.map((i) => i.kind)).toEqual(
      expect.arrayContaining(['overlap', 'outside_frame']),
    );
  });
});
