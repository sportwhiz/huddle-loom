import { z } from 'zod';
import {
  anchor,
  nativeCoordinateLimit,
  nativePosition,
  noteColor,
  requiredNativeText,
  type NativeOperation,
} from './native-operation-schema';

const ref = z.string().min(1).max(120);
export const workflowSchema = z.object({
  title: z.string().max(240).default('Workflow'),
  direction: z.enum(['horizontal', 'vertical']).default('horizontal'),
  notation: z.enum(['sticky', 'flowchart']).default('sticky'),
  nodes: z
    .array(
      z.object({
        ref,
        label: requiredNativeText(2000),
        color: noteColor.optional(),
        kind: z
          .enum(['start', 'action', 'decision', 'end', 'exception'])
          .default('action'),
        lane: requiredNativeText(120).optional(),
        column: z.number().int().min(0).max(40).optional(),
        row: z.number().int().min(0).max(40).optional(),
      }),
    )
    .min(1)
    .max(30),
  edges: z
    .array(
      z.object({
        sourceRef: ref,
        targetRef: ref,
        label: z.string().max(160).optional(),
        sourceAnchor: anchor.optional(),
        targetAnchor: anchor.optional(),
        labelPosition: z.number().min(0.15).max(0.85).optional(),
      }),
    )
    .max(60),
  x: nativePosition.default(100),
  y: nativePosition.default(100),
  columnGap: z.number().min(300).max(800).default(360),
  rowGap: z.number().min(240).max(1200).default(280),
});
export type Workflow = z.infer<typeof workflowSchema>;

/** Remove DFS back edges for ranking, then reserve the main path before placing branches. */
export function layoutGraph(
  nodes: Workflow['nodes'],
  edges: Workflow['edges'],
  direction: Workflow['direction'],
) {
  const refs = new Set(nodes.map((n) => n.ref));
  if (refs.size !== nodes.length)
    throw new Error('INVALID_DIAGRAM: every node ref must be unique');
  if (edges.some((e) => !refs.has(e.sourceRef) || !refs.has(e.targetRef)))
    throw new Error(
      'INVALID_DIAGRAM: connector endpoints must match node refs',
    );
  const visited = new Set<string>();
  const active = new Set<string>();
  const feedback = new Set<Workflow['edges'][number]>();
  const visit = (id: string) => {
    visited.add(id);
    active.add(id);
    for (const edge of edges.filter((e) => e.sourceRef === id)) {
      if (active.has(edge.targetRef)) feedback.add(edge);
      else if (!visited.has(edge.targetRef)) visit(edge.targetRef);
    }
    active.delete(id);
  };
  nodes.forEach((n) => {
    if (!visited.has(n.ref)) visit(n.ref);
  });
  const forward = edges.filter((e) => !feedback.has(e));
  const ranks = new Map<string, number>();
  const rank = (id: string): number => {
    if (ranks.has(id)) return ranks.get(id)!;
    const result = Math.max(
      0,
      ...forward
        .filter((e) => e.targetRef === id)
        .map((e) => rank(e.sourceRef) + 1),
    );
    ranks.set(id, result);
    return result;
  };
  const kindPriority = (id: string) =>
    ({ decision: 4, action: 3, end: 2, start: 1, exception: 0 })[
      nodes.find((n) => n.ref === id)!.kind
    ];
  const roots = nodes.filter(
    (n) => !forward.some((e) => e.targetRef === n.ref),
  );
  const primary = new Set<string>();
  let current: string | undefined = roots[0]?.ref;
  while (current && !primary.has(current)) {
    primary.add(current);
    current = forward
      .filter((e) => e.sourceRef === current)
      .sort(
        (a, b) => kindPriority(b.targetRef) - kindPriority(a.targetRef),
      )[0]?.targetRef;
  }
  const baseline = forward.some(
    (edge) => forward.filter((e) => e.sourceRef === edge.sourceRef).length > 1,
  )
    ? 1
    : 0;
  const lanes = [
    ...new Set(nodes.map((n) => n.lane).filter((n): n is string => Boolean(n))),
  ];
  const laneWidths = lanes.map(
    (lane) =>
      Math.max(
        1,
        ...nodes.map(
          (n) =>
            nodes.filter(
              (other) => other.lane === lane && rank(other.ref) === rank(n.ref),
            ).length,
        ),
      ) + 1,
  );
  const laneStart = (lane?: string) =>
    laneWidths
      .slice(0, lane ? lanes.indexOf(lane) : lanes.length)
      .reduce((a, b) => a + b, 0);
  const occupied = new Set<string>();
  const positions = new Map<string, { column: number; row: number }>();
  for (const node of nodes)
    if (node.column !== undefined && node.row !== undefined) {
      const key = `${node.column}:${node.row}`;
      if (occupied.has(key))
        throw new Error(
          'INVALID_DIAGRAM: two nodes occupy the same manual grid cell',
        );
      occupied.add(key);
      positions.set(node.ref, { column: node.column, row: node.row });
    }
  const ordered = [
    ...nodes.filter((n) => primary.has(n.ref)),
    ...nodes.filter((n) => !primary.has(n.ref)),
  ].sort(
    (a, b) =>
      Number(primary.has(b.ref)) - Number(primary.has(a.ref)) ||
      rank(a.ref) - rank(b.ref),
  );
  for (const node of ordered) {
    if (positions.has(node.ref)) continue;
    const parent = forward
      .filter((e) => e.targetRef === node.ref)
      .map((e) => positions.get(e.sourceRef))
      .find(Boolean);
    const inherited = parent
      ? direction === 'horizontal'
        ? parent.row
        : parent.column
      : baseline;
    const preferred = lanes.length
      ? laneStart(node.lane)
      : primary.has(node.ref)
        ? baseline
        : inherited;
    let minor = preferred;
    let column =
      node.column ?? (direction === 'horizontal' ? rank(node.ref) : minor);
    let row = node.row ?? (direction === 'vertical' ? rank(node.ref) : minor);
    let attempts = 0;
    while (occupied.has(`${column}:${row}`)) {
      if (++attempts > nodes.length * 2)
        throw new Error('INVALID_DIAGRAM: no free grid cell');
      minor = lanes.length
        ? preferred + attempts
        : attempts % 2
          ? Math.max(0, preferred - Math.ceil(attempts / 2))
          : preferred + attempts / 2;
      if (node.row === undefined && direction === 'horizontal') row = minor;
      else if (node.column === undefined) column = minor;
      else row = minor;
    }
    occupied.add(`${column}:${row}`);
    positions.set(node.ref, { column, row });
  }
  return positions;
}
const colorFor = (kind: Workflow['nodes'][number]['kind']) =>
  kind === 'start'
    ? 'blue'
    : kind === 'decision'
      ? 'yellow'
      : kind === 'end'
        ? 'green'
        : kind === 'exception'
          ? 'orange'
          : 'blue';
function internalRef(refs: string[], prefix: string) {
  let result = prefix;
  while (refs.includes(result)) result += '_';
  return result;
}
export function assertCanvasBounds(x: number, y: number, width: number, height: number) {
  if (x < -nativeCoordinateLimit || y < -nativeCoordinateLimit ||
      x + width > nativeCoordinateLimit || y + height > nativeCoordinateLimit)
    throw new Error(
      'INVALID_DIAGRAM: layout exceeds canvas coordinate bounds. Move the origin inward to keep the complete diagram within -1000000 to 1000000.',
    );
}
export function composeWorkflow(
  input: Workflow,
  dimensions?: { width: number; height: number },
) {
  const positions = layoutGraph(input.nodes, input.edges, input.direction);
  const frame = internalRef(
    input.nodes.map((n) => n.ref),
    '__workflow',
  );
  const nodeWidth =
    dimensions?.width ?? (input.notation === 'sticky' ? 208 : 240);
  const nodeHeight =
    dimensions?.height ?? (input.notation === 'sticky' ? 208 : 144);
  const columnGap = Math.max(input.columnGap, nodeWidth + 120);
  const rowGap = Math.max(input.rowGap, nodeHeight + 72);
  const maxColumn = Math.max(...[...positions.values()].map((p) => p.column));
  const maxRow = Math.max(...[...positions.values()].map((p) => p.row));
  const width = Math.max(600, maxColumn * columnGap + nodeWidth + 160);
  const height = Math.max(400, maxRow * rowGap + nodeHeight + 180);
  if (width > 20_000 || height > 20_000)
    throw new Error(
      'INVALID_DIAGRAM: workflow frame exceeds 20000 pixels. Reduce row/column gaps or split the diagram into sections.',
    );
  assertCanvasBounds(input.x, input.y, width, height);
  const operations: NativeOperation[] = [
    {
      type: 'create_frame',
      ref: frame,
      title: input.title,
      x: input.x,
      y: input.y,
      width,
      height,
    },
  ];
  const lanes = [
    ...new Set(
      input.nodes.map((n) => n.lane).filter((n): n is string => Boolean(n)),
    ),
  ];
  for (const lane of lanes) {
    const cells = input.nodes
      .filter((n) => n.lane === lane)
      .map((n) => positions.get(n.ref)!);
    if (input.direction === 'horizontal')
      operations.push({
        type: 'create_text',
        frameRef: frame,
        text: lane,
        x: input.x + 50,
        y: input.y + 55 + Math.min(...cells.map((p) => p.row)) * rowGap,
        width: width - 100,
        height: 28,
        fontSize: 18,
        bold: true,
      });
    else
      operations.push({
        type: 'create_text',
        frameRef: frame,
        text: lane,
        x: input.x + 60 + Math.min(...cells.map((p) => p.column)) * columnGap,
        y: input.y + 45,
        width: nodeWidth,
        height: 28,
        fontSize: 18,
        bold: true,
      });
  }
  for (const node of input.nodes) {
    const cell = positions.get(node.ref)!;
    const x = input.x + 60 + cell.column * columnGap;
    const y = input.y + 100 + cell.row * rowGap;
    operations.push(
      input.notation === 'sticky'
        ? {
            type: 'create_note',
            ref: node.ref,
            frameRef: frame,
            text: node.label,
            color: node.color ?? colorFor(node.kind),
            x,
            y,
          }
        : {
            type: 'create_shape',
            ref: node.ref,
            frameRef: frame,
            text: node.label,
            shape:
              node.kind === 'decision'
                ? 'diamond'
                : node.kind === 'start' || node.kind === 'end'
                  ? 'ellipse'
                  : 'roundedRect',
            x,
            y,
            width: nodeWidth,
            height: nodeHeight,
          },
    );
  }
  for (const edge of input.edges) {
    const a = positions.get(edge.sourceRef)!;
    const b = positions.get(edge.targetRef)!;
    const forward =
      input.direction === 'horizontal' ? b.column > a.column : b.row > a.row;
    const reverse =
      input.direction === 'horizontal' ? b.column <= a.column : b.row <= a.row;
    const minorDelta =
      input.direction === 'horizontal' ? b.row - a.row : b.column - a.column;
    const defaultSource = forward
      ? minorDelta === 0
        ? input.direction === 'horizontal'
          ? 'right'
          : 'bottom'
        : input.direction === 'horizontal'
          ? minorDelta > 0
            ? 'bottom'
            : 'top'
          : minorDelta > 0
            ? 'right'
            : 'left'
      : input.direction === 'horizontal'
        ? minorDelta >= 0
          ? 'top'
          : 'bottom'
        : minorDelta >= 0
          ? 'left'
          : 'right';
    const defaultTarget = forward
      ? minorDelta === 0
        ? input.direction === 'horizontal'
          ? 'left'
          : 'top'
        : input.direction === 'horizontal'
          ? minorDelta > 0
            ? 'top'
            : 'bottom'
          : minorDelta > 0
            ? 'left'
            : 'right'
      : defaultSource;
    operations.push({
      type: 'create_connector',
      ...edge,
      sourceAnchor:
        edge.sourceAnchor ??
        (edge.sourceRef === edge.targetRef ? 'right' : defaultSource),
      targetAnchor:
        edge.targetAnchor ??
        (edge.sourceRef === edge.targetRef ? 'top' : defaultTarget),
      style: reverse ? 'curve' : 'orthogonal',
      labelPosition: edge.labelPosition ?? (reverse ? 0.65 : 0.5),
    });
  }
  if (operations.length > 100)
    throw new Error(
      'Diagram exceeds 100 operations including lane headings; reduce nodes, edges, or lanes',
    );
  return {
    operations,
    layout: {
      width,
      height,
      positions: Object.fromEntries(positions),
      direction: input.direction,
      notation: input.notation,
      warnings: input.nodes
        .filter((n) => n.label.length > 180)
        .map(
          (n) =>
            `Shorten the label for ${n.ref} or use an accompanying document for details`,
        ),
    },
  };
}

export const compositionSchema = z.object({
  title: requiredNativeText(240),
  layout: z
    .enum(['columns', 'story_map', 'matrix', 'comparison'])
    .default('columns'),
  groups: z.array(requiredNativeText(120)).min(1).max(12),
  rows: z.array(requiredNativeText(120)).max(12).optional(),
  items: z
    .array(
      z.object({
        ref: ref.optional(),
        id: ref.optional(),
        title: requiredNativeText(240),
        description: z.string().max(2000).default(''),
        group: z.string().max(120),
        row: z.string().max(120).optional(),
        color: noteColor.optional(),
        owner: z.string().max(120).optional(),
        estimate: z.number().min(0).max(10000).optional(),
        status: z.string().max(80).optional(),
        highlight: z.boolean().default(false).describe(
          'Mark a selected option. Existing objects receive an editable Selected label without changing their styling; new stickies are green and new cards show Selected priority.',
        ),
      }),
    )
    .max(60),
  itemStyle: z.enum(['sticky', 'card']).default('sticky'),
  x: nativePosition.default(100),
  y: nativePosition.default(100),
});
export function composeBoard(input: z.infer<typeof compositionSchema>) {
  if (
    new Set(input.groups).size !== input.groups.length ||
    (input.rows && new Set(input.rows).size !== input.rows.length)
  )
    throw new Error('Group and row names must be unique');
  const rows =
    input.layout === 'columns' || input.layout === 'comparison'
      ? ['']
      : input.rows;
  if (!rows?.length)
    throw new Error('Matrix and story map layouts need row names');
  for (const item of input.items)
    if (
      !input.groups.includes(item.group) ||
      (rows[0] !== '' && (!item.row || !rows.includes(item.row)))
    )
      throw new Error('Each item must match a group and row');
  const duplicateIds = input.items.flatMap((i) => (i.id ? [i.id] : []));
  if (new Set(duplicateIds).size !== duplicateIds.length)
    throw new Error('An existing item can appear only once');
  const ops: NativeOperation[] = [];
  const itemRefs = input.items.flatMap((i) => (i.ref ? [i.ref] : []));
  if (new Set(itemRefs).size !== itemRefs.length)
    throw new Error('Each composition item reference must be unique');
  if (itemRefs.some(itemRef => duplicateIds.includes(itemRef)))
    throw new Error('New item references must not match existing item IDs');
  const cellWidth =
    input.itemStyle === 'card' ? 872 : input.layout === 'matrix' ? 740 : 620;
  const columns = 2;
  const itemWidth = input.itemStyle === 'card' ? 360 : 208;
  const itemHeight = input.itemStyle === 'card' ? 240 : 208;
  const counts = rows.map((row) =>
    Math.max(
      0,
      ...input.groups.map(
        (group) =>
          input.items.filter(
            (i) => i.group === group && (row === '' || i.row === row),
          ).length,
      ),
    ),
  );
  const heights = counts.map((count) =>
    Math.max(400, 100 + Math.ceil(count / columns) * (itemHeight + 44)),
  );
  rows.forEach((row, ri) =>
    input.groups.forEach((group, gi) => {
      const x = input.x + gi * (cellWidth + 48);
      const y =
        input.y + 120 + heights.slice(0, ri).reduce((a, h) => a + h + 48, 0);
      const frame = internalRef(
        [
          ...itemRefs,
          ...ops.flatMap((op) => ('ref' in op && op.ref ? [op.ref] : [])),
        ],
        `__cell_${ri}_${gi}`,
      );
      assertCanvasBounds(x, y, cellWidth, heights[ri]);
      ops.push({
        type: 'create_frame',
        ref: frame,
        title: row ? `${row} · ${group}` : group,
        x,
        y,
        width: cellWidth,
        height: heights[ri],
      });
      input.items
        .filter((i) => i.group === group && (row === '' || i.row === row))
        .forEach((item, ii) => {
          const ix =
            x + 44 + (ii % columns) * (input.itemStyle === 'card' ? 392 : 280);
          const iy = y + 70 + Math.floor(ii / columns) * (itemHeight + 44);
          if (item.id) {
            ops.push(
              { type: 'move_element', id: item.id, x: ix, y: iy, frameRef: frame },
            );
            if (item.highlight)
              ops.push({
                type: 'create_text',
                frameRef: frame,
                text: 'Selected',
                x: ix,
                y: iy - 28,
                width: 180,
                height: 24,
                fontSize: 16,
                bold: true,
              });
          } else
            ops.push(
              input.itemStyle === 'card'
                ? {
                    type: 'create_card',
                    ref: item.ref,
                    frameRef: frame,
                    title: item.title,
                    description: item.description,
                    owner: item.owner,
                    estimate: item.estimate,
                    status: item.status,
                    priority: item.highlight ? 'Selected' : undefined,
                    x: ix,
                    y: iy,
                    width: itemWidth,
                    height: itemHeight,
                  }
                : {
                    type: 'create_note',
                    ref: item.ref,
                    frameRef: frame,
                    text: [item.title, item.description]
                      .filter(Boolean)
                      .join('\n\n'),
                    color: item.highlight
                      ? 'green'
                      : (item.color ??
                        (
                          [
                            'yellow',
                            'blue',
                            'purple',
                            'green',
                            'orange',
                          ] as const
                        )[gi % 5]),
                    x: ix,
                    y: iy,
                  },
            );
        });
    }),
  );
  assertCanvasBounds(input.x, input.y, input.groups.length * (cellWidth + 48), 42);
  ops.unshift({
    type: 'create_text',
    text: input.title,
    x: input.x,
    y: input.y,
    width: input.groups.length * (cellWidth + 48),
    height: 42,
    fontSize: 32,
    bold: true,
  });
  if (ops.length > 100)
    throw new Error(
      'Composition exceeds 100 operations; use smaller groups or a second batch',
    );
  return ops;
}

export const entitySchema = z.object({
  title: z.string().max(240).default('Entity relationships'),
  entities: z
    .array(
      z.object({
        ref,
        name: requiredNativeText(120),
        attributes: z.array(z.string().max(160)).max(20),
      }),
    )
    .min(1)
    .max(20),
  relationships: z
    .array(
      z.object({ sourceRef: ref, targetRef: ref, label: z.string().max(160) }),
    )
    .max(40),
  x: nativePosition.default(100),
  y: nativePosition.default(100),
});
export function composeEntities(input: z.infer<typeof entitySchema>) {
  const nodeHeight = Math.max(
    180,
    ...input.entities.map((e) => 80 + e.attributes.length * 28),
  );
  const workflow = workflowSchema.parse({
    title: input.title,
    notation: 'flowchart',
    nodes: input.entities.map((e) => ({
      ref: e.ref,
      label: [e.name, '────────────', ...e.attributes].join('\n'),
    })),
    edges: input.relationships,
    x: input.x,
    y: input.y,
    rowGap: Math.max(500, nodeHeight + 100),
    columnGap: 420,
  });
  const result = composeWorkflow(workflow, { width: 300, height: nodeHeight });
  for (const op of result.operations) {
    if (op.type === 'create_shape') {
      op.fontSize = 18;
    }
  }
  return result.operations;
}
export const sequenceSchema = z.object({
  title: z.string().max(240).default('Sequence'),
  participants: z
    .array(z.object({ ref, name: requiredNativeText(120) }))
    .min(2)
    .max(10),
  messages: z
    .array(
      z.object({
        from: ref,
        to: ref,
        label: requiredNativeText(160),
        response: z.boolean().default(false),
      }),
    )
    .min(1)
    .max(25),
  x: nativePosition.default(100),
  y: nativePosition.default(100),
});
export function composeSequence(input: z.infer<typeof sequenceSchema>) {
  const ids = new Set(input.participants.map((p) => p.ref));
  if (
    ids.size !== input.participants.length ||
    input.messages.some((m) => !ids.has(m.from) || !ids.has(m.to))
  )
    throw new Error(
      'Sequence participants must be unique and every message must reference one',
    );
  const frame = internalRef([...ids], '__sequence');
  const width = input.participants.length * 320 + 100;
  const height = input.messages.length * 100 + 220;
  assertCanvasBounds(input.x, input.y, width, height);
  const ops: NativeOperation[] = [
    {
      type: 'create_frame',
      ref: frame,
      title: input.title,
      x: input.x,
      y: input.y,
      width,
      height,
    },
  ];
  input.participants.forEach((p, index) =>
    ops.push({
      type: 'create_shape',
      ref: p.ref,
      frameRef: frame,
      text: p.name,
      x: input.x + 70 + index * 320,
      y: input.y + 60,
      width: 240,
      height: 64,
    }),
  );
  const anchorRefs = new Map<string, string>();
  const point = (participant: string, step: number) => {
    const key = JSON.stringify([participant, step]);
    if (anchorRefs.has(key)) return anchorRefs.get(key)!;
    const generated = internalRef(
      [...ids, frame, ...anchorRefs.values()],
      `__point_${anchorRefs.size}`,
    );
    const index = input.participants.findIndex((p) => p.ref === participant);
    ops.push({
      type: 'create_shape',
      ref: generated,
      frameRef: frame,
      text: '',
      shape: 'rect',
      x: input.x + 182 + index * 320,
      y: input.y + 170 + step * 100,
      width: 16,
      height: 16,
    });
    anchorRefs.set(key, generated);
    return generated;
  };
  // One frame-bound lifeline per participant avoids per-message segments and
  // terminal helpers. Keep these behind the message anchors and arrows.
  input.participants.forEach((p, index) => ops.push({
    type: 'create_connector',
    sourceRef: p.ref,
    targetRef: frame,
    sourceAnchor: 'bottom',
    targetAnchor: [(190 + index * 320) / width, (height - 42) / height],
    style: 'straight',
    dashed: true,
    arrow: false,
  }));
  input.messages.forEach((m, index) => {
    const source = point(m.from, index);
    const target = point(m.to, m.from === m.to ? index + 0.8 : index);
    ops.push({
      type: 'create_connector',
      sourceRef: source,
      targetRef: target,
      label: `${index + 1}. ${m.label}`,
      style: m.from === m.to ? 'curve' : 'straight',
      dashed: m.response,
      sourceAnchor: m.from === m.to ? 'right' : undefined,
      targetAnchor: m.from === m.to ? 'right' : undefined,
    });
  });
  if (ops.length > 100)
    throw new Error('Sequence exceeds 100 objects; split into sections');
  return ops;
}
