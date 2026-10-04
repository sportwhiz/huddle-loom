import WebSocket from 'ws';
import { randomUUID } from 'node:crypto';

const origin = process.argv.slice(2).find(value => /^https?:\/\//u.test(value)) ?? 'http://127.0.0.1:5175';
const connectionCount = 50;
const editorCount = 10;
let boardId;
const sockets = [];

function assert(value, message) {
  if (!value) throw new Error(message);
}

async function json(path, init = {}) {
  const response = await fetch(new URL(path, origin), {
    ...init,
    headers: { 'Content-Type': 'application/json', ...init.headers },
    body: init.body && typeof init.body !== 'string' ? JSON.stringify(init.body) : init.body,
  });
  const body = await response.json();
  if (!response.ok) throw new Error(`${init.method ?? 'GET'} ${path} failed: ${response.status} ${JSON.stringify(body)}`);
  return body;
}

function connect(url) {
  const socket = new WebSocket(url, {headers:{Origin:new URL(url).origin.replace(/^ws/u,'http')}});
  sockets.push(socket);
  const messages = [];
  const waiters = [];
  socket.addEventListener('message', event => {
    const message = JSON.parse(String(event.data));
    messages.push(message);
    if (messages.length > 250) messages.shift();
    for (const waiter of [...waiters]) {
      if (!waiter.predicate(message)) continue;
      waiters.splice(waiters.indexOf(waiter), 1);
      clearTimeout(waiter.timer);
      waiter.resolve(message);
    }
  });
  const opened = new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', () => reject(new Error('WebSocket connection failed')), { once: true });
  });
  const waitFor = (predicate, label, timeout = 20_000) => {
    const existing = messages.find(predicate);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const waiter = { predicate, resolve, timer: setTimeout(() => {
        const index = waiters.indexOf(waiter);
        if (index >= 0) waiters.splice(index, 1);
        reject(new Error(`Timed out waiting for ${label}`));
      }, timeout) };
      waiters.push(waiter);
    });
  };
  return { socket, opened, waitFor };
}

const startedAt = performance.now();
try {
  const catalog = await json('/api/v1/catalog');
  assert(catalog.workbooks[0]?.id, 'No workbook is available');
  const board = await json('/api/v1/boards', { method: 'POST', body: { workbookId: catalog.workbooks[0].id, title: '50-connection stress proof' } });
  boardId = board.id;
  const initial = await json(`/api/v1/boards/${encodeURIComponent(boardId)}/semantic`);

  const wsOrigin = origin.replace(/^http/u, 'ws');
  const path = `${wsOrigin}/api/v1/boards/${encodeURIComponent(boardId)}/ws`;
  const clients = Array.from({ length: connectionCount }, () => connect(path));
  await Promise.all(clients.map(client => client.opened));
  const connectedAt = performance.now();

  const initialBoard = await clients[0].waitFor(message => message.type === 'snapshot', 'initial board snapshot');

  const allPresent = await clients.at(-1).waitFor(message => message.type === 'collaboration' && message.state?.participants?.length === connectionCount, `${connectionCount} participants`);
  assert(new Set(allPresent.state.participants.map(participant => participant.connectionId)).size === connectionCount, 'Connection IDs are not unique');

  clients[0].socket.send(JSON.stringify({ type: 'sync-request', vectors: { root: 'AA==', docs: {} } }));
  const sync = await clients[0].waitFor(message => message.type === 'update' && message.sync === true, 'stress state-vector sync');
  const operations = clients.slice(0, editorCount).map((client, index) => {
    const operationId = `stress:${index}:${randomUUID()}`;
    client.socket.send(JSON.stringify({ type: 'update', operationId, documentEpoch: initialBoard.documentEpoch, updates: sync.updates }));
    return client.waitFor(message => message.type === 'ack' && message.operationId === operationId, `editor ${index + 1} acknowledgement`);
  });
  const acknowledgements = await Promise.all(operations);
  const completedAt = performance.now();
  const revisions = acknowledgements.map(message => message.revision).sort((a, b) => a - b);
  assert(new Set(revisions).size === editorCount, 'Concurrent editor updates did not receive unique committed revisions');
  assert(revisions[0] === initial.revision + 1 && revisions.at(-1) === initial.revision + editorCount, 'Concurrent revisions were lost or skipped');

  const final = await json(`/api/v1/boards/${encodeURIComponent(boardId)}/semantic`);
  assert(final.revision === initial.revision + editorCount, 'The persisted final revision does not include every acknowledged edit');

  process.stdout.write(`${JSON.stringify({ origin, boardId, connections: connectionCount, concurrentEditors: editorCount, initialRevision: initial.revision, finalRevision: final.revision, uniqueAcknowledgements: revisions.length, connectMs: Math.round(connectedAt - startedAt), concurrentCommitMs: Math.round(completedAt - connectedAt), totalMs: Math.round(completedAt - startedAt) }, null, 2)}\n`);
} finally {
  for (const socket of sockets) socket.close();
  if (boardId) await fetch(new URL(`/api/v1/boards/${encodeURIComponent(boardId)}/catalog`, origin), { method: 'DELETE' }).catch(() => undefined);
}
