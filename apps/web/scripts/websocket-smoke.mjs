import WebSocket from 'ws';
import { randomBytes, randomUUID } from 'node:crypto';
import http from 'node:http';
import https from 'node:https';

const origin = process.argv.slice(2).find(value => /^https?:\/\//u.test(value)) ?? 'http://127.0.0.1:5175';
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
  const waitFor = (predicate, label, timeout = 5000) => {
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
  return { socket, messages, opened, waitFor };
}

function crossOriginUpgradeStatus(path) {
  const target = new URL(path);
  const transport = target.protocol === 'wss:' ? https : http;
  return new Promise((resolve, reject) => {
    const request = transport.request({
      hostname: target.hostname,
      port: target.port || undefined,
      path: `${target.pathname}${target.search}`,
      headers: {
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        Origin: 'https://untrusted.example',
        'Sec-WebSocket-Key': randomBytes(16).toString('base64'),
        'Sec-WebSocket-Version': '13',
      },
    });
    request.once('response', response => {
      response.resume();
      resolve(response.statusCode);
    });
    request.once('upgrade', socket => {
      socket.destroy();
      reject(new Error('A cross-origin WebSocket upgrade was accepted'));
    });
    request.once('error', error => {
      if (error && typeof error === 'object' && error.code === 'ECONNRESET') resolve(0);
      else reject(error);
    });
    request.end();
  });
}

try {
  const catalog = await json('/api/v1/catalog');
  assert(catalog.workbooks[0]?.id, 'No workbook is available');
  const board = await json('/api/v1/boards', { method: 'POST', body: { workbookId: catalog.workbooks[0].id, title: 'WebSocket convergence proof' } });
  boardId = board.id;
  await json(`/api/v1/boards/${encodeURIComponent(boardId)}/semantic`);

  const wsOrigin = origin.replace(/^http/u, 'ws');
  const path = `${wsOrigin}/api/v1/boards/${encodeURIComponent(boardId)}/ws`;
  const rejectedUpgradeStatus = await crossOriginUpgradeStatus(path);
  assert(rejectedUpgradeStatus === 403 || rejectedUpgradeStatus === 0, 'Cross-origin WebSocket upgrade was not rejected');
  const first = connect(path);
  const second = connect(path);
  await Promise.all([first.opened, second.opened]);

  const [firstSnapshot, secondSnapshot] = await Promise.all([
    first.waitFor(message => message.type === 'snapshot', 'first initial snapshot'),
    second.waitFor(message => message.type === 'snapshot', 'second initial snapshot'),
  ]);
  assert(firstSnapshot.revision === secondSnapshot.revision, 'Initial socket revisions disagree');
  assert(typeof firstSnapshot.documentEpoch === 'string' && firstSnapshot.documentEpoch === secondSnapshot.documentEpoch, 'Initial socket document epochs disagree');

  first.socket.send(JSON.stringify({ type: 'sync-request', vectors: { root: 'AA==', docs: {} } }));
  const sync = await first.waitFor(message => message.type === 'update' && message.sync === true, 'state-vector sync');
  assert(Array.isArray(sync.updates) && sync.updates.length >= 2, 'State-vector sync returned no native updates');

  first.socket.send(JSON.stringify({ type: 'presence', idle: false, cursor: { x: 42, y: 84 }, selection: ['note:test'], viewport: { x: 10, y: 20, zoom: 1.25 } }));
  const presence = await second.waitFor(message => message.type === 'presence' && message.participant?.cursor?.x === 42, 'remote presence');
  assert(presence.participant.selection?.[0] === 'note:test', 'Remote selection was not transmitted');

  first.socket.send(JSON.stringify({ type: 'update', operationId: `stale:${randomUUID()}`, documentEpoch: randomUUID(), updates: sync.updates }));
  const stale = await first.waitFor(message => message.type === 'error' && String(message.error).includes('STALE_DOCUMENT'), 'stale document rejection');
  assert(stale.error.includes('restored'), 'Stale document rejection was not actionable');

  const catalogBeforeUpdate = await json('/api/v1/catalog');
  const updatedAtBefore = catalogBeforeUpdate.boards.find(item => item.id === boardId)?.updatedAt;
  await new Promise(resolve => setTimeout(resolve, 10));
  const operationId = `ws-smoke:${randomUUID()}`;
  first.socket.send(JSON.stringify({ type: 'update', operationId, documentEpoch: firstSnapshot.documentEpoch, updates: sync.updates }));
  const [ack, remoteUpdate] = await Promise.all([
    first.waitFor(message => message.type === 'ack' && message.operationId === operationId, 'incremental update acknowledgement'),
    second.waitFor(message => message.type === 'update' && message.operationId === operationId, 'incremental update broadcast'),
  ]);
  assert(ack.revision === remoteUpdate.revision, 'Acknowledged and broadcast revisions disagree');
  const catalogAfterUpdate = await json('/api/v1/catalog');
  const updatedAtAfter = catalogAfterUpdate.boards.find(item => item.id === boardId)?.updatedAt;
  assert(Date.parse(updatedAtAfter) > Date.parse(updatedAtBefore), 'WebSocket edit did not refresh the board catalog timestamp');

  first.socket.send(JSON.stringify({ type: 'update', operationId, documentEpoch: firstSnapshot.documentEpoch, updates: sync.updates }));
  const duplicateAck = await first.waitFor(message => message.type === 'ack' && message.operationId === operationId && message.revision === ack.revision, 'idempotent retry acknowledgement');
  assert(duplicateAck.revision === ack.revision, 'A retry created another revision');
  await new Promise(resolve => setTimeout(resolve, 150));
  assert(second.messages.filter(message => message.type === 'update' && message.operationId === operationId).length === 1, 'A duplicate retry was rebroadcast');

  first.socket.send(JSON.stringify({ type: 'attention', viewport: { x: 500, y: 400, zoom: 0.8 } }));
  const attention = await second.waitFor(message => message.type === 'attention', 'bring-everyone attention');
  assert(attention.viewport.x === 500 && attention.viewport.zoom === 0.8, 'Attention viewport changed in transit');

  process.stdout.write(`${JSON.stringify({ origin, boardId, initialRevision: firstSnapshot.revision, updateRevision: ack.revision, crossOriginRejected: true, stateVectorSync: true, catalogFreshness: true, compactPresence: true, remoteSelection: true, staleDocumentRejected: true, idempotentRetry: true, attentionBroadcast: true }, null, 2)}\n`);
} finally {
  for (const socket of sockets) socket.close();
  if (boardId) await fetch(new URL(`/api/v1/boards/${encodeURIComponent(boardId)}/catalog`, origin), { method: 'DELETE' }).catch(() => undefined);
}
