import {developmentMcpCredentials} from './dev-mcp-credentials.mjs';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import * as Y from 'yjs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
const base =
  process.argv.find((value) => /^https?:\/\//u.test(value)) ??
  'http://127.0.0.1:5175';
const origin = new URL(base).origin;
const client = new Client({
  name: 'canvas-authoring-acceptance',
  version: '1.0',
});
const boards = [];
const proofs = [];
const keep = process.argv.includes('--keep');
function parsed(response) {
  if (response.isError)
    throw new Error(response.content?.find((c) => c.type === 'text')?.text);
  return (
    response.structuredContent ??
    JSON.parse(response.content.find((c) => c.type === 'text').text)
  );
}
const call = async (name, args) =>
  parsed(await client.callTool({ name, arguments: args }));
const reject = async (name, args) => {
  const result = await client.callTool({ name, arguments: args });
  assert.equal(result.isError, true, `${name} should reject`);
};
let workbookId;
const board = async (title) => {
  const created = await call('create_board', {
    workbookId,
    title: `MCP acceptance · ${title}`,
  });
  boards.push(created.id);
  return created.id;
};
const read = (id) => call('get_board', { boardId: id });
const inspect = async (id) => {
  const result = await call('inspect_board', { boardId: id });
  assert.deepEqual(result.issues, []);
  return result;
};
const authorization = await developmentMcpCredentials(origin);
await client.connect(
  new StreamableHTTPClientTransport(new URL('/mcp', origin), {requestInit:{headers:authorization.headers}}),
);
try {
  const discovery = await client.listTools();
  assert.equal(discovery.tools.length, 21);
  assert.ok(client.getInstructions().includes('get_authoring_guide'));
  const prompts = await client.listPrompts();
  assert.ok(prompts.prompts.some((p) => p.name === 'workflow'));
  const guide = await call('get_authoring_guide', {});
  assert.equal(guide.recipes.length, 10);
  const catalog = await call('list_workbooks', {});
  workbookId = catalog.workbooks[0].id;
  const workflow = await board('Refund workflow');
  const workflowArgs = {
    boardId: workflow,
    operationId: 'refund-v1',
    title: 'Refund process',
    nodes: [
      { ref: 'request', label: 'Receive refund request', kind: 'start' },
      { ref: 'eligible', label: 'Check refund eligibility', kind: 'decision' },
      { ref: 'approve', label: 'Review and approve', kind: 'decision' },
      { ref: 'details', label: 'Request missing details', kind: 'exception' },
      { ref: 'deny', label: 'Explain rejection', kind: 'end' },
      { ref: 'pay', label: 'Send refund' },
      { ref: 'retry', label: 'Resolve payment failure', kind: 'exception' },
      { ref: 'done', label: 'Notify customer\nRefund complete', kind: 'end' },
    ],
    edges: [
      { sourceRef: 'request', targetRef: 'eligible' },
      { sourceRef: 'eligible', targetRef: 'approve', label: 'Eligible' },
      { sourceRef: 'eligible', targetRef: 'deny', label: 'Not eligible' },
      { sourceRef: 'approve', targetRef: 'details', label: 'Need details' },
      { sourceRef: 'details', targetRef: 'approve', label: 'Received' },
      { sourceRef: 'approve', targetRef: 'pay', label: 'Approved' },
      { sourceRef: 'approve', targetRef: 'deny', label: 'Denied' },
      { sourceRef: 'pay', targetRef: 'retry', label: 'Failed' },
      { sourceRef: 'retry', targetRef: 'pay', label: 'Retry' },
      { sourceRef: 'pay', targetRef: 'done', label: 'Paid' },
    ],
  };
  const receipt = await call('create_workflow', workflowArgs);
  assert.deepEqual(await call('create_workflow', workflowArgs), receipt);
  let data = await read(workflow);
  assert.equal(data.board.notes.length, 8);
  assert.equal(data.board.connectors.length, 10);
  await inspect(workflow);
  const firstNote = data.board.notes[0];
  await call('batch_edit_board', {
    boardId: workflow,
    operationId: 'refine-text',
    expectedRevision: data.revision,
    operations: [
      {
        type: 'update_text',
        id: firstNote.id,
        text: 'Receive customer refund request',
      },
    ],
  });
  await reject('batch_edit_board', {
    boardId: workflow,
    operationId: 'stale',
    expectedRevision: data.revision,
    operations: [{ type: 'move_element', id: firstNote.id, x: 900, y: 900 }],
  });
  data = await read(workflow);
  assert.ok(
    data.board.notes.some(
      (n) =>
        n.id === firstNote.id && n.text === 'Receive customer refund request',
    ),
  );
  await reject('batch_edit_board', {
    boardId: workflow,
    operationId: 'bad-batch',
    operations: [
      { type: 'create_note', text: 'Must not commit', x: 0, y: 0 },
      {
        type: 'create_connector',
        sourceRef: 'missing',
        targetRef: firstNote.id,
      },
    ],
  });
  assert.equal((await read(workflow)).revision, data.revision);
  await reject('create_workflow', { ...workflowArgs, operationId: 'outside-canvas', x: 1_000_000 });
  await reject('add_notes', { boardId: workflow, operationId: 'notes-outside-canvas', notes: [{ text: 'Outside' }], x: 999_999 });
  await reject('add_notes', { boardId: workflow, operationId: 'blank-notes', notes: [{ text: ' \t\n' }] });
  await reject('create_workflow', { boardId: workflow, operationId: 'blank-workflow', nodes: [{ ref: 'blank', label: ' \t' }], edges: [] });
  await reject('compose_board', { boardId: workflow, operationId: 'blank-composition', title: 'Ideas', groups: ['Team'], items: [{ title: ' ', group: 'Team' }] });
  await reject('batch_edit_board', { boardId: workflow, operationId: 'blank-note-batch', operations: [{ type: 'create_note', text: '\n', x: 0, y: 0 }] });
  assert.equal((await read(workflow)).revision, data.revision);
  const workflowFrame = data.board.frames[0];
  const emptyShapes = await board('Relayout blank shapes');
  const blankShape = await call('batch_edit_board', { boardId: emptyShapes, operationId: 'blank-shape', operations: [{ type: 'create_shape', ref: 'blank', text: ' ', x: 0, y: 0, width: 208, height: 208 }] });
  await call('relayout_workflow', { boardId: emptyShapes, operationId: 'blank-shape-layout', nodeIds: [blankShape.refs.blank] });
  assert.equal((await read(emptyShapes)).board.shapes[0].text, ' ');
  const [frameX, frameY] = JSON.parse(workflowFrame.xywh);
  const labelBounds = data.board.connectors.filter(c => c.label).map(c => ({ id: c.id, xywh: c.labelXYWH }));
  await call('batch_edit_board', { boardId: workflow, operationId: 'move-labeled-workflow', operations: [{ type: 'move_element', id: workflowFrame.id, x: frameX + 200, y: frameY + 300 }] });
  const translated = (await read(workflow)).board;
  for (const before of labelBounds) {
    const after = translated.connectors.find(c => c.id === before.id).labelXYWH;
    assert.ok(Math.abs(after[0] - before.xywh[0] - 200) < 1e-8);
    assert.ok(Math.abs(after[1] - before.xywh[1] - 300) < 1e-8);
    assert.deepEqual(after.slice(2), before.xywh.slice(2));
  }
  await call('batch_edit_board', { boardId: workflow, operationId: 'return-labeled-workflow', operations: [{ type: 'move_element', id: workflowFrame.id, x: frameX, y: frameY }] });
  proofs.push({
    scenario: 'Business process',
    boardId: workflow,
    url: receipt.url,
  });
  const ownership = await board('Responsibility lanes');
  await call('create_workflow', {
    boardId: ownership,
    operationId: 'lanes-v1',
    title: 'Refund ownership',
    nodes: [
      {
        ref: 'request',
        label: 'Request a refund',
        lane: 'Customer',
        kind: 'start',
      },
      {
        ref: 'review',
        label: 'Review eligibility',
        lane: 'Support',
        kind: 'decision',
      },
      { ref: 'pay', label: 'Issue payment', lane: 'Finance', kind: 'end' },
    ],
    edges: [
      { sourceRef: 'request', targetRef: 'review' },
      { sourceRef: 'review', targetRef: 'pay', label: 'Eligible' },
    ],
  });
  assert.deepEqual(
    (await read(ownership)).board.texts.map((t) => t.text),
    ['Customer', 'Support', 'Finance'],
  );
  await inspect(ownership);
  const research = await board('Research synthesis');
  await call('batch_edit_board', {
    boardId: research,
    operationId: 'research-v1',
    operations: [
      {
        type: 'create_document',
        title: 'Interview evidence',
        x: 100,
        y: 100,
        width: 500,
        height: 350,
        blocks: [
          { type: 'paragraph', text: '“I cannot find the next step.”' },
          { type: 'paragraph', text: '“The approval status is unclear.”' },
        ],
      },
      {
        type: 'create_shape',
        text: 'Navigation theme',
        x: 750,
        y: 100,
        width: 240,
        height: 144,
      },
    ],
  });
  assert.ok(
    (await read(research)).board.notes[0].text.includes('approval status'),
  );
  const searched = await call('search_board', {
    boardId: research,
    query: 'approval status',
  });
  assert.equal(searched.total, 1);
  const crossSearch = await call('search_boards', { query: 'approval status' });
  assert.ok(crossSearch.matches.some((m) => m.boardId === research));
  await inspect(research);
  proofs.push({ scenario: 'Research synthesis', boardId: research });
  const technical = await board('Checkout system');
  await call('create_entity_diagram', {
    boardId: technical,
    operationId: 'entities-v1',
    title: 'Checkout data',
    entities: [
      {
        ref: 'users',
        name: 'User',
        attributes: ['id: uuid · PK', 'email: string'],
      },
      {
        ref: 'orders',
        name: 'Order',
        attributes: ['id: uuid · PK', 'user_id: uuid · FK', 'total: decimal'],
      },
      {
        ref: 'payments',
        name: 'Payment',
        attributes: ['id: uuid · PK', 'order_id: uuid · FK', 'status: string'],
      },
    ],
    relationships: [
      { sourceRef: 'users', targetRef: 'orders', label: '1 → many' },
      { sourceRef: 'orders', targetRef: 'payments', label: '1 → many' },
    ],
  });
  await call('create_sequence_diagram', {
    boardId: technical,
    operationId: 'sequence-v1',
    title: 'Checkout request',
    y:
      JSON.parse((await read(technical)).board.frames[0].xywh)[1] +
      JSON.parse((await read(technical)).board.frames[0].xywh)[3] +
      100,
    participants: [
      { ref: 'customer', name: 'Customer' },
      { ref: 'api', name: 'Checkout API' },
      { ref: 'payment', name: 'Payment provider' },
      { ref: 'api:observer', name: 'Audit observer' },
    ],
    messages: [
      { from: 'customer', to: 'api', label: 'Submit order' },
      { from: 'api', to: 'api', label: 'Validate order' },
      { from: 'api', to: 'payment', label: 'Authorize payment' },
      { from: 'payment', to: 'api', label: 'Authorization', response: true },
      {
        from: 'api',
        to: 'customer',
        label: 'Order confirmation',
        response: true,
      },
    ],
  });
  assert.equal(
    (await read(technical)).board.shapes.filter((s) => s.text.includes('PK'))
      .length,
    3,
  );
  await inspect(technical);
  proofs.push({ scenario: 'System explanation', boardId: technical });
  const retro = await board('Retrospective');
  const retroReceipt = await call('compose_board', {
    boardId: retro,
    operationId: 'retro-v1',
    title: 'Sprint retrospective · 8 participants',
    groups: ['Start', 'Stop', 'Continue'],
    items: [
      {
        ref: 'start',
        title: 'Share context before refinement',
        group: 'Start',
      },
      { ref: 'stop', title: 'Leave reviews until Friday', group: 'Stop' },
      { ref: 'continue', title: 'Pair on risky changes', group: 'Continue' },
    ],
  });
  await call('collaboration_command', {
    boardId: retro,
    operationId: 'vote-v1',
    action: 'start_vote',
    values: {
      title: 'Choose our next improvement',
      targets: Object.values(retroReceipt.receipt.refs).filter((id) =>
        id.startsWith('note:'),
      ),
      votesPerUser: 3,
      maxPerTarget: 1,
    },
  });
  assert.equal(
    (await call('get_collaboration', { boardId: retro })).voteRounds[0].status,
    'running',
  );
  await inspect(retro);
  proofs.push({ scenario: 'Retrospective', boardId: retro });
  const decision = await board('Auth provider decision');
  const decisionReceipt = await call('batch_edit_board', {
    boardId: decision,
    operationId: 'matrix-v1',
    operations: [
      {
        type: 'create_frame',
        ref: 'criteria',
        title: 'Criteria',
        x: 70,
        y: 60,
        width: 900,
        height: 450,
      },
      {
        type: 'create_table',
        ref: 'matrix',
        frameRef: 'criteria',
        title: 'Compare authentication options',
        x: 100,
        y: 100,
        columns: [
          { key: 'criterion', name: 'Criterion', type: 'text' },
          { key: 'a', name: 'Provider A', type: 'number' },
          { key: 'b', name: 'Provider B', type: 'number' },
          { key: 'agreed', name: 'Agreed', type: 'checkbox' },
        ],
        rows: [
          {
            criterion: 'Operational simplicity',
            a: null,
            b: null,
            agreed: false,
          },
          { criterion: 'Data residency', a: null, b: null, agreed: false },
          { criterion: 'Cost', a: null, b: null, agreed: false },
        ],
      },
    ],
  });
  await call('compose_board', {
    boardId: decision,
    operationId: 'stakeholders-v1',
    title: 'Stakeholder input',
    y: 650,
    groups: ['Engineering', 'Product'],
    items: [
      { title: 'What are the integration costs?', group: 'Engineering' },
      { title: 'How does sign-in feel?', group: 'Product' },
    ],
  });
  data = await read(decision);
  const table = data.board.tables[0];
  const tableSearch = await call('search_board', {
    boardId: decision, frameId: decisionReceipt.refs.criteria, type: 'table', query: 'Operational simplicity',
  });
  assert.equal(tableSearch.total, 1);
  assert.equal(tableSearch.elements[0].containerId, table.containerId);
  await call('batch_edit_board', {
    boardId: decision, operationId: 'move-table-from-search',
    operations: [{ type: 'move_element', id: tableSearch.elements[0].containerId, x: 130, y: 120 }],
  });
  assert.equal((await read(decision)).board.tables[0].xywh, '[130,120,790,276]');
  await call('batch_edit_board', {
    boardId: decision,
    operationId: 'cell-v1',
    operations: [
      {
        type: 'update_table_cell',
        id: decisionReceipt.refs.matrix,
        rowId: table.rows[0].id,
        columnKey: 'a',
        value: 4,
      },
    ],
  });
  assert.equal((await read(decision)).board.tables[0].rows[0].values.a, 4);
  await call('batch_edit_board', {
    boardId: decision, operationId: 'table-title-from-search',
    operations: [{ type: 'update_text', id: tableSearch.elements[0].id, text: 'Updated decision matrix' }],
  });
  assert.equal((await read(decision)).board.tables[0].title, 'Updated decision matrix');
  assert.deepEqual((await call('search_board', { boardId: decision, type: 'table', query: 'Updated decision matrix' })).elements.map(e => e.id), [table.id]);
  await inspect(decision);
  proofs.push({ scenario: 'Decision matrix', boardId: decision });
  const ideas = await board('Onboarding ideas');
  const ideaReceipt = await call('compose_board', {
    boardId: ideas,
    operationId: 'ideas-v1',
    title: 'Reduce onboarding drop-off',
    groups: ['Guidance', 'Speed', 'Confidence'],
    items: Array.from({ length: 15 }, (_, i) => ({
      ref: `idea-${i}`,
      title: `Candidate ${i + 1}`,
      description: [
        'Show the next useful step',
        'Remove repeated input',
        'Explain progress clearly',
      ][i % 3],
      group: ['Guidance', 'Speed', 'Confidence'][i % 3],
    })),
  });
  assert.equal((await read(ideas)).board.notes.length, 15);
  await inspect(ideas);
  proofs.push({ scenario: 'Ideation', boardId: ideas });
  const ids = Object.entries(ideaReceipt.receipt.refs).filter(([key]) =>
    key.startsWith('idea-'),
  );
  await call('compose_board', {
    boardId: ideas,
    operationId: 'priority-v1',
    title: 'Impact and effort',
    layout: 'matrix',
    groups: ['Low effort', 'High effort'],
    rows: ['High impact', 'Low impact'],
    x: 2300,
    items: ids.map(([ref, id], i) => ({
      id,
      title: ref,
      group: i % 2 ? 'High effort' : 'Low effort',
      row: i < 8 ? 'High impact' : 'Low impact',
      highlight: i < 3,
    })),
  });
  const movedIdeas = await read(ideas);
  assert.equal(movedIdeas.board.notes.length, 15);
  assert.deepEqual(
    movedIdeas.board.notes.map((n) => n.id).sort(),
    ids.map(([, id]) => id).sort(),
  );
  await inspect(ideas);
  proofs.push({ scenario: 'Prioritization', boardId: ideas });
  const comparison = await board('Technical comparison');
  await call('compose_board', {
    boardId: comparison,
    operationId: 'compare-v1',
    title: 'Service architecture options',
    layout: 'comparison',
    groups: ['Monolith', 'Services'],
    items: [
      { title: 'Simpler transactions', group: 'Monolith' },
      { title: 'Independent deployment', group: 'Services' },
    ],
  });
  await call('create_workflow', {
    boardId: comparison,
    operationId: 'architecture-v1',
    title: 'Architecture sketch',
    notation: 'flowchart',
    y: 700,
    nodes: [
      { ref: 'ui', label: 'Web application' },
      { ref: 'worker', label: 'Cloudflare Worker' },
      { ref: 'db', label: 'D1 catalog' },
    ],
    edges: [
      { sourceRef: 'ui', targetRef: 'worker', label: 'HTTPS' },
      { sourceRef: 'worker', targetRef: 'db', label: 'Queries' },
    ],
  });
  await inspect(comparison);
  proofs.push({ scenario: 'Technical comparison', boardId: comparison });
  const story = await board('Story map');
  await call('compose_board', {
    boardId: story,
    operationId: 'story-v1',
    title: 'Customer support journey',
    layout: 'story_map',
    groups: ['Ask for help', 'Track progress', 'Complete'],
    rows: ['Release 1', 'Release 2'],
    items: [
      { title: 'Submit a request', group: 'Ask for help', row: 'Release 1' },
      { title: 'See status', group: 'Track progress', row: 'Release 1' },
      { title: 'Confirm resolution', group: 'Complete', row: 'Release 2' },
    ],
  });
  await inspect(story);
  proofs.push({ scenario: 'Story map', boardId: story });
  const sprint = await board('Sprint planning');
  await call('compose_board', {
    boardId: sprint,
    operationId: 'sprint-v1',
    title: 'Two sprint delivery plan',
    groups: ['Sprint 1', 'Sprint 2'],
    itemStyle: 'card',
    items: Array.from({ length: 12 }, (_, i) => ({
      title: `Task ${i + 1}`,
      description: 'Acceptance criteria and implementation notes',
      group: i < 6 ? 'Sprint 1' : 'Sprint 2',
      owner: i % 2 ? 'Alex' : 'Sam',
      estimate: (i % 3) + 1,
      status: 'To do',
    })),
  });
  assert.equal((await read(sprint)).board.notes.length, 12);
  await inspect(sprint);
  proofs.push({ scenario: 'Sprint planning', boardId: sprint });
  const feedback = await board('Feedback follow-up');
  await call('collaboration_command', {
    boardId: feedback,
    operationId: 'comment-v1',
    action: 'add_comment',
    values: { body: 'Clarify the next step', x: 100, y: 100 },
  });
  const comments = await call('get_collaboration', { boardId: feedback });
  const threadId = comments.comments[0].id;
  await call('batch_edit_board', {
    boardId: feedback,
    operationId: 'checklist-v1',
    operations: [
      {
        type: 'create_document',
        title: 'Next steps',
        x: 100,
        y: 100,
        width: 500,
        height: 350,
        blocks: [
          { type: 'check', text: 'Clarify next step', checked: false },
          { type: 'check', text: 'Review with stakeholders', checked: false },
        ],
      },
    ],
  });
  await call('collaboration_command', {
    boardId: feedback,
    operationId: 'reply-v1',
    action: 'reply_comment',
    values: { threadId, body: 'Added to the editable checklist.' },
  });
  await call('collaboration_command', {
    boardId: feedback,
    operationId: 'resolve-v1',
    action: 'resolve_comment',
    values: { threadId },
  });
  assert.ok(
    (await call('get_collaboration', { boardId: feedback })).comments[0]
      .resolvedAt,
  );
  await reject('collaboration_command', {
    boardId: feedback,
    operationId: 'override',
    action: 'raise_hand',
    values: { action: 'reveal_brainstorm' },
  });
  await inspect(feedback);
  proofs.push({ scenario: 'Feedback follow-up', boardId: feedback });
  const asset = await call('upload_image', {
    boardId: research,
    contentType: 'image/png',
    data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==',
  });
  await call('batch_edit_board', {
    boardId: research,
    operationId: 'image-v1',
    operations: [
      {
        type: 'create_image',
        sourceId: asset.sourceId,
        caption: 'Raster upload proof',
        x: 1100,
        y: 100,
        width: 160,
        height: 160,
      },
    ],
  });
  const image = (await read(research)).board.images.find(item => item.sourceId === asset.sourceId);
  await call('batch_edit_board', { boardId: research, operationId: 'image-caption-v2', operations: [{ type: 'update_text', id: image.id, text: 'Updated image caption' }] });
  assert.equal((await read(research)).board.images.find(item => item.id === image.id).text, 'Updated image caption');
  assert.equal((await call('search_board', { boardId: research, type: 'image', query: 'Updated image caption' })).elements[0].id, image.id);
  const workflowBeforeForeignImage = await read(workflow);
  await reject('batch_edit_board', { boardId: workflow, operationId: 'foreign-image', operations: [{ type: 'create_image', sourceId: asset.sourceId, x: 0, y: 0, width: 160, height: 160 }] });
  assert.equal((await read(workflow)).revision, workflowBeforeForeignImage.revision);
  const imageRead = await client.callTool({
    name: 'get_image',
    arguments: {
      boardId: research,
      sourceId: asset.sourceId,
      includeData: true,
    },
  });
  assert.equal(parsed(imageRead).size, asset.size);
  assert.ok(
    imageRead.content.some(
      (c) =>
        c.type === 'image' && c.mimeType === 'image/png' && c.data.length > 0,
    ),
  );
  await reject('get_image', { boardId: workflow, sourceId: asset.sourceId });
  await reject('upload_image', {
    boardId: research,
    contentType: 'image/png',
    data: btoa('not an image'),
  });
  await call('batch_edit_board', {
    boardId: comparison,
    operationId: 'resize-before-relayout',
    operations: [
      {
        type: 'resize_element',
        id: (await read(comparison)).board.shapes[0].id,
        width: 700,
        height: 420,
      },
    ],
  });
  const relayoutArgs = {
    boardId: comparison,
    operationId: 'relayout-v1',
    nodeIds: (await read(comparison)).board.shapes.map((s) => s.id),
    frameId: (await read(comparison)).board.frames.find(
      (f) => f.title === 'Architecture sketch',
    ).id,
    y: 700,
  };
  const unrelated = await call('batch_edit_board', {
    boardId: comparison, operationId: 'unrelated-frame-member',
    operations: [{ type: 'create_note', ref: 'keep', frameRef: relayoutArgs.frameId, text: 'Keep this context here', x: 2500, y: 900 }],
  });
  const unrelatedId = unrelated.refs.keep;
  const beforeUnrelated = (await read(comparison)).board.notes.find(n => n.id === unrelatedId).xywh;
  const relayout = await call('relayout_workflow', relayoutArgs);
  assert.deepEqual(await call('relayout_workflow', relayoutArgs), relayout);
  assert.equal((await read(comparison)).board.notes.find(n => n.id === unrelatedId).xywh, beforeUnrelated);
  await inspect(comparison);
  const dense = await board('Dense workflow capacity');
  const comparisonRevision = (await read(comparison)).revision;
  await reject('relayout_workflow', { ...relayoutArgs, operationId: 'far-reused-frame', x: 30_000 });
  await reject('compose_board', { boardId: comparison, operationId: 'blank-title', title: '', groups: ['Ideas'], items: [] });
  assert.equal((await read(comparison)).revision, comparisonRevision);
  const denseNodes = Array.from({ length: 30 }, (_, i) => ({ ref: `step-${i}`, label: `Step ${i + 1}` }));
  const denseEdges = [
    ...denseNodes.slice(1).map((n, i) => ({ sourceRef: denseNodes[i].ref, targetRef: n.ref })),
    ...denseNodes.map((n, i) => ({ sourceRef: n.ref, targetRef: denseNodes[(i + 2) % 30].ref })),
    { sourceRef: denseNodes[29].ref, targetRef: denseNodes[0].ref },
  ];
  await call('create_workflow', { boardId: dense, operationId: 'dense-create', nodes: denseNodes, edges: denseEdges });
  const denseBefore = (await read(dense)).board;
  const denseIds = denseBefore.notes.map(n => n.id);
  await call('relayout_workflow', { boardId: dense, operationId: 'dense-relayout', nodeIds: denseIds, y: 1500 });
  const denseAfter = (await read(dense)).board;
  assert.deepEqual(denseAfter.notes.map(n => n.id), denseIds);
  assert.equal(denseAfter.connectors.length, 60);
  await call('relayout_workflow', { boardId: dense, operationId: 'dense-reuse-frame', nodeIds: denseIds, frameId: denseAfter.frames.at(-1).id, y: 1500 });
  await inspect(dense);
  const edgeNotes = await board('Note cluster boundary');
  await call('add_notes', { boardId: edgeNotes, operationId: 'notes-at-boundary', notes: [{ text: 'Inside' }], x: 999_620, y: 999_680 });
  await inspect(edgeNotes);
  const technicalBoard = (await read(technical)).board;
  const observer = technicalBoard.shapes.find(shape => shape.text === 'Audit observer');
  assert.ok(technicalBoard.connectors.some(connector => !connector.label && connector.source.id === observer.id));
  const reusedIdeas = await board('Large existing idea set');
  await call('add_notes', { boardId: reusedIdeas, operationId: 'first-ideas', notes: Array.from({ length: 30 }, (_, i) => ({ text: `Idea ${i}` })) });
  await call('add_notes', { boardId: reusedIdeas, operationId: 'second-ideas', notes: Array.from({ length: 30 }, (_, i) => ({ text: `Idea ${i + 30}` })), y: 1800 });
  const originalIdeas = (await read(reusedIdeas)).board.notes;
  await call('compose_board', { boardId: reusedIdeas, operationId: 'reuse-sixty-ideas', title: 'Theme', groups: ['Ideas'], items: originalIdeas.map(note => ({ id: note.id, title: note.text, group: 'Ideas' })), y: 3500 });
  assert.deepEqual((await read(reusedIdeas)).board.notes.map(n => n.id), originalIdeas.map(n => n.id));
  await inspect(reusedIdeas);
  const longSequence = await board('Maximum sequence capacity');
  const participants = Array.from({ length: 10 }, (_, i) => ({ ref: `p${i}`, name: `Service ${i}` }));
  await call('create_sequence_diagram', { boardId: longSequence, operationId: 'twenty-five-messages', participants, messages: Array.from({ length: 25 }, (_, i) => ({ from: participants[i % 10].ref, to: participants[(i + 1) % 10].ref, label: `Message ${i + 1}` })) });
  const sequenceData = (await read(longSequence)).board;
  assert.equal(sequenceData.connectors.filter(c => c.label).length, 25);
  assert.equal(sequenceData.connectors.filter(c => !c.label).length, 10);
  await inspect(longSequence);
  const mixedHighlights = await board('Mixed selected alternatives');
  const mixedAsset = await call('upload_image', { boardId: mixedHighlights, contentType: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==' });
  const mixedReceipt = await call('batch_edit_board', { boardId: mixedHighlights, operationId: 'mixed-originals', operations: [
    { type: 'create_note', ref: 'note', text: 'Guided onboarding', color: 'purple', x: 0, y: 0 },
    { type: 'create_shape', ref: 'shape', text: 'Reduce manual steps', shape: 'diamond', fill: '#abcdef', stroke: '#123456', x: 400, y: 0, width: 240, height: 160 },
    { type: 'create_text', ref: 'text', text: 'Evidence from interviews', x: 800, y: 0, width: 240, height: 80 },
    { type: 'create_image', ref: 'image', sourceId: mixedAsset.sourceId, caption: 'Research screenshot', x: 1200, y: 0, width: 160, height: 160 },
    { type: 'create_card', ref: 'card', title: 'Improve sign-in', priority: 'High', x: 1600, y: 0, width: 360, height: 240 },
  ] });
  const mixedBefore = (await read(mixedHighlights)).board;
  const mixedArgs = { boardId: mixedHighlights, operationId: 'highlight-originals', title: 'Selected alternatives', groups: ['Review'], itemStyle: 'card', items: Object.entries(mixedReceipt.refs).map(([title, id]) => ({ id, title, group: 'Review', highlight: true })) };
  const highlighted = await call('compose_board', mixedArgs);
  assert.deepEqual(await call('compose_board', mixedArgs), highlighted);
  const mixedAfter = (await read(mixedHighlights)).board;
  assert.deepEqual(mixedAfter.notes.map(note => note.id), mixedBefore.notes.map(note => note.id));
  assert.deepEqual(mixedAfter.notes[0].color, mixedBefore.notes[0].color);
  assert.equal(mixedAfter.notes[1].text, mixedBefore.notes[1].text);
  assert.equal(mixedAfter.shapes[0].id, mixedReceipt.refs.shape);
  assert.equal(mixedAfter.shapes[0].color, '#abcdef');
  assert.equal(mixedAfter.images[0].sourceId, mixedAsset.sourceId);
  assert.equal(mixedAfter.texts.find(text => text.id === mixedReceipt.refs.text).text, 'Evidence from interviews');
  assert.equal(mixedAfter.texts.filter(text => text.text === 'Selected').length, 5);
  const shapeInk = async () => (await call('get_board', { boardId: mixedHighlights, includeRaw: true })).board.surfaceElements.find(element => element.id === mixedReceipt.refs.shape).color;
  assert.equal(await shapeInk(), '#000000');
  await call('batch_edit_board', { boardId: mixedHighlights, operationId: 'dark-shape-fill', operations: [{ type: 'style_element', id: mixedReceipt.refs.shape, fill: '#102030' }] });
  assert.equal(await shapeInk(), '#ffffff');
  await call('batch_edit_board', { boardId: mixedHighlights, operationId: 'restore-shape-fill', operations: [{ type: 'style_element', id: mixedReceipt.refs.shape, fill: '#abcdef' }] });
  assert.equal(await shapeInk(), '#000000');
  await inspect(mixedHighlights);
  const lockedMembership = await board('Locked frame membership');
  const lockFixture = await call('batch_edit_board', { boardId: lockedMembership, operationId: 'lock-fixture', operations: [
    { type: 'create_frame', ref: 'source', title: 'Protected', x: 0, y: 0, width: 600, height: 400 },
    { type: 'create_frame', ref: 'destination', title: 'Open', x: 800, y: 0, width: 600, height: 400 },
    { type: 'create_note', ref: 'member', text: 'Protected membership', x: 40, y: 60, frameRef: 'source' },
  ] });
  const snapshotResponse = await fetch(`${origin}/api/v1/boards/${encodeURIComponent(lockedMembership)}`);
  assert.equal(snapshotResponse.status, 200);
  const { snapshot } = await snapshotResponse.json();
  const lockDoc = new Y.Doc();
  Y.applyUpdate(lockDoc, Buffer.from(snapshot.docs['board:home'], 'base64'));
  lockDoc.getMap('blocks').get(lockFixture.refs.source).set('prop:lockedBySelf', true);
  snapshot.docs['board:home'] = Buffer.from(Y.encodeStateAsUpdate(lockDoc)).toString('base64');
  lockDoc.destroy();
  const savedLock = await fetch(`${origin}/api/v1/boards/${encodeURIComponent(lockedMembership)}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ snapshot }) });
  assert.equal(savedLock.status, 200);
  const lockedBefore = await read(lockedMembership);
  for (const [index, operation] of [
    { type: 'set_frame', id: lockFixture.refs.member, frameRef: null },
    { type: 'set_frame', id: lockFixture.refs.member, frameRef: lockFixture.refs.destination },
    { type: 'move_element', id: lockFixture.refs.member, x: 840, y: 60, frameRef: lockFixture.refs.destination },
    { type: 'delete_element', id: lockFixture.refs.member },
  ].entries()) await reject('batch_edit_board', { boardId: lockedMembership, operationId: `locked-membership-${index}`, operations: [operation] });
  await reject('compose_board', { boardId: lockedMembership, operationId: 'colliding-item-ref', title: 'Themes', groups: ['Ideas'], items: [
    { id: lockFixture.refs.member, title: 'Original', group: 'Ideas' },
    { ref: lockFixture.refs.member, title: 'New item', group: 'Ideas' },
  ] });
  const lockedAfter = await read(lockedMembership);
  assert.equal(lockedAfter.revision, lockedBefore.revision);
  assert.deepEqual(lockedAfter.board, lockedBefore.board);
  const report = {
    endpoint: `${origin}/mcp`,
    tools: discovery.tools.length,
    mixedHighlightBoardId: mixedHighlights,
    testBoardIds: boards,
    scenarios: proofs.map((proof) => ({
      ...proof,
      url: `${origin}/boards/${encodeURIComponent(proof.boardId)}`,
    })),
    checks: [
      '11 published use-case scenarios',
      'native semantic read-back',
      'no geometry issues',
      'retry deduplication',
      'stale revision rejection',
      'atomic invalid batch',
      'reserved collaboration field rejection',
      'board-scoped images',
      'identity-preserving relayout',
      'unrelated frame members preserved',
      'movable table identifier from search',
      '30-node 60-edge relayout within batch capacity',
      'canvas origin rejection without a revision change',
      'labeled frame movement preserves label positions and size',
      'note cluster coordinate boundaries',
      'lifelines include inactive participants',
      'sixty existing notes reorganized with stable IDs',
      'twenty-five messages and ten participants within one batch',
      'locked source frame membership preserved atomically',
      'colliding composition refs rejected without a revision change',
      'reused mixed objects highlighted without changing their styling',
      'shape text contrast follows explicit fill colors',
    ],
  };
  await writeFile(
    '/tmp/canvas-mcp-authoring-acceptance.json',
    JSON.stringify(report, null, 2),
  );
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} finally {
  await client.close();
  await authorization.revoke();
  if (!keep)
    await Promise.all(
      boards.map(async (id) => {
        const response = await fetch(
          `${origin}/api/v1/boards/${encodeURIComponent(id)}/catalog`,
          {
            method: 'DELETE',
          },
        );
        assert.ok(response.ok, `Cleanup failed for ${id}: ${response.status}`);
      }),
    );
}
