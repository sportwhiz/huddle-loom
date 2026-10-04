import * as Y from 'yjs';

import { NativeWorkspace } from './runtime/workspace';

const NOTE_COLORS = [
  { light: '#fde68a', dark: '#704200' },
  { light: '#ffc58f', dark: '#843b06' },
  { light: '#c9f8c1', dark: '#3b5315' },
  { light: '#ceecff', dark: '#004b7b' },
  { light: '#ddd6fe', dark: '#312e81' },
];

export type HeadlessBoard = {
  workspace: NativeWorkspace;
  boardId: string;
  noteIds: string[];
  connectorIds: string[];
  frameIds: string[];
  shapeIds: string[];
};

const NATIVE_UNIQ_IDENTIFIER = '$blocksuite:internal:native$';

type BlockSpec = {
  id: string;
  flavour: string;
  version: number;
  props?: Record<string, unknown>;
  parentId?: string;
};

function nativeToY(value: unknown): unknown {
  if (value instanceof Y.AbstractType) return value;
  if (Array.isArray(value)) {
    const array = new Y.Array<unknown>();
    array.insert(0, value.map(nativeToY));
    return array;
  }
  if (value && typeof value === 'object') {
    const map = new Y.Map<unknown>();
    for (const [key, nested] of Object.entries(value)) {
      if (nested !== undefined) map.set(key, nativeToY(nested));
    }
    return map;
  }
  return value;
}

function createText(value: string) {
  const text = new Y.Text();
  text.insert(0, value);
  return text;
}

function createBlockWriter(blocks: Y.Map<Y.Map<unknown>>) {
  return ({ id, flavour, version, props = {}, parentId }: BlockSpec) => {
    const block = new Y.Map<unknown>();
    block.set('sys:id', id);
    block.set('sys:flavour', flavour);
    block.set('sys:version', version);
    block.set('sys:children', new Y.Array<string>());
    for (const [key, value] of Object.entries(props)) {
      if (value !== undefined) block.set(`prop:${key}`, nativeToY(value));
    }
    blocks.set(id, block);

    if (parentId) {
      const parent = blocks.get(parentId);
      if (!parent) throw new Error(`Missing parent block: ${parentId}`);
      (parent.get('sys:children') as Y.Array<string>).push([id]);
    }
    return id;
  };
}

function createSurfaceElements() {
  const elements = new Y.Map<Y.Map<unknown>>();
  const boxed = new Y.Map<unknown>();
  boxed.set('type', NATIVE_UNIQ_IDENTIFIER);
  boxed.set('value', elements);
  return { boxed, elements };
}

function addSurfaceElement(
  elements: Y.Map<Y.Map<unknown>>,
  id: string,
  type: 'connector' | 'shape',
  props: Record<string, unknown>
) {
  const element = new Y.Map<unknown>();
  element.set('type', type);
  element.set('id', id);
  element.set('index', `a${elements.size}`);
  element.set('seed', elements.size + 1);
  for (const [key, value] of Object.entries(props)) {
    if (value !== undefined) element.set(key, value);
  }
  elements.set(id, element);
}

export function createHeadlessBoard(
  noteTexts: string[],
  workspaceId = 'headless-fixture',
  {
    includeFrames = true,
    includeShape = includeFrames,
  }: { includeFrames?: boolean; includeShape?: boolean } = {}
): HeadlessBoard {
  const workspace = new NativeWorkspace({ id: workspaceId });
  workspace.meta.initialize();

  const boardId = 'board:home';
  workspace.createDoc(boardId);
  const doc = workspace.getBlockCollection(boardId);
  if (!doc) throw new Error('Native board document was not created');
  const blocks = doc.yBlocks as Y.Map<Y.Map<unknown>>;
  const addBlock = createBlockWriter(blocks);
  const { boxed: boxedElements, elements } = createSurfaceElements();

  const pageId = addBlock({
    id: 'page:root',
    flavour: 'affine:page',
    version: 2,
    props: { title: createText('Headless brainstorming fixture') },
  });
  const surfaceId = addBlock({
    id: 'surface:root',
    flavour: 'affine:surface',
    version: 5,
    props: { elements: boxedElements },
    parentId: pageId,
  });
  const noteIds: string[] = [];

  noteTexts.forEach((text, index) => {
    const column = index % 5;
    const row = Math.floor(index / 5);
    const noteId = addBlock({
      id: `note:${index + 1}`,
      flavour: 'affine:note',
      version: 1,
      props: {
        xywh: `[${120 + column * 300},${140 + row * 220},260,170]`,
        index: `a${index + 1}`,
        background: NOTE_COLORS[index % NOTE_COLORS.length],
        lockedBySelf: false,
        hidden: false,
        displayMode: 'edgeless',
        edgeless: {
          style: {
            borderRadius: 8,
            borderSize: 4,
            borderStyle: 'none',
            shadowType: '--affine-note-shadow-box',
          },
        },
      },
      parentId: pageId,
    });
    addBlock({
      id: `paragraph:${index + 1}`,
      flavour: 'affine:paragraph',
      version: 1,
      props: { type: 'text', text: createText(text), collapsed: false },
      parentId: noteId,
    });
    noteIds.push(noteId);
  });

  const frameIds: string[] = [];
  if (includeFrames) {
    const halfway = Math.ceil(noteIds.length / 2);
    frameIds.push('frame:discover', 'frame:decide');
    addBlock({
      id: frameIds[0],
      flavour: 'affine:frame',
      version: 1,
      props: {
        title: createText('Discover'),
        background: 'transparent',
        xywh: '[60,60,1540,1140]',
        index: 'a100',
        childElementIds: Object.fromEntries(
          noteIds.slice(0, halfway).map(id => [id, true])
        ),
        presentationIndex: 'a0',
        lockedBySelf: false,
      },
      parentId: surfaceId,
    });
    addBlock({
      id: frameIds[1],
      flavour: 'affine:frame',
      version: 1,
      props: {
        title: createText('Decide'),
        background: 'transparent',
        xywh: `[60,1260,1540,${Math.max(
          480,
          Math.ceil(noteIds.length / 10) * 440
        )}]`,
        index: 'a101',
        childElementIds: Object.fromEntries(
          noteIds.slice(halfway).map(id => [id, true])
        ),
        presentationIndex: 'a1',
        lockedBySelf: false,
      },
      parentId: surfaceId,
    });
  }

  const connectorIds: string[] = [];
  for (let index = 0; index < Math.min(noteIds.length - 1, 8); index += 1) {
    const id = `connector:${index + 1}`;
    addSurfaceElement(elements, id, 'connector', {
      source: { id: noteIds[index] },
      target: { id: noteIds[index + 1] },
      mode: 2,
      strokeStyle: 'solid',
      strokeWidth: 4,
      frontEndpointStyle: 'None',
      rearEndpointStyle: 'Arrow',
    });
    connectorIds.push(id);
  }

  const shapeIds: string[] = [];
  if (includeShape) {
    shapeIds.push('shape:parking-lot');
    addSurfaceElement(elements, shapeIds[0], 'shape', {
      xywh: '[1740,180,320,180]',
      shapeType: 'rect',
      shapeStyle: 'General',
      radius: 0,
      rotate: 0,
      roughness: 1.4,
      filled: true,
      fillColor: '#fcd34d',
      strokeColor: '#a16207',
      strokeStyle: 'solid',
      strokeWidth: 4,
      color: '#111827',
      fontFamily: 'blocksuite:surface:Inter',
      fontSize: 20,
      fontStyle: 'normal',
      fontWeight: '400',
      maxWidth: false,
      padding: [10, 20],
      shadow: null,
      textAlign: 'center',
      textHorizontalAlign: 'center',
      textResizing: 1,
      textVerticalAlign: 'center',
    });
  }

  return { workspace, boardId, noteIds, connectorIds, frameIds, shapeIds };
}

export function createFiftyNoteFixture() {
  return createHeadlessBoard(
    Array.from({ length: 50 }, (_, index) => `Idea ${index + 1}`)
  );
}

export function summarizeBoard(board: HeadlessBoard) {
  return {
    notes: board.noteIds.length,
    frames: board.frameIds.length,
    connectors: board.connectorIds.length,
    shapes: board.shapeIds.length,
  };
}
