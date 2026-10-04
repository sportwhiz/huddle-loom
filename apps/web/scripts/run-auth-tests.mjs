import { spawn, spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { rmSync } from "node:fs";
import { setDefaultResultOrder } from "node:dns";
setDefaultResultOrder("ipv6first");
const env = {
  ...process.env,
  NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --dns-result-order=ipv6first`,
  WHITEBOARD_WRANGLER_CONFIG: "tests/wrangler.auth.jsonc",
};
const run = (args) => {
  const result = spawnSync("pnpm", args, { env, stdio: "inherit" });
  if (result.status !== 0)
    throw new Error(`Fixture command failed: ${args.slice(0, 3).join(" ")}`);
};
let server;
const stop = async () => {
  if (server && server.exitCode === null) {
    server.kill("SIGTERM");
    await new Promise((resolve) => server.once("exit", resolve));
  }
  server = undefined;
};
try {
  try {
    const response = await fetch("http://localhost:5180/api/v1/health", {
      signal: AbortSignal.timeout(500),
    });
    if (
      response.ok &&
      (await response.json()).service === "personal-whiteboard"
    )
      throw new Error(
        "Stop the isolated auth fixture on localhost:5180 before this test.",
      );
  } catch (error) {
    if (error.message.startsWith("Stop")) throw error;
  }
  run([
    "exec",
    "wrangler",
    "d1",
    "migrations",
    "apply",
    "CATALOG",
    "--local",
    "--config",
    "tests/wrangler.auth.jsonc",
  ]);
  server = spawn(
    process.execPath,
    [
      resolve("node_modules/vite/bin/vite.js"),
      "--host",
      "localhost",
      "--port",
      "5180",
      "--strictPort",
    ],
    { env, stdio: "ignore" },
  );
  let ready = false;
  for (let i = 0; i < 120; i++) {
    try {
      const response = await fetch("http://localhost:5180/api/v1/health");
      if (
        response.ok &&
        (await response.json()).service === "personal-whiteboard"
      ) {
        ready = true;
        break;
      }
    } catch {}
    if (server.exitCode !== null) break;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  if (!ready) throw new Error("The isolated auth fixture did not start.");
  run(["exec", "tsx", "scripts/auth-smoke.ts", "--reset", "--ui-fixture"]);
  await stop();
  run(["exec", "tsx", "scripts/auth-restore-rehearsal.ts"]);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  await stop();
  if (!process.argv.includes("--keep-ui-fixture"))
    rmSync("/tmp/canvas-auth-ui.json", { force: true });
}
