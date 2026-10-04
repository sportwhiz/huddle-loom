import {developmentMcpCredentials} from './dev-mcp-credentials.mjs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const endpointInput =
  process.argv.slice(2).find(value => /^https?:\/\//u.test(value)) ??
  'http://127.0.0.1:5175/mcp';
const endpointUrl = new URL(endpointInput);
if (endpointUrl.pathname === '/') endpointUrl.pathname = '/mcp';
const endpoint = endpointUrl.toString();
const keepBoard = process.argv.includes('--keep');
const client = new Client({ name: 'whiteboard-smoke', version: '0.1.0' });
const authorization = await developmentMcpCredentials(endpoint);
const transport = new StreamableHTTPClientTransport(new URL(endpoint), {requestInit:{headers:authorization.headers}});
let createdBoardId;

function parsed(result) {
  const text = result.content?.find(item => item.type === 'text')?.text;
  if (!text) throw new Error('Tool returned no JSON text');
  return JSON.parse(text);
}

await client.connect(transport);
try {
  const tools = await client.listTools();
  const requiredTools = ['get_profile', 'list_workbooks', 'list_boards', 'get_board', 'create_board', 'batch_edit_board', 'add_notes', 'create_workflow', 'export_board', 'get_collaboration', 'collaboration_command'];
  for (const name of requiredTools) if (!tools.tools.some(tool => tool.name === name)) throw new Error(`Missing MCP tool: ${name}`);
  const catalog = parsed(await client.callTool({ name: 'list_workbooks', arguments: {} }));
  const workbookId = catalog.workbooks[0]?.id;
  if (!workbookId) throw new Error('No workbook available');

  const created = parsed(
    await client.callTool({
      name: 'create_board',
      arguments: { workbookId, title: 'MCP closed-browser proof' },
    })
  );
  createdBoardId = created.id;
  const workflowArgs = {
    boardId: created.id,
    operationId: 'mcp-smoke-workflow-v1',
    title: 'Approval workflow',
    nodes: [
      { ref: 'request', label: 'Request submitted', color: 'yellow', column: 0, row: 1 },
      { ref: 'review', label: 'Review request', color: 'blue', column: 1, row: 1 },
      { ref: 'approve', label: 'Approved', color: 'green', column: 2, row: 0 },
      { ref: 'revise', label: 'Needs changes', color: 'orange', column: 2, row: 2 },
    ],
    edges: [
      { sourceRef: 'request', targetRef: 'review', label: 'Next' },
      { sourceRef: 'review', targetRef: 'approve', label: 'Yes' },
      { sourceRef: 'review', targetRef: 'revise', label: 'No', labelPosition: 0.35 },
      { sourceRef: 'revise', targetRef: 'review', label: 'Changes made', sourceAnchor: 'bottom', targetAnchor: 'bottom', labelPosition: 0.55 },
    ],
  };
  const receipt = parsed(
    await client.callTool({ name: 'create_workflow', arguments: workflowArgs })
  );
  const retried = parsed(
    await client.callTool({ name: 'create_workflow', arguments: workflowArgs })
  );
  if (JSON.stringify(receipt) !== JSON.stringify(retried)) {
    throw new Error('Idempotent retry returned a different receipt');
  }

  const board = parsed(
    await client.callTool({
      name: 'get_board',
      arguments: { boardId: created.id },
    })
  );
  if (board.board.notes.length !== 4 || board.board.connectors.length !== 4) {
    throw new Error(
      `Unexpected semantic counts: ${board.board.notes.length} notes, ${board.board.connectors.length} connectors`
    );
  }
  const noteByText = new Map(board.board.notes.map(note => [note.text, JSON.parse(note.xywh)]));
  const reviewPosition = noteByText.get('Review request');
  const approvedPosition = noteByText.get('Approved');
  const revisePosition = noteByText.get('Needs changes');
  if (!reviewPosition || !approvedPosition || !revisePosition || approvedPosition[0] !== revisePosition[0] || approvedPosition[1] >= reviewPosition[1] || revisePosition[1] <= reviewPosition[1]) {
    throw new Error('Branched workflow nodes were not placed in the requested grid');
  }
  const labels = new Set(board.board.connectors.map(connector => connector.label));
  for (const label of ['Yes', 'No', 'Changes made']) if (!labels.has(label)) throw new Error(`Missing directed workflow label: ${label}`);
  if (board.board.connectors.some(connector => connector.label && !Array.isArray(connector.labelXYWH))) throw new Error('A workflow connector label has no renderable canvas bounds');

  let invalidRejected = false;
  try {
    const invalid = await client.callTool({
      name: 'batch_edit_board',
      arguments: {
        boardId: created.id,
        operationId: 'mcp-smoke-invalid-v1',
        expectedRevision: board.revision,
        operations: [
          {
            type: 'create_connector',
            sourceRef: 'missing-source',
            targetRef: board.board.notes[0].id,
          },
        ],
      },
    });
    invalidRejected = invalid.isError === true;
  } catch {
    invalidRejected = true;
  }
  if (!invalidRejected) throw new Error('Invalid batch was accepted');
  const afterInvalid = parsed(
    await client.callTool({ name: 'get_board', arguments: { boardId: created.id } })
  );
  if (
    afterInvalid.revision !== board.revision ||
    afterInvalid.board.notes.length !== board.board.notes.length ||
    afterInvalid.board.connectors.length !== board.board.connectors.length
  ) {
    throw new Error('Rejected batch changed the board');
  }

  process.stdout.write(
    `${JSON.stringify(
      {
        endpoint,
        tools: tools.tools.map(tool => tool.name),
        boardId: created.id,
        revision: receipt.revision,
        retryWasIdempotent: true,
        invalidBatchWasAtomic: true,
        branchedWorkflowLayout: true,
        directedLabeledArrows: true,
        notes: board.board.notes.length,
        connectors: board.board.connectors.length,
        frames: board.board.frames.length,
      },
      null,
      2
    )}\n`
  );
} finally {
  await client.close();
  await authorization.revoke();
  if (createdBoardId && !keepBoard) {
    const base = new URL(endpoint);
    await fetch(
      new URL(`/api/v1/boards/${encodeURIComponent(createdBoardId)}/catalog`, base),
      { method: 'DELETE' }
    ).catch(() => undefined);
  }
}
