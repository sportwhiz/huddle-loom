import { writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { buildInfo } from "./build-info.mjs";
const root = process.cwd();
const info = buildInfo(root);
const tag = process.env.RELEASE_TAG;
if (
  !/^v\d{1,5}\.\d{1,5}\.\d{1,5}$/.test(tag ?? "") ||
  tag !== `v${info.version}`
)
  throw new Error("The release tag must match package.json.");
if (
  execFileSync("git", ["rev-parse", `${tag}^{commit}`], {
    encoding: "utf8",
  }).trim() !== info.commit
)
  throw new Error("Checkout must match the release tag.");
if (
  execFileSync("git", ["status", "--porcelain", "--untracked-files=no"], {
    encoding: "utf8",
  }).trim()
)
  throw new Error("Release source must be clean.");
info.security = process.env.RELEASE_SECURITY === "true";
info.notes = (process.env.RELEASE_NOTES ?? "").slice(0, 12000);
if (!info.notes.trim()) throw new Error("Release notes are required.");
writeFileSync("huddle-loom-release.json", JSON.stringify(info, null, 2) + "\n");
console.log(`Prepared release manifest for ${tag} at ${info.commit}.`);
