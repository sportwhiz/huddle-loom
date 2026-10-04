import { build } from "esbuild";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, cp, writeFile, readFile, rm, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildInfo } from "../../../scripts/releases/build-info.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const repository = resolve(root, "../..");
const output = resolve(root, "dist-node");
const release = buildInfo(repository);
process.chdir(root);
function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: "inherit", ...options });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(`${command} failed with exit code ${result.status ?? 1}`);
}
await rm(output, { recursive: true, force: true });
run(process.execPath, ["scripts/generate-operator-guide.mjs"]);
run("pnpm", ["exec", "vite", "build"], {
  env: { ...process.env, HUDDLE_BUILD_TARGET: "node" },
});
await mkdir(output, { recursive: true });
const serverBuild = await build({
  metafile: true,
  entryPoints: ["src/node/entry.ts"],
  outfile: resolve(output, "server.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  // Build resolution must not inherit machine-specific declaration paths.
  tsconfigRaw: { compilerOptions: { useDefineForClassFields: false } },
  alias: { yjs: fileURLToPath(import.meta.resolve("yjs")) },
  sourcemap: false,
  external: ["mysql2/promise", "ws"],
  define: { __HUDDLE_RELEASE__: JSON.stringify(release) },
  banner: {
    js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);',
  },
});
const yjsInputs = Object.keys(serverBuild.metafile.inputs).filter((path) =>
  /[/\\]yjs[/\\]dist[/\\]yjs\.(?:mjs|cjs)$/.test(path),
);
if (yjsInputs.length !== 1)
  throw new Error("Node bundle must contain exactly one Yjs runtime.");
await cp("migrations", resolve(output, "migrations"), { recursive: true });
await cp(
  resolve(repository, "docs/godaddy-nodejs-installation.md"),
  resolve(output, "README.md"),
);
for (const notice of ["LICENSE", "THIRD_PARTY_NOTICES.md"]) {
  await cp(resolve(repository, notice), resolve(output, notice));
}
const application = JSON.parse(await readFile("package.json", "utf8"));
await writeFile(
  resolve(output, "package.json"),
  JSON.stringify(
    {
      name: "huddle-loom-node",
      version: application.version,
      private: true,
      license: "MIT",
      type: "module",
      main: "server.mjs",
      engines: { node: ">=22.16.0 <23" },
      scripts: { build: "node validate-package.mjs", start: "node server.mjs" },
      dependencies: {
        mysql2: application.dependencies.mysql2,
        ws: application.dependencies.ws,
      },
    },
    null,
    2,
  ) + "\n",
);
await writeFile(
  resolve(output, ".npmrc"),
  "registry=https://registry.npmjs.org/\n",
);
await writeFile(
  resolve(output, "release.json"),
  JSON.stringify(release, null, 2) + "\n",
);
await writeFile(
  resolve(output, "validate-package.mjs"),
  `import { access } from 'node:fs/promises';
for (const path of ['server.mjs', 'client/index.html', 'migrations', 'release.json', 'package-lock.json']) await access(path);
console.log('Huddle Loom Node package is complete.');
`,
);
run(
  "npm",
  ["install", "--package-lock-only", "--ignore-scripts", "--omit=dev"],
  { cwd: output },
);
run("npm", ["run", "build"], { cwd: output });
await writeFile(
  resolve(output, "DEPLOYMENT-STATUS.txt"),
  "Locally qualified Node package. Live GoDaddy qualification is still required.\nGoDaddy uses its durable private catalog plus managed MySQL; other Node hosts may select a full MySQL catalog. Verify TLS, private-volume persistence, isolated Publish settings, canonical app origin/private owner setup, email delivery, backup/restore and process replacement before production use.\n",
);
const archive = resolve(root, "huddle-loom-node.zip");
await rm(archive, { force: true });
run(
  "zip",
  ["-q", "-r", archive, ".", "-x", "node_modules/*", ".env", ".env.*"],
  { cwd: output },
);
if ((await stat(archive)).size >= 100_000_000)
  throw new Error("Node archive exceeds the GoDaddy upload limit.");
const checksum = createHash("sha256")
  .update(await readFile(archive))
  .digest("hex");
await writeFile(`${archive}.sha256`, `${checksum}  huddle-loom-node.zip\n`);
console.log(`Node package: ${archive}`);
