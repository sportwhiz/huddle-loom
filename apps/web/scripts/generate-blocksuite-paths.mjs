import { existsSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const queue = ['affine', 'store', 'sync']
  .map(name => resolve(appRoot, 'node_modules', '@blocksuite', name))
  .filter(existsSync)
  .map(path => realpathSync(path));
const packages = new Map();

while (queue.length > 0) {
  const packageRoot = queue.shift();
  const manifest = await import(resolve(packageRoot, 'package.json'), {
    with: { type: 'json' },
  });
  const metadata = manifest.default;
  if (packages.has(metadata.name)) continue;
  packages.set(metadata.name, packageRoot);

  const dependencies = {
    ...metadata.dependencies,
    ...metadata.peerDependencies,
  };
  for (const dependency of Object.keys(dependencies)) {
    if (!dependency.startsWith('@blocksuite/')) continue;
    const shortName = dependency.slice('@blocksuite/'.length);
    const candidate = resolve(dirname(packageRoot), shortName);
    if (existsSync(candidate)) queue.push(realpathSync(candidate));
  }
}

const paths = {};
for (const [name, packageRoot] of [...packages].sort(([a], [b]) =>
  a.localeCompare(b)
)) {
  const dist = resolve(packageRoot, 'dist');
  const index = resolve(dist, 'index.d.ts');
  if (existsSync(index)) paths[name] = [index];
  paths[`${name}/*`] = [`${dist}/*`];
}

const config = {
  compilerOptions: {
    baseUrl: '.',
    paths,
  },
};

writeFileSync(
  resolve(appRoot, 'tsconfig.blocksuite.json'),
  `${JSON.stringify(config, null, 2)}\n`
);
