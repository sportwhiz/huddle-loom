import { z } from 'zod';

const id = z.string().min(1).max(160);
export const nativeCoordinateLimit = 1_000_000;
export const nativePosition = z.number().finite().min(-nativeCoordinateLimit).max(nativeCoordinateLimit);
const position = nativePosition;
const dimension = z.number().finite().min(16).max(20_000);
const content = z.string().max(20_000);
export const requiredNativeText = (maximum: number) => z.string().min(1).max(maximum)
  .refine(value => value.trim().length > 0, 'Text must contain a non-whitespace character');
export const noteColor = z.enum([
  'yellow',
  'orange',
  'green',
  'blue',
  'purple',
]);
export const anchor = z.union([
  z.enum(['top', 'right', 'bottom', 'left']),
  // Both coordinates have the same constraints. A fixed-length array emits a
  // single `items` schema that assistant tool importers can consume; Zod
  // tuples emit Draft 7 positional `items` arrays instead.
  z.array(z.number().finite().min(0).max(1)).length(2)
    .transform(([x, y]): [number, number] => [x, y]),
]).describe('Named edge or relative [x,y] position within the endpoint bounds, from 0 to 1.');
const color = z.string().regex(/^#[0-9a-fA-F]{6}$/u);
const placement = {
  ref: id.optional(),
  frameRef: id.optional(),
  x: position,
  y: position,
};
const sized = { ...placement, width: dimension, height: dimension };
export const documentBlockSchema = z
  .object({
    type: z.enum(['paragraph', 'heading', 'bullet', 'check', 'code']),
    text: content,
    checked: z.boolean().optional(),
    language: z.string().max(40).optional(),
  })
  .strict();
export const tableColumnSchema = z
  .object({
    key: id,
    name: z.string().min(1).max(120),
    type: z.enum(['text', 'number', 'checkbox']),
  })
  .strict();
export const tableCellSchema = z.union([
  z.string().max(4000),
  z.number().finite(),
  z.boolean(),
  z.null(),
]);
export const nativeOperationSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('create_note'),
      ...placement,
      text: requiredNativeText(20_000),
      color: noteColor.optional(),
      width: dimension.optional(),
      height: dimension.optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('create_frame'),
      ref: id.optional(),
      title: z.string().max(240),
      x: position,
      y: position,
      width: dimension,
      height: dimension,
    })
    .strict(),
  z
    .object({
      type: z.literal('create_shape'),
      ...sized,
      text: content.default(''),
      shape: z
        .enum(['rect', 'roundedRect', 'diamond', 'ellipse', 'triangle'])
        .default('roundedRect'),
      fill: color.optional(),
      stroke: color.optional(),
      fontSize: z.number().min(12).max(64).optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('create_text'),
      ...sized,
      text: requiredNativeText(20_000),
      fontSize: z.number().min(12).max(96).default(24),
      bold: z.boolean().default(false),
    })
    .strict(),
  z
    .object({
      type: z.literal('create_document'),
      ...sized,
      title: z.string().max(240),
      blocks: z.array(documentBlockSchema).max(100),
    })
    .strict(),
  z
    .object({
      type: z.literal('create_card'),
      ...sized,
      title: requiredNativeText(240),
      description: content.default(''),
      owner: z.string().max(120).default('Unassigned'),
      estimate: z.number().min(0).max(10000).optional(),
      status: z.string().max(80).default('To do'),
      priority: z.string().max(80).optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('create_table'),
      ...placement,
      title: z.string().max(240),
      columns: z.array(tableColumnSchema).min(1).max(12),
      rows: z.array(z.record(z.string(), tableCellSchema)).max(100),
    })
    .strict(),
  z
    .object({
      type: z.literal('create_image'),
      ...sized,
      sourceId: z.string().regex(/^[A-Za-z0-9_-]{43}=?$/u),
      caption: z.string().max(1000).default(''),
    })
    .strict(),
  z
    .object({
      type: z.literal('create_connector'),
      ref: id.optional(),
      sourceRef: id,
      targetRef: id,
      label: z.string().max(500).optional(),
      sourceAnchor: anchor.optional(),
      targetAnchor: anchor.optional(),
      labelPosition: z.number().min(0.15).max(0.85).optional(),
      style: z.enum(['curve', 'orthogonal', 'straight']).optional(),
      dashed: z.boolean().optional(),
      arrow: z.boolean().optional(),
    })
    .strict(),
  z.object({ type: z.literal('update_note_text'), id, text: content }).strict(),
  z.object({ type: z.literal('update_text'), id, text: content }).strict(),
  z
    .object({
      type: z.literal('move_element'), id, x: position, y: position,
      moveContents: z.boolean().optional().describe('Frames only: default true moves members; false moves the outline while preserving member positions.'),
      frameRef: id.nullable().optional().describe('Optionally assign canvas content to this frame, or detach with null, in the same atomic move.'),
    })
    .strict(),
  z
    .object({
      type: z.literal('resize_element'),
      id,
      width: dimension,
      height: dimension,
    })
    .strict(),
  z
    .object({
      type: z.literal('style_element'),
      id,
      color: noteColor.optional(),
      fill: color.optional(),
      stroke: color.optional(),
      fontSize: z.number().min(12).max(96).optional(),
    })
    .strict(),
  z
    .object({ type: z.literal('set_frame'), id, frameRef: id.nullable() })
    .strict(),
  z
    .object({
      type: z.literal('update_connector'),
      id,
      sourceRef: id.optional(),
      targetRef: id.optional(),
      label: z.string().max(500).optional(),
      sourceAnchor: anchor.optional(),
      targetAnchor: anchor.optional(),
      style: z.enum(['curve', 'orthogonal', 'straight']).optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('update_table_cell'),
      id,
      rowId: id,
      columnKey: id,
      value: tableCellSchema,
    })
    .strict(),
  z.object({ type: z.literal('delete_element'), id }).strict(),
]);
export const nativeBatchSchema = z.array(nativeOperationSchema).min(1).max(100);
export type NativeOperation = z.input<typeof nativeOperationSchema>;
