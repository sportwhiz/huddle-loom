import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
process.chdir(fileURLToPath(new URL("..", import.meta.url)));
const guide = spawnSync(process.execPath, ["scripts/generate-operator-guide.mjs"], { stdio: "inherit" });
if (guide.status !== 0) process.exit(guide.status ?? 1);
const result = spawnSync("pnpm", ["exec", "vite", ...process.argv.slice(2).filter(arg => arg !== "--")], {
  stdio: "inherit",
  env: { ...process.env, WHITEBOARD_WRANGLER_CONFIG: process.env.WHITEBOARD_WRANGLER_CONFIG ?? "wrangler.local.jsonc" },
});
if (result.error) throw result.error;
process.exit(result.status ?? 1);
