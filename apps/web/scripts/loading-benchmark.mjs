import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { parseArgs } from 'node:util';
import { chromium } from 'playwright';

const { values } = parseArgs({ options: {
  base: { type: 'string', default: 'http://127.0.0.1:5186' },
  output: { type: 'string', default: '../../test-results/performance/loading.json' },
  runs: { type: 'string', default: '5' },
  cpu: { type: 'string', default: '4' },
  keep: { type: 'boolean', default: false },
} });
const origin = new URL(values.base);
assert(['localhost', '127.0.0.1'].includes(origin.hostname), 'Benchmarks create disposable boards and run only against localhost.');
const runs = Number(values.runs), cpu = Number(values.cpu);
assert(Number.isInteger(runs) && runs > 0 && runs <= 20);
assert(cpu >= 1 && cpu <= 20);
const executablePath = process.env.CHROMIUM_EXECUTABLE_PATH ?? (
  existsSync('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')
    ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : undefined
);
const browser = await chromium.launch({ headless: true, executablePath });
const api = await browser.newContext();
const boardIds = [];
async function request(path, method = 'GET', data) {
  const response = await api.request.fetch(new URL(path, origin).href, { method, data });
  assert(response.ok(), `${method} ${path}: ${response.status()} ${await response.text()}`);
  return response.json();
}
async function fixture(count, workbookId) {
  const board = await request('/api/v1/boards', 'POST', { title: `Loading benchmark · ${count} notes`, workbookId });
  boardIds.push(board.id);
  const path = `/api/v1/boards/${encodeURIComponent(board.id)}`;
  await request(path);
  for (let offset = 0; offset < count; offset += 100) {
    const operations = Array.from({ length: Math.min(100, count - offset) }, (_, index) => {
      const i = index + offset;
      return { type: 'create_note', text: `Idea ${i + 1}\nA practical brainstorming note.`, x: i % 20 * 240, y: Math.floor(i / 20) * 240 };
    });
    await request(`${path}/commands`, 'POST', { operationId: `benchmark-${offset}`, operations });
  }
  return { id: board.id, count, url: new URL(`/boards/${encodeURIComponent(board.id)}`, origin).href };
}
const results = [];
async function measure(page, name, open, ready) {
  const errors = [];
  const recordError = error => errors.push(error.message);
  page.on('pageerror', recordError);
  await page.evaluate(() => performance.clearResourceTimings());
  const start = performance.now();
  await open();
  await page.locator(ready).first().waitFor({ state: 'visible', timeout: 60_000 });
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => resolve())));
  const elapsed = performance.now() - start;
  const metrics = await page.evaluate(() => ({
    fcp: performance.getEntriesByName('first-contentful-paint')[0]?.startTime,
    resources: performance.getEntriesByType('resource').filter(entry => /\.(?:js|css)(?:\?|$)|\/api\//u.test(entry.name)).map(entry => ({
      path: new URL(entry.name).pathname, start: entry.startTime, duration: entry.duration,
      transferBytes: entry.transferSize, bodyBytes: entry.encodedBodySize,
    })),
  }));
  page.off('pageerror', recordError);
  assert.deepEqual(errors, [], `${name}: browser errors`);
  results.push({ name, readyMs: Math.round(elapsed), ...metrics });
  console.log(`${name}: ${Math.round(elapsed)} ms`);
}
try {
  const catalog = await request('/api/v1/catalog');
  const workbook = catalog.workbooks.find(item => ['owner', 'editor'].includes(item.role));
  assert(workbook, 'A local editable workbook is required.');
  const small = await fixture(50, workbook.id);
  const large = await fixture(1000, workbook.id);
  for (let run = 0; run < runs; run++) {
    for (const board of [small, large]) {
      const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
      const page = await context.newPage();
      const cdp = await context.newCDPSession(page);
      await cdp.send('Emulation.setCPUThrottlingRate', { rate: cpu });
      const ready = `main[data-board-id="${board.id}"] .creation-rail`;
      await measure(page, `cold-board-${board.count}`, () => page.goto(board.url), ready);
      await measure(page, `reload-board-${board.count}`, () => page.reload(), ready);
      await context.close();
    }
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    const cdp = await context.newCDPSession(page);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: cpu });
    await measure(page, 'cold-workspace', () => page.goto(origin.href), '.board-card-link');
    const link = page.locator(`.board-card-link[href="/boards/${small.id}"]`);
    await measure(page, 'workspace-to-board', () => link.click(), `main[data-board-id="${small.id}"] .creation-rail`);
    await measure(page, 'board-to-workspace', () => page.getByRole('link', { name: 'Back to studio', exact: true }).click(), '.board-card-link');
    const next = page.locator(`.board-card-link[href="/boards/${large.id}"]`);
    await measure(page, 'warm-workspace-to-board', () => next.click(), `main[data-board-id="${large.id}"] .creation-rail`);
    await context.close();
  }
  const names = [...new Set(results.map(result => result.name))];
  const medians = Object.fromEntries(names.map(name => {
    const samples = results.filter(result => result.name === name).map(result => result.readyMs).sort((a, b) => a - b);
    return [name, samples[Math.floor(samples.length / 2)]];
  }));
  const report = { measuredAt: new Date().toISOString(), base: origin.href, cpuSlowdown: cpu, runs, browser: browser.version(), fixtures: boardIds, medians, results };
  await mkdir(dirname(values.output), { recursive: true });
  await writeFile(values.output, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(medians, null, 2));
} finally {
  if (!values.keep) for (const boardId of boardIds) await request(`/api/v1/boards/${encodeURIComponent(boardId)}/catalog`, 'DELETE').catch(error => console.error(error.message));
  await api.close();
  await browser.close();
}
