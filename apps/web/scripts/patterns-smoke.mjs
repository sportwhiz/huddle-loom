import assert from 'node:assert/strict';
import { existsSync, mkdirSync } from 'node:fs';
import { chromium } from 'playwright';

const origin = new URL(process.env.PATTERNS_SMOKE_URL ?? 'http://127.0.0.1:5299');
assert(['localhost', '127.0.0.1'].includes(origin.hostname), 'Pattern smoke tests create disposable local boards only.');
const screenshots = process.env.PATTERNS_SCREENSHOTS ?? '/tmp/huddle-patterns';
mkdirSync(screenshots, { recursive: true });
const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_EXECUTABLE_PATH ?? (existsSync('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome') ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : undefined) });
const context = await browser.newContext({ viewport: { width: 1600, height: 1100 } });
const page = await context.newPage();
const errors = [];
page.on('pageerror', error => errors.push(error.message));
let workbook, board;
async function request(path, method = 'GET', data) {
  const response = await context.request.fetch(new URL(path, origin).href, { method, data });
  assert(response.ok(), `${method} ${path}: ${await response.text()}`);
  return response.json();
}
async function counts() {
  return page.evaluate(() => {
    const store = document.querySelector('whiteboard-editor').doc;
    const elements = store.spaceDoc.getMap('blocks').get(store.getModelsByFlavour('affine:surface')[0].id).get('prop:elements').get('value');
    return { notes: store.getModelsByFlavour('affine:note').length, frames: store.getModelsByFlavour('affine:frame').length,
      shapes: [...elements.values()].filter(model => model.get('type') === 'shape').length,
      connectors: [...elements.values()].filter(model => model.get('type') === 'connector').length };
  });
}
try {
  workbook = await request('/api/v1/workbooks', 'POST', { title: 'Pattern smoke workbook' });
  board = await request('/api/v1/boards', 'POST', { title: 'Pattern smoke board', workbookId: workbook.id });
  const path = `/api/v1/boards/${encodeURIComponent(board.id)}`;
  await page.goto(new URL(`/boards/${encodeURIComponent(board.id)}`, origin).href);
  await page.locator('.creation-rail').waitFor({ timeout: 120000 });
  const before = await counts();
  await page.getByRole('button', { name: 'Patterns (templates)', exact: true }).click();
  await page.screenshot({ path: `${screenshots}/picker-light.png` });
  await page.getByRole('button', { name: /^How updates work/ }).click();
  await page.waitForFunction(() => document.querySelector('whiteboard-editor').doc.getModelsByFlavour('affine:frame').some(frame => String(frame.props.title).includes('Release and approval')));
  await page.waitForTimeout(1000);
  const flow = await counts();
  assert.equal(flow.notes - before.notes, 4);
  assert.equal(flow.shapes - before.shapes, 16);
  assert.equal(flow.connectors - before.connectors, 15);
  assert.equal(flow.frames - before.frames, 4);
  await page.screenshot({ path: `${screenshots}/update-flow-light.png` });
  await page.getByRole('button', { name: /^Undo/ }).click();
  await page.waitForTimeout(250);
  assert.deepEqual(await counts(), before, 'The whole pattern must undo as one action');
  await page.getByRole('button', { name: /^Redo/ }).click();
  assert.deepEqual(await counts(), flow);
  // Native objects, not a picture: moving a shape keeps connector attachment IDs.
  await page.evaluate(() => {
    const store = document.querySelector('whiteboard-editor').doc;
    const map = store.spaceDoc.getMap('blocks').get(store.getModelsByFlavour('affine:surface')[0].id).get('prop:elements').get('value');
    const shape = [...map.values()].find(model => model.get('type') === 'shape' && String(model.get('text')).includes('Publish a release'));
    const id = shape.get('id');
    if (![...map.values()].some(model => model.get('type') === 'connector' && model.get('source').id === id)) throw new Error('Arrow lost its source attachment');
    const bounds = JSON.parse(shape.get('xywh'));
    bounds[1] += 12; shape.set('xywh', JSON.stringify(bounds));
  });
  await page.getByRole('button', { name: 'Patterns (templates)', exact: true }).click();
  await page.getByRole('button', { name: /^50 ideas/ }).click();
  await page.waitForFunction(count => document.querySelector('whiteboard-editor').doc.getModelsByFlavour('affine:note').length === count, flow.notes + 50);
  await page.waitForTimeout(1000);
  const all = await counts();
  assert.equal(all.notes - flow.notes, 50);
  assert.equal(all.frames - flow.frames, 1);
  assert.equal(all.connectors, flow.connectors);
  await page.screenshot({ path: `${screenshots}/fifty-notes-light.png` });
  await page.waitForFunction(() => document.querySelector('.save-status')?.textContent === 'Saved');
  const semantic = (await request(`${path}/semantic`)).board;
  assert.equal(semantic.notes.filter(note => note.text === '').length, 50, 'MCP must see all blank editable notes');
  assert(semantic.shapes.some(shape => shape.text.includes('Publish a release')), 'MCP must see diagram text');
  assert.equal(semantic.connectors.length, all.connectors);
  await page.reload();
  await page.locator('.creation-rail').waitFor();
  assert.deepEqual(await counts(), all, 'Pattern must survive a persisted reload');
  await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; localStorage.setItem('whiteboard-theme', 'dark'); });
  await page.getByRole('button', { name: 'Patterns (templates)', exact: true }).click();
  await page.screenshot({ path: `${screenshots}/picker-dark.png` });
  await page.getByRole('button', { name: /^How updates work/ }).click();
  await page.waitForTimeout(1000);
  await page.screenshot({ path: `${screenshots}/update-flow-dark.png` });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'Patterns (templates)', exact: true }).click();
  await page.screenshot({ path: `${screenshots}/picker-mobile-dark.png` });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'Mobile pattern picker overflowed');
  assert.deepEqual(errors, [], 'Browser errors while inserting or restoring patterns');
  console.log('Patterns smoke passed: picker, native objects, atomic undo/redo, non-destructive insertion, MCP semantics, persistence, light/dark/mobile.');
} finally {
  if (board) await request(`/api/v1/boards/${encodeURIComponent(board.id)}/catalog`, 'DELETE').catch(console.error);
  if (workbook) await request(`/api/v1/workbooks/${encodeURIComponent(workbook.id)}`, 'DELETE').catch(console.error);
  await browser.close();
}
