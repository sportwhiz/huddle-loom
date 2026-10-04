import { createHash, randomUUID } from 'node:crypto';

const baseUrl = (process.argv.slice(2).find(value => /^https?:\/\//u.test(value)) ?? 'http://127.0.0.1:5173').replace(/\/$/u, '');
const runId = randomUUID().slice(0, 8);
const identities = {
  owner: 'owner@local.test',
  editor: `editor-${runId}@local.test`,
  commenter: `commenter-${runId}@local.test`,
  viewer: `viewer-${runId}@local.test`,
  workbookViewer: `workbook-viewer-${runId}@local.test`,
  outsider: `outsider-${runId}@local.test`,
};

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function request(path, { as = 'owner', body, headers, method = body === undefined ? 'GET' : 'POST', expected = 200 } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      'X-Whiteboard-Dev-Email': identities[as],
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const contentType = response.headers.get('content-type') ?? '';
  const value = contentType.includes('json') ? await response.json() : await response.text();
  const allowed = Array.isArray(expected) ? expected : [expected];
  if (!allowed.includes(response.status)) {
    throw new Error(`${method} ${path} as ${as} returned ${response.status}: ${JSON.stringify(value)}`);
  }
  return { response, value };
}

async function command(boardId, as, action, body = {}, expected = 200) {
  return request(`/api/v1/boards/${encodeURIComponent(boardId)}/collaboration/commands`, {
    as,
    body: { action, operationId: `${action}:${randomUUID()}`, ...body },
    expected,
  });
}

const principals = {};
for (const name of Object.keys(identities)) {
  principals[name] = (await request('/api/v1/me', { as: name })).value.user;
}

const catalog = (await request('/api/v1/catalog')).value;
const workbook = catalog.workbooks[0];
assert(workbook, 'The owner needs at least one workbook');

const created = (await request('/api/v1/boards', {
  body: { workbookId: workbook.id, title: `Collaboration smoke ${runId}` },
  expected: 201,
})).value;
const boardId = created.id;
let isolationBoardId;
let sharedWorkbookId;
let inheritedBoardId;
let privateWorkbookBoardId;
let deletedWorkbookId;

try {
  const firstLoad = await request(`/api/v1/boards/${encodeURIComponent(boardId)}/bootstrap`);
  assert(firstLoad.value.snapshot && firstLoad.value.collaboration.capabilities.edit, 'Bootstrap did not initialize the new board');
  assert(firstLoad.value.metadata.title === created.title && firstLoad.value.metadata.canCopy, 'Owner bootstrap metadata is incorrect');
  assert(firstLoad.response.headers.get('cache-control') === 'private, no-store', 'Bootstrap can be cached across users');
  const workspaceLoad = (await request('/api/v1/workspace')).value;
  assert(workspaceLoad.user.id === principals.owner.id && workspaceLoad.workspace.owner, 'Workspace bootstrap identity is incorrect');
  assert(workspaceLoad.catalog.boards.some(board => board.id === boardId), 'Workspace bootstrap omitted the new board');
  assert(Array.isArray(workspaceLoad.notifications.notifications), 'Workspace bootstrap notifications are missing');
  await request(`/api/v1/boards/${encodeURIComponent(boardId)}/catalog`, { method: 'PATCH', body: { favorite: true } });
  await request(`/api/v1/boards/${encodeURIComponent(boardId)}/bootstrap`);
  const openedFavorite = (await request('/api/v1/workspace')).value.catalog.boards.find(board => board.id === boardId);
  assert(openedFavorite.favorite && openedFavorite.lastOpenedAt, 'Opening a board reset its favorite or failed to record recency');
  await request(`/api/v1/boards/${encodeURIComponent(boardId)}/catalog`, { method: 'PATCH', body: { favorite: false } });
  const unfavorited = (await request('/api/v1/workspace')).value.catalog.boards.find(board => board.id === boardId);
  assert(!unfavorited.favorite && unfavorited.lastOpenedAt === openedFavorite.lastOpenedAt, 'Changing a favorite reset the last-opened timestamp');
  const emptyPreview = (await request(`/api/v1/boards/${encodeURIComponent(boardId)}/preview`)).value;
  assert(emptyPreview.board.elements.length === 0, 'A new board preview did not initialize an empty board');
  // New boards start empty. Seed the ballot's targets explicitly so this
  // permission test does not depend on product starter content.
  await request(`/api/v1/boards/${encodeURIComponent(boardId)}/commands`, {
    body: {
      operationId: `ballot-fixture:${runId}`,
      operations: [
        { type: 'create_note', text: 'First idea', color: 'yellow', x: 0, y: 0 },
        { type: 'create_note', text: 'Second idea', color: 'blue', x: 300, y: 0 },
      ],
    },
  });
  for (const role of ['editor', 'commenter', 'viewer']) {
    const invite = (await request(`/api/v1/boards/${encodeURIComponent(boardId)}/share`, {
      body: { email: identities[role], role, expiresInDays: 1 },
      expected: 201,
    })).value;
    assert(invite.token && invite.email === identities[role], `${role} invitation was not created`);
    const pendingInvitation = (await request('/api/v1/notifications', { as: role })).value.notifications;
    assert(pendingInvitation.some(item => item.kind === 'invitation'), `${role} could not see the pending board invitation`);
    const accepted = (await request('/api/v1/invitations/accept', {
      as: role,
      body: { token: invite.token },
    })).value;
    assert(accepted.boardId === boardId && accepted.role === role, `${role} invitation was not accepted`);
  }

  const selfInvite = (await request(`/api/v1/boards/${encodeURIComponent(boardId)}/share`, {
    body: { email: identities.owner, role: 'viewer', expiresInDays: 1 }, expected: 201,
  })).value;
  const selfAccepted = (await request('/api/v1/invitations/accept', { body: { token: selfInvite.token } })).value;
  assert(selfAccepted.role === 'owner', 'Accepting a weaker self-invitation downgraded the board owner');

  const wrongInvite = (await request(`/api/v1/boards/${encodeURIComponent(boardId)}/share`, {
    body: { email: `bound-${runId}@local.test`, role: 'viewer' },
    expected: 201,
  })).value;
  await request('/api/v1/invitations/accept', {
    as: 'viewer',
    body: { token: wrongInvite.token },
    expected: 403,
  });

  for (const as of ['owner', 'editor', 'commenter', 'viewer']) {
    const snapshot = (await request(`/api/v1/boards/${encodeURIComponent(boardId)}`, { as })).value;
    const bootstrap = (await request(`/api/v1/boards/${encodeURIComponent(boardId)}/bootstrap`, { as })).value;
    assert(bootstrap.revision === snapshot.revision && bootstrap.documentEpoch === snapshot.documentEpoch, `${as} received a stale bootstrap snapshot`);
    assert(bootstrap.collaboration.currentUserId === principals[as].id && bootstrap.collaboration.capabilities.role === as, `${as} bootstrap permissions differ`);
    if (as !== 'owner') assert(bootstrap.metadata.workbookTitle === 'Shared with me' && !bootstrap.metadata.canCopy, `${as} bootstrap leaked the parent workbook`);
    const preview = (await request(`/api/v1/boards/${encodeURIComponent(boardId)}/preview`, { as })).value;
    assert(preview.board.notes.length === 2 && !('blocks' in preview.board), `${as} did not receive the bounded board preview`);
  }
  await request(`/api/v1/boards/${encodeURIComponent(boardId)}/preview`, { as: 'outsider', expected: 404 });
  await request(`/api/v1/boards/${encodeURIComponent(boardId)}/bootstrap`, { as: 'outsider', expected: 404 });
  await request(`/api/v1/boards/${encodeURIComponent(boardId)}/bootstrap`, { method: 'POST', body: {}, expected: 405 });
  await request(`/api/v1/boards/${encodeURIComponent(boardId)}/preview`, { method: 'POST', body: {}, expected: 405 });
  await request(`/api/v1/boards/${encodeURIComponent(boardId)}/duplicate`, { as: 'editor', method: 'POST', body: {}, expected: 404 });
  const restrictedHistory = (await request(`/api/v1/boards/${encodeURIComponent(boardId)}/versions`, { as: 'editor' })).value;
  await request(`/api/v1/boards/${encodeURIComponent(boardId)}/versions/${restrictedHistory.versions.at(-1).revision}/restore-copy`, { as: 'editor', body: {}, expected: 404 });
  await request(`/api/v1/boards/${encodeURIComponent(boardId)}/export`, { as: 'viewer', expected: 403 });
  await request(`/api/v1/boards/${encodeURIComponent(boardId)}`, {
    as: 'viewer', method: 'PUT', body: { snapshot: {} }, expected: 403,
  });
  await request(`/api/v1/boards/${encodeURIComponent(boardId)}/commands`, {
    as: 'commenter', body: { operationId: randomUUID(), operations: [] }, expected: 403,
  });

  await command(boardId, 'viewer', 'add_comment', { body: 'viewer cannot comment', x: 10, y: 10 }, 400);
  const commentOperationId = `comment-retry:${randomUUID()}`;
  const commentBody = `A comment that mentions the viewer ${runId}`;
  const commentResult = (await command(boardId, 'commenter', 'add_comment', {
    operationId: commentOperationId, body: commentBody, x: 140, y: 160,
    mentions: [principals.viewer.id, principals.outsider.id],
  })).value;
  assert(commentResult.state.comments[0]?.replies[0]?.body.includes('mentions'), 'Comment was not stored');
  assert(!commentResult.state.comments[0]?.replies[0]?.mentions.includes(principals.outsider.id), 'An out-of-board mention was stored');
  const notifications = (await request('/api/v1/notifications', { as: 'viewer' })).value;
  assert(notifications.notifications.some(item => item.kind === 'mention'), 'Mention notification was not delivered');
  const notificationCount = notifications.notifications.filter(item => item.body === commentBody).length;
  await command(boardId, 'commenter', 'add_comment', {
    operationId: commentOperationId, body: commentBody, x: 140, y: 160,
    mentions: [principals.viewer.id, principals.outsider.id],
  });
  const retriedNotifications = (await request('/api/v1/notifications', { as: 'viewer' })).value.notifications;
  assert(retriedNotifications.filter(item => item.body === commentBody).length === notificationCount, 'Retrying a completed comment duplicated its notification');
  const outsiderNotifications = (await request('/api/v1/notifications', { as: 'outsider' })).value;
  assert(!outsiderNotifications.notifications.some(item => item.kind === 'mention'), 'A mention notification escaped the board access boundary');

  await command(boardId, 'editor', 'start_brainstorm', {
    title: 'Private ideas', instructions: 'Keep drafts private until reveal', durationSeconds: 0,
  });
  await command(boardId, 'viewer', 'save_draft', { draftId: 'd'.repeat(161), text: 'Oversized identifier' }, 400);
  const privateText = `private-${randomUUID()}`;
  const savedDraft = (await command(boardId, 'viewer', 'save_draft', {
    text: privateText, color: 'purple', x: 40, y: 60,
  })).value.state.brainstorm.myDrafts[0];
  assert(savedDraft?.text === privateText, 'The author cannot read their own brainstorm draft');
  const ownerDuringBrainstorm = (await request(`/api/v1/boards/${encodeURIComponent(boardId)}/collaboration`)).value;
  assert(ownerDuringBrainstorm.brainstorm.myDrafts.length === 0, 'A private draft leaked to the facilitator');
  const commenterDuringBrainstorm = (await request(`/api/v1/boards/${encodeURIComponent(boardId)}/collaboration`, { as: 'commenter' })).value;
  assert(commenterDuringBrainstorm.brainstorm.myDrafts.length === 0, 'A private draft leaked to another participant');
  const bootstrapDuringBrainstorm = (await request(`/api/v1/boards/${encodeURIComponent(boardId)}/bootstrap`)).value;
  assert(!JSON.stringify(bootstrapDuringBrainstorm).includes(privateText), 'Bootstrap leaked a private brainstorming draft');
  const authorBootstrap = (await request(`/api/v1/boards/${encodeURIComponent(boardId)}/bootstrap`, { as: 'viewer' })).value;
  assert(authorBootstrap.collaboration.brainstorm.myDrafts[0]?.text === privateText, 'Bootstrap omitted the author\'s own draft');
  await command(boardId, 'viewer', 'submit_draft', { draftId: savedDraft.id });

  const semantic = (await request(`/api/v1/boards/${encodeURIComponent(boardId)}/semantic`)).value.board;
  const targetIds = semantic.notes.slice(0, 2).map(note => note.id);
  assert(targetIds.length > 0, 'The board has no notes to vote on');
  const voteState = (await command(boardId, 'editor', 'start_vote', {
    title: 'Private ballot', targets: targetIds, votesPerUser: 2, maxPerTarget: 2, anonymous: false,
  })).value.state;
  const round = voteState.voteRounds[0];
  await command(boardId, 'viewer', 'cast_vote', { roundId: round.id, targets: [targetIds[0], targetIds[0]] });
  const ownerDuringVote = (await request(`/api/v1/boards/${encodeURIComponent(boardId)}/collaboration`)).value.voteRounds[0];
  assert(ownerDuringVote.results === null && ownerDuringVote.voterNames === null, 'Running ballot results leaked');
  const bootstrapDuringVote = (await request(`/api/v1/boards/${encodeURIComponent(boardId)}/bootstrap`)).value.collaboration.voteRounds[0];
  assert(bootstrapDuringVote.results === null && bootstrapDuringVote.voterNames === null, 'Bootstrap leaked a running ballot');
  await command(boardId, 'editor', 'end_vote', { roundId: round.id });
  const endedVote = (await request(`/api/v1/boards/${encodeURIComponent(boardId)}/collaboration`)).value.voteRounds[0];
  assert(endedVote.results[targetIds[0]] === 2, 'Ended vote totals are incorrect');
  assert(endedVote.voterNames[targetIds[0]].includes(principals.viewer.name), 'Named voter results are incorrect');
  for (let index = 0; index < 21; index += 1) {
    const nextRound = (await command(boardId, 'editor', 'start_vote', { title: `Retention ${index}`, targets: targetIds })).value.state.voteRounds[0];
    await command(boardId, 'editor', 'end_vote', { roundId: nextRound.id });
  }
  const retainedVotes = (await request(`/api/v1/boards/${encodeURIComponent(boardId)}/collaboration`)).value.voteRounds;
  assert(retainedVotes.length === 20, `Vote history retained ${retainedVotes.length} rounds instead of 20`);

  await command(boardId, 'editor', 'close_brainstorm');
  await command(boardId, 'editor', 'reveal_brainstorm', { x: 500, y: 400 });
  const revealed = (await request(`/api/v1/boards/${encodeURIComponent(boardId)}/semantic`)).value.board;
  assert(revealed.notes.some(note => note.text === privateText), 'Revealed brainstorm note was not added to the board');
  const revealedCollaboration = (await request(`/api/v1/boards/${encodeURIComponent(boardId)}/collaboration`, { as: 'viewer' })).value;
  assert(revealedCollaboration.brainstorm.myDrafts.length === 0, 'Revealed brainstorm retained private draft content');

  const bytes = Buffer.from(`board-scoped-${runId}`);
  const key = createHash('sha256').update(bytes).digest('base64').replace(/\+/gu, '-').replace(/\//gu, '_');
  const upload = await fetch(`${baseUrl}/api/v1/boards/${encodeURIComponent(boardId)}/blobs/${encodeURIComponent(key)}`, {
    method: 'PUT',
    headers: {
      'X-Whiteboard-Dev-Email': identities.owner,
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(bytes.byteLength),
    },
    body: bytes,
  });
  assert(upload.status === 201, `Board asset upload failed with ${upload.status}: ${await upload.text()}`);
  isolationBoardId = (await request('/api/v1/boards', {
    body: { workbookId: workbook.id, title: `Asset isolation ${runId}` }, expected: 201,
  })).value.id;
  await request(`/api/v1/boards/${encodeURIComponent(isolationBoardId)}/blobs/${key}`, { expected: 404 });

  const share = (await request(`/api/v1/boards/${encodeURIComponent(boardId)}/share`)).value;
  const viewer = share.collaborators.find(item => item.id === principals.viewer.id);
  assert(viewer?.role === 'viewer', 'Viewer is missing from the collaborator list');
  const renewed = (await request(`/api/v1/boards/${encodeURIComponent(boardId)}/collaborators/${encodeURIComponent(principals.viewer.id)}`, {
    method: 'PATCH', body: { expiresInDays: 30 },
  })).value;
  assert(renewed.expiresAt, 'Guest expiration was not renewed');
  const privateBoard = (await request(`/api/v1/boards/${encodeURIComponent(boardId)}/catalog`, {
    method: 'PATCH', body: { private: true },
  })).value;
  assert(privateBoard.private === true, 'Board privacy was not enabled');
  await request(`/api/v1/boards/${encodeURIComponent(boardId)}/ownership`, {
    body: { userId: principals.editor.id },
  });
  const formerOwnerShare = (await request(`/api/v1/boards/${encodeURIComponent(boardId)}/share`)).value;
  assert(formerOwnerShare.capabilities.share === false, 'The previous owner retained sharing permission');
  await request(`/api/v1/boards/${encodeURIComponent(boardId)}/ownership`, {
    as: 'editor', body: { userId: principals.owner.id },
  });
  await request(`/api/v1/boards/${encodeURIComponent(boardId)}/collaborators/${encodeURIComponent(principals.viewer.id)}`, {
    method: 'DELETE', expected: 200,
  });
  await request(`/api/v1/boards/${encodeURIComponent(boardId)}`, { as: 'viewer', expected: 404 });
  await request(`/api/v1/boards/${encodeURIComponent(boardId)}/bootstrap`, { as: 'viewer', expected: 404 });
  const revokedNotifications = (await request('/api/v1/notifications', { as: 'viewer' })).value.notifications;
  assert(!revokedNotifications.some(item => item.body === commentBody), 'A revoked guest could still read a board notification preview');

  sharedWorkbookId = (await request('/api/v1/workbooks', { body: { title: `Shared workbook ${runId}` }, expected: 201 })).value.id;
  inheritedBoardId = (await request('/api/v1/boards', { body: { workbookId: sharedWorkbookId, title: `Inherited board ${runId}` }, expected: 201 })).value.id;
  privateWorkbookBoardId = (await request('/api/v1/boards', { body: { workbookId: sharedWorkbookId, title: `Private board ${runId}`, private: true }, expected: 201 })).value.id;
  const workbookInvite = (await request(`/api/v1/workbooks/${encodeURIComponent(sharedWorkbookId)}/share`, { body: { email: identities.workbookViewer, role: 'viewer', expiresInDays: 7 }, expected: 201 })).value;
  const acceptedWorkbook = (await request(`/api/v1/invitations/${encodeURIComponent(workbookInvite.id)}/accept`, { as: 'workbookViewer', body: {} })).value;
  assert(acceptedWorkbook.workbookId === sharedWorkbookId && acceptedWorkbook.resourceType === 'workbook', 'Workbook invitation was not accepted by ID');
  await request(`/api/v1/boards/${encodeURIComponent(inheritedBoardId)}`, { as: 'workbookViewer' });
  const inheritedBootstrap = (await request(`/api/v1/boards/${encodeURIComponent(inheritedBoardId)}/bootstrap`, { as: 'workbookViewer' })).value;
  assert(inheritedBootstrap.collaboration.capabilities.role === 'viewer' && inheritedBootstrap.metadata.workbookTitle !== 'Shared with me' && !inheritedBootstrap.metadata.canCopy, 'Inherited viewer bootstrap metadata is incorrect');
  await request(`/api/v1/boards/${encodeURIComponent(privateWorkbookBoardId)}`, { as: 'workbookViewer', expected: 404 });
  await request(`/api/v1/boards/${encodeURIComponent(privateWorkbookBoardId)}/bootstrap`, { as: 'workbookViewer', expected: 404 });
  const workbookCatalog = (await request('/api/v1/catalog', { as: 'workbookViewer' })).value;
  assert(workbookCatalog.workbooks.some(item => item.id === sharedWorkbookId), 'Shared workbook was missing from the catalog');
  await request(`/api/v1/workbooks/${encodeURIComponent(sharedWorkbookId)}/collaborators/${encodeURIComponent(principals.workbookViewer.id)}`, { method: 'DELETE' });
  await request(`/api/v1/boards/${encodeURIComponent(inheritedBoardId)}`, { as: 'workbookViewer', expected: 404 });
  await request(`/api/v1/boards/${encodeURIComponent(inheritedBoardId)}/bootstrap`, { as: 'workbookViewer', expected: 404 });

  const editorWorkbookInvite = (await request(`/api/v1/workbooks/${encodeURIComponent(sharedWorkbookId)}/share`, { body: { email: identities.editor, role: 'editor', expiresInDays: 7 }, expected: 201 })).value;
  await request(`/api/v1/invitations/${encodeURIComponent(editorWorkbookInvite.id)}/accept`, { as: 'editor', body: {} });
  const transferTargetInvite = (await request(`/api/v1/boards/${encodeURIComponent(inheritedBoardId)}/share`, { body: { email: identities.workbookViewer, role: 'editor', expiresInDays: 7 }, expected: 201 })).value;
  await request(`/api/v1/invitations/${encodeURIComponent(transferTargetInvite.id)}/accept`, { as: 'workbookViewer', body: {} });
  const privateBoardInvite = (await request(`/api/v1/boards/${encodeURIComponent(privateWorkbookBoardId)}/share`, { body: { email: identities.editor, role: 'viewer', expiresInDays: 7 }, expected: 201 })).value;
  await request(`/api/v1/invitations/${encodeURIComponent(privateBoardInvite.id)}/accept`, { as: 'editor', body: {} });
  const privateCatalog = (await request('/api/v1/catalog', { as: 'editor' })).value;
  assert(privateCatalog.boards.find(item => item.id === privateWorkbookBoardId)?.role === 'viewer', 'A private board incorrectly advertised an inherited workbook role');
  const privateViewerBootstrap = (await request(`/api/v1/boards/${encodeURIComponent(privateWorkbookBoardId)}/bootstrap`, { as: 'editor' })).value;
  assert(privateViewerBootstrap.collaboration.capabilities.role === 'viewer' && !privateViewerBootstrap.metadata.canCopy, 'A private-board viewer was offered an editor-only copy action');
  await request(`/api/v1/workbooks/${encodeURIComponent(sharedWorkbookId)}/ownership`, { body: { userId: principals.editor.id } });
  await request(`/api/v1/boards/${encodeURIComponent(inheritedBoardId)}/ownership`, { as: 'editor', body: { userId: principals.workbookViewer.id }, expected: 403 });
  await request(`/api/v1/boards/${encodeURIComponent(inheritedBoardId)}/catalog`, { as: 'editor', method: 'PATCH', body: { private: true } });
  const inheritedOwnerState = (await request(`/api/v1/boards/${encodeURIComponent(inheritedBoardId)}/share`, { as: 'editor' })).value;
  assert(inheritedOwnerState.capabilities.share === true, 'An inherited owner lost access after making a board private');
  await request(`/api/v1/workbooks/${encodeURIComponent(sharedWorkbookId)}/ownership`, { as: 'editor', body: { userId: principals.owner.id } });

  deletedWorkbookId = (await request('/api/v1/workbooks', { body: { title: `Deleted workbook ${runId}` }, expected: 201 })).value.id;
  await request(`/api/v1/workbooks/${encodeURIComponent(deletedWorkbookId)}`, { method: 'DELETE' });
  await request('/api/v1/boards', { body: { workbookId: deletedWorkbookId, title: 'Must not be orphaned' }, expected: 404 });

  console.log(`Collaboration smoke passed for ${boardId}`);
  console.log('Verified role-safe invitations, workbook creation rights, private-board ownership, bounded votes, four roles, inheritance, private drafts, comments, notifications, reveal, revocation, and asset isolation.');
} finally {
  if (isolationBoardId) {
    await request(`/api/v1/boards/${encodeURIComponent(isolationBoardId)}/catalog`, { method: 'DELETE', expected: [200, 404] }).catch(() => undefined);
  }
  await request(`/api/v1/boards/${encodeURIComponent(boardId)}/catalog`, { method: 'DELETE', expected: [200, 404] }).catch(() => undefined);
  if (inheritedBoardId) await request(`/api/v1/boards/${encodeURIComponent(inheritedBoardId)}/catalog`, { method: 'DELETE', expected: [200, 404] }).catch(() => undefined);
  if (privateWorkbookBoardId) await request(`/api/v1/boards/${encodeURIComponent(privateWorkbookBoardId)}/catalog`, { method: 'DELETE', expected: [200, 404] }).catch(() => undefined);
  if (sharedWorkbookId) await request(`/api/v1/workbooks/${encodeURIComponent(sharedWorkbookId)}`, { method: 'DELETE', expected: [200, 404] }).catch(() => undefined);
}
