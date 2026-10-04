import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { chromium } from 'playwright';

const { values } = parseArgs({ options: { base: { type: 'string', default: 'http://127.0.0.1:5186' } } });
const origin = new URL(values.base);
assert(['localhost', '127.0.0.1'].includes(origin.hostname), 'Loading smoke tests create disposable boards on localhost only.');
const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_EXECUTABLE_PATH ?? (
  existsSync('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome') ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : undefined
) });
const context = await browser.newContext();
const created = [];
async function request(path, method = 'GET', data, expected = 200) {
  const response = await context.request.fetch(new URL(path, origin).href, { method, data });
  assert.equal(response.status(), expected, `${method} ${path}: ${await response.text()}`);
  return response.json();
}
const page = await context.newPage();
const errors = [];
const resources = [];
// Production chunks and Vite's development module URLs name the same deferred
// engine differently. Keep both the absence and later presence assertions.
const isHighlightEngine = url => /(?:^|\/)(?:wasm-[^/]+\.js|wasm\.mjs|shiki_wasm\.js)$/u.test(new URL(url).pathname);
page.on('pageerror', error => errors.push(error.message));
page.on('request', request => resources.push(request.url()));
await page.addInitScript(() => {
  const NativeSocket = WebSocket;
  window.__testSockets = [];
  window.WebSocket = class extends NativeSocket {
    constructor(...args) { super(...args); window.__testSockets.push(this); }
  };
});
async function ready(board) {
  await page.locator(`main[data-board-id="${board.id}"] .creation-rail`).waitFor();
  await page.waitForFunction(() => document.querySelector('.save-status')?.textContent === 'Saved');
}
async function sameDocument() {
  assert.equal(await page.evaluate(() => window.__testDocument), 'preserved', 'Application navigation reloaded the document');
}
try {
  const catalog = await request('/api/v1/catalog');
  const workbookId = catalog.workbooks.find(item => ['owner', 'editor'].includes(item.role)).id;
  for (const title of ['Navigation and recovery proof', 'Warm editor proof', 'History retention proof']) {
    created.push(await request('/api/v1/boards', 'POST', { title, workbookId }, 201));
  }
  const [board, next, history] = created;
  const path = `/api/v1/boards/${encodeURIComponent(board.id)}`;
  await request(`${path}/bootstrap`);
  await request(`${path}/commands`, 'POST', { operationId: 'loading-seed', operations: [{ type: 'create_note', text: 'Original note', x: 0, y: 0 }] });
  await page.goto(origin.href);
  await page.locator('.board-card-link').first().waitFor();
  await page.evaluate(() => { window.__testDocument = 'preserved'; });
  assert(!resources.some(url => /EditorCanvas-.*\.js/u.test(url)), 'Workspace eagerly loaded the native editor');
  await page.getByRole('link', { name: 'Connected apps', exact: true }).click();
  await page.getByRole('heading', { name: 'Connected apps', exact: true }).waitFor();
  await sameDocument();
  await page.getByRole('link', { name: 'Back to studio', exact: true }).click();
  await page.locator('.board-card-link').first().waitFor();
  await sameDocument();
  const openedTab = context.waitForEvent('page');
  await page.locator(`.board-card-link[href="/boards/${board.id}"]`).click({ modifiers: ['ControlOrMeta'] });
  const tab = await openedTab;
  await tab.locator('.creation-rail').waitFor();
  assert.equal(new URL(page.url()).pathname, '/', 'A modified link click changed the original tab');
  await tab.close();
  await page.locator(`.board-card-link[href="/boards/${board.id}"]`).click();
  await ready(board);
  await sameDocument();
  assert(!resources.some(isHighlightEngine), 'A sticky-only board downloaded the syntax-highlighting engine');
  assert(resources.filter(url => /fonts\.cdnfonts\.com/u.test(url)).length <= 2, 'A sticky-only board fetched unused font families');

  await page.getByRole('link', { name: 'Back to studio', exact: true }).click();
  await page.locator('.board-card-link').first().waitFor();
  await page.goBack();
  await ready(board);
  await page.goForward();
  await page.locator('.board-card-link').first().waitFor();
  const before = resources.filter(url => /EditorCanvas-.*\.js/u.test(url)).length;
  await page.locator(`.board-card-link[href="/boards/${next.id}"]`).click();
  await ready(next);
  assert.equal(resources.filter(url => /EditorCanvas-.*\.js/u.test(url)).length, before, 'Warm board navigation downloaded the editor again');
  await sameDocument();
  await page.getByRole('link', { name: 'Back to studio', exact: true }).click();
  await page.locator('.board-card-link').first().waitFor();
  await page.locator(`.board-card-link[href="/boards/${board.id}"]`).click();
  await ready(board);

  // Disconnect the real socket, make 220 distinct Yjs updates, and leave in
  // the same task, before the 120 ms save debounce can run.
  await context.setOffline(true);
  await page.evaluate(() => window.__testSockets.forEach(socket => socket.close()));
  await page.evaluate(() => {
    const store = document.querySelector('whiteboard-editor').doc;
    const text = store.getModelsByFlavour('affine:paragraph')[0].text;
    for (let i = 0; i < 220; i++) text.insert('x', text.length);
    document.querySelector('a[aria-label="Back to studio"]').click();
  });
  await page.waitForFunction(() => location.pathname === '/' && !document.querySelector('whiteboard-editor'));
  await page.waitForFunction(() => new Promise(resolve => {
    const opened = indexedDB.open('personal-whiteboard', 2);
    opened.onsuccess = () => {
      const db = opened.result;
      const all = db.transaction('pending-update-batches').objectStore('pending-update-batches').getAll();
      all.onsuccess = () => { db.close(); resolve(all.result.reduce((count, batch) => count + batch.updates.length, 0) >= 220); };
    };
  }));
  await context.setOffline(false);
  await page.goBack();
  await ready(board);
  const semantic = await request(`${path}/semantic`);
  assert(semantic.board.notes[0].text.endsWith('x'.repeat(220)), 'Immediate navigation lost edits from a later save chunk');
  await sameDocument();

  const shape = await request(`${path}/commands`, 'POST', { operationId: 'font-proof', operations: [{ type: 'create_shape', shape: 'rect', text: 'Font selection', x: 300, y: 0, width: 220, height: 160 }] });
  await page.waitForFunction(id => document.querySelector('whiteboard-editor').doc.spaceDoc.getMap('blocks').get(
    document.querySelector('whiteboard-editor').doc.getModelsByFlavour('affine:surface')[0].id
  ).get('prop:elements').get('value').has(id), shape.createdIds[0]);
  await page.evaluate(id => {
    const store = document.querySelector('whiteboard-editor').doc;
    const element = store.spaceDoc.getMap('blocks').get(store.getModelsByFlavour('affine:surface')[0].id).get('prop:elements').get('value').get(id);
    element.set('fontFamily', 'blocksuite:surface:Kalam');
    element.set('fontWeight', '700');
  }, shape.createdIds[0]);
  await page.waitForFunction(() => [...document.fonts].some(face => face.family.includes('Kalam') && face.weight === '600' && face.status === 'loaded'));

  // Exercise the deferred engine using a real native code block.
  await page.evaluate(() => {
    const store = document.querySelector('whiteboard-editor').doc;
    const paragraph = store.getModelsByFlavour('affine:paragraph')[0];
    store.addBlock('affine:code', { text: new paragraph.text.constructor('const answer = 42;'), language: 'javascript' }, store.getParent(paragraph).id);
  });
  await page.waitForFunction(() => document.querySelector('affine-code')?.highlighter.highlighter$.value?.getLoadedLanguages().includes('javascript'));
  assert(resources.some(isHighlightEngine), 'Code blocks did not load the deferred engine');
  await ready(board);
  await page.reload();
  await ready(board);
  await page.waitForFunction(() => document.querySelector('affine-code')?.highlighter.highlighter$.value?.getLoadedLanguages().includes('javascript'));
  await page.waitForFunction(() => [...document.fonts].some(face => face.family.includes('Kalam') && face.weight === '600' && face.status === 'loaded'));

  const historyPath = `/api/v1/boards/${encodeURIComponent(history.id)}`;
  await request(`${historyPath}/bootstrap`);
  const seeded = await request(`${historyPath}/commands`, 'POST', { operationId: 'history-note', operations: [{ type: 'create_note', text: 'Revision seed', x: 0, y: 0 }] });
  for (let i = 0; i < 105; i++) await request(`${historyPath}/commands`, 'POST', {
    operationId: `history-${i}`, operations: [{ type: 'update_note_text', id: seeded.createdIds[0], text: `History value ${i}` }],
  });
  const current = await request(`${historyPath}/bootstrap`);
  const versions = (await request(`${historyPath}/versions`)).versions;
  assert.equal(versions.length, 100, 'History did not retain exactly 100 revisions');
  assert.equal(versions[0].revision, current.revision);
  assert.equal(versions.at(-1).revision, current.revision - 99);
  await request(`${historyPath}/versions/${current.revision - 100}/preview`, 'GET', undefined, 404);
  const earliest = await request(`${historyPath}/versions/${versions.at(-1).revision}/preview`);
  await request(`${historyPath}/versions/${versions.at(-1).revision}/restore`, 'POST', {});
  const restored = await request(`${historyPath}/bootstrap`);
  assert.notEqual(restored.documentEpoch, current.documentEpoch, 'Restore did not change the document epoch');
  assert.equal((await request(`${historyPath}/semantic`)).board.notes[0].text, earliest.notes[0], 'Restore did not recover the retained revision');
  assert.equal((await request(`${historyPath}/versions`)).versions.length, 100);
  assert.deepEqual(errors, [], 'Browser raised errors during navigation, recovery, or code highlighting');
  console.log('Loading smoke passed: workspace splitting, warm navigation, back/forward, 220-update immediate leave and recovery, font selection, deferred code highlighting, reload, and 100-revision history retention/restore.');
} catch (error) {
  console.error(await page.evaluate(() => {
    const store = document.querySelector('whiteboard-editor')?.doc;
    const surface = store?.getModelsByFlavour('affine:surface')[0];
    return {
      status: document.querySelector('.board-status')?.textContent,
      save: document.querySelector('.save-status')?.textContent,
      surfaceId: surface?.id,
      elementIds: surface ? [...store.spaceDoc.getMap('blocks').get(surface.id).get('prop:elements').get('value').keys()] : [],
      sockets: window.__testSockets?.map(socket => socket.readyState),
    };
  }).catch(() => 'Browser diagnostics unavailable'));
  throw error;
} finally {
  for (const board of created) await request(`/api/v1/boards/${encodeURIComponent(board.id)}/catalog`, 'DELETE').catch(console.error);
  await browser.close();
}
