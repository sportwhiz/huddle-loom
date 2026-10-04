import * as Y from 'yjs';
import type { NativeBoardSnapshot } from './blocksuite/runtime/snapshot';
import { BOARD_PREVIEW_LIMIT, BOARD_PREVIEW_TEXT_LIMIT, type PreviewBoard, type PreviewEndpoint } from './board-preview';

function field(value: unknown, key: string): unknown {
  if (value instanceof Y.Map) return value.get(key);
  if (value && typeof value === 'object') return (value as Record<string, unknown>)[key];
}

function snippet(value: unknown) {
  return typeof value === 'string' || value instanceof Y.Text
    ? String(value).slice(0, BOARD_PREVIEW_TEXT_LIMIT) : '';
}

function identifier(value: unknown) {
  return typeof value === 'string' && value.length > 0 && value.length <= 160 ? value : undefined;
}

function geometry(value: unknown) {
  if (typeof value !== 'string' || value.length > 160) return undefined;
  try {
    const box: unknown = JSON.parse(value);
    if (!Array.isArray(box) || box.length !== 4 || !box.every(n => typeof n === 'number' && Number.isFinite(n)) || box[2] <= 0 || box[3] <= 0 || !Number.isFinite(box[0] + box[2]) || !Number.isFinite(box[1] + box[3])) return undefined;
    return JSON.stringify(box);
  } catch { return undefined; }
}

function color(value: unknown) {
  const light = typeof value === 'string' ? value : field(value, 'light');
  if (typeof light !== 'string' || !/^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/iu.test(light)) return undefined;
  return light.length === 4 ? `#${[...light.slice(1)].map(c => c + c).join('')}` : light;
}

function endpoint(value: unknown): PreviewEndpoint | undefined {
  const id = identifier(field(value, 'id'));
  const raw = field(value, 'position');
  const position = raw instanceof Y.Array ? [raw.get(0), raw.get(1)] : raw;
  const tuple = Array.isArray(position) && position.length === 2 && position.every(n => typeof n === 'number' && Number.isFinite(n))
    ? position as [number, number] : undefined;
  return id || tuple ? { ...(id ? { id } : {}), ...(tuple ? { position: tuple } : {}) } : undefined;
}

/** Decode once and read only thumbnail fields. Never normalize the full semantic board. */
export function readNativePreview(snapshot: NativeBoardSnapshot): PreviewBoard {
  const result: PreviewBoard = { elements: [], notes: [], shapes: [], connectors: [] };
  const doc = new Y.Doc();
  try {
    Y.applyUpdate(doc, Uint8Array.from(atob(snapshot.docs['board:home']), c => c.charCodeAt(0)), 'preview-read');
    const blocks = doc.getMap<Y.Map<unknown>>('blocks');
    let surface: Y.Map<unknown> | undefined;
    for (const block of blocks.values()) {
      if (!(block instanceof Y.Map)) continue;
      const flavour = block.get('sys:flavour');
      if (flavour === 'affine:surface') surface = block;
      if (result.elements.length >= BOARD_PREVIEW_LIMIT) {
        if (surface) break;
        continue;
      }
      if (!['affine:note', 'affine:frame', 'affine:image'].includes(String(flavour))) continue;
      const id = identifier(block.get('sys:id'));
      const xywh = geometry(block.get('prop:xywh'));
      if (!id || !xywh) continue;
      let type = flavour === 'affine:frame' ? 'frame' : 'image';
      let text = snippet(block.get(flavour === 'affine:frame' ? 'prop:title' : 'prop:caption'));
      if (flavour === 'affine:note') {
        const collapsed = field(block.get('prop:edgeless'), 'collapse') === true;
        type = collapsed ? 'note' : 'document';
        // A caption from the first nonempty child is enough. Do not visit document
        // descendants or database cells, which can dominate the full board payload.
        const children = block.get('sys:children');
        if (children instanceof Y.Array) {
          for (let i = 0; i < Math.min(children.length, 4) && !text; i++) {
            const child = blocks.get(children.get(i));
            if (child instanceof Y.Map) text = snippet(child.get('prop:text') ?? child.get('prop:title'));
          }
        }
        result.notes.push({ id, color: color(block.get('prop:background')), collapsed });
      }
      result.elements.push({ id, type, text, xywh });
    }
    const elements = field(surface?.get('prop:elements'), 'value');
    if (elements instanceof Y.Map) for (const element of elements.values()) {
      if (!(element instanceof Y.Map)) continue;
      const id = identifier(element.get('id'));
      const type = element.get('type');
      if (!id) continue;
      if (type === 'connector' && result.connectors.length < BOARD_PREVIEW_LIMIT) {
        result.connectors.push({ id, source: endpoint(element.get('source')), target: endpoint(element.get('target')) });
      } else if ((type === 'shape' || type === 'text') && result.elements.length < BOARD_PREVIEW_LIMIT) {
        const xywh = geometry(element.get('xywh'));
        if (!xywh) continue;
        result.elements.push({ id, type, text: snippet(element.get('text')), xywh });
        if (type === 'shape') result.shapes.push({ id, color: color(element.get('fillColor')), shape: snippet(element.get('shapeType')) });
      }
      if (result.elements.length >= BOARD_PREVIEW_LIMIT && result.connectors.length >= BOARD_PREVIEW_LIMIT) break;
    }
    return result;
  } finally { doc.destroy(); }
}
