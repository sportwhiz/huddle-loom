import * as Y from 'yjs';

const origin = (
  process.argv.slice(2).find(value => /^https?:\/\//u.test(value)) ??
  'http://127.0.0.1:5175'
).replace(/\/$/u, '');
const createdIds = [];
let createdWorkbookId;

async function request(path, options = {}) {
  const response = await fetch(`${origin}${path}`, options);
  const text = await response.text();
  let body;
  try {
    body = text ? JSON.parse(text) : undefined;
  } catch {
    body = text;
  }
  if (!response.ok) {
    throw new Error(`${options.method ?? 'GET'} ${path} failed (${response.status}): ${text}`);
  }
  return { response, body, text };
}

async function json(path, method, body) {
  return request(path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

try {
  const catalog = (await request('/api/v1/catalog')).body;
  const workbookId = catalog.workbooks[0]?.id;
  if (!workbookId) throw new Error('No workbook is available');

  const secondWorkbook = (
    await json('/api/v1/workbooks', 'POST', {
      title: `Smoke destination ${Date.now()}`,
      folderId: catalog.folders[0]?.id,
    })
  ).body;
  createdWorkbookId = secondWorkbook.id;
  const source = (
    await json('/api/v1/boards', 'POST', {
      title: `Portable smoke ${Date.now()}`,
      workbookId,
    })
  ).body;
  createdIds.push(source.id);

  await json(`/api/v1/boards/${encodeURIComponent(source.id)}/commands`, 'POST', {
    operationId: `product-smoke-${Date.now()}`,
    operations: [
      {
        type: 'create_note',
        text: 'Findable portable smoke phrase',
        color: 'purple',
        x: 900,
        y: 120,
      },
    ],
  });
  await json(`/api/v1/boards/${encodeURIComponent(source.id)}/catalog`, 'PATCH', {
    title: 'Portable smoke renamed',
    favorite: true,
    workbookId: secondWorkbook.id,
  });

  const search = (
    await request('/api/v1/search?q=Findable%20portable%20smoke%20phrase')
  ).body;
  if (!search.matches.some(match => match.board.id === source.id && match.match === 'content')) {
    throw new Error('Content search did not find the native note');
  }

  const history = (
    await request(`/api/v1/boards/${encodeURIComponent(source.id)}/versions`)
  ).body;
  if (history.versions.length < 2) {
    throw new Error('Durable board history did not retain both revisions');
  }
  const oldest = history.versions.at(-1);
  const historicalCopy = (
    await json(
      `/api/v1/boards/${encodeURIComponent(source.id)}/versions/${oldest.revision}/restore-copy`,
      'POST',
      {}
    )
  ).body;
  createdIds.push(historicalCopy.id);
  const historicalBoard = (
    await request(`/api/v1/boards/${encodeURIComponent(historicalCopy.id)}/semantic`)
  ).body;
  if (historicalBoard.board.notes.length !== 0) {
    throw new Error('Historical copy did not restore the selected revision');
  }

  const duplicate = (
    await json(`/api/v1/boards/${encodeURIComponent(source.id)}/duplicate`, 'POST', {})
  ).body;
  createdIds.push(duplicate.id);
  const sourceBefore = (
    await request(`/api/v1/boards/${encodeURIComponent(source.id)}/semantic`)
  ).body;
  const copyBefore = (
    await request(`/api/v1/boards/${encodeURIComponent(duplicate.id)}/semantic`)
  ).body;
  if (copyBefore.board.notes.length !== sourceBefore.board.notes.length) {
    throw new Error('Duplicate does not contain the source notes');
  }
  await json(`/api/v1/boards/${encodeURIComponent(duplicate.id)}/commands`, 'POST', {
    operationId: `product-copy-edit-${Date.now()}`,
    expectedRevision: copyBefore.revision,
    operations: [
      {
        type: 'update_note_text',
        id: copyBefore.board.notes[0].id,
        text: 'Copy-only edit',
      },
    ],
  });
  const sourceAfter = (
    await request(`/api/v1/boards/${encodeURIComponent(source.id)}/semantic`)
  ).body;
  if (sourceAfter.board.notes[0].text === 'Copy-only edit') {
    throw new Error('Editing the duplicate changed the source board');
  }

  const exported = await request(
    `/api/v1/boards/${encodeURIComponent(source.id)}/export`
  );
  if (
    exported.body.format !== 'cloudflare-whiteboard/archive' ||
    exported.body.version !== 1 ||
    !exported.response.headers.get('Content-Disposition')?.includes('.whiteboard.json')
  ) {
    throw new Error('Native export is missing its format or download metadata');
  }
  const restored = (
    await request(
      `/api/v1/import?workbookId=${encodeURIComponent(workbookId)}&title=${encodeURIComponent('Restored smoke')}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/vnd.personal-whiteboard+json' },
        body: exported.text,
      }
    )
  ).body;
  createdIds.push(restored.id);
  const restoredBoard = (
    await request(`/api/v1/boards/${encodeURIComponent(restored.id)}/semantic`)
  ).body;
  if (restoredBoard.board.notes.length !== sourceBefore.board.notes.length) {
    throw new Error('Restored board does not contain all source notes');
  }

  const corrupt = structuredClone(exported.body);
  corrupt.version = 99;
  const rejected = await fetch(
    `${origin}/api/v1/import?workbookId=${encodeURIComponent(workbookId)}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/vnd.personal-whiteboard+json' },
      body: JSON.stringify(corrupt),
    }
  );
  if (rejected.status !== 400) throw new Error('Unsupported archive version was accepted');

  const beforeMalformedImport = (await request('/api/v1/catalog')).body.boards.length;
  const malformedCollaboration = structuredClone(exported.body);
  malformedCollaboration.collaboration = {};
  const malformedRejected = await fetch(
    `${origin}/api/v1/import?workbookId=${encodeURIComponent(workbookId)}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/vnd.personal-whiteboard+json' },
      body: JSON.stringify(malformedCollaboration),
    }
  );
  if (malformedRejected.status !== 400) throw new Error('Malformed collaboration archive was accepted');
  const afterMalformedImport = (await request('/api/v1/catalog')).body.boards.length;
  if (afterMalformedImport !== beforeMalformedImport) throw new Error('Rejected collaboration archive left an orphan board');

  const missingAssetArchive = structuredClone(exported.body);
  const snapshotDocId = Object.keys(missingAssetArchive.snapshot.docs)[0];
  const snapshotDoc = new Y.Doc();
  Y.applyUpdate(snapshotDoc, Buffer.from(missingAssetArchive.snapshot.docs[snapshotDocId], 'base64'));
  snapshotDoc.getMap('blocks').set('missing-asset-probe', { 'sys:flavour': 'affine:image', 'prop:sourceId': 'A'.repeat(43) });
  missingAssetArchive.snapshot.docs[snapshotDocId] = Buffer.from(Y.encodeStateAsUpdate(snapshotDoc)).toString('base64');
  const missingAssetRejected = await fetch(
    `${origin}/api/v1/import?workbookId=${encodeURIComponent(workbookId)}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/vnd.personal-whiteboard+json' },
      body: JSON.stringify(missingAssetArchive),
    }
  );
  snapshotDoc.destroy();
  if (missingAssetRejected.status !== 400) throw new Error('Archive with a missing referenced asset was accepted');
  const afterMissingAssetImport = (await request('/api/v1/catalog')).body.boards.length;
  if (afterMissingAssetImport !== beforeMalformedImport) throw new Error('Rejected missing-asset archive left an orphan board');

  process.stdout.write(
    `${JSON.stringify(
      {
        origin,
        contentSearch: true,
        catalogMutation: true,
        duplicateIndependent: true,
        archiveRoundTrip: true,
        historyRestoreAsCopy: true,
        corruptArchiveRejected: true,
        malformedCollaborationRejectedAtomically: true,
        missingAssetRejectedAtomically: true,
        notes: sourceBefore.board.notes.length,
        exportedAssets: exported.body.assets.length,
      },
      null,
      2
    )}\n`
  );
} finally {
  await Promise.allSettled(
    createdIds.map(id =>
      request(`/api/v1/boards/${encodeURIComponent(id)}/catalog`, { method: 'DELETE' })
    )
  );
  if (createdWorkbookId) {
    await request(`/api/v1/workbooks/${encodeURIComponent(createdWorkbookId)}`, {
      method: 'DELETE',
    }).catch(() => undefined);
  }
}
