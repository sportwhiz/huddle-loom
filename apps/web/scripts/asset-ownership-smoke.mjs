import WebSocket from 'ws';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';

const origin = process.argv.find(value => /^https?:\/\//u.test(value)) ?? 'http://127.0.0.1:5175';
assert.ok(['127.0.0.1', 'localhost'].includes(new URL(origin).hostname), 'Run asset regression tests against a local server');
const runId = randomUUID();
const editor = `asset-editor-${runId}@local.test`;
const boards = [];
let socket;

async function request(path, { method = 'GET', body, email = 'owner@local.test', status = 200 } = {}) {
  const response = await fetch(new URL(path, origin), {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Whiteboard-Dev-Email': email },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const value = response.headers.get('content-type')?.includes('json') ? await response.json() : await response.text();
  assert.equal(response.status, status, `${method} ${path}: ${JSON.stringify(value)}`);
  return value;
}
const path = id => `/api/v1/boards/${encodeURIComponent(id)}`;
const command = (id, operationId, operations, email, status) => request(`${path(id)}/commands`, { method: 'POST', body: { operationId, operations }, email, status });
const bytes = Buffer.from(`private asset ${runId}`);
const key = createHash('sha256').update(bytes).digest('base64url') + '=';
const image = { type: 'create_image', sourceId: key, caption: 'Private image', x: 0, y: 0, width: 160, height: 160 };
async function upload(id, email = 'owner@local.test') {
  const response = await fetch(new URL(`${path(id)}/blobs/${key}`, origin), {
    method: 'PUT', headers: { 'Content-Type': 'application/octet-stream', 'X-Whiteboard-Dev-Email': email }, body: bytes,
  });
  assert.equal(response.status, 201, await response.text());
}

try {
  const catalog = await request('/api/v1/catalog');
  const workbookId = catalog.workbooks[0].id;
  const create = async title => {
    const board = await request('/api/v1/boards', { method: 'POST', status: 201, body: { workbookId, title, private: true } });
    boards.push(board.id);
    await request(path(board.id));
    return board.id;
  };
  const source = await create(`Private asset source ${runId}`);
  const target = await create(`Asset target ${runId}`);
  const invite = await request(`${path(target)}/share`, { method: 'POST', status: 201, body: { email: editor, role: 'editor' } });
  await request('/api/v1/invitations/accept', { method: 'POST', email: editor, body: { token: invite.token } });
  await request(path(source), { email: editor, status: 404 });
  await upload(source);
  await command(source, 'source-image', [image]);
  const foreign = await request(path(source));
  const before = await request(path(target));

  // REST commands, full snapshots, and native WebSocket updates must all enforce ownership.
  const failedCommand = await command(target, 'foreign-image', [image], editor, 400);
  assert.match(failedCommand.error, /uploaded to this board/u);
  const failedSnapshot = await request(path(target), { method: 'PUT', email: editor, status: 400, body: { snapshot: foreign.snapshot } });
  assert.match(failedSnapshot.error, /uploaded to this board/u);

  const messages = [];
  const waiters = [];
  socket = new WebSocket(new URL(`${path(target)}/ws`, origin.replace(/^http/u, 'ws')), {headers:{Origin:origin}});
  socket.addEventListener('message', event => {
    const message = JSON.parse(String(event.data));
    messages.push(message);
    for (const waiter of [...waiters]) {
      if (messages.length <= waiter.after || !waiter.predicate(message)) continue;
      waiters.splice(waiters.indexOf(waiter), 1);
      clearTimeout(waiter.timer);
      waiter.resolve(message);
    }
  });
  const waitFor = (predicate, after = 0) => {
    const found = messages.slice(after).find(predicate);
    if (found) return Promise.resolve(found);
    return new Promise((resolve, reject) => {
      const waiter = { predicate, after, resolve, timer: setTimeout(() => {
        waiters.splice(waiters.indexOf(waiter), 1);
        reject(new Error('Timed out waiting for asset WebSocket response'));
      }, 5000) };
      waiters.push(waiter);
    });
  };
  const initial = await waitFor(message => message.type === 'snapshot');
  const send = async (message, type) => {
    const after = messages.length;
    socket.send(JSON.stringify(message));
    return waitFor(result => result.type === type, after);
  };
  assert.match((await send({ type: 'snapshot', snapshot: foreign.snapshot }, 'error')).error, /uploaded to this board/u);
  const updates = Object.entries(foreign.snapshot.docs).map(([docId, update]) => ({ docId, update }));
  assert.match((await send({ type: 'update', operationId: 'foreign-delta', documentEpoch: initial.documentEpoch, updates }, 'error')).error, /uploaded to this board/u);
  const after = await request(path(target));
  assert.equal(after.revision, before.revision);
  assert.deepEqual(after.snapshot, before.snapshot);
  await request(`${path(target)}/blobs/${key}`, { email: editor, status: 404 });
  assert.deepEqual(await request(`${path(target)}/blobs`), { keys: [] });

  // Writing a hash in a sticky is normal content and must never grant access to the blob.
  await command(target, 'hash-shaped-note', [{ type: 'create_note', text: key, x: 300, y: 0 }], editor);
  await request(`${path(target)}/blobs/${key}`, { email: editor, status: 404 });
  const noteArchive = await request(`${path(target)}/export`);
  assert.equal(noteArchive.assets.length, 0);

  // The same failed operation can succeed after a real upload; successful retries remain idempotent.
  await upload(target, editor);
  const saved = await command(target, 'foreign-image', [image], editor);
  const replay = await command(target, 'foreign-image', [image], editor);
  assert.deepEqual(replay, saved);
  assert.equal((await request(`${path(target)}/semantic`)).board.images.length, 1);
  const accepted = await send({ type: 'update', operationId: 'foreign-delta', documentEpoch: initial.documentEpoch, updates }, 'ack');
  assert.ok(accepted.revision > saved.revision);
  const replayDelta = await send({ type: 'update', operationId: 'foreign-delta', documentEpoch: initial.documentEpoch, updates }, 'ack');
  assert.equal(replayDelta.revision, accepted.revision);
  await send({ type: 'snapshot', snapshot: (await request(path(target))).snapshot }, 'ack');
  socket.close();

  // Trusted copies/history/imports retain asset access without requiring another upload.
  const duplicate = await request(`${path(target)}/duplicate`, { method: 'POST', status: 201, body: {} });
  boards.push(duplicate.id);
  const restored = await request(`${path(target)}/versions/${saved.revision}/restore-copy`, { method: 'POST', status: 201, body: {} });
  boards.push(restored.id);
  for (const id of [duplicate.id, restored.id]) {
    const response = await fetch(new URL(`${path(id)}/blobs/${key}`, origin));
    assert.equal(response.status, 200);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
  }
  const archive = await request(`${path(target)}/export`);
  assert.equal(archive.assets.length, 1);
  const imported = await request(`/api/v1/import?workbookId=${encodeURIComponent(workbookId)}`, { method: 'POST', status: 201, body: archive });
  boards.push(imported.id);
  assert.equal((await request(`${path(imported.id)}/semantic`)).board.images.length, 2);
  assert.equal((await request(`${path(imported.id)}/export`)).assets.length, 1);
  await request(`${path(target)}/versions/${saved.revision}/restore`, { method: 'POST', body: {} });
  assert.equal((await request(`${path(target)}/semantic`)).board.images.length, 1);
  console.log(JSON.stringify({ ok: true, restCommands: true, restSnapshots: true, webSocketSnapshots: true, webSocketUpdates: true, hashTextIsolation: true, atomicRejection: true, idempotentRetries: true, copiesHistoryImport: true }));
} finally {
  socket?.close();
  for (const id of boards) await request(`${path(id)}/catalog`, { method: 'DELETE' }).catch(() => undefined);
}
