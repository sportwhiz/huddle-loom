import { Text } from '@blocksuite/affine/store';

import { getStoreExtensions } from './store-extensions';
import { NativeWorkspace } from './runtime/workspace';

export type LocalBoard = ReturnType<typeof createLocalBoard>;

export function createLocalBoard() {
  const workspace = new NativeWorkspace({ id: 'm0-browser-proof' });
  workspace.storeExtensions = getStoreExtensions();
  workspace.start();
  workspace.meta.initialize();

  const doc = workspace.createDoc('board:home');
  const store = doc.getStore({ id: 'board:home' });
  store.load();

  const pageId = store.addBlock('affine:page', {
    title: new Text('Brainstorming proof'),
  });
  store.addBlock('affine:surface', {}, pageId);

  const notes = [
    { text: 'Capture the problem', xywh: '[120, 120, 260, 180]' },
    { text: 'Collect possible paths', xywh: '[440, 120, 260, 180]' },
    { text: 'Test the strongest idea', xywh: '[760, 120, 260, 180]' },
  ];

  for (const note of notes) {
    const noteId = store.addBlock(
      'affine:note',
      { xywh: note.xywh, background: '--affine-palette-note-yellow' },
      pageId,
    );
    store.addBlock(
      'affine:paragraph',
      { text: new Text(note.text) },
      noteId,
    );
  }

  store.resetHistory();

  return { workspace, store };
}
