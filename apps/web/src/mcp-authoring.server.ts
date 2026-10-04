import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  assertCanvasBounds,
  composeBoard,
  compositionSchema,
  composeEntities,
  entitySchema,
  composeSequence,
  sequenceSchema,
  composeWorkflow,
  workflowSchema,
} from './board-composer';
import { AUTHORING_GUIDE } from './mcp-authoring-guide';
import type {
  readNativeBoard,
  NativeOperation,
} from './native-operations.server';

type Semantic = {
  revision: number;
  updatedAt: string;
  board: Omit<ReturnType<typeof readNativeBoard>, 'blocks' | 'surfaceElements'>;
};
export type AuthoringContext = {
  authorize: (scope: 'boards:read' | 'boards:write') => void;
  read: (boardId: string) => Promise<Semantic>;
  execute: (
    boardId: string,
    operationId: string,
    operations: NativeOperation[],
    revision?: number,
  ) => Promise<unknown>;
  search: (query: string, offset: number) => Promise<unknown>;
  upload: (
    boardId: string,
    data: string,
    contentType: string,
  ) => Promise<unknown>;
  image: (
    boardId: string,
    sourceId: string,
    includeData: boolean,
  ) => Promise<{
    sourceId: string;
    contentType: string;
    size: number;
    data?: string;
  }>;
  url: (boardId: string) => string;
};
const boardId = z.string().min(1).max(160);
const mutation = {
  boardId,
  operationId: z.string().min(1).max(160),
  expectedRevision: z.number().int().positive().optional(),
};
function result(value: unknown) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }],
    structuredContent: value as Record<string, unknown>,
  };
}
function security(...scopes: string[]) {
  return { securitySchemes: [{ type: 'oauth2' as const, scopes }] };
}
/** Refit the outline without translating unrelated frame members. */
export function reuseFrameForLayout(
  board: Semantic['board'],
  frameId: string,
  layout: Extract<NativeOperation, { type: 'create_frame' }>,
  selectedIds: string[],
): NativeOperation[] {
  const frame = board.frames.find((f) => f.id === frameId);
  if (!frame) throw new Error('Frame not found');
  let x = layout.x;
  let y = layout.y;
  let right = x + layout.width;
  let bottom = y + layout.height;
  for (const id of frame.childIds) {
    const element = board.elements.find((e) => e.id === id);
    if (!element) continue;
    // Selected nodes will be placed inside layout; their old positions need not
    // enlarge the outline. Other members stay at their current coordinates.
    if (selectedIds.includes(id)) continue;
    try {
      const b: unknown = JSON.parse(element.xywh);
      if (
        !Array.isArray(b) || b.length !== 4 ||
        !b.every((v) => typeof v === 'number' && Number.isFinite(v)) ||
        b[2] <= 0 || b[3] <= 0
      ) continue;
      x = Math.min(x, b[0]);
      y = Math.min(y, b[1]);
      right = Math.max(right, b[0] + b[2]);
      bottom = Math.max(bottom, b[1] + b[3]);
    } catch { /* Unsupported content has no usable canvas bounds. */ }
  }
  if (right - x > 20_000 || bottom - y > 20_000)
    throw new Error('INVALID_DIAGRAM: reused frame exceeds 20000 pixels. Choose a closer layout origin or create a new frame to preserve distant context.');
  assertCanvasBounds(x, y, right - x, bottom - y);
  return [
    { type: 'move_element', id: frameId, x, y, moveContents: false },
    { type: 'resize_element', id: frameId, width: right - x, height: bottom - y },
  ];
}
export function inspectNativeBoard(board: Semantic['board']) {
  const parse = (value: string) => {
    try {
      const a = JSON.parse(value) as number[];
      return a.length === 4 && a.every(Number.isFinite) ? a : [0, 0, 0, 0];
    } catch {
      return [0, 0, 0, 0];
    }
  };
  const nodes = board.elements.filter(
    (e) =>
      !['frame', 'connector', 'table'].includes(e.type) && parse(e.xywh)[2] > 0,
  );
  const issues: { kind: string; ids: string[]; detail: string }[] = [];
  for (let i = 0; i < nodes.length; i++)
    for (let j = i + 1; j < nodes.length; j++) {
      const a = parse(nodes[i].xywh);
      const b = parse(nodes[j].xywh);
      if (
        Math.min(a[0] + a[2], b[0] + b[2]) - Math.max(a[0], b[0]) > 8 &&
        Math.min(a[1] + a[3], b[1] + b[3]) - Math.max(a[1], b[1]) > 8
      )
        issues.push({
          kind: 'overlap',
          ids: [nodes[i].id, nodes[j].id],
          detail:
            'Canvas objects overlap; inspect whether this is intentional.',
        });
    }
  const ids = new Set(board.elements.map((e) => e.id));
  for (const c of board.connectors)
    for (const endpoint of [c.source, c.target])
      if (
        endpoint &&
        typeof endpoint === 'object' &&
        'id' in endpoint &&
        !ids.has(String(endpoint.id))
      )
        issues.push({
          kind: 'dangling_connector',
          ids: [c.id, String(endpoint.id)],
          detail: 'A connector endpoint no longer exists.',
        });
  for (const frame of board.frames) {
    const f = parse(frame.xywh);
    for (const id of frame.childIds) {
      const node = nodes.find((n) => n.id === id);
      if (!node) continue;
      const n = parse(node.xywh);
      if (
        n[0] < f[0] ||
        n[1] < f[1] ||
        n[0] + n[2] > f[0] + f[2] ||
        n[1] + n[3] > f[1] + f[3]
      )
        issues.push({
          kind: 'outside_frame',
          ids: [frame.id, id],
          detail: 'Frame member extends outside its frame.',
        });
    }
  }
  return {
    counts: {
      notes: board.notes.length,
      shapes: board.shapes.length,
      texts: board.texts.length,
      tables: board.tables.length,
      images: board.images.length,
      frames: board.frames.length,
      connectors: board.connectors.length,
    },
    issues,
    checks: ['object overlap', 'frame containment', 'bound endpoint existence'],
    limitation:
      'Geometry checks do not establish text legibility or absence of connector crossings. Inspect the rendered board.',
  };
}
export function registerAuthoringTools(
  server: McpServer,
  context: AuthoringContext,
) {
  server.registerTool(
    'get_authoring_guide',
    {
      title: 'Huddle Loom authoring guide',
      description:
        'Start here: installed capabilities, recipes for complete boards, native editing semantics, tool limits, and exact collaboration value fields.',
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true },
      _meta: security('boards:read'),
    },
    async () => {
      context.authorize('boards:read');
      return result(AUTHORING_GUIDE);
    },
  );
  server.registerTool(
    'search_boards',
    {
      title: 'Search board content',
      description:
        'Search accessible board titles and all native canvas text. Pages scan up to 40 boards; continue with nextOffset until null.',
      inputSchema: z.object({
        query: z.string().min(1).max(120),
        offset: z.number().int().min(0).default(0),
      }),
      annotations: { readOnlyHint: true },
      _meta: security('boards:read'),
    },
    async ({ query, offset }) => result(await context.search(query, offset)),
  );
  server.registerTool(
    'search_board',
    {
      title: 'Find board objects',
      description:
        'Search and paginate native objects by text, type or frame. Empty query pages all objects. Returns stable IDs, bounds, excerpts and the revision. Tables expose containerId: use that for moving, resizing, frame assignment or deleting the entire table; use id for cell edits.',
      inputSchema: z.object({
        boardId,
        query: z.string().max(120).default(''),
        type: z.string().max(80).optional(),
        frameId: boardId.optional(),
        offset: z.number().int().min(0).default(0),
        limit: z.number().int().min(1).max(100).default(40),
      }),
      annotations: { readOnlyHint: true },
      _meta: security('boards:read'),
    },
    async ({ boardId, query, type, frameId, offset, limit }) => {
      const data = await context.read(boardId);
      const matches = data.board.elements.filter(
        (e) =>
          (!query ||
            e.text.toLocaleLowerCase().includes(query.toLocaleLowerCase())) &&
          (!type || e.type === type) &&
          (!frameId || e.frameIds.includes(frameId)),
      );
      return result({
        revision: data.revision,
        total: matches.length,
        nextOffset: offset + limit < matches.length ? offset + limit : null,
        elements: matches.slice(offset, offset + limit),
      });
    },
  );
  const composed = async (
    id: string,
    operationId: string,
    ops: NativeOperation[],
    revision?: number,
  ) => ({
    receipt: await context.execute(id, operationId, ops, revision),
    url: context.url(id),
  });
  server.registerTool(
    'compose_board',
    {
      title: 'Compose a workshop or plan',
      description:
        'Create a complete native board arrangement: columns for retros/ideation/sprints, matrix for prioritization, story_map for activities by release, comparison for alternatives. items with id reorganize originals; items without id create stickies or cards. Highlighted originals receive an editable Selected label without changing their styling. Every item must match groups and rows; headings, frames, movements and highlight labels share the 100-command limit.',
      inputSchema: compositionSchema.extend(mutation),
      annotations: { readOnlyHint: false, idempotentHint: true },
      _meta: security('boards:write'),
    },
    async ({ boardId, operationId, expectedRevision, ...input }) =>
      result(
        await composed(
          boardId,
          operationId,
          composeBoard(input),
          expectedRevision,
        ),
      ),
  );
  server.registerTool(
    'create_entity_diagram',
    {
      title: 'Create an entity diagram',
      description:
        'Draw native editable entity boxes containing names and attributes, with labeled bound relationships. Supply cardinality in each relationship label.',
      inputSchema: entitySchema.extend(mutation),
      annotations: { readOnlyHint: false, idempotentHint: true },
      _meta: security('boards:write'),
    },
    async ({ boardId, operationId, expectedRevision, ...input }) =>
      result(
        await composed(
          boardId,
          operationId,
          composeEntities(input),
          expectedRevision,
        ),
      ),
  );
  server.registerTool(
    'create_sequence_diagram',
    {
      title: 'Create a sequence diagram',
      description:
        'Draw editable participant headers, lifelines and ordered messages. Messages use participant refs; response messages are dashed. Self messages render as return loops.',
      inputSchema: sequenceSchema.extend(mutation),
      annotations: { readOnlyHint: false, idempotentHint: true },
      _meta: security('boards:write'),
    },
    async ({ boardId, operationId, expectedRevision, ...input }) =>
      result(
        await composed(
          boardId,
          operationId,
          composeSequence(input),
          expectedRevision,
        ),
      ),
  );
  server.registerTool(
    'inspect_board',
    {
      title: 'Inspect board layout',
      description:
        'Check object overlaps, dangling connectors and frame containment. Review rendered text and connectors separately. Use after composing and before declaring the board complete.',
      inputSchema: z.object({ boardId }),
      annotations: { readOnlyHint: true },
      _meta: security('boards:read'),
    },
    async ({ boardId }) => {
      const data = await context.read(boardId);
      return result({
        revision: data.revision,
        ...inspectNativeBoard(data.board),
        url: context.url(boardId),
      });
    },
  );
  server.registerTool(
    'relayout_workflow',
    {
      title: 'Arrange existing workflow nodes',
      description:
        'Automatically reorganize selected existing sticky or shape nodes and their connections. Preserve native IDs, text and styling; optional frameId reuses an existing frame. Reject a stale board revision.',
      inputSchema: z.object({
        ...mutation,
        nodeIds: z.array(boardId).min(1).max(30),
        frameId: boardId.optional(),
        direction: z.enum(['horizontal', 'vertical']).default('horizontal'),
        x: z.number().finite().default(100),
        y: z.number().finite().default(100),
      }),
      annotations: { readOnlyHint: false, idempotentHint: true },
      _meta: security('boards:read', 'boards:write'),
    },
    async ({
      boardId,
      operationId,
      expectedRevision,
      nodeIds,
      frameId,
      direction,
      x,
      y,
    }) => {
      if (new Set(nodeIds).size !== nodeIds.length)
        throw new Error('Node IDs must be unique');
      const data = await context.read(boardId);
      const dimensions = { width: 208, height: 208 };
      const nodes = nodeIds.map((id) => {
        const node = data.board.elements.find((e) => e.id === id);
        if (!node || !['note', 'shape'].includes(node.type))
          throw new Error('Relayout requires sticky or shape node IDs');
        const bounds = JSON.parse(node.xywh) as number[];
        dimensions.width = Math.max(dimensions.width, bounds[2]);
        dimensions.height = Math.max(dimensions.height, bounds[3]);
        // Layout placeholders never replace the original object's text.
        return { ref: id, label: node.text.trim().slice(0, 2000) || 'Untitled', kind: 'action' as const };
      });
      const edges = data.board.connectors
        .filter(
          (c) =>
            nodeIds.includes(String((c.source as { id?: string })?.id)) &&
            nodeIds.includes(String((c.target as { id?: string })?.id)),
        )
        .map((c) => ({
          sourceRef: String((c.source as { id: string }).id),
          targetRef: String((c.target as { id: string }).id),
          label: c.label,
          id: c.id,
        }));
      const layout = composeWorkflow(
        workflowSchema.parse({ nodes, edges, direction, x, y }),
        dimensions,
      );
      const frameOp = layout.operations[0];
      if (frameOp.type !== 'create_frame')
        throw new Error('Missing layout frame');
      if (frameId && !data.board.frames.some((f) => f.id === frameId))
        throw new Error('Frame not found');
      const ops: NativeOperation[] = frameId
        ? reuseFrameForLayout(data.board, frameId, frameOp, nodeIds)
        : [frameOp];
      for (const op of layout.operations)
        if (op.type === 'create_note')
          ops.push({
            type: 'move_element', id: op.ref!, x: op.x, y: op.y,
            frameRef: frameId ?? frameOp.ref!,
          });
      layout.operations
        .filter(
          (op): op is Extract<NativeOperation, { type: 'create_connector' }> =>
            op.type === 'create_connector',
        )
        .forEach((op, index) =>
          ops.push({
            type: 'update_connector',
            id: edges[index].id,
            sourceAnchor: op.sourceAnchor,
            targetAnchor: op.targetAnchor,
            style: op.style,
          }),
        );
      return result(
        await composed(
          boardId,
          operationId,
          ops,
          expectedRevision ?? data.revision,
        ),
      );
    },
  );
  server.registerTool(
    'upload_image',
    {
      title: 'Upload a board image',
      description:
        'Upload PNG, JPEG or WebP base64 bytes (maximum 512 KB), scoped to an editable board. Returns sourceId for create_image in batch_edit_board. Exact bytes deduplicate by SHA-256.',
      inputSchema: z.object({
        boardId,
        data: z.string().min(1).max(700_000),
        contentType: z.enum(['image/png', 'image/jpeg', 'image/webp']),
      }),
      annotations: { readOnlyHint: false, idempotentHint: true },
      _meta: security('boards:write'),
    },
    async ({ boardId, data, contentType }) =>
      result(await context.upload(boardId, data, contentType)),
  );
  server.registerTool(
    'get_image',
    {
      title: 'Read a board image',
      description:
        'Read metadata and optionally base64 bytes for an image that belongs to this board. Data reads are limited to 512 KB; metadata works for larger images.',
      inputSchema: z.object({
        boardId,
        sourceId: z.string().regex(/^[A-Za-z0-9_-]{43}=?$/u),
        includeData: z.boolean().default(false),
      }),
      annotations: { readOnlyHint: true },
      _meta: security('boards:read'),
    },
    async ({ boardId, sourceId, includeData }) => {
      const { data, ...metadata } = await context.image(
        boardId,
        sourceId,
        includeData,
      );
      const response = result(metadata);
      return data
        ? {
            ...response,
            content: [
              ...response.content,
              { type: 'image' as const, data, mimeType: metadata.contentType },
            ],
          }
        : response;
    },
  );
  server.registerPrompt(
    'workflow',
    {
      title: 'Map a workflow',
      description: 'Compose and verify an editable process board.',
      argsSchema: { description: z.string(), boardId: z.string().optional() },
    },
    ({ description, boardId }) => ({
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text: `Map this workflow${boardId ? ` on board ${boardId}` : ' on a new board'}: ${description}\nRead the Huddle Loom authoring guide. Include branches, outcomes, responsibility lanes and retries present in the description. Create native sticky notes and bound labeled arrows. Inspect the board, fix material layout issues, and return its link. Label assumptions.`,
          },
        },
      ],
    }),
  );
  server.registerPrompt(
    'workshop',
    {
      title: 'Prepare a workshop',
      description: 'Create an editable session board with facilitation tools.',
      argsSchema: { brief: z.string() },
    },
    ({ brief }) => ({
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text: `Prepare this workshop: ${brief}\nUse get_authoring_guide and compose_board, then inspect_board. Create labeled zones and editable notes or planning cards. Set up voting or a timer if requested. Return a board link and facilitation instructions.`,
          },
        },
      ],
    }),
  );
}
