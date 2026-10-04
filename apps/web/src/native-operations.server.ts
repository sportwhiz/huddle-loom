import * as Y from 'yjs';
import { avatarInk } from './avatar-color';
import { generateKeyBetween } from 'fractional-indexing';

import type { NativeBoardSnapshot } from './blocksuite/runtime/snapshot';

import {
  nativeBatchSchema,
  type NativeOperation,
} from './native-operation-schema';
export type { NativeOperation } from './native-operation-schema';
type ConnectorAnchor = 'top' | 'right' | 'bottom' | 'left';

const NOTE_COLORS = {
  yellow: { light: '#fde68a', dark: '#704200' },
  orange: { light: '#ffc58f', dark: '#843b06' },
  green: { light: '#c9f8c1', dark: '#3b5315' },
  blue: { light: '#ceecff', dark: '#004b7b' },
  purple: { light: '#ddd6fe', dark: '#312e81' },
};

function decode(value: string) {
  const binary = atob(value);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function encode(value: Uint8Array) {
  let binary = '';
  for (let offset = 0; offset < value.length; offset += 0x8000) {
    binary += String.fromCharCode(...value.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

function nativeToY(value: unknown): unknown {
  if (value instanceof Y.AbstractType) return value;
  if (Array.isArray(value)) {
    const result = new Y.Array<unknown>();
    result.insert(0, value.map(nativeToY));
    return result;
  }
  if (value && typeof value === 'object') {
    const result = new Y.Map<unknown>();
    for (const [key, item] of Object.entries(value))
      result.set(key, nativeToY(item));
    return result;
  }
  return value;
}

function text(value: string) {
  const result = new Y.Text();
  result.insert(0, value);
  return result;
}

function addBlock(
  blocks: Y.Map<Y.Map<unknown>>,
  flavour: string,
  version: number,
  props: Record<string, unknown>,
  parentId: string,
) {
  const id = `${flavour.replace('affine:', '')}:${crypto.randomUUID()}`;
  const block = new Y.Map<unknown>();
  block.set('sys:id', id);
  block.set('sys:flavour', flavour);
  block.set('sys:version', version);
  block.set('sys:children', new Y.Array<string>());
  for (const [key, value] of Object.entries(props)) {
    if (value !== undefined) block.set(`prop:${key}`, nativeToY(value));
  }
  blocks.set(id, block);
  const parent = blocks.get(parentId);
  if (!parent) throw new Error(`Parent block not found: ${parentId}`);
  (parent.get('sys:children') as Y.Array<string>).push([id]);
  return id;
}

function findByFlavour(blocks: Y.Map<Y.Map<unknown>>, flavour: string) {
  return [...blocks.values()].find(
    (block) => block.get('sys:flavour') === flavour,
  );
}

function idOf(block: Y.Map<unknown>) {
  return block.get('sys:id') as string;
}

function surfaceElements(blocks: Y.Map<Y.Map<unknown>>) {
  const surface = findByFlavour(blocks, 'affine:surface');
  if (!surface) throw new Error('Board has no surface block');
  const boxed = surface.get('prop:elements') as Y.Map<unknown>;
  const elements = boxed?.get('value');
  if (!(elements instanceof Y.Map)) throw new Error('Board surface is invalid');
  return elements as Y.Map<Y.Map<unknown>>;
}

const SHAPE_DEFAULTS: Record<string, unknown> = {
  shapeType: 'rect',
  shapeStyle: 'General',
  radius: 0,
  rotate: 0,
  roughness: 1.4,
  filled: false,
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
};

/** Adds fields required by BlockSuite renderers to snapshots from early builds. */
export function repairNativeSnapshot(snapshot: NativeBoardSnapshot) {
  const nativeUpdate = snapshot.docs['board:home'];
  if (!nativeUpdate) return { snapshot, changed: false };
  const doc = new Y.Doc();
  Y.applyUpdate(doc, decode(nativeUpdate), 'native-repair-load');
  const blocks = doc.getMap<Y.Map<unknown>>('blocks');
  let changed = false;

  doc.transact(() => {
    const indexed = [...blocks.values()]
      .filter((b) => b.has('prop:index'))
      .map((b) => ({ model: b, key: 'prop:index' }))
      .concat(
        [...surfaceElements(blocks).values()].map((model) => ({
          model,
          key: 'index',
        })),
      );
    if (indexed.some(({ model, key }) => !validIndex(model.get(key)))) {
      indexed.sort((a, b) =>
        String(a.model.get(a.key)).localeCompare(String(b.model.get(b.key))),
      );
      let previous: string | null = null;
      for (const { model, key } of indexed) {
        previous = generateKeyBetween(previous, null);
        model.set(key, previous);
      }
      changed = true;
    }
    for (const block of blocks.values())
      if (
        block.get('sys:flavour') === 'affine:frame' &&
        !validIndex(block.get('prop:presentationIndex'))
      ) {
        block.set('prop:presentationIndex', block.get('prop:index'));
        changed = true;
      }
    for (const element of surfaceElements(blocks).values()) {
      if (element.get('type') !== 'shape') continue;
      for (const [key, value] of Object.entries(SHAPE_DEFAULTS)) {
        if (!element.has(key)) {
          element.set(key, value);
          changed = true;
        }
      }
    }
  }, 'native-repair');

  if (!changed) {
    doc.destroy();
    return { snapshot, changed: false };
  }
  const repairedUpdate = encode(Y.encodeStateAsUpdate(doc));
  doc.destroy();
  return {
    changed: true,
    snapshot: {
      ...snapshot,
      docs: {
        ...snapshot.docs,
        'board:home': repairedUpdate,
      },
    },
  };
}

const ANCHOR_POSITION: Record<ConnectorAnchor, [number, number]> = {
  top: [0.5, 0],
  right: [1, 0.5],
  bottom: [0.5, 1],
  left: [0, 0.5],
};
const anchorPosition = (anchor: ConnectorAnchor | [number, number]) =>
  typeof anchor === 'string' ? ANCHOR_POSITION[anchor] : anchor;
function validIndex(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    generateKeyBetween(value, null);
    return true;
  } catch {
    return false;
  }
}
function nextIndex(blocks: Y.Map<Y.Map<unknown>>) {
  const keys = [...blocks.values()]
    .map((b) => b.get('prop:index'))
    .concat([...surfaceElements(blocks).values()].map((e) => e.get('index')))
    .filter(validIndex)
    .sort();
  return generateKeyBetween(keys.at(-1) ?? null, null);
}
const INK = { light: '#23304a', dark: '#eef2fb' };
const PAPER = { light: '#ffffff', dark: '#283347' };
const BORDER = { light: '#425574', dark: '#b9c5dc' };
function plain(value: unknown): unknown {
  if (value instanceof Y.Text) return value.toString();
  if (value instanceof Y.Map)
    return Object.fromEntries(
      [...value.entries()].map(([k, v]) => [k, plain(v)]),
    );
  if (value instanceof Y.Array) return value.toArray().map(plain);
  if (Array.isArray(value)) return value.map(plain);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, plain(v)]),
    );
  return value;
}
function bounds(element: Y.Map<unknown>, block: boolean) {
  const value = String(
    element.get(block ? 'prop:xywh' : 'xywh') ?? '[0,0,0,0]',
  );
  try {
    const parsed: unknown = JSON.parse(value);
    if (
      Array.isArray(parsed) &&
      parsed.length === 4 &&
      parsed.every((v) => typeof v === 'number' && Number.isFinite(v))
    )
      return parsed as number[];
  } catch {
    /* Report a harmless empty bound for unsupported legacy content. */
  }
  return [0, 0, 0, 0];
}
function replaceText(value: unknown, content: string) {
  if (!(value instanceof Y.Text))
    throw new Error('Element has no editable text');
  value.delete(0, value.length);
  value.insert(0, content);
}
function blockText(
  blocks: Y.Map<Y.Map<unknown>>,
  id: string,
  visited = new Set<string>(),
): string {
  if (visited.has(id)) return '';
  visited.add(id);
  const block = blocks.get(id);
  if (!block) return '';
  const own = block.get('prop:text');
  const children = block.get('sys:children');
  return [
    own instanceof Y.Text ? own.toString() : '',
    ...(children instanceof Y.Array
      ? children
          .toArray()
          .map((child) => blockText(blocks, String(child), visited))
      : []),
  ]
    .filter(Boolean)
    .join('\n');
}
function attachFrame(
  blocks: Y.Map<Y.Map<unknown>>,
  id: string,
  frameId: string | null,
) {
  const frame = frameId ? blocks.get(frameId) : undefined;
  if (frameId && (!frame || frame.get('sys:flavour') !== 'affine:frame'))
    throw new Error(`Frame not found: ${frameId}`);
  if (frame?.get('prop:lockedBySelf'))
    throw new Error(`Frame is locked: ${frameId}`);
  // Detaching changes the source frame too. Validate every affected frame
  // before changing any membership, including deletions and moves with frameRef.
  const frames = [...blocks.values()].filter(existing => existing.get('sys:flavour') === 'affine:frame');
  for (const existing of frames) {
    const members = existing.get('prop:childElementIds') as Y.Map<boolean> | undefined;
    if (members?.has(id) && existing.get('prop:lockedBySelf'))
      throw new Error(`Frame is locked: ${idOf(existing)}`);
  }
  for (const existing of frames) {
    (
      existing.get('prop:childElementIds') as Y.Map<boolean> | undefined
    )?.delete(id);
  }
  if (frame) {
    if (!(frame.get('prop:childElementIds') instanceof Y.Map))
      frame.set('prop:childElementIds', new Y.Map<boolean>());
    (frame.get('prop:childElementIds') as Y.Map<boolean>).set(id, true);
  }
}
function addSurface(
  blocks: Y.Map<Y.Map<unknown>>,
  type: string,
  props: Record<string, unknown>,
) {
  const elements = surfaceElements(blocks);
  const id = `${type}:${crypto.randomUUID()}`;
  const element = new Y.Map<unknown>();
  element.set('id', id);
  element.set('type', type);
  element.set('index', nextIndex(blocks));
  element.set('seed', elements.size + 1);
  for (const [key, value] of Object.entries(props))
    if (value !== undefined) element.set(key, value);
  elements.set(id, element);
  return id;
}
function connectionLabel(
  element: Y.Map<unknown>,
  source: Y.Map<unknown> | undefined,
  target: Y.Map<unknown> | undefined,
  label: string,
  position?: number,
) {
  const savedPosition = (element.get('labelOffset') as { distance?: number })?.distance;
  const distance = position ?? (
    typeof savedPosition === 'number' && Number.isFinite(savedPosition)
      ? savedPosition : 0.5
  );
  const value = element.get('text');
  if (value instanceof Y.Text) replaceText(value, label);
  else element.set('text', text(label));
  element.set('labelDisplay', Boolean(label));
  element.set('labelOffset', { distance, anchor: 'center' });
  refreshConnectionLabelPosition(element, source, target, false);
}
function refreshConnectionLabelPosition(
  element: Y.Map<unknown>,
  source: Y.Map<unknown> | undefined,
  target: Y.Map<unknown> | undefined,
  preserveSize = true,
) {
  const label = String(element.get('text') ?? '');
  const savedPosition = (element.get('labelOffset') as { distance?: number })?.distance;
  const distance = typeof savedPosition === 'number' && Number.isFinite(savedPosition) ? savedPosition : 0.5;
  const point = (node: Y.Map<unknown> | undefined, endpoint: unknown) => {
    const position = (endpoint as { position?: number[] })?.position;
    if (!node) {
      if (!position || position.length !== 2 || !position.every(Number.isFinite))
        throw new Error('Connector endpoint has no position');
      return position;
    }
    const [x, y, w, h] = bounds(node, node.has('sys:flavour'));
    const relative = position ?? [
      0.5, 0.5,
    ];
    return [x + w * relative[0], y + h * relative[1]];
  };
  const a = point(source, element.get('source'));
  const b = point(target, element.get('target'));
  const sourcePosition = (element.get('source') as { position?: number[] })
    .position;
  const targetPosition = (element.get('target') as { position?: number[] })
    .position;
  const same =
    sourcePosition &&
    targetPosition &&
    sourcePosition.join() === targetPosition.join();
  const offset = same
    ? [
        sourcePosition[0] === 0 ? -70 : sourcePosition[0] === 1 ? 70 : 0,
        sourcePosition[1] === 0 ? -70 : sourcePosition[1] === 1 ? 70 : 0,
      ]
    : [0, 0];
  const savedBounds = element.get('labelXYWH') as number[] | undefined;
  const validSize = preserveSize && Array.isArray(savedBounds) && savedBounds.length === 4 &&
    savedBounds.every(Number.isFinite) && savedBounds[2] > 0 && savedBounds[3] > 0;
  const width = validSize ? savedBounds[2] : Math.min(360, Math.max(56, label.length * 9 + 20));
  const height = validSize ? savedBounds[3] : label.length > 30 ? 44 : 28;
  element.set('labelXYWH', [
    a[0] + (b[0] - a[0]) * distance + offset[0] - width / 2,
    a[1] + (b[1] - a[1]) * distance + offset[1] - height / 2,
    width,
    height,
  ]);
}
function tableValue(type: string, value: unknown) {
  if (value === null)
    return type === 'number'
      ? undefined
      : type === 'checkbox'
        ? false
        : text('');
  if (type === 'number' && typeof value === 'number') return value;
  if (type === 'checkbox' && typeof value === 'boolean') return value;
  if (type === 'rich-text' && typeof value === 'string') return text(value);
  throw new Error(`Invalid ${type} table cell value`);
}

export function applyNativeOperations(
  snapshot: NativeBoardSnapshot,
  input: NativeOperation[],
) {
  const operations = nativeBatchSchema.parse(input);
  const nativeUpdate = snapshot.docs['board:home'];
  if (!nativeUpdate) throw new Error('Board document is missing');
  const doc = new Y.Doc();
  try {
    Y.applyUpdate(doc, decode(nativeUpdate), 'semantic-load');
    const blocks = doc.getMap<Y.Map<unknown>>('blocks');
    const page = findByFlavour(blocks, 'affine:page');
    const surface = findByFlavour(blocks, 'affine:surface');
    if (!page || !surface) throw new Error('Board root blocks are missing');
    const elements = surfaceElements(blocks);
    const refs = new Map<string, string>();
    const createdIds: string[] = [];
    const updatedIds = new Set<string>();
    const boundsChanged = new Set<string>();
    const deletedIds = new Set<string>();
    const resolve = (ref: string) => refs.get(ref) ?? ref;
    const get = (id: string) => {
      const element = blocks.get(id) ?? elements.get(id);
      if (!element) throw new Error(`Element not found: ${id}`);
      return element;
    };
    const endpointNode = (endpoint: unknown) => {
      const id = (endpoint as { id?: string })?.id;
      return id ? get(id) : undefined;
    };
    const editable = (id: string) => {
      const element = get(id);
      let ancestorId: string | undefined = id;
      const seen = new Set<string>();
      while (ancestorId && !seen.has(ancestorId)) {
        seen.add(ancestorId);
        const ancestor = get(ancestorId);
        if (ancestor.get('prop:lockedBySelf') || ancestor.get('lockedBySelf'))
          throw new Error(`Element is locked: ${ancestorId}`);
        const parent = [...blocks.values()].find((b) =>
          (b.get('sys:children') as Y.Array<string>)
            .toArray()
            .includes(ancestorId!),
        );
        ancestorId = parent ? idOf(parent) : undefined;
      }
      if (
        ['affine:page', 'affine:surface'].includes(
          String(element.get('sys:flavour')),
        )
      )
        throw new Error('Root blocks cannot be edited');
      return element;
    };
    const register = (id: string, ref?: string, frameRef?: string) => {
      if (ref) refs.set(ref, id);
      if (frameRef) attachFrame(blocks, id, resolve(frameRef));
      createdIds.push(id);
    };
    const note = (
      x: number,
      y: number,
      w: number,
      h: number,
      collapsed: boolean,
      color: unknown = PAPER,
    ) =>
      addBlock(
        blocks,
        'affine:note',
        1,
        {
          xywh: JSON.stringify([x, y, w, h]),
          index: nextIndex(blocks),
          background: color,
          lockedBySelf: false,
          hidden: false,
          displayMode: 'edgeless',
          edgeless: {
            collapse: collapsed,
            collapsedHeight: h,
            scale: 1,
            style: {
              borderRadius: collapsed ? 2 : 8,
              borderSize: collapsed ? 0 : 1,
              borderStyle: collapsed ? 'none' : 'solid',
              shadowType: '--affine-note-shadow-box',
            },
          },
        },
        idOf(page),
      );
    const remove = (id: string) => {
      const block = blocks.get(id);
      if (block) {
        const children = block.get('sys:children') as Y.Array<string>;
        for (const child of children.toArray()) remove(child);
        for (const parent of blocks.values()) {
          const ids = parent.get('sys:children') as Y.Array<string>;
          const index = ids.toArray().indexOf(id);
          if (index >= 0) {
            ids.delete(index, 1);
            if (parent.get('sys:flavour') === 'affine:database')
              (parent.get('prop:cells') as Y.Map<unknown>).delete(id);
          }
        }
        blocks.delete(id);
      } else elements.delete(id);
      attachFrame(blocks, id, null);
      deletedIds.add(id);
    };
    const inputRefs = new Set<string>();
    for (const operation of operations)
      if ('ref' in operation && operation.ref) {
        if (
          inputRefs.has(operation.ref) ||
          blocks.has(operation.ref) ||
          elements.has(operation.ref)
        )
          throw new Error(`Duplicate or ambiguous ref: ${operation.ref}`);
        inputRefs.add(operation.ref);
      }
    doc.transact(() => {
      for (const op of operations) {
        if (op.type === 'create_frame') {
          register(
            addBlock(
              blocks,
              'affine:frame',
              1,
              {
                title: text(op.title),
                background: 'transparent',
                xywh: JSON.stringify([op.x, op.y, op.width, op.height]),
                index: nextIndex(blocks),
                presentationIndex: nextIndex(blocks),
                childElementIds: {},
                lockedBySelf: false,
              },
              idOf(surface),
            ),
            op.ref,
          );
        } else if (op.type === 'create_note') {
          if (!op.text.trim()) throw new Error('Note text cannot be empty');
          const id = note(
            op.x,
            op.y,
            op.width ?? 208,
            op.height ?? 208,
            true,
            NOTE_COLORS[op.color ?? 'yellow'],
          );
          addBlock(
            blocks,
            'affine:paragraph',
            1,
            { type: 'text', text: text(op.text), collapsed: false },
            id,
          );
          register(id, op.ref, op.frameRef);
        } else if (op.type === 'create_shape' || op.type === 'create_text') {
          const props =
            op.type === 'create_shape'
              ? {
                  ...SHAPE_DEFAULTS,
                  shapeType: op.shape === 'roundedRect' ? 'rect' : op.shape,
                  radius: op.shape === 'roundedRect' ? 0.1 : 0,
                  filled: true,
                  fillColor: op.fill ?? PAPER,
                  strokeColor: op.stroke ?? BORDER,
                  strokeWidth: 2,
                  color: op.fill ? avatarInk(op.fill) : INK,
                  fontSize: op.fontSize ?? 20,
                  text: text(op.text),
                }
              : {
                  color: INK,
                  fontFamily: 'blocksuite:surface:Inter',
                  fontSize: op.fontSize,
                  fontWeight: op.bold ? '600' : '400',
                  fontStyle: 'normal',
                  textAlign: 'left',
                  rotate: 0,
                  hasMaxWidth: true,
                  text: text(op.text),
                };
          register(
            addSurface(blocks, op.type === 'create_shape' ? 'shape' : 'text', {
              ...props,
              xywh: JSON.stringify([op.x, op.y, op.width, op.height]),
            }),
            op.ref,
            op.frameRef,
          );
        } else if (op.type === 'create_document' || op.type === 'create_card') {
          const id = note(op.x, op.y, op.width, op.height, false);
          addBlock(
            blocks,
            'affine:paragraph',
            1,
            { type: 'h2', text: text(op.title), collapsed: false },
            id,
          );
          const content =
            op.type === 'create_document'
              ? op.blocks
              : [
                  { type: 'paragraph' as const, text: op.description },
                  {
                    type: 'paragraph' as const,
                    text: `Owner: ${op.owner}  ·  Estimate: ${op.estimate ?? '—'}`,
                  },
                  {
                    type: 'paragraph' as const,
                    text: `Status: ${op.status}${op.priority ? `  ·  Priority: ${op.priority}` : ''}`,
                  },
                ];
          for (const item of content) {
            if (item.type === 'code')
              addBlock(
                blocks,
                'affine:code',
                1,
                {
                  text: text(item.text),
                  language: item.language ?? 'plain',
                  wrap: true,
                },
                id,
              );
            else if (item.type === 'bullet' || item.type === 'check')
              addBlock(
                blocks,
                'affine:list',
                1,
                {
                  text: text(item.text),
                  type: item.type === 'check' ? 'todo' : 'bulleted',
                  checked: item.checked ?? false,
                  collapsed: false,
                },
                id,
              );
            else
              addBlock(
                blocks,
                'affine:paragraph',
                1,
                {
                  type: item.type === 'heading' ? 'h3' : 'text',
                  text: text(item.text),
                  collapsed: false,
                },
                id,
              );
          }
          register(id, op.ref, op.frameRef);
        } else if (op.type === 'create_table') {
          if (op.columns[0].type !== 'text')
            throw new Error(
              'The first table column must be text for the native row title',
            );
          const keys = op.columns.map((c) => c.key);
          if (new Set(keys).size !== keys.length)
            throw new Error('Table column keys must be unique');
          const width = Math.max(600, op.columns.length * 180 + 70);
          const id = note(
            op.x,
            op.y,
            width,
            Math.max(260, 150 + op.rows.length * 42),
            false,
          );
          const columns = op.columns.map((c, index) => ({
            id: c.key,
            type:
              index === 0 ? 'title' : c.type === 'text' ? 'rich-text' : c.type,
            name: c.name,
            data: {},
          }));
          const dbId = addBlock(
            blocks,
            'affine:database',
            3,
            {
              title: text(op.title),
              columns,
              cells: {},
              views: [
                {
                  id: crypto.randomUUID(),
                  name: 'Table',
                  mode: 'table',
                  columns: columns.map((c) => ({
                    id: c.id,
                    width: 180,
                    hide: false,
                  })),
                  filter: { type: 'group', op: 'and', conditions: [] },
                  header: { titleColumn: columns[0].id, iconColumn: 'type' },
                },
              ],
            },
            id,
          );
          const cells = blocks.get(dbId)!.get('prop:cells') as Y.Map<unknown>;
          for (const row of op.rows) {
            if (Object.keys(row).some((key) => !keys.includes(key)))
              throw new Error('Unknown table column');
            const rowId = addBlock(
              blocks,
              'affine:paragraph',
              1,
              {
                type: 'text',
                text: text(
                  typeof row[columns[0].id] === 'string'
                    ? (row[columns[0].id] as string)
                    : '',
                ),
                collapsed: false,
              },
              dbId,
            );
            const values: Record<string, unknown> = Object.create(null);
            if (row[columns[0].id] !== undefined)
              tableValue('rich-text', row[columns[0].id]);
            for (const c of columns.filter((c) => c.type !== 'title'))
              values[c.id] = {
                columnId: c.id,
                value: tableValue(c.type, row[c.id] ?? null),
              };
            cells.set(rowId, nativeToY(values));
          }
          register(id, op.ref, op.frameRef);
        } else if (op.type === 'create_image') {
          register(
            addBlock(
              blocks,
              'affine:image',
              1,
              {
                xywh: JSON.stringify([op.x, op.y, op.width, op.height]),
                width: op.width,
                height: op.height,
                rotate: 0,
                size: -1,
                index: nextIndex(blocks),
                lockedBySelf: false,
                sourceId: op.sourceId,
                caption: op.caption,
              },
              idOf(surface),
            ),
            op.ref,
            op.frameRef,
          );
        } else if (op.type === 'create_connector') {
          const sourceId = resolve(op.sourceRef);
          const targetId = resolve(op.targetRef);
          if (
            !(blocks.has(sourceId) || elements.has(sourceId)) ||
            !(blocks.has(targetId) || elements.has(targetId))
          )
            throw new Error(
              'Connector endpoints must reference existing elements',
            );
          const source = get(sourceId);
          const target = get(targetId);
          if (
            !bounds(source, blocks.has(sourceId))[2] ||
            !bounds(target, blocks.has(targetId))[2]
          )
            throw new Error(
              'Connector endpoints must reference existing elements with bounds',
            );
          const id = addSurface(blocks, 'connector', {
            source: {
              id: sourceId,
              ...(op.sourceAnchor
                ? { position: anchorPosition(op.sourceAnchor) }
                : {}),
            },
            target: {
              id: targetId,
              ...(op.targetAnchor
                ? { position: anchorPosition(op.targetAnchor) }
                : {}),
            },
            mode:
              op.style === 'straight' ? 0 : op.style === 'orthogonal' ? 1 : 2,
            stroke: BORDER,
            strokeStyle: op.dashed ? 'dash' : 'solid',
            strokeWidth: 2,
            frontEndpointStyle: 'None',
            rearEndpointStyle: op.arrow === false ? 'None' : 'Arrow',
          });
          if (op.label)
            connectionLabel(
              elements.get(id)!,
              source,
              target,
              op.label,
              op.labelPosition,
            );
          register(id, op.ref);
        } else {
          const id = resolve(op.id);
          const element = editable(id);
          const isBlock = blocks.has(id);
          const prefix = isBlock ? 'prop:' : '';
          if (op.type === 'delete_element') {
            const children = new Set<string>();
            const collect = (child: string) => {
              editable(child);
              children.add(child);
              const b = blocks.get(child);
              if (b)
                for (const c of (
                  b.get('sys:children') as Y.Array<string>
                ).toArray())
                  collect(c);
            };
            collect(id);
            const connectors = [...elements.entries()]
              .filter(
                ([, e]) =>
                  e.get('type') === 'connector' &&
                  [e.get('source'), e.get('target')].some((endpoint) =>
                    children.has(String((endpoint as { id?: string })?.id)),
                  ),
              )
              .map(([key]) => key);
            for (const key of connectors) {
              editable(key);
              remove(key);
            }
            remove(id);
          } else if (
            op.type === 'move_element' ||
            op.type === 'resize_element'
          ) {
            const xywh = bounds(element, isBlock);
            if (!xywh[2]) throw new Error('Element has no canvas bounds');
            if (op.type === 'move_element') {
              if (op.moveContents !== undefined && element.get('sys:flavour') !== 'affine:frame')
                throw new Error('moveContents is supported only for frames');
              if (element.get('sys:flavour') === 'affine:frame' && op.moveContents !== false) {
                const members = element.get('prop:childElementIds');
                if (members instanceof Y.Map)
                  for (const childId of members.keys()) {
                    const child = editable(childId);
                    const childIsBlock = blocks.has(childId);
                    const childBounds = bounds(child, childIsBlock);
                    if (!childBounds[2]) continue;
                    childBounds[0] += op.x - xywh[0];
                    childBounds[1] += op.y - xywh[1];
                    child.set(
                      childIsBlock ? 'prop:xywh' : 'xywh',
                      JSON.stringify(childBounds),
                    );
                    updatedIds.add(childId);
                    boundsChanged.add(childId);
                  }
              }
              xywh[0] = op.x;
              xywh[1] = op.y;
            } else {
              xywh[2] = op.width;
              xywh[3] = op.height;
              const edgeless = element.get('prop:edgeless');
              if (edgeless instanceof Y.Map)
                edgeless.set('collapsedHeight', op.height);
            }
            element.set(`${prefix}xywh`, JSON.stringify(xywh));
            boundsChanged.add(id);
            if (op.type === 'move_element' && op.frameRef !== undefined) {
              if (element.get('sys:flavour') === 'affine:frame')
                throw new Error('Frames cannot be assigned to another frame');
              if (op.frameRef) editable(resolve(op.frameRef));
              attachFrame(blocks, id, op.frameRef ? resolve(op.frameRef) : null);
            }
            updatedIds.add(id);
          } else if (op.type === 'set_frame') {
            if (
              element.get('sys:flavour') === 'affine:frame' ||
              !bounds(element, isBlock)[2]
            )
              throw new Error('Only canvas content can be assigned to a frame');
            if (op.frameRef) editable(resolve(op.frameRef));
            attachFrame(blocks, id, op.frameRef ? resolve(op.frameRef) : null);
            updatedIds.add(id);
          } else if (
            op.type === 'update_note_text' ||
            op.type === 'update_text'
          ) {
            if (
              op.type === 'update_note_text' &&
              element.get('sys:flavour') !== 'affine:note'
            )
              throw new Error('Target must be a note');
            if (element.get('sys:flavour') === 'affine:note') {
              const children = (
                element.get('sys:children') as Y.Array<string>
              ).toArray();
              const child = children.length === 1 ? blocks.get(children[0]) : undefined;
              if (!child || !['affine:paragraph', ...(op.type === 'update_text' ? ['affine:database'] : [])].includes(String(child.get('sys:flavour'))))
                throw new Error(
                  'Edit document blocks individually to preserve structured content',
                );
              editable(children[0]);
              replaceText(child.get(child.get('sys:flavour') === 'affine:database' ? 'prop:title' : 'prop:text'), op.text);
              updatedIds.add(children[0]);
            } else if (element.get('sys:flavour') === 'affine:frame')
              replaceText(element.get('prop:title'), op.text);
            else if (element.get('sys:flavour') === 'affine:database')
              replaceText(element.get('prop:title'), op.text);
            else if (element.get('sys:flavour') === 'affine:image')
              element.set('prop:caption', op.text);
            else if (element.get('type') === 'connector')
              connectionLabel(
                element,
                endpointNode(element.get('source')),
                endpointNode(element.get('target')),
                op.text,
              );
            else replaceText(element.get(`${prefix}text`), op.text);
            updatedIds.add(id);
          } else if (op.type === 'style_element') {
            if (op.color) {
              if (element.get('sys:flavour') !== 'affine:note')
                throw new Error('Sticky colors require a note');
              element.set('prop:background', nativeToY(NOTE_COLORS[op.color]));
            }
            if (op.fill) {
              if (element.get('type') !== 'shape')
                throw new Error('Fill requires a shape');
              element.set('fillColor', op.fill);
              element.set('color', avatarInk(op.fill));
            }
            if (op.stroke) {
              if (!['shape', 'connector'].includes(String(element.get('type'))))
                throw new Error('Stroke requires a shape or connector');
              element.set(
                element.get('type') === 'connector' ? 'stroke' : 'strokeColor',
                op.stroke,
              );
            }
            if (op.fontSize) {
              if (!['shape', 'text'].includes(String(element.get('type'))))
                throw new Error('Font size requires canvas text or a shape');
              element.set('fontSize', op.fontSize);
            }
            updatedIds.add(id);
          } else if (op.type === 'update_connector') {
            if (element.get('type') !== 'connector')
              throw new Error('Target must be a connector');
            for (const end of ['source', 'target'] as const) {
              const ref = end === 'source' ? op.sourceRef : op.targetRef;
              const a = end === 'source' ? op.sourceAnchor : op.targetAnchor;
              const current = element.get(end) as {
                id?: string;
                position?: number[];
              };
              const endpointId = ref ? resolve(ref) : current.id;
              if (!endpointId) {
                if (a) throw new Error('Connector anchors require an attached endpoint');
                continue;
              }
              if (!bounds(get(endpointId), blocks.has(endpointId))[2])
                throw new Error('Connector endpoint has no bounds');
              element.set(end, {
                id: endpointId,
                ...(a
                  ? { position: anchorPosition(a) }
                  : current.id && current.position
                    ? { position: current.position }
                    : {}),
              });
            }
            if (op.style)
              element.set(
                'mode',
                op.style === 'straight' ? 0 : op.style === 'orthogonal' ? 1 : 2,
              );
            connectionLabel(
              element,
              endpointNode(element.get('source')),
              endpointNode(element.get('target')),
              op.label ?? String(element.get('text') ?? ''),
            );
            updatedIds.add(id);
          } else if (op.type === 'update_table_cell') {
            const db =
              element.get('sys:flavour') === 'affine:database'
                ? element
                : (element.get('sys:children') as Y.Array<string> | undefined)
                    ?.toArray()
                    .map((child) => blocks.get(child))
                    .find((b) => b?.get('sys:flavour') === 'affine:database');
            if (!db) throw new Error('Target must be a table');
            editable(idOf(db));
            const columns = plain(db.get('prop:columns')) as {
              id: string;
              type: string;
            }[];
            const column = columns.find((c) => c.id === op.columnKey);
            if (!column) throw new Error('Unknown table column');
            const row = (db.get('prop:cells') as Y.Map<Y.Map<unknown>>).get(
              op.rowId,
            );
            if (!row) throw new Error('Unknown table row');
            editable(op.rowId);
            if (column.type === 'title') {
              if (op.value !== null && typeof op.value !== 'string')
                throw new Error('Invalid text table cell value');
              replaceText(
                blocks.get(op.rowId)?.get('prop:text'),
                op.value ?? '',
              );
            } else
              row.set(
                op.columnKey,
                nativeToY({
                  columnId: op.columnKey,
                  value: tableValue(column.type, op.value),
                }),
              );
            updatedIds.add(id);
          }
        }
      }
      // Labels are saved in absolute canvas coordinates. Refresh them only after
      // all endpoint moves/resizes have completed, including frame members.
      for (const [id, connector] of elements) {
        if (connector.get('type') !== 'connector' || !String(connector.get('text') ?? '')) continue;
        const endpointMoved = ['source', 'target'].some(end =>
          boundsChanged.has(String((connector.get(end) as { id?: string })?.id)),
        );
        if (!endpointMoved) continue;
        editable(id);
        refreshConnectionLabelPosition(connector, endpointNode(connector.get('source')), endpointNode(connector.get('target')));
        updatedIds.add(id);
      }
    }, 'semantic-batch');
    return {
      snapshot: {
        ...snapshot,
        docs: {
          ...snapshot.docs,
          'board:home': encode(Y.encodeStateAsUpdate(doc)),
        },
      },
      createdIds,
      updatedIds: [...updatedIds],
      deletedIds: [...deletedIds],
      refs: Object.fromEntries(refs),
    };
  } finally {
    doc.destroy();
  }
}

export function readNativeBoard(snapshot: NativeBoardSnapshot) {
  const doc = new Y.Doc();
  try {
    Y.applyUpdate(doc, decode(snapshot.docs['board:home']), 'semantic-read');
    const blocks = doc.getMap<Y.Map<unknown>>('blocks');
    const values = [...blocks.values()];
    const frameIds = (id: string) =>
      values
        .filter(
          (b) =>
            b.get('sys:flavour') === 'affine:frame' &&
            (b.get('prop:childElementIds') as Y.Map<boolean> | undefined)?.get(
              id,
            ),
        )
        .map(idOf);
    const blockContent = (
      id: string,
      seen = new Set<string>(),
    ): { id: string; type: string; text: string; checked: unknown }[] => {
      if (seen.has(id)) return [];
      seen.add(id);
      const b = blocks.get(id);
      if (!b) return [];
      return [
        {
          id,
          type: String(b.get('sys:flavour')),
          text: String(b.get('prop:text') ?? ''),
          checked: b.get('prop:checked') ?? null,
        },
        ...(b.get('sys:children') as Y.Array<string>)
          .toArray()
          .flatMap((c) => blockContent(c, seen)),
      ];
    };
    const notes = values
      .filter((b) => b.get('sys:flavour') === 'affine:note')
      .map((b) => ({
        id: idOf(b),
        text: blockText(blocks, idOf(b)),
        xywh: String(b.get('prop:xywh')),
        color: plain(b.get('prop:background')),
        frameIds: frameIds(idOf(b)),
        collapsed:
          (b.get('prop:edgeless') as Y.Map<unknown> | undefined)?.get(
            'collapse',
          ) ?? false,
        content: (b.get('sys:children') as Y.Array<string>)
          .toArray()
          .flatMap((c) => blockContent(c)),
      }));
    const frames = values
      .filter((b) => b.get('sys:flavour') === 'affine:frame')
      .map((b) => ({
        id: idOf(b),
        title: String(b.get('prop:title') ?? ''),
        xywh: String(b.get('prop:xywh')),
        childIds: Object.entries(
          (plain(b.get('prop:childElementIds')) as Record<string, boolean>) ??
            {},
        )
          .filter(([, member]) => member)
          .map(([id]) => id),
      }));
    const nativeElements = [...surfaceElements(blocks).values()];
    const connectors = nativeElements
      .filter((e) => e.get('type') === 'connector')
      .map((e) => ({
        id: String(e.get('id')),
        source: plain(e.get('source')),
        target: plain(e.get('target')),
        label: String(e.get('text') ?? ''),
        labelXYWH: plain(e.get('labelXYWH')) ?? null,
        style: e.get('mode'),
        xywh: String(e.get('xywh') ?? '[0,0,0,0]'),
      }));
    const shapes = nativeElements
      .filter((e) => e.get('type') === 'shape')
      .map((e) => ({
        id: String(e.get('id')),
        text: String(e.get('text') ?? ''),
        xywh: String(e.get('xywh')),
        shape: e.get('shapeType'),
        color: plain(e.get('fillColor')),
        frameIds: frameIds(String(e.get('id'))),
      }));
    const texts = nativeElements
      .filter((e) => e.get('type') === 'text')
      .map((e) => ({
        id: String(e.get('id')),
        text: String(e.get('text') ?? ''),
        xywh: String(e.get('xywh')),
        fontSize: e.get('fontSize'),
        frameIds: frameIds(String(e.get('id'))),
      }));
    const images = values
      .filter((b) => b.get('sys:flavour') === 'affine:image')
      .map((b) => ({
        id: idOf(b),
        text: String(b.get('prop:caption') ?? ''),
        sourceId: String(b.get('prop:sourceId') ?? ''),
        xywh: String(b.get('prop:xywh')),
        frameIds: frameIds(idOf(b)),
      }));
    const tables = values
      .filter((b) => b.get('sys:flavour') === 'affine:database')
      .map((b) => {
        const container = values.find((parent) =>
          (parent.get('sys:children') as Y.Array<string>)
            .toArray()
            .includes(idOf(b)),
        );
        const containerId = container ? idOf(container) : idOf(b);
        return {
          id: idOf(b),
          containerId,
          xywh: container
            ? String(container.get('prop:xywh') ?? '[0,0,0,0]')
            : '[0,0,0,0]',
          frameIds: frameIds(containerId),
          title: String(b.get('prop:title') ?? ''),
          columns: plain(b.get('prop:columns')) as {
            id: string;
            type: string;
            name: string;
          }[],
          rows: Object.entries(
            plain(b.get('prop:cells')) as Record<
              string,
              Record<string, { value?: unknown }>
            >,
          ).map(([id, cells]) => ({
            id,
            values: {
              ...Object.fromEntries(
                Object.entries(cells).map(([key, cell]) => [
                  key,
                  cell.value ?? null,
                ]),
              ),
              ...Object.fromEntries(
                (plain(b.get('prop:columns')) as { id: string; type: string }[])
                  .filter((c) => c.type === 'title')
                  .map((c) => [
                    c.id,
                    String(blocks.get(id)?.get('prop:text') ?? ''),
                  ]),
              ),
            },
          })),
        };
      });
    const elements = [
      ...notes.map((n) => ({
        id: n.id,
        type: n.collapsed ? 'note' : 'document',
        text: n.text,
        xywh: n.xywh,
        frameIds: n.frameIds,
      })),
      ...frames.map((f) => ({
        id: f.id,
        type: 'frame',
        text: f.title,
        xywh: f.xywh,
        frameIds: [] as string[],
      })),
      ...shapes.map((s) => ({ ...s, type: 'shape' })),
      ...texts.map((t) => ({ ...t, type: 'text' })),
      ...images.map((i) => ({ ...i, type: 'image' })),
      ...connectors.map((c) => ({
        id: c.id,
        type: 'connector',
        text: c.label,
        xywh: c.xywh,
        frameIds: [] as string[],
      })),
      ...tables.map((t) => ({
        id: t.id,
        containerId: t.containerId,
        type: 'table',
        text: [
          t.title,
          ...t.columns.map((c) => c.name),
          ...t.rows.flatMap((r) => Object.values(r.values).map(String)),
        ].join('\n'),
        xywh: t.xywh,
        frameIds: t.frameIds,
      })),
      ...nativeElements
        .filter(
          (e) =>
            !['shape', 'text', 'connector'].includes(String(e.get('type'))),
        )
        .map((e) => ({
          id: String(e.get('id')),
          type: String(e.get('type')),
          text: String(e.get('text') ?? ''),
          xywh: String(e.get('xywh') ?? '[0,0,0,0]'),
          frameIds: frameIds(String(e.get('id'))),
        })),
    ];
    return {
      notes,
      frames,
      connectors,
      shapes,
      texts,
      images,
      tables,
      elements,
      blocks: values.map((b) => plain(b) as Record<string, unknown>),
      surfaceElements: nativeElements.map(
        (e) => plain(e) as Record<string, unknown>,
      ),
    };
  } finally {
    doc.destroy();
  }
}

const ASSET_KEY = /^[A-Za-z0-9_-]{43}=?$/u;

/** Finds content-addressed BlockSuite blob references without coupling export to a UI renderer. */
export function collectNativeAssetIds(snapshot: NativeBoardSnapshot) {
  const ids = new Set<string>();
  for (const update of Object.values(snapshot.docs)) {
    const doc = new Y.Doc();
    try {
      Y.applyUpdate(doc, decode(update), 'asset-reference-read');
      // Only native blob fields are references. Hash-shaped text never grants file access.
      for (const block of Object.values(doc.getMap('blocks').toJSON()) as Record<string, unknown>[]) {
        if (!block || !['affine:image', 'affine:attachment'].includes(String(block['sys:flavour']))) continue;
        const sourceId = block['prop:sourceId'];
        if (typeof sourceId === 'string' && ASSET_KEY.test(sourceId)) ids.add(sourceId);
      }
    } finally { doc.destroy(); }
  }
  return [...ids].sort();
}
