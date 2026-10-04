/** A card-sized projection: no document bodies, table cells, blobs or raw CRDT data. */
export const BOARD_PREVIEW_LIMIT = 600;
export const BOARD_PREVIEW_TEXT_LIMIT = 32;
export type PreviewColor = string | { light?: string };
export type PreviewElement = { id: string; type: string; text?: string; xywh: string };
export type PreviewEndpoint = { id?: string; position?: [number, number] };
export type PreviewBoard = {
  elements: PreviewElement[];
  notes: { id: string; color?: PreviewColor; collapsed: boolean }[];
  shapes: { id: string; color?: PreviewColor; shape?: string }[];
  connectors: { id: string; source?: PreviewEndpoint; target?: PreviewEndpoint }[];
};
