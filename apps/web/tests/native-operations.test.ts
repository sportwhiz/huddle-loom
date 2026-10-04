import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';

import { createHeadlessBoard } from '../src/blocksuite/headless-board';
import { applyNativeUpdates, captureNativeSnapshot } from '../src/blocksuite/runtime/snapshot';
import {
  applyNativeOperations,
  collectNativeAssetIds,
  readNativeBoard,
  repairNativeSnapshot,
} from '../src/native-operations.server';

function decode(value: string) {
  return Uint8Array.from(atob(value), character => character.charCodeAt(0));
}

function encode(value: Uint8Array) {
  return btoa(String.fromCharCode(...value));
}

function fixture() {
  const board = createHeadlessBoard(['Existing idea'], 'unit-test', {
    includeFrames: false,
  });
  const snapshot = captureNativeSnapshot(board.workspace);
  board.workspace.dispose();
  return snapshot;
}

describe('native semantic operations', () => {
  it('converges concurrent Yjs update batches in either arrival order', () => {
    const source = fixture();
    const first = applyNativeOperations(source, [
      { type: 'create_note', text: 'Concurrent A', color: 'blue', x: 100, y: 100 },
    ]).snapshot;
    const second = applyNativeOperations(source, [
      { type: 'create_note', text: 'Concurrent B', color: 'green', x: 500, y: 100 },
    ]).snapshot;
    const makeDelta = (result: typeof source) => {
      const base = new Y.Doc();
      const changed = new Y.Doc();
      Y.applyUpdate(base, decode(source.docs['board:home']));
      Y.applyUpdate(changed, decode(result.docs['board:home']));
      return encode(Y.encodeStateAsUpdate(changed, Y.encodeStateVector(base)));
    };
    const updateA = { docId: 'board:home', update: makeDelta(first) };
    const updateB = { docId: 'board:home', update: makeDelta(second) };
    const ab = applyNativeUpdates(applyNativeUpdates(source, [updateA]), [updateB]);
    const ba = applyNativeUpdates(applyNativeUpdates(source, [updateB]), [updateA]);
    const texts = (snapshot: typeof source) => readNativeBoard(snapshot).notes.map(note => note.text).sort();

    expect(texts(ab)).toEqual(['Concurrent A', 'Concurrent B', 'Existing idea']);
    expect(texts(ba)).toEqual(texts(ab));
  });

  it('creates native notes, a frame, and an attached connector in one batch', () => {
    const result = applyNativeOperations(fixture(), [
      {
        type: 'create_frame',
        ref: 'flow',
        title: 'Flow',
        x: 100,
        y: 100,
        width: 900,
        height: 420,
      },
      {
        type: 'create_note',
        ref: 'first',
        frameRef: 'flow',
        text: 'First step',
        color: 'yellow',
        x: 160,
        y: 200,
      },
      {
        type: 'create_note',
        ref: 'second',
        frameRef: 'flow',
        text: 'Second step',
        color: 'green',
        x: 480,
        y: 200,
      },
      {
        type: 'create_connector',
        sourceRef: 'first',
        targetRef: 'second',
        label: 'Then',
      },
    ]);

    const board = readNativeBoard(result.snapshot);
    expect(board.notes.map(note => note.text).sort()).toEqual([
      'Existing idea',
      'First step',
      'Second step',
    ].sort());
    expect(board.frames).toHaveLength(1);
    expect(board.connectors).toHaveLength(1);
    expect(board.connectors[0]).toMatchObject({ label: 'Then' });
    expect(result.refs).toMatchObject({
      flow: expect.stringMatching(/^frame:/u),
      first: expect.stringMatching(/^note:/u),
      second: expect.stringMatching(/^note:/u),
    });
  });

  it('rejects a connector with a missing endpoint without changing the source', () => {
    const source = fixture();
    const before = readNativeBoard(source);
    expect(() =>
      applyNativeOperations(source, [
        {
          type: 'create_connector',
          sourceRef: 'missing',
          targetRef: before.notes[0].id,
        },
      ])
    ).toThrow(/endpoints/u);
    expect(readNativeBoard(source)).toEqual(before);
  });

  it('updates note text and position while preserving its identity', () => {
    const source = fixture();
    const note = readNativeBoard(source).notes[0];
    const result = applyNativeOperations(source, [
      { type: 'update_note_text', id: note.id, text: 'Rewritten idea' },
      { type: 'move_element', id: note.id, x: 900, y: 700 },
    ]);
    expect(readNativeBoard(result.snapshot).notes[0]).toMatchObject({
      id: note.id,
      text: 'Rewritten idea',
      xywh: '[900,700,260,170]',
    });
  });

  it('repairs shape fields omitted by snapshots from early builds', () => {
    const board = createHeadlessBoard(['Idea'], 'legacy-shape', {
      includeFrames: false,
      includeShape: true,
    });
    const source = captureNativeSnapshot(board.workspace);
    board.workspace.dispose();
    const doc = new Y.Doc();
    Y.applyUpdate(doc, decode(source.docs['board:home']));
    const blocks = doc.getMap<Y.Map<unknown>>('blocks');
    const surface = [...blocks.values()].find(
      block => block.get('sys:flavour') === 'affine:surface'
    )!;
    const elements = (surface.get('prop:elements') as Y.Map<unknown>).get(
      'value'
    ) as Y.Map<Y.Map<unknown>>;
    const shape = elements.get('shape:parking-lot')!;
    shape.delete('shapeStyle');
    shape.delete('strokeColor');
    shape.delete('shadow');
    source.docs['board:home'] = encode(Y.encodeStateAsUpdate(doc));

    const repaired = repairNativeSnapshot(source);
    expect(repaired.changed).toBe(true);
    const repairedDoc = new Y.Doc();
    Y.applyUpdate(repairedDoc, decode(repaired.snapshot.docs['board:home']));
    const repairedSurface = [
      ...repairedDoc.getMap<Y.Map<unknown>>('blocks').values(),
    ].find(block => block.get('sys:flavour') === 'affine:surface')!;
    const repairedShape = (
      (repairedSurface.get('prop:elements') as Y.Map<unknown>).get(
        'value'
      ) as Y.Map<Y.Map<unknown>>
    ).get('shape:parking-lot')!;
    expect(repairedShape.get('shapeStyle')).toBe('General');
    expect(repairedShape.get('strokeColor')).toBe('#a16207');
    expect(repairedShape.has('shadow')).toBe(true);
    expect(repairNativeSnapshot(repaired.snapshot).changed).toBe(false);
  });

  it('finds content-addressed asset references in lazily materialized Yjs blocks', () => {
    const source = fixture();
    const doc = new Y.Doc();
    Y.applyUpdate(doc, decode(source.docs['board:home']));
    const note = [...doc.getMap<Y.Map<unknown>>('blocks').values()].find(
      block => block.get('sys:flavour') === 'affine:note'
    )!;
    const key = 'X-gEV7k8C5DjCYKZubkFd6DJ95pjyldIBulmOmBtcY4=';
    note.set('sys:flavour', 'affine:image');
    note.set('prop:sourceId', key);
    source.docs['board:home'] = encode(Y.encodeStateAsUpdate(doc));

    expect(collectNativeAssetIds(source)).toEqual([key]);
    doc.destroy();
  });

  it('does not interpret hash-shaped text or arbitrary properties as asset references', () => {
    const source = fixture();
    const doc = new Y.Doc();
    Y.applyUpdate(doc, decode(source.docs['board:home']));
    const blocks = doc.getMap<Y.Map<unknown>>('blocks');
    const key = 'a'.repeat(43);
    for (const block of blocks.values()) {
      block.set('prop:text', new Y.Text(key));
      block.set('prop:caption', key);
      block.set('prop:sourceId', key);
    }
    source.docs['board:home'] = encode(Y.encodeStateAsUpdate(doc));
    expect(collectNativeAssetIds(source)).toEqual([]);
    doc.destroy();
  });
});
