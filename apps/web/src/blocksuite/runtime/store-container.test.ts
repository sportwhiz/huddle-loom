import { Store, Text } from '@blocksuite/affine/store';
import { describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { createLocalBoard } from '../create-board';
import { getStoreExtensions } from '../store-extensions';
import { captureNativeSnapshot, restoreNativeSnapshot } from './snapshot';

function matchesNative(store: Store) {
  const nativeRoot = Object.getOwnPropertyDescriptor(Store.prototype, 'root')!.get!.call(store);
  expect(store.root?.id).toBe(nativeRoot?.id);
  for (const flavour of ['affine:note', 'affine:paragraph', 'affine:surface', ['affine:paragraph', 'affine:note']]) {
    expect(store.getBlocksByFlavour(flavour).map(block => block.id))
      .toEqual(Store.prototype.getBlocksByFlavour.call(store, flavour).map(block => block.id));
  }
  for (const model of store.getAllModels()) {
    expect(store.getParent(model)?.id).toBe(Store.prototype.getParent.call(store, model)?.id);
  }
}

describe('indexed native store', () => {
  it('matches native reads after initialization and snapshot restoration', () => {
    const { workspace, store } = createLocalBoard();
    matchesNative(store);
    const restored = restoreNativeSnapshot(captureNativeSnapshot(workspace), getStoreExtensions());
    const copy = restored.getDoc('board:home')!.getStore({ id: 'copy' });
    copy.load();
    matchesNative(copy);
    restored.dispose();
    workspace.dispose();
  });

  it('updates membership and parents through local changes, undo and redo', () => {
    const { workspace, store } = createLocalBoard();
    const page = store.root!;
    const notes = store.getModelsByFlavour('affine:note');
    const paragraph = notes[0].children[0];
    store.captureSync();
    store.moveBlocks([paragraph], notes[1]);
    expect(store.getParent(paragraph)?.id).toBe(notes[1].id);
    matchesNative(store);
    store.captureSync();
    store.undo();
    expect(store.getParent(paragraph)?.id).toBe(notes[0].id);
    matchesNative(store);
    store.redo();
    matchesNative(store);
    store.captureSync();
    const note = store.addBlock('affine:note', { xywh: '[100,100,200,200]' }, page.id);
    store.addBlock('affine:paragraph', { text: new Text('New idea') }, note);
    matchesNative(store);
    store.deleteBlock(store.getModelById(note)!);
    matchesNative(store);
    expect(store.getModelsByFlavour('affine:note').map(model => model.id)).not.toContain(note);
    workspace.dispose();
  });

  it('updates indexes for remote Yjs additions and deletions', () => {
    const { workspace, store } = createLocalBoard();
    const remote = restoreNativeSnapshot(captureNativeSnapshot(workspace), getStoreExtensions());
    const other = remote.getDoc('board:home')!.getStore({ id: 'remote' });
    other.load();
    matchesNative(store); // Populate the caches before the remote change.
    const vector = Y.encodeStateVector(store.spaceDoc);
    const note = other.addBlock('affine:note', { xywh: '[20,20,200,200]' }, other.root!.id);
    other.addBlock('affine:paragraph', { text: new Text('From another person') }, note);
    Y.applyUpdate(store.spaceDoc, Y.encodeStateAsUpdate(other.spaceDoc, vector), 'native-remote');
    matchesNative(store);
    expect(store.getModelsByFlavour('affine:note').map(model => model.id)).toContain(note);
    const nextVector = Y.encodeStateVector(store.spaceDoc);
    other.deleteBlock(other.getModelById(note)!);
    Y.applyUpdate(store.spaceDoc, Y.encodeStateAsUpdate(other.spaceDoc, nextVector), 'native-remote');
    matchesNative(store);
    expect(store.getModelsByFlavour('affine:note').map(model => model.id)).not.toContain(note);
    remote.dispose();
    workspace.dispose();
  });

  it('sees intermediate parent changes inside a larger Yjs transaction', () => {
    const { workspace, store } = createLocalBoard();
    const notes = store.getModelsByFlavour('affine:note');
    const paragraph = notes[0].children[0];
    expect(store.getParent(paragraph)?.id).toBe(notes[0].id);
    store.spaceDoc.transact(() => {
      store.moveBlocks([paragraph], notes[1]);
      expect(store.getParent(paragraph)?.id).toBe(notes[1].id);
      store.moveBlocks([paragraph], notes[0]);
      expect(store.getParent(paragraph)?.id).toBe(notes[0].id);
    });
    matchesNative(store);
    workspace.dispose();
  });

  it('preserves the native model order after undoing a deletion', () => {
    const { workspace, store } = createLocalBoard();
    const note = store.getModelsByFlavour('affine:note')[0];
    store.captureSync();
    store.deleteBlock(note, { deleteChildren: true });
    matchesNative(store);
    store.captureSync();
    store.undo();
    matchesNative(store);
    store.redo();
    matchesNative(store);
    workspace.dispose();
  });

  it('reuses structural indexes while text changes and repeated reads occur', () => {
    const { workspace, store } = createLocalBoard();
    const paragraph = store.getModelsByFlavour('affine:paragraph')[0];
    const parent = store.getParent(paragraph);
    const root = store.root;
    const scan = vi.spyOn(store.spaceDoc.getMap('blocks'), 'forEach');
    paragraph.text!.insert('More text', 0);
    for (let i = 0; i < 100; i++) {
      expect(store.root).toBe(root);
      expect(store.getParent(paragraph)).toBe(parent);
      expect(store.getBlocksByFlavour('affine:surface')).toHaveLength(1);
    }
    expect(scan).not.toHaveBeenCalled();
    scan.mockRestore();
    workspace.dispose();
  });

  it('releases a document without clearing its content', () => {
    const { workspace, store } = createLocalBoard();
    const before = Y.encodeStateAsUpdate(store.spaceDoc);
    workspace.getBlockCollection('board:home')!.dispose();
    expect(Y.encodeStateAsUpdate(store.spaceDoc)).toEqual(before);
    workspace.dispose();
  });
});
