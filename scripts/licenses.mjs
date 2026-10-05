import { readdir, readFile, mkdir, writeFile, cp, rm, realpath } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const root = fileURLToPath(new URL('..', import.meta.url));
const output = resolve(root, 'apps/web/public/licenses');
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
const directories = [];
for (const modules of [resolve(root, 'node_modules'), resolve(root, 'apps/web/node_modules')]) {
  for (const name of await readdir(modules)) {
    if (name.startsWith('.')) continue;
    if (name.startsWith('@')) {
      for (const sub of await readdir(join(modules, name))) directories.push(join(modules, name, sub));
    } else directories.push(join(modules, name));
  }
}
const records = new Map(), visited = new Set();
// Follow installed dependency links instead of including stale virtual-store versions.
for (let index = 0; index < directories.length; index++) {
  const candidate = directories[index];
  let directory, pkg;
  try { directory = await realpath(candidate); pkg = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8')); } catch { continue; }
  if (visited.has(directory)) continue;
  visited.add(directory);
  const require = createRequire(join(directory, 'package.json'));
  for (const dependency of new Set(Object.keys({ ...pkg.dependencies, ...pkg.optionalDependencies, ...pkg.peerDependencies }))) {
    for (const modules of require.resolve.paths(dependency) ?? []) {
      const path = join(modules, dependency);
      try { await readFile(join(path, 'package.json')); directories.push(path); break; } catch { /* Not installed at this level. */ }
    }
  }
  const key = `${pkg.name}@${pkg.version}`;
  if (records.has(key)) continue;
  const slug = `${pkg.name.replaceAll('@', '').replaceAll('/', '__')}@${pkg.version}`;
  const notices = [];
  for (const file of await readdir(directory)) {
    if (!/^(licen[cs]e|copying|notice)(?:[.-].*)?$/i.test(file)) continue;
    try {
      const text = await readFile(join(directory, file), 'utf8');
      if (!text.trim()) continue;
      await mkdir(join(output, 'packages', slug), { recursive: true });
      await writeFile(join(output, 'packages', slug, file), text);
      notices.push(`packages/${slug}/${file}`);
    } catch { /* Some packages use a directory called licenses. */ }
  }
  // BlockSuite's embedded drawing libraries carry their own copyright notices.
  if (pkg.name.startsWith('@blocksuite/')) {
    async function collect(path, relative = '') {
      let entries; try { entries = await readdir(path, { withFileTypes: true }); } catch { return; }
      for (const entry of entries) {
        const next = join(path, entry.name), rel = join(relative, entry.name);
        if (entry.isDirectory()) await collect(next, rel);
        else if (/^(licen[cs]e|copying|notice)(?:[.-].*)?$/i.test(entry.name)) {
          const target = join(output, 'packages', slug, rel);
          await mkdir(resolve(target, '..'), { recursive: true });
          await cp(next, target); notices.push(`packages/${slug}/${rel}`);
        }
      }
    }
    await collect(join(directory, 'src'), 'src');
  }
  let license = typeof pkg.license === 'string' ? pkg.license : pkg.license?.type;
  if (!license && pkg.name === '@toeverything/theme') license = 'MPL-2.0';
  if (!license && ['eval', 'require-like'].includes(pkg.name)) license = 'MIT (see package license)';
  const repository = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url;
  records.set(key, {
    name: pkg.name, version: pkg.version, license: license ?? 'See upstream source and notices',
    ...(repository ? { repository } : {}),
    source: `https://registry.npmjs.org/${pkg.name}/-/${pkg.name.split('/').at(-1)}-${pkg.version}.tgz`,
    notices,
  });
}
const packages = [...records.values()].sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
await writeFile(join(output, 'dependencies.json'), JSON.stringify({ note: 'Installed dependencies, including build and test tools. Each package keeps its own license.', packages }, null, 2) + '\n');
const theme = await realpath(resolve(root, 'apps/web/node_modules/@toeverything/theme'));
// The npm tarball omits some source modules; preserve the complete upstream
// source archive at tag 1.1.23 instead of advertising that subset as complete.
await cp(resolve(root, 'licenses/upstream'), join(output, 'upstream'), { recursive: true });
async function copyFontNotices(directory, relative = '') {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const next = join(directory, entry.name), rel = join(relative, entry.name);
    if (entry.isDirectory()) await copyFontNotices(next, rel);
    else if (/^(ofl|license|notice)(?:[.-].*)?$/i.test(entry.name)) {
      const target = join(output, 'theme-fonts', rel);
      await mkdir(resolve(target, '..'), { recursive: true }); await cp(next, target);
    }
  }
}
await copyFontNotices(join(theme, 'fonts'));
const escape = value => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;');
await writeFile(join(output, 'index.html'), `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Open Whiteboard open source notices</title><style>body{font:16px/1.6 system-ui,sans-serif;max-width:960px;margin:40px auto;padding:0 24px;overflow-wrap:anywhere}li{margin:16px 0}a{color:#2554c7}</style></head><body><h1>Open source notices</h1><p>Open Whiteboard uses open source libraries. Their licenses apply to their own code. This list includes build and test tools as well as libraries used in the application.</p><p>The theme is MPL-2.0. Its complete corresponding source is included in <a href="upstream/toeverything-design-1.1.23.tar.gz">this source archive</a>, from upstream commit <a href="https://github.com/toeverything/design/tree/2ce2dfa5d9c207e270d874275b3b3d2dd5cfaf91">2ce2dfa</a>. BlockSuite packages at 0.22.4 declare MIT in their published package metadata; the upstream repository also includes MPL-2.0. The upstream <a href="upstream/blocksuite-0.22.4-LICENSE">license notice</a> is preserved. The exact <a href="https://github.com/toeverything/blocksuite/tree/v0.22.4">upstream source</a> and package source archives below are available.</p><p><a href="https://github.com/sportwhiz/open-whiteboard/blob/main/THIRD_PARTY_NOTICES.md">Application notices and fonts</a> · <a href="dependencies.json">Dependency inventory</a></p><ul>${packages.map(pkg => `<li><strong>${escape(pkg.name)} ${escape(pkg.version)}</strong> (${escape(pkg.license)}) · <a href="${escape(pkg.source)}">Source archive</a>${pkg.notices.map(path => ` · <a href="${escape(path)}">${escape(path.split('/').at(-1))}</a>`).join('')}</li>`).join('')}</ul></body></html>\n`);
console.log(`Preserved notices for ${packages.length} dependency versions.`);
