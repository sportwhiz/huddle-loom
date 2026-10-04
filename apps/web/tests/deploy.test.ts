import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const deploy = fileURLToPath(new URL("../scripts/deploy.mjs", import.meta.url));
const namedMissing =
  "Couldn't find a D1 DB named 'fresh-catalog' (bound as 'CATALOG') in the API. Run 'wrangler d1 create fresh-catalog' to create it.";
const automaticMissing =
  "Couldn't find an auto-provisioned D1 DB named 'canvas-catalog' for binding 'CATALOG'. Run 'wrangler deploy' to provision it, or add 'database_name' / 'database_id' to your config.";

function rehearsal(
  failure: string,
  catalog: Record<string, string>,
  failRetry = false,
) {
  const directory = mkdtempSync(resolve(tmpdir(), "canvas-deploy-test-"));
  try {
    mkdirSync(resolve(directory, ".wrangler/deploy"), { recursive: true });
    writeFileSync(
      resolve(directory, ".wrangler/deploy/config.json"),
      JSON.stringify({ configPath: "../../built.json" }),
    );
    writeFileSync(
      resolve(directory, "built.json"),
      JSON.stringify({ d1_databases: [{ binding: "CATALOG", ...catalog }] }),
    );
    writeFileSync(
      resolve(directory, "wrangler"),
      `#!/usr/bin/env node
import { appendFileSync, existsSync } from 'node:fs';
const args = process.argv.slice(2);
const first = !existsSync('calls.jsonl');
appendFileSync('calls.jsonl', JSON.stringify(args) + '\\n');
if (args[0] === 'd1' && (first || process.env.FAIL_RETRY === 'true')) {
  console.error(first ? process.env.FIXTURE_ERROR : 'incomplete input: SQLITE_ERROR');
  process.exit(1);
}
`,
      { mode: 0o700 },
    );
    const result = spawnSync(process.execPath, [deploy], {
      cwd: directory,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${directory}:${process.env.PATH}`,
        FIXTURE_ERROR: failure,
        FAIL_RETRY: String(failRetry),
      },
    });
    const calls = readFileSync(resolve(directory, "calls.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as string[]);
    return { status: result.status, calls };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

describe("deployment migration ordering", () => {
  it.each([
    { failure: namedMissing, catalog: { database_name: "fresh-catalog" } },
    { failure: automaticMissing, catalog: {} },
  ])(
    "provisions a missing catalog once and then applies its migrations",
    ({ failure, catalog }) => {
      const result = rehearsal(failure, catalog);
      expect(result.status).toBe(0);
      expect(result.calls.map((args) => args[0])).toEqual([
        "d1",
        "deploy",
        "d1",
        "deploy",
      ]);
      expect(result.calls[0]).toEqual(result.calls[2]);
    },
  );

  it.each([
    {
      failure: "incomplete input: SQLITE_ERROR",
      catalog: { database_name: "fresh-catalog" },
    },
    {
      failure: "Authentication error [code: 10000]",
      catalog: { database_name: "fresh-catalog" },
    },
    { failure: namedMissing, catalog: { database_name: "another-catalog" } },
    {
      failure: namedMissing,
      catalog: { database_name: "fresh-catalog", database_id: "pinned-id" },
    },
  ])(
    "stops without publishing or replacing storage on $failure",
    ({ failure, catalog }) => {
      const result = rehearsal(failure, catalog);
      expect(result.status).toBe(1);
      expect(result.calls).toHaveLength(1);
    },
  );

  it("does not publish a final deployment if the migration retry fails", () => {
    const result = rehearsal(
      namedMissing,
      { database_name: "fresh-catalog" },
      true,
    );
    expect(result.status).toBe(1);
    expect(result.calls.map((args) => args[0])).toEqual(["d1", "deploy", "d1"]);
  });
});
