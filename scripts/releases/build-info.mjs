import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
export function schemaDigest(root) {
  const directory = resolve(root, "apps/web/migrations");
  const hash = createHash("sha256");
  for (const name of readdirSync(directory)
    .filter((n) => n.endsWith(".sql"))
    .sort()) {
    hash.update(name + "\0");
    hash.update(readFileSync(resolve(directory, name)));
    hash.update("\0");
  }
  return hash.digest("hex");
}
export function buildInfo(root) {
  let commit = "development";
  try {
    commit = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: root,
      encoding: "utf8",
    }).trim();
  } catch {
    /* source package */
  }
  return {
    version: JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"))
      .version,
    commit,
    schema: schemaDigest(root),
    dataFormat: 1,
    protocol: 1,
    security: false,
    notes: "",
  };
}
