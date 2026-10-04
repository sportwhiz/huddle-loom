import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const sourceDirectory = resolve(root, 'apps/web/.wrangler/deploy');
const targetDirectory = resolve(root, '.wrangler/deploy');
const deployment = JSON.parse(
  await readFile(resolve(sourceDirectory, 'config.json'), 'utf8')
);

// Vite writes paths relative to the app's deploy directory. Wrangler commands
// run by Workers Builds start at the repository root, so rebase those paths.
async function rebase(configPath) {
  const absolutePath = resolve(sourceDirectory, configPath);
  await access(absolutePath);
  return relative(targetDirectory, absolutePath).split(sep).join('/');
}

deployment.configPath = await rebase(deployment.configPath);
deployment.auxiliaryWorkers = await Promise.all(
  (deployment.auxiliaryWorkers ?? []).map(async worker => ({
    ...worker,
    configPath: await rebase(worker.configPath),
  }))
);
if (deployment.prerenderWorkerConfigPath) {
  deployment.prerenderWorkerConfigPath = await rebase(deployment.prerenderWorkerConfigPath);
}

await mkdir(targetDirectory, { recursive: true });
await writeFile(
  resolve(targetDirectory, 'config.json'),
  JSON.stringify(deployment, null, 2) + '\n'
);
console.log('Generated repository-root Wrangler deployment redirect.');
